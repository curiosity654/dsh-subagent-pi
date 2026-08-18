import { randomUUID } from "node:crypto";

import type { ContentBlock } from "@deepseek-ai/dsh-llm";
import type { AgentCancelCause } from "@deepseek-ai/dsh-agent";
import type {
  ResolvedSubagentStartRequest,
  SubagentCapabilities,
  SubagentProvider,
  SubagentResult,
  SubagentRun,
} from "@deepseek-ai/dsh-subagent";
import { resolveChildDepth } from "@deepseek-ai/dsh-subagent";
import type { SessionId } from "@deepseek-ai/dsh-session";

import type { PluginConfig } from "./config.js";
import type { ModelSelectionSource, PiDiagnosticSink, PiRunDiagnostic, ThinkingSelectionSource } from "./diagnostics.js";
import type { PiRunEvent, PiSession, PiSessionFactory, PiSessionStartInput, PiStopReason } from "./pi-session.js";
import type { ProjectionFailure, SessionProjectionFactory, SessionProjectionHandle } from "./session-projection.js";
import { canonicalWorkspace, textPrompt } from "./workspace.js";

const capabilities: SubagentCapabilities = {
  depthLimit: true,
  outputSchema: false,
  toolFilter: false,
  persona: false,
};

export interface ProviderOptions {
  readonly factory: PiSessionFactory;
  readonly config: PluginConfig | (() => PluginConfig);
  readonly agentDir?: string;
  readonly resolveTrust?: (workspace: string) => boolean;
  readonly onDiagnostic?: PiDiagnosticSink;
  readonly projection?: SessionProjectionFactory;
  /** Activation supplies this guard; direct test seams may omit projection. */
  readonly requireProjection?: boolean;
}

export interface PiProvider extends SubagentProvider {
  /** Stop every admitted run and await terminal Pi quiescence during unload. */
  shutdown(): Promise<void>;
}

class RunCapacity {
  private active = 0;

  constructor(private readonly limit: () => number) {}

  admit(): () => void {
    const limit = this.limit();
    if (this.active >= limit) {
      throw new Error(`Pi run capacity exhausted (maxConcurrentRuns=${limit})`);
    }
    this.active += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active -= 1;
    };
  }
}

function resolveConfig(source: PluginConfig | (() => PluginConfig)): PluginConfig {
  return typeof source === "function" ? source() : source;
}

class OutputCollector {
  private readonly deltas: string[] = [];
  private lastAssistant?: ContentBlock[];
  private terminal?: PiStopReason;
  private infrastructureError?: unknown;

  push(event: PiRunEvent): void {
    if (event.type === "text-delta" && event.text.length > 0) this.deltas.push(event.text);
    if (event.type === "assistant-message") {
      const visible = event.content.filter((block): block is ContentBlock => typeof block === "object"
        && block !== null && (block as { type?: unknown }).type === "text"
        && typeof (block as { text?: unknown }).text === "string") as ContentBlock[];
      if (visible.length > 0) this.lastAssistant = visible;
    }
    if (event.type === "terminal") this.terminal = event.reason;
  }

  fail(error: unknown): void {
    this.infrastructureError = error;
  }

  result(aborted: boolean): SubagentResult {
    const output = this.lastAssistant ?? (this.deltas.length > 0 ? [{ type: "text", text: this.deltas.join("") }] : []);
    if (aborted) return { output, stopReason: "aborted" };
    if (this.infrastructureError !== undefined) return { output, stopReason: "error" };
    return { output, stopReason: mapStopReason(this.terminal ?? "error") };
  }

  stopReason(): PiStopReason | undefined {
    return this.terminal;
  }
}

function mapStopReason(reason: PiStopReason): SubagentResult["stopReason"] {
  switch (reason) {
    case "stop": return "completed";
    case "length": return "max-tokens";
    case "aborted": return "aborted";
    case "error": return "error";
    case "pending":
    case "toolUse":
    case "deferred":
      return "error";
  }
}

interface ModelSelection {
  readonly model?: PluginConfig["defaultModel"];
  readonly source: ModelSelectionSource;
}

function explicitSelection(request: ResolvedSubagentStartRequest, config: PluginConfig): ModelSelection {
  const requested = request.agentOptions as { provider?: unknown; model?: unknown; maxTokens?: unknown } | undefined;
  if (requested?.maxTokens !== undefined) throw new Error("agentOptions.maxTokens is not supported in V1");
  const hasProvider = requested?.provider !== undefined;
  const hasModel = requested?.model !== undefined;
  if (hasProvider !== hasModel) throw new Error("provider and model must be provided together");
  if (hasProvider) {
    if (typeof requested?.provider !== "string" || typeof requested?.model !== "string") {
      throw new Error("provider and model must be non-empty strings");
    }
    const provider = requested.provider.trim();
    const model = requested.model.trim();
    if (provider.length === 0 || model.length === 0) throw new Error("provider and model must be non-empty strings");
    return { model: { provider, model }, source: "request" };
  }
  if (config.defaultModel !== undefined) return { model: config.defaultModel, source: "plugin-config" };
  return { source: "pi-settings" };
}

export function createPiProvider(options: ProviderOptions): PiProvider {
  const getConfig = () => resolveConfig(options.config);
  const capacity = new RunCapacity(() => getConfig().maxConcurrentRuns);
  const agentDir = options.agentDir ?? "";
  const activeDisposers = new Set<() => Promise<void>>();
  let closed = false;
  let shuttingDown = false;
  let starting = 0;
  let startingDrain: Promise<void> | undefined;
  let resolveStartingDrain: (() => void) | undefined;
  let shutdownPromise: Promise<void> | undefined;

  const waitForStarting = (): Promise<void> => {
    if (starting === 0) return Promise.resolve();
    if (startingDrain !== undefined) return startingDrain;
    startingDrain = new Promise(resolve => {
      resolveStartingDrain = resolve;
    });
    return startingDrain;
  };

  const shutdown = (): Promise<void> => {
    if (shutdownPromise !== undefined) return shutdownPromise;
    closed = true;
    shuttingDown = true;
    shutdownPromise = (async () => {
      await waitForStarting();
      const settled = await Promise.allSettled([...activeDisposers].map(dispose => dispose()));
      const failures = settled.filter((entry): entry is PromiseRejectedResult => entry.status === "rejected");
      if (failures.length > 0) throw new AggregateError(failures.map(entry => entry.reason), "Pi provider shutdown failed");
    })();
    return shutdownPromise;
  };

  const provider: Omit<PiProvider, "shutdown"> = {
    name: "pi",
    capabilities,
    inheritsParentContext: false,
    async start(request): Promise<SubagentRun> {
      if (closed) throw new Error("Pi provider is unloading");
      if (options.requireProjection === true && options.projection === undefined) {
        throw new Error("Pi provider requires a Session-backed projection");
      }
      const prompt = textPrompt(request.prompt as never);
      if (request.outputSchema !== undefined) throw new Error("Pi provider does not support outputSchema in V1");
      if (request.toolFilter !== undefined) throw new Error("Pi provider does not support toolFilter in V1");
      if (request.persona !== undefined) throw new Error("Pi provider does not support persona in V1");
      const config = getConfig();
      const selection = explicitSelection(request, config);
      const childDepth = resolveChildDepth(request.parent, request.maxDepth);
      const descriptorLabel = request.label ?? (
        typeof (request.descriptor as { label?: unknown } | undefined)?.label === "string"
          ? (request.descriptor as { label: string }).label
          : undefined
      );
      const workspace = await canonicalWorkspace(request.parent.session.header.cwd);
      if (closed) throw new Error("Pi provider is unloading");
      const trusted = options.resolveTrust?.(workspace) ?? false;
      const release = capacity.admit();
      if (closed) {
        release();
        throw new Error("Pi provider is unloading");
      }
      starting += 1;
      let startFinished = false;
      const finishStarting = (): void => {
        if (startFinished) return;
        startFinished = true;
        starting -= 1;
        if (starting === 0) {
          resolveStartingDrain?.();
          resolveStartingDrain = undefined;
          startingDrain = undefined;
        }
      };
      let session: PiSession | undefined;
      let projection: SessionProjectionHandle | undefined;
      let unsubscribe: () => void = () => {};
      let disposed = false;
      let abortRequested = request.signal.aborted;
      let resultSettled = false;
      let cleanup: Exclude<PiRunDiagnostic["cleanup"], undefined> = "pending";
      let diagnosticEnded = false;
      let projectionFailureEmitted = false;
      let removeAbortListener: () => void = () => {};
      const collector = new OutputCollector();
      const childSessionId = randomUUID() as SessionId;
      const parentSessionId = String(request.parent.session.id ?? request.parent.id);

      const emitDiagnostic = (diagnostic: PiRunDiagnostic): void => {
        try {
          options.onDiagnostic?.(diagnostic);
        } catch {
          // Diagnostics are observability only and never change run semantics.
        }
      };

      const maybeEmitEnd = (): void => {
        if (!resultSettled || cleanup === "pending" || diagnosticEnded || session === undefined) return;
        diagnosticEnded = true;
        const stopReason = collector.stopReason();
        emitDiagnostic({
          event: "end",
          childSessionId: String(projection?.id ?? childSessionId),
          parentSessionId,
          workspace,
          trusted,
          ...(session.model === undefined ? {} : { model: session.model }),
          modelSource: session.modelSource ?? selection.source,
          thinking: session.thinkingLevel,
          thinkingSource: session.thinkingSource ?? (config.thinking === undefined ? "default-medium" : "plugin-config"),
          ...(session.thinkingClamped === undefined ? {} : { thinkingClamped: session.thinkingClamped }),
          ...(stopReason === undefined ? {} : { stopReason }),
          durationMs: Date.now() - startedAt,
          cleanup,
          ...(projection === undefined ? {} : { unsupportedCounts: projection.diagnostics.unsupportedCounts }),
        });
      };

      const emitProjectionFailure = (failure: ProjectionFailure): void => {
        if (projectionFailureEmitted) return;
        projectionFailureEmitted = true;
        emitDiagnostic({
          event: "projection-failure",
          childSessionId: String(projection?.id ?? childSessionId),
          parentSessionId,
          workspace,
          trusted,
          modelSource: selection.source,
          thinkingSource: config.thinking === undefined ? "default-medium" : "plugin-config",
          phase: failure.phase,
          ...(failure.eventCategory === undefined ? {} : { nativeEventCategory: failure.eventCategory }),
          lastSuccessfulSeq: failure.lastSuccessfulSeq,
          ...(projection === undefined ? {} : { unsupportedCounts: projection.diagnostics.unsupportedCounts }),
        });
      };

      const startedAt = Date.now();

      const dispose = async (): Promise<void> => {
        if (disposed) return;
        disposed = true;
        if (!resultSettled) {
          abortRequested = true;
          projection?.cancel(shuttingDown
            ? { kind: "hook", reason: "plugin-shutdown" }
            : { kind: "disposed" });
        }
        let cleanupError: unknown;
        try {
          removeAbortListener();
        } catch (error) {
          cleanupError = error;
        }
        if (session !== undefined) {
          try {
            if (session.isIdle !== true) await session.abort();
            await session.waitForIdle();
          } catch (error) {
            cleanupError = error;
          } finally {
            try {
              unsubscribe();
            } catch (error) {
              cleanupError ??= error;
            }
            if (projection !== undefined) {
              try {
                const finalized = await projection.finalize(abortRequested ? "aborted" : (collector.stopReason() ?? "aborted"));
                if (finalized.projectionFailure !== undefined) cleanupError ??= finalized.projectionFailure.error;
              } catch (error) {
                cleanupError ??= error;
              }
              try {
                await projection.dispose();
              } catch (error) {
                cleanupError ??= error;
              }
            }
            try {
              session.dispose();
            } catch (error) {
              cleanupError ??= error;
            }
          }
        }
        release();
        cleanup = cleanupError === undefined ? "complete" : "error";
        maybeEmitEnd();
        if (cleanupError !== undefined) throw cleanupError;
      };

      try {
        if (abortRequested) throw new DOMException("The operation was aborted", "AbortError");
        const sessionInput = {
          cwd: workspace,
          agentDir,
          trusted,
          ...(selection.model === undefined ? {} : { model: selection.model }),
          ...(selection.source === "pi-settings" ? {} : { modelSource: selection.source }),
          ...(config.thinking === undefined ? {} : { thinking: config.thinking }),
        } satisfies PiSessionStartInput;
        session = await options.factory.start(sessionInput);
        if (closed) throw new Error("Pi provider is unloading");
        if (request.signal.aborted) throw new DOMException("The operation was aborted", "AbortError");
        const abortSession = (): void => {
          abortRequested = true;
          void session?.abort().catch(error => collector.fail(error));
        };
        projection = options.projection === undefined
          ? undefined
          : await options.projection.prepare({
            parent: request.parent,
            workspace,
            delegationDepth: childDepth,
            provider: "pi",
            ...(descriptorLabel === undefined ? {} : { label: descriptorLabel }),
            ...(session.model === undefined ? {} : { model: session.model }),
            childSessionId: String(childSessionId),
            onProjectionFailure: emitProjectionFailure,
            onCancel: abortSession,
          });
        if (closed) throw new Error("Pi provider is unloading");
        if (request.signal.aborted) throw new DOMException("The operation was aborted", "AbortError");
        projection?.publish(prompt);
        unsubscribe = session.subscribe(event => {
          collector.push(event);
          projection?.project(event);
        });
        emitDiagnostic({
          event: "start",
          childSessionId: String(projection?.id ?? childSessionId),
          parentSessionId,
          workspace,
          trusted,
          ...(session.model === undefined ? {} : { model: session.model }),
          modelSource: session.modelSource ?? selection.source,
          thinking: session.thinkingLevel,
          thinkingSource: session.thinkingSource ?? (config.thinking === undefined ? "default-medium" : "plugin-config"),
          ...(session.thinkingClamped === undefined ? {} : { thinkingClamped: session.thinkingClamped }),
        });
        const abort = () => {
          projection?.cancel({ kind: "parent" });
          abortSession();
        };
        request.signal.addEventListener("abort", abort, { once: true });
        removeAbortListener = () => {
          request.signal.removeEventListener("abort", abort);
          removeAbortListener = () => {};
        };
        if (request.signal.aborted) abort();
        if (request.signal.aborted) throw new DOMException("The operation was aborted", "AbortError");
        const promptPromise = session.prompt(prompt).catch(error => {
          collector.fail(error);
        });
        const result = promptPromise.then(async () => {
          try {
            await session?.waitForIdle();
            if (projection !== undefined) {
              const finalized = await projection.finalize(abortRequested ? "aborted" : (collector.stopReason() ?? "error"));
              if (finalized.projectionFailure !== undefined) {
                emitProjectionFailure(finalized.projectionFailure);
                throw finalized.projectionFailure.error;
              }
            }
            const value = collector.result(abortRequested);
            resultSettled = true;
            maybeEmitEnd();
            return value;
          } catch (error) {
            collector.fail(error);
            resultSettled = true;
            maybeEmitEnd();
            throw error;
          }
        });
        result.finally(() => removeAbortListener()).catch(() => undefined);
        const runDispose = async (): Promise<void> => {
          try {
            await dispose();
          } finally {
            activeDisposers.delete(runDispose);
          }
        };
        activeDisposers.add(runDispose);
        finishStarting();
        return { id: projection?.id ?? childSessionId, localAgent: projection?.localAgent, result, dispose: runDispose };
      } catch (error) {
        collector.fail(error);
        try {
          await dispose();
        } finally {
          finishStarting();
        }
        throw error;
      }
    },
  };
  return { ...provider, shutdown };
}
