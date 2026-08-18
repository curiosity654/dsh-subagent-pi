import type { ContentBlock, TokenUsage } from "@deepseek-ai/dsh-llm";

import type { DefaultModel, ThinkingLevel } from "./config.js";
import type { ModelSelectionSource, ThinkingSelectionSource } from "./diagnostics.js";

export type PiStopReason = "stop" | "length" | "aborted" | "error" | "pending" | "toolUse" | "deferred";

/**
 * The normalized, provider-neutral event stream owned by the Pi adapter.
 *
 * A single stream is consumed by both result folding and Session projection;
 * neither consumer interprets Pi-native callbacks independently.  `content`
 * is intentionally unknown at this seam because Pi tool results can contain
 * image/private blocks that the DSH projection must omit and count.
 */
export type PiRunEvent =
  | { type: "turn-start"; turn?: number }
  | { type: "turn-end"; turn?: number }
  | { type: "step-start"; turn?: number; step?: number }
  | { type: "step-end"; turn?: number; step?: number }
  | { type: "user-message"; turn?: number; step?: number; content: readonly unknown[] }
  | { type: "text-delta"; turn?: number; step?: number; text: string }
  | { type: "reasoning-delta"; turn?: number; step?: number; text: string }
  | {
    type: "assistant-message";
    turn?: number;
    step?: number;
    content: readonly unknown[];
    messageId?: string;
    provider?: string;
    model?: string;
    usage?: TokenUsage;
  }
  | {
    type: "tool-call";
    turn?: number;
    step?: number;
    callId: string;
    name: string;
    arguments: unknown;
  }
  | {
    type: "tool-result";
    turn?: number;
    step?: number;
    callId: string;
    content: readonly unknown[];
    isError: boolean;
    error?: { name: string; code: string };
  }
  | { type: "usage"; turn?: number; step?: number; usage: TokenUsage }
  | { type: "unsupported"; category: string }
  | { type: "terminal"; reason: PiStopReason };

/** Backwards-compatible name for the public session subscription seam. */
export type PiSessionEvent = PiRunEvent;

export interface PiSession {
  readonly model?: DefaultModel;
  readonly modelSource?: ModelSelectionSource;
  readonly thinkingLevel: ThinkingLevel;
  readonly thinkingSource?: ThinkingSelectionSource;
  readonly thinkingClamped?: boolean;
  readonly availableThinkingLevels: readonly ThinkingLevel[];
  readonly isIdle?: boolean;
  subscribe(listener: (event: PiRunEvent) => void): () => void;
  prompt(prompt: string): Promise<void>;
  abort(): Promise<void>;
  waitForIdle(): Promise<void>;
  dispose(): void;
}

export interface PiSessionStartInput {
  readonly cwd: string;
  readonly agentDir: string;
  readonly trusted: boolean;
  readonly model?: DefaultModel;
  readonly modelSource?: ModelSelectionSource;
  readonly thinking?: ThinkingLevel;
}

export interface PiSessionFactory {
  start(input: PiSessionStartInput): Promise<PiSession>;
}
