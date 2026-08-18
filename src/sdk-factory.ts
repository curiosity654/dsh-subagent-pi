import {
  ProjectTrustStore,
  SessionManager,
  createAgentSessionFromServices,
  createAgentSessionServices,
  type AgentSession,
  type AgentSessionEvent,
} from "@earendil-works/pi-coding-agent";

import type { ContentBlock } from "@deepseek-ai/dsh-llm";
import { clampThinkingLevel, getSupportedThinkingLevels, type Api, type Model } from "@earendil-works/pi-ai";

import type { DefaultModel, ThinkingLevel } from "./config.js";
import type { ModelSelectionSource, ThinkingSelectionSource } from "./diagnostics.js";
import type { PiSession, PiSessionEvent, PiSessionFactory, PiSessionStartInput, PiStopReason } from "./pi-session.js";

export class SdkPiSessionFactory implements PiSessionFactory {
  constructor(private readonly defaultAgentDir: string) {}

  async start(input: PiSessionStartInput): Promise<PiSession> {
    const services = await createAgentSessionServices({
      cwd: input.cwd,
      agentDir: input.agentDir || this.defaultAgentDir,
      resourceLoaderReloadOptions: {
        resolveProjectTrust: async () => input.trusted,
      },
    });
    const modelResolution = await resolveModel(services.modelRuntime, services.settingsManager, input.model);
    const thinkingResolution = resolveThinking(
      modelResolution.model,
      input.thinking,
      services.settingsManager.getDefaultThinkingLevel() as ThinkingLevel | undefined,
    );
    let session: AgentSession | undefined;
    try {
      const created = await createAgentSessionFromServices({
        services,
        sessionManager: SessionManager.inMemory(input.cwd),
        model: modelResolution.model,
        thinkingLevel: thinkingResolution.level,
      });
      session = created.session;
      const availableThinkingLevels = session.getAvailableThinkingLevels() as ThinkingLevel[];
      if (input.thinking !== undefined && !availableThinkingLevels.includes(input.thinking)) {
        throw new Error(`Thinking level "${input.thinking}" is not supported by the selected Pi model`);
      }
      const actualThinking = session.thinkingLevel as ThinkingLevel;
      await session.bindExtensions({ mode: "print" });
      return new SdkPiSession(session, {
        modelSource: input.modelSource ?? modelResolution.source,
        thinkingSource: thinkingResolution.source,
        thinkingClamped: thinkingResolution.clamped || actualThinking !== thinkingResolution.level,
      });
    } catch (error) {
      session?.dispose();
      throw error;
    }
  }
}

export function createProjectTrustResolver(agentDir: string): {
  store: ProjectTrustStore;
  resolve(workspace: string): boolean;
} {
  const store = new ProjectTrustStore(agentDir);
  return {
    store,
    resolve: workspace => store.get(workspace) === true,
  };
}

class SdkPiSession implements PiSession {
  readonly model?: DefaultModel;
  readonly modelSource: ModelSelectionSource;
  readonly thinkingLevel: ThinkingLevel;
  readonly thinkingSource: ThinkingSelectionSource;
  readonly thinkingClamped: boolean;
  readonly availableThinkingLevels: readonly ThinkingLevel[];

  constructor(
    private readonly session: AgentSession,
    metadata: {
      modelSource: ModelSelectionSource;
      thinkingSource: ThinkingSelectionSource;
      thinkingClamped: boolean;
    },
  ) {
    this.modelSource = metadata.modelSource;
    this.thinkingSource = metadata.thinkingSource;
    this.thinkingClamped = metadata.thinkingClamped;
    const model = session.model;
    if (model !== undefined) this.model = { provider: model.provider, model: model.id };
    this.thinkingLevel = session.thinkingLevel as ThinkingLevel;
    this.availableThinkingLevels = session.getAvailableThinkingLevels() as ThinkingLevel[];
  }

  get isIdle(): boolean {
    return this.session.isIdle;
  }

  subscribe(listener: (event: PiSessionEvent) => void): () => void {
    return this.session.subscribe(event => emitPiEvent(listener, event));
  }

  prompt(prompt: string): Promise<void> {
    return this.session.prompt(prompt, { source: "rpc" });
  }

  abort(): Promise<void> {
    return this.session.abort();
  }

  waitForIdle(): Promise<void> {
    return this.session.waitForIdle();
  }

  dispose(): void {
    this.session.dispose();
  }
}

async function resolveModel(
  runtime: {
    getModel(provider: string, model: string): Model<Api> | undefined;
    getAvailable(provider?: string): Promise<readonly Model<Api>[]>;
  },
  settings: { getDefaultProvider(): string | undefined; getDefaultModel(): string | undefined },
  requested: DefaultModel | undefined,
): Promise<{ model: Model<Api>; source: ModelSelectionSource }> {
  if (requested !== undefined) {
    const provider = requested.provider;
    const modelId = requested.model;
    const model = runtime.getModel(provider, modelId);
    if (model === undefined) {
      throw new Error(`Pi model is unavailable: ${provider}/${modelId}`);
    }
    const available = await runtime.getAvailable(provider);
    if (!available.some(candidate => candidate.provider === provider && candidate.id === modelId)) {
      throw new Error(`Pi model is not authenticated or available: ${provider}/${modelId}`);
    }
    return { model, source: "request" };
  }
  const provider = settings.getDefaultProvider();
  const modelId = settings.getDefaultModel();
  if (provider !== undefined && modelId !== undefined) {
    const model = runtime.getModel(provider, modelId);
    const available = await runtime.getAvailable(provider);
    if (model !== undefined && available.some(candidate => candidate.provider === provider && candidate.id === modelId)) {
      return { model, source: "pi-settings" };
    }
  }
  const available = await runtime.getAvailable();
  const first = available[0];
  if (first === undefined) throw new Error("No authenticated Pi model is available");
  const model = runtime.getModel(first.provider, first.id);
  if (model === undefined) throw new Error(`Pi model disappeared during resolution: ${first.provider}/${first.id}`);
  return { model, source: "authenticated-fallback" };
}

function supportedThinkingLevels(model: Model<Api>): ThinkingLevel[] {
  return getSupportedThinkingLevels(model) as ThinkingLevel[];
}

function resolveThinking(
  model: Model<Api>,
  pluginThinking: ThinkingLevel | undefined,
  settingsThinking: ThinkingLevel | undefined,
): { level: ThinkingLevel; source: ThinkingSelectionSource; clamped: boolean } {
  const source: ThinkingSelectionSource = pluginThinking !== undefined
    ? "plugin-config"
    : settingsThinking !== undefined
      ? "pi-settings"
      : "default-medium";
  const desired = pluginThinking ?? settingsThinking ?? "medium";
  const available = supportedThinkingLevels(model);
  if (pluginThinking !== undefined && !available.includes(pluginThinking)) {
    throw new Error(`Thinking level "${pluginThinking}" is not supported by the selected Pi model`);
  }
  const level = clampThinkingLevel(model, desired) as ThinkingLevel;
  return { level, source, clamped: level !== desired };
}

function emitPiEvent(listener: (event: PiSessionEvent) => void, event: AgentSessionEvent): void {
  if (event.type === "message_update") {
    const update = event.assistantMessageEvent as unknown as Record<string, unknown>;
    if (update.type === "text_delta" && typeof update.delta === "string") {
      listener({ type: "text-delta", text: update.delta });
    }
    if (update.type === "done" || update.type === "error") {
      const message = (update.message ?? update.error) as { content?: unknown; stopReason?: unknown } | undefined;
      if (message !== undefined) {
        const content = visibleContent(message.content);
        if (content.length > 0) listener({ type: "assistant-message", content });
        const reason = toPiStopReason(message.stopReason ?? update.reason);
        if (reason !== undefined) listener({ type: "terminal", reason });
      }
    }
    return;
  }
  if (event.type === "message_end" && event.message.role === "assistant") {
    const message = event.message as unknown as { content?: unknown; stopReason?: unknown };
    const content = visibleContent(message.content);
    if (content.length > 0) listener({ type: "assistant-message", content });
    const reason = toPiStopReason(message.stopReason);
    if (reason !== undefined) listener({ type: "terminal", reason });
    return;
  }
  if (event.type === "turn_end" && event.message.role === "assistant") {
    const message = event.message as unknown as { content?: unknown; stopReason?: unknown };
    const content = visibleContent(message.content);
    if (content.length > 0) listener({ type: "assistant-message", content });
    const reason = toPiStopReason(message.stopReason);
    if (reason !== undefined) listener({ type: "terminal", reason });
    return;
  }
  if (event.type === "agent_end") {
    const assistant = [...event.messages].reverse().find(message => message.role === "assistant") as unknown as { content?: unknown; stopReason?: unknown } | undefined;
    if (assistant !== undefined) {
      const content = visibleContent(assistant.content);
      if (content.length > 0) listener({ type: "assistant-message", content });
      const reason = toPiStopReason(assistant.stopReason);
      if (reason !== undefined) listener({ type: "terminal", reason });
    }
  }
}

function visibleContent(value: unknown): ContentBlock[] {
  if (!Array.isArray(value)) return [];
  return value.filter(block => {
    if (typeof block !== "object" || block === null) return false;
    const candidate = block as { type?: unknown; text?: unknown };
    return candidate.type === "text" && typeof candidate.text === "string";
  }) as ContentBlock[];
}

function toPiStopReason(value: unknown): PiStopReason | undefined {
  switch (value) {
    case "stop":
    case "length":
    case "aborted":
    case "error":
    case "pending":
    case "toolUse":
    case "deferred":
      return value;
    default:
      return undefined;
  }
}
