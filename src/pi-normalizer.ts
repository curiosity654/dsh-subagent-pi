import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";

import type { TokenUsage } from "@deepseek-ai/dsh-llm";

import type { PiRunEvent, PiStopReason } from "./pi-session.js";

export interface PiNormalizerState {
  turn: number;
  step: number;
  turnStarted?: boolean;
  stepClosed?: boolean;
  awaitingNextStep?: boolean;
  readonly seenToolResults: Set<string>;
}

/** Stateful adapter object used by one Pi session subscription. */
export class PiEventNormalizer {
  readonly state: PiNormalizerState = {
    turn: 1,
    step: 1,
    turnStarted: false,
    stepClosed: false,
    awaitingNextStep: false,
    seenToolResults: new Set(),
  };

  normalize(event: AgentSessionEvent): PiRunEvent[] {
    return normalizePiEvent(event, this.state);
  }
}

export function createPiNormalizer(): {
  readonly state: PiNormalizerState;
  normalize(event: AgentSessionEvent): PiRunEvent[];
} {
  const normalizer = new PiEventNormalizer();
  return {
    state: normalizer.state,
    normalize: event => normalizer.normalize(event),
  };
}

/**
 * Normalize Pi callbacks in native callback order. The output is intentionally
 * semantic: result folding and Session projection consume the same events.
 */
export function normalizePiEvent(event: AgentSessionEvent, state: PiNormalizerState): PiRunEvent[] {
  const value = event as unknown as Record<string, any>;
  switch (value.type) {
    case "turn_start": {
      if (state.turnStarted !== true) {
        state.turnStarted = true;
        state.turn = 1;
        state.step = 1;
        state.stepClosed = false;
        return [
          { type: "turn-start", turn: state.turn },
          { type: "step-start", turn: state.turn, step: state.step },
        ];
      }
      // A one-shot delegation owns exactly one DSH turn. Pi may emit another
      // native turn boundary while retrying/continuing internally; represent
      // that cycle as the next DSH step instead of opening a second turn.
      const previousStep = state.step;
      state.awaitingNextStep = false;
      state.step += 1;
      const events: PiRunEvent[] = [];
      if (state.stepClosed !== true) events.push({ type: "step-end", turn: state.turn, step: previousStep });
      state.stepClosed = false;
      events.push({ type: "step-start", turn: state.turn, step: state.step });
      return events;
    }
    case "turn_end": {
      if (state.stepClosed === true) return [];
      state.stepClosed = true;
      return [{ type: "step-end", turn: state.turn, step: state.step }];
    }
    case "message_start":
      if (value.message?.role === "assistant" && state.awaitingNextStep) {
        state.awaitingNextStep = false;
        state.step += 1;
        const events: PiRunEvent[] = [];
        if (state.stepClosed !== true) events.push({ type: "step-end", turn: state.turn, step: state.step - 1 });
        state.stepClosed = false;
        events.push({ type: "step-start", turn: state.turn, step: state.step });
        return events;
      }
      // message_end is the finalized-message authority. The start callback
      // is intentionally only used for step topology.
      return [];
    case "message_update":
      return normalizeMessageUpdate(value, state);
    case "message_end":
      return normalizeMessageEnd(value, state);
    case "tool_execution_end": {
      return [];
    }
    case "agent_end": {
      // agent_end.messages is a summary of already-finalized messages. It is
      // consistency evidence only and must never append a second transcript.
      return [];
    }
    case "agent_settled": {
      return [];
    }
    default:
      return [];
  }
}

function normalizeMessageUpdate(value: Record<string, any>, state: PiNormalizerState): PiRunEvent[] {
  const update = value.assistantMessageEvent as Record<string, any> | undefined;
  if (update === undefined) return [];
  const usage = update.partial?.usage === undefined
    ? []
    : [{ type: "usage" as const, turn: state.turn, step: state.step, usage: toTokenUsage(update.partial.usage) }];
  switch (update.type) {
    case "text_delta":
      return [...usage, { type: "text-delta", turn: state.turn, step: state.step, text: update.delta ?? "" }];
    case "thinking_delta":
      return [...usage, { type: "reasoning-delta", turn: state.turn, step: state.step, text: update.delta ?? "" }];
    case "done": {
      const events: PiRunEvent[] = [...usage];
      const stopReason = toStopReason(update.reason);
      if (stopReason === "toolUse") state.awaitingNextStep = true;
      if (stopReason !== undefined && stopReason !== "toolUse") events.push({ type: "terminal", reason: stopReason });
      return events;
    }
    case "error": {
      const events: PiRunEvent[] = [...usage];
      const stopReason = toStopReason(update.reason) ?? "error";
      events.push({ type: "terminal", reason: stopReason });
      return events;
    }
    default:
      return [];
  }
}

function normalizeMessageEnd(value: Record<string, any>, state: PiNormalizerState): PiRunEvent[] {
  const message = value.message as Record<string, any> | undefined;
  if (message === undefined) return [];
  if (message.role === "user") {
    return [{
      type: "user-message",
      turn: state.turn,
      step: state.step,
      content: contentArray(message.content),
    }];
  }
  if (message.role === "toolResult") {
    const callId = String(message.toolCallId ?? "");
    if (callId.length === 0 || state.seenToolResults.has(callId)) return [];
    state.seenToolResults.add(callId);
    return [toolResultEvent(message, state)];
  }
  if (message.role !== "assistant") return [];
  const events: PiRunEvent[] = [assistantEvent(message, state)];
  const stopReason = toStopReason(message.stopReason);
  if (stopReason === "toolUse") state.awaitingNextStep = true;
  if (stopReason !== undefined && stopReason !== "toolUse") events.push({ type: "terminal", reason: stopReason });
  return events;
}

function toolResultEvent(message: Record<string, any>, state: PiNormalizerState): PiRunEvent {
  return {
    type: "tool-result",
    turn: state.turn,
    step: state.step,
    callId: String(message.toolCallId ?? ""),
    content: contentArray(message.content),
    isError: message.isError === true,
  };
}

function assistantEvent(message: Record<string, any>, state: PiNormalizerState): PiRunEvent {
  return {
    type: "assistant-message",
    turn: state.turn,
    step: state.step,
    content: contentArray(message?.content),
    ...(typeof message?.id === "string" ? { messageId: message.id } : {}),
    ...(typeof message?.provider === "string" ? { provider: message.provider } : {}),
    ...(typeof message?.model === "string" ? { model: message.model } : {}),
    ...(message?.usage === undefined ? {} : { usage: toTokenUsage(message.usage) }),
  };
}

function contentArray(value: unknown): readonly unknown[] {
  return typeof value === "string" ? [{ type: "text", text: value }] : Array.isArray(value) ? value : [];
}

function toTokenUsage(value: Record<string, unknown>): TokenUsage {
  return {
    inputTokens: numberOrZero(value.input),
    outputTokens: numberOrZero(value.output),
    ...(value.cacheRead === undefined ? {} : { cacheReadTokens: numberOrZero(value.cacheRead) }),
    ...(value.cacheWrite === undefined ? {} : { cacheWriteTokens: numberOrZero(value.cacheWrite) }),
    ...(value.reasoning === undefined ? {} : { reasoningTokens: numberOrZero(value.reasoning) }),
  };
}

function numberOrZero(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function toStopReason(value: unknown): PiStopReason | undefined {
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
