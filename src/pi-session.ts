import type { ContentBlock } from "@deepseek-ai/dsh-llm";

import type { DefaultModel, ThinkingLevel } from "./config.js";
import type { ModelSelectionSource, ThinkingSelectionSource } from "./diagnostics.js";

export type PiStopReason = "stop" | "length" | "aborted" | "error" | "pending" | "toolUse" | "deferred";

export type PiSessionEvent =
  | { type: "text-delta"; text: string }
  | { type: "assistant-message"; content: ContentBlock[] }
  | { type: "terminal"; reason: PiStopReason };

export interface PiSession {
  readonly model?: DefaultModel;
  readonly modelSource?: ModelSelectionSource;
  readonly thinkingLevel: ThinkingLevel;
  readonly thinkingSource?: ThinkingSelectionSource;
  readonly thinkingClamped?: boolean;
  readonly availableThinkingLevels: readonly ThinkingLevel[];
  readonly isIdle?: boolean;
  subscribe(listener: (event: PiSessionEvent) => void): () => void;
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
