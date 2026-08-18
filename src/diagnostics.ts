import type { DefaultModel, ThinkingLevel } from "./config.js";
import type { PiStopReason } from "./pi-session.js";

export type ModelSelectionSource = "request" | "plugin-config" | "pi-settings" | "authenticated-fallback";
export type ThinkingSelectionSource = "plugin-config" | "pi-settings" | "default-medium";

/**
 * Redacted run diagnostics. Prompt text, assistant output, credentials, and
 * private Pi settings are deliberately absent from this public audit shape.
 */
export interface PiRunDiagnostic {
  readonly event: "start" | "end";
  readonly runId: string;
  readonly parentId: string;
  readonly workspace: string;
  readonly trusted: boolean;
  readonly model?: DefaultModel;
  readonly modelSource: ModelSelectionSource;
  readonly thinking?: ThinkingLevel;
  readonly thinkingSource: ThinkingSelectionSource;
  readonly thinkingClamped?: boolean;
  readonly stopReason?: PiStopReason;
  readonly durationMs?: number;
  readonly cleanup?: "pending" | "complete" | "error";
}

export type PiDiagnosticSink = (diagnostic: PiRunDiagnostic) => void;
