import { randomUUID } from "node:crypto";

import type { Context } from "@deepseek-ai/cordis";
import {
  CallId,
  createAssistantMessage,
  createToolResultMessage,
  createUserMessage,
  type ContentBlock,
  type TokenUsage,
} from "@deepseek-ai/dsh-llm";
import {
  emitAgentEvent,
  type Agent,
  type AgentCancelCause,
  type AgentRegistry,
} from "@deepseek-ai/dsh-agent";
import {
  SessionId,
  type Session,
  type SessionEvent,
  type SessionStore,
} from "@deepseek-ai/dsh-session";
import {
  snapshotSubagentDescriptor,
} from "@deepseek-ai/dsh-subagent";

import type { DefaultModel } from "./config.js";
import type { PiRunEvent, PiStopReason } from "./pi-session.js";

type SessionStoreSeam = Pick<SessionStore, "prepare" | "enter" | "announce" | "flush">;
type AgentRegistrySeam = Pick<AgentRegistry, "enter" | "announce">;

export interface SessionProjectionHost {
  readonly context: Context;
  readonly sessions: SessionStoreSeam;
  readonly agents: AgentRegistrySeam;
}

/**
 * Resolve the official rc.7 services at activation. Persistence and projection
 * are checked even though the handle reaches them through the session store.
 */
export function createSessionProjectionHost(context: Context): SessionProjectionHost {
  const get = (name: string): unknown => (context as unknown as { get(key: string): unknown }).get(name);
  const sessionsValue = get("sessions");
  const agentsValue = get("agents");
  const persistence = get("sessionPersistence");
  const projections = get("sessionProjections");
  const sessions = sessionsValue as SessionStore | undefined;
  const agents = agentsValue as AgentRegistry | undefined;
  const missing = [
    serviceReady(sessionsValue, ["prepare", "enter", "announce", "flush"]) ? undefined : "Session",
    serviceReady(agentsValue, ["enter", "announce"]) ? undefined : "Agent",
    serviceReady(persistence, ["prepare", "append", "load", "inspect", "readFrom", "list", "listSnapshots"])
      ? undefined
      : "persistence",
    serviceReady(projections, ["register", "snapshot", "checkpoint", "restore", "viewCheckpoint"])
      ? undefined
      : "projection",
  ].filter((value): value is string => value !== undefined);
  if (missing.length > 0) {
    throw new Error("Pi Session-backed parity requires official " + missing.join(", ") + " capabilities");
  }
  return { context, sessions: sessions as SessionStoreSeam, agents: agents as AgentRegistrySeam };
}

function serviceReady(value: unknown, methods: readonly string[]): boolean {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return methods.every(method => typeof record[method] === "function");
}

export interface SessionProjectionPrepareInput {
  readonly parent: Agent;
  readonly workspace: string;
  readonly delegationDepth: number;
  readonly provider: string;
  readonly label?: string;
  readonly model?: DefaultModel;
  readonly childSessionId?: string;
  readonly onProjectionFailure?: (failure: ProjectionFailure) => void;
  readonly onCancel?: (cause: AgentCancelCause) => void;
}

export interface ProjectionFailure {
  readonly error: unknown;
  readonly phase: "append" | "serialize" | "pairing" | "invariant" | "flush" | "recovery";
  readonly eventCategory?: string;
  readonly lastSuccessfulSeq: number;
}

export interface ProjectionDiagnostics {
  readonly unsupportedCounts: Readonly<Record<string, number>>;
  readonly projectionFailure?: ProjectionFailure;
  readonly lastSuccessfulSeq: number;
}

export interface SessionProjectionFinalizeResult {
  readonly projectionFailure?: ProjectionFailure;
}

export interface SessionProjectionHandle {
  readonly id: SessionId;
  readonly localAgent: Agent;
  readonly diagnostics: ProjectionDiagnostics;
  readonly published: boolean;
  publish(prompt: string): void;
  project(event: PiRunEvent): void;
  cancel(cause: AgentCancelCause): void;
  finalize(reason: PiStopReason): Promise<SessionProjectionFinalizeResult>;
  dispose(): Promise<void>;
}

export interface SessionProjectionFactory {
  prepare(input: SessionProjectionPrepareInput): Promise<SessionProjectionHandle>;
}

/** Deep publication module owning one run-scoped Session/Agent transaction. */
export class SessionProjector implements SessionProjectionFactory {
  constructor(private readonly host: SessionProjectionHost) {}

  async prepare(input: SessionProjectionPrepareInput): Promise<SessionProjectionHandle> {
    const id = SessionId(input.childSessionId ?? randomUUID());
    const session = this.host.sessions.prepare(id, {
      meta: {
        cwd: input.workspace,
        parentSession: input.parent.session.id,
        origin: "subagent",
        delegationDepth: input.delegationDepth,
      },
    });
    return new SessionProjectionHandleImpl(this.host, input, session);
  }
}

export function createSessionProjectionFactory(host: SessionProjectionHost): SessionProjectionFactory {
  return new SessionProjector(host);
}

class ProjectionAgentController {
  readonly agent: Agent;
  private currentStatus: "running" | "idle" = "running";
  private cancellation?: AgentCancelCause;
  private resolveIdle: (() => void) | undefined;
  private readonly idlePromise: Promise<void>;

  constructor(
    private readonly host: SessionProjectionHost,
    parent: Agent,
    session: Session,
    onCancel: (cause: AgentCancelCause) => void,
  ) {
    this.idlePromise = new Promise(resolve => {
      this.resolveIdle = resolve;
    });
    const context = parent.ctx ?? host.context;
    const controller = this;
    const rejectUnsupported = (): never => {
      throw new Error("one-shot Pi Projection Agent does not support follow-up or maintenance");
    };
    const projected = {
      id: session.id,
      options: {},
      session,
      inbox: { steering: [], followUp: [], nextStep: [], hasPending: false },
      ctx: context,
      get status(): "running" | "idle" {
        return controller.currentStatus;
      },
      cancel(cause: AgentCancelCause): void {
        if (controller.currentStatus === "idle") return;
        if (controller.cancellation === undefined) controller.cancellation = cause;
        onCancel(controller.cancellation);
      },
      whenIdle(): Promise<void> {
        return controller.currentStatus === "idle" ? Promise.resolve() : controller.idlePromise;
      },
      runMaintenance: async (): Promise<never> => rejectUnsupported(),
      send: rejectUnsupported,
      followup: rejectUnsupported,
      steer: rejectUnsupported,
      inject: rejectUnsupported,
    } as unknown as Agent;
    this.agent = projected;
  }

  get cancellationCause(): AgentCancelCause | undefined {
    return this.cancellation;
  }

  setIdle(): void {
    if (this.currentStatus === "idle") return;
    this.currentStatus = "idle";
    try {
      emitAgentEvent(this.host.context, this.agent, "agent/status", { status: "idle" });
    } catch {
      // Reduced test hosts may not mount Cordis event dispatch.
    }
    this.resolveIdle?.();
    this.resolveIdle = undefined;
  }
}

class SessionProjectionHandleImpl implements SessionProjectionHandle {
  readonly id: SessionId;
  readonly localAgent: Agent;
  private readonly controller: ProjectionAgentController;
  private readonly session: Session;
  private readonly input: SessionProjectionPrepareInput;
  private sessionDetach: (() => void) | undefined;
  private agentDetach: (() => void) | undefined;
  private isPublished = false;
  private isDisposed = false;
  private isFinalized = false;
  private finalizePromise: Promise<SessionProjectionFinalizeResult> | undefined;
  private currentTurn = 1;
  private currentStep = 1;
  private turnOpen = false;
  private stepOpen = false;
  private failure?: ProjectionFailure;
  private ordinaryFrozen = false;
  private recoveryAttempted = false;
  private lastSeq = -1;
  private terminalReason: PiStopReason = "pending";
  private initialPrompt: string | undefined;
  private readonly unsupported = new Map<string, number>();
  private readonly chunkSeqs = new Map<string, number[]>();
  private readonly callSeqs = new Map<string, number>();
  private readonly assistantSeqs = new Map<string, {
    seq: number;
    fingerprint: string;
    usageFingerprint?: string;
  }>();
  private readonly latestUsage = new Map<string, TokenUsage>();
  private readonly host: SessionProjectionHost;

  constructor(host: SessionProjectionHost, input: SessionProjectionPrepareInput, session: Session) {
    this.host = host;
    this.session = session;
    this.input = input;
    this.id = session.id;
    this.controller = new ProjectionAgentController(host, input.parent, session, cause => input.onCancel?.(cause));
    this.localAgent = this.controller.agent;
  }

  get published(): boolean {
    return this.isPublished;
  }

  get diagnostics(): ProjectionDiagnostics {
    return {
      unsupportedCounts: Object.fromEntries(this.unsupported),
      ...(this.failure === undefined ? {} : { projectionFailure: this.failure }),
      lastSuccessfulSeq: this.lastSeq,
    };
  }

  publish(prompt: string): void {
    if (this.isDisposed) throw new Error("cannot publish a disposed Pi child");
    if (this.isPublished) throw new Error("Pi child was already published");
    let sessionDetach: (() => void) | undefined;
    let agentDetach: (() => void) | undefined;
    try {
      sessionDetach = this.host.sessions.enter(this.session);
      agentDetach = this.host.agents.enter(this.localAgent, this.input.parent);
      this.appendRequired("turn/start", { turn: 1 }, "invariant");
      const descriptor = snapshotSubagentDescriptor({
        mode: "one-shot",
        provider: this.input.provider,
        ...(this.input.label === undefined ? {} : { label: this.input.label }),
      });
      this.appendRequired("subagent/descriptor", descriptor, "invariant");
      this.appendRequired("step/start", { turn: 1, step: 1 }, "invariant");
      this.appendRequired("user/message", createUserMessage({
        content: [{ type: "text", text: prompt }],
        source: { kind: "user" },
      }), "invariant", { surfaceOp: "append" });
      this.host.sessions.announce(this.session);
      this.host.agents.announce(this.localAgent);
      this.sessionDetach = sessionDetach;
      this.agentDetach = agentDetach;
      this.isPublished = true;
      this.turnOpen = true;
      this.stepOpen = true;
      this.initialPrompt = prompt;
    } catch (error) {
      agentDetach?.();
      sessionDetach?.();
      throw error;
    }
  }

  project(event: PiRunEvent): void {
    if (!this.isPublished || this.isFinalized || this.isDisposed) return;
    if (event.type === "unsupported") {
      this.countUnsupported(event.category);
      return;
    }
    if (this.ordinaryFrozen) return;
    const rawTurn = "turn" in event ? event.turn : undefined;
    const rawStep = "step" in event ? event.step : undefined;
    const positioned = {
      ...event,
      turn: rawTurn ?? this.currentTurn,
      step: rawStep ?? this.currentStep,
    } as PiRunEvent & { turn: number; step: number };
    try {
      switch (positioned.type) {
        case "turn-start":
          this.ensureTurn(positioned.turn);
          return;
        case "turn-end":
          this.closeStep(positioned.turn, positioned.step);
          return;
        case "step-start":
          this.ensureStep(positioned.turn, positioned.step);
          return;
        case "step-end":
          this.closeStep(positioned.turn, positioned.step);
          return;
        case "user-message":
          this.ensureStep(positioned.turn, positioned.step);
          this.appendUserMessage(positioned);
          return;
        case "text-delta":
          this.ensureStep(positioned.turn, positioned.step);
          this.appendChunk(positioned, { type: "text-delta", index: 0, text: positioned.text });
          return;
        case "reasoning-delta":
          this.ensureStep(positioned.turn, positioned.step);
          this.appendChunk(positioned, { type: "reasoning-delta", index: 0, text: positioned.text });
          return;
        case "usage":
          this.latestUsage.set(this.stepKey(positioned.turn, positioned.step), positioned.usage);
          return;
        case "assistant-message":
          this.ensureStep(positioned.turn, positioned.step);
          this.appendAssistant(positioned);
          return;
        case "tool-call":
          this.ensureStep(positioned.turn, positioned.step);
          this.appendToolCall(positioned);
          return;
        case "tool-result":
          this.ensureStep(positioned.turn, positioned.step);
          this.appendToolResult(positioned);
          return;
        case "terminal":
          this.terminalReason = positioned.reason;
          return;
      }
    } catch (error) {
      this.fail(error, "invariant", positioned.type);
    }
  }

  cancel(cause: AgentCancelCause): void {
    this.localAgent.cancel(cause);
  }

  finalize(reason: PiStopReason): Promise<SessionProjectionFinalizeResult> {
    if (this.finalizePromise !== undefined) return this.finalizePromise;
    this.finalizePromise = this.finalizeOnce(reason);
    return this.finalizePromise;
  }

  private async finalizeOnce(reason: PiStopReason): Promise<SessionProjectionFinalizeResult> {
    if (!this.isPublished || this.isDisposed) return this.failure === undefined ? {} : { projectionFailure: this.failure };
    this.terminalReason = reason;
    if (this.failure === undefined) {
      try {
        this.closeStep(this.currentTurn, this.currentStep);
        this.closeTurn(reason);
        await this.flushOrFail();
      } catch (error) {
        this.fail(error, "invariant", "terminal");
      }
    }
    if (this.failure !== undefined && !this.recoveryAttempted) {
      this.recoveryAttempted = true;
      this.recoverTerminal();
      await this.flushOrFail("recovery");
    }
    this.isFinalized = true;
    this.controller.setIdle();
    return this.failure === undefined ? {} : { projectionFailure: this.failure };
  }

  async dispose(): Promise<void> {
    if (this.isDisposed) return;
    if (!this.isFinalized && this.isPublished) await this.finalize("aborted");
    this.isDisposed = true;
    this.agentDetach?.();
    this.sessionDetach?.();
    this.agentDetach = undefined;
    this.sessionDetach = undefined;
  }

  private ensureTurn(turn: number): void {
    if (!this.turnOpen) {
      this.appendRequired("turn/start", { turn }, "invariant");
      this.currentTurn = turn;
      this.turnOpen = true;
    }
    if (turn !== this.currentTurn) {
      this.closeStep(this.currentTurn, this.currentStep);
      this.closeTurn("stop");
      this.appendRequired("turn/start", { turn }, "invariant");
      this.currentTurn = turn;
      this.currentStep = 1;
      this.turnOpen = true;
    }
  }

  private ensureStep(turn: number, step: number): void {
    this.ensureTurn(turn);
    if (this.stepOpen && this.currentStep === step) return;
    if (this.stepOpen) this.closeStep(this.currentTurn, this.currentStep);
    this.appendRequired("step/start", { turn, step }, "invariant");
    this.currentTurn = turn;
    this.currentStep = step;
    this.stepOpen = true;
  }

  private closeStep(turn: number, step: number): void {
    if (!this.stepOpen || turn !== this.currentTurn || step !== this.currentStep) return;
    this.appendRequired("step/end", { turn, step }, "invariant");
    this.stepOpen = false;
  }

  private closeTurn(reason: PiStopReason): void {
    if (!this.turnOpen) return;
    this.appendRequired("turn/end", {
      turn: this.currentTurn,
      reason: toTurnEndReason(reason, this.controller.cancellationCause),
    }, "invariant");
    this.turnOpen = false;
  }

  private appendUserMessage(event: Extract<PiRunEvent, { type: "user-message" }>): void {
    const blocks = supportedTextContent(event.content, this.countUnsupported.bind(this));
    if (this.initialPrompt !== undefined
      && blocks.length === 1
      && blocks[0]?.type === "text"
      && blocks[0].text === this.initialPrompt) {
      this.initialPrompt = undefined;
      return;
    }
    this.appendRequired("user/message", createUserMessage({
      content: blocks,
      source: { kind: "user" },
    }), "invariant", { surfaceOp: "append" });
  }

  private appendChunk(
    event: Extract<PiRunEvent, { type: "text-delta" | "reasoning-delta" }>,
    chunk: { type: "text-delta" | "reasoning-delta"; index: number; text: string },
  ): void {
    const turn = event.turn ?? this.currentTurn;
    const step = event.step ?? this.currentStep;
    const appended = this.appendRequired("assistant/chunk", {
      turn,
      step,
      chunk,
    }, "invariant");
    const key = this.stepKey(turn, step);
    const prior = this.chunkSeqs.get(key) ?? [];
    prior.push(appended.seq);
    this.chunkSeqs.set(key, prior);
  }

  private appendAssistant(event: Extract<PiRunEvent, { type: "assistant-message" }>): void {
    const provider = event.provider ?? this.input.model?.provider;
    const model = event.model ?? this.input.model?.model;
    if (provider === undefined || model === undefined || provider.length === 0 || model.length === 0) {
      const error = new Error("assistant message is missing exact Pi provider/model provenance");
      this.fail(error, "invariant", "assistant/message");
      throw error;
    }
    let content: ContentBlock[];
    try {
      content = assistantContent(event.content, this.countUnsupported.bind(this));
    } catch (error) {
      this.fail(error, "serialize", "assistant/message");
      throw error;
    }
    const message = createAssistantMessage({
      content,
      source: { provider, model },
    });
    const turn = event.turn ?? this.currentTurn;
    const step = event.step ?? this.currentStep;
    const key = event.messageId ?? this.stepKey(turn, step);
    const prior = this.assistantSeqs.get(key);
    const usage = event.usage ?? this.latestUsage.get(this.stepKey(turn, step));
    let fingerprint: string;
    let usageFingerprint: string | undefined;
    try {
      fingerprint = stableJson({ provider, model, content });
      usageFingerprint = usage === undefined ? undefined : stableJson(usage);
    } catch (error) {
      this.fail(error, "serialize", "assistant/message");
      throw error;
    }
    if (prior !== undefined && prior.fingerprint !== fingerprint) {
      const error = new Error("repeated assistant message disagrees with prior finalized content");
      this.fail(error, "invariant", "assistant/message");
      throw error;
    }
    if (prior !== undefined && prior.usageFingerprint === usageFingerprint) return;
    const sourceEventSeqs = this.chunkSeqs.get(this.stepKey(turn, step)) ?? [];
    const data = {
      turn,
      step,
      message,
      ...(usage === undefined ? {} : { usage }),
    };
    const appended = prior === undefined
      ? this.appendRequired("assistant/message", data, "invariant", { surfaceOp: "append", sourceEventSeqs })
      : this.appendRequired("assistant/message", data, "invariant", {
        surfaceOp: { op: "replace", start: prior.seq, end: prior.seq },
        sourceEventSeqs: [...sourceEventSeqs, prior.seq],
      });
    this.assistantSeqs.set(key, { seq: appended.seq, fingerprint, ...(usageFingerprint === undefined ? {} : { usageFingerprint }) });
    for (const block of message.content) {
      if (block.type !== "tool-call") continue;
      if (this.callSeqs.has(String(block.id))) continue;
      const call = this.appendRequired("tool/call", {
        turn,
        step,
        callId: block.id,
        name: block.name,
        arguments: block.arguments,
      }, "pairing");
      this.callSeqs.set(String(block.id), call.seq);
    }
  }

  private appendToolCall(event: Extract<PiRunEvent, { type: "tool-call" }>): void {
    if (this.callSeqs.has(event.callId)) return;
    const turn = event.turn ?? this.currentTurn;
    const step = event.step ?? this.currentStep;
    let argumentsJson: string;
    try {
      argumentsJson = normalizeArguments(event.arguments);
    } catch (error) {
      this.fail(error, "serialize", "tool/call");
      throw error;
    }
    const call = this.appendRequired("tool/call", {
      turn,
      step,
      callId: CallId(event.callId),
      name: event.name,
      arguments: argumentsJson,
    }, "pairing");
    this.callSeqs.set(event.callId, call.seq);
  }

  private appendToolResult(event: Extract<PiRunEvent, { type: "tool-result" }>): void {
    const callSeq = this.callSeqs.get(event.callId);
    if (callSeq === undefined) {
      const error = new Error("tool result has no matching call: " + event.callId);
      this.fail(error, "pairing", "tool/result");
      throw error;
    }
    const turn = event.turn ?? this.currentTurn;
    const step = event.step ?? this.currentStep;
    const content = supportedTextContent(event.content, this.countUnsupported.bind(this));
    const message = createToolResultMessage({
      callId: CallId(event.callId),
      content,
      isError: event.isError,
    });
    this.appendRequired("tool/result", {
      turn,
      step,
      message,
      ...(event.error === undefined ? {} : { error: event.error }),
    }, "pairing", { surfaceOp: "append", sourceEventSeqs: [callSeq] });
  }

  private appendRequired(
    type: string,
    data: unknown,
    _phase: ProjectionFailure["phase"],
    surface?: { surfaceOp: "append" | { op: "replace"; start: number; end: number }; sourceEventSeqs?: number[] },
  ): SessionEvent {
    if (this.ordinaryFrozen) throw new Error("projection is frozen after failure");
    const append = this.session.append.bind(this.session) as unknown as (type: string, data: unknown, surface?: unknown) => SessionEvent;
    try {
      const event = surface === undefined ? append(type, data) : append(type, data, surface);
      this.lastSeq = event.seq;
      return event;
    } catch (error) {
      // The official Session append boundary owns lossless JSON and surface
      // validation. Preserve that boundary as the failure phase; callers
      // classify pre-append serialization/pairing errors explicitly.
      this.fail(error, "append", type);
      throw error;
    }
  }

  private recoverTerminal(): void {
    try {
      const append = this.session.append as unknown as (type: string, data: unknown) => SessionEvent;
      if (this.stepOpen) {
        const event = append("step/end", { turn: this.currentTurn, step: this.currentStep });
        this.lastSeq = event.seq;
        this.stepOpen = false;
      }
      if (this.turnOpen) {
        const event = append("turn/end", {
          turn: this.currentTurn,
          reason: {
            kind: "error",
            error: { message: "Session Projection failed", code: "PROJECTION_FAILURE" },
          },
        });
        this.lastSeq = event.seq;
        this.turnOpen = false;
      }
    } catch (error) {
      this.fail(error, "recovery", "turn/end");
    }
  }

  private async flushOrFail(phase: ProjectionFailure["phase"] = "flush"): Promise<void> {
    try {
      const participated = await this.host.sessions.flush(this.session);
      if (participated === false) throw new Error("Session persistence did not participate in flush");
    } catch (error) {
      this.fail(error, phase, "session/flush");
    }
  }

  private fail(error: unknown, phase: ProjectionFailure["phase"], eventCategory?: string): void {
    if (this.failure !== undefined) return;
    this.ordinaryFrozen = true;
    this.failure = {
      error,
      phase,
      ...(eventCategory === undefined ? {} : { eventCategory }),
      lastSuccessfulSeq: this.lastSeq,
    };
    try {
      this.input.onProjectionFailure?.(this.failure);
    } catch {
      // Observability callbacks cannot change projection or Pi semantics.
    }
  }

  private countUnsupported(category: string): void {
    this.unsupported.set(category, (this.unsupported.get(category) ?? 0) + 1);
  }

  private stepKey(turn: number, step: number): string {
    return String(turn) + ":" + String(step);
  }
}

function toTurnEndReason(reason: PiStopReason, cancellation: AgentCancelCause | undefined): Record<string, unknown> {
  switch (reason) {
    case "stop":
      return { kind: "completed" };
    case "length":
      return { kind: "max-tokens" };
    case "aborted":
      return { kind: "aborted", reason: cancellation ?? { kind: "hook", reason: "pi-aborted" } };
    case "error":
    case "pending":
    case "toolUse":
    case "deferred":
      return { kind: "error", error: { message: "Pi stopped with " + reason, code: "PI_STOP" } };
  }
}

function assistantContent(content: readonly unknown[], countUnsupported: (category: string) => void): ContentBlock[] {
  const output: ContentBlock[] = [];
  for (const value of content) {
    if (!isRecord(value)) {
      countUnsupported("unknown");
      continue;
    }
    if (value.type === "text" && typeof value.text === "string") {
      output.push({ type: "text", text: value.text });
      continue;
    }
    if ((value.type === "thinking" || value.type === "reasoning") && typeof (value.thinking ?? value.text) === "string") {
      output.push({ type: "reasoning", text: (value.thinking ?? value.text) as string });
      continue;
    }
    if ((value.type === "toolCall" || value.type === "tool-call") && typeof value.id === "string" && typeof value.name === "string") {
      output.push({
        type: "tool-call",
        id: CallId(value.id),
        name: value.name,
        arguments: normalizeArguments(value.arguments),
      });
      continue;
    }
    countUnsupported(blockCategory(value));
  }
  return output;
}

function supportedTextContent(content: readonly unknown[], countUnsupported: (category: string) => void): ContentBlock[] {
  const output: ContentBlock[] = [];
  for (const value of content) {
    if (isRecord(value) && value.type === "text" && typeof value.text === "string") output.push({ type: "text", text: value.text });
    else countUnsupported(blockCategory(value));
  }
  return output;
}

function normalizeArguments(value: unknown): string {
  if (typeof value === "string") {
    try {
      JSON.parse(value);
    } catch {
      throw new TypeError("tool arguments are invalid JSON");
    }
    return value;
  }
  return stableJson(value);
}

function stableJson(value: unknown): string {
  const seen = new WeakSet<object>();
  const normalize = (candidate: unknown): unknown => {
    if (candidate === null || typeof candidate === "string" || typeof candidate === "boolean") return candidate;
    if (typeof candidate === "number") {
      if (!Number.isFinite(candidate) || Object.is(candidate, -0)) throw new TypeError("tool arguments are not lossless JSON");
      return candidate;
    }
    if (typeof candidate !== "object") throw new TypeError("tool arguments are not lossless JSON");
    if (seen.has(candidate)) throw new TypeError("tool arguments are circular");
    seen.add(candidate);
    if (Array.isArray(candidate)) {
      const output: unknown[] = [];
      for (let index = 0; index < candidate.length; index += 1) {
        if (!Object.prototype.hasOwnProperty.call(candidate, index)) {
          throw new TypeError("tool arguments contain a sparse array");
        }
        output.push(normalize(candidate[index]));
      }
      return output;
    }
    const prototype = Object.getPrototypeOf(candidate);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError("tool arguments are not plain JSON records");
    }
    const record = candidate as Record<string, unknown>;
    const output: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) output[key] = normalize(record[key]);
    return output;
  };
  const serialized = JSON.stringify(normalize(value));
  if (serialized === undefined) throw new TypeError("tool arguments are not lossless JSON");
  return serialized;
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null;
}

function blockCategory(value: unknown): string {
  return isRecord(value) && typeof value.type === "string" ? value.type : "unknown";
}
