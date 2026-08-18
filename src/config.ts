import z from "@deepseek-ai/schemastery";

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

export interface DefaultModel {
  provider: string;
  model: string;
}

export interface PluginConfig {
  defaultModel?: DefaultModel;
  thinking?: ThinkingLevel;
  maxConcurrentRuns: number;
}

export const Config = z.object({
  defaultModel: z.object({
    provider: z.string().min(1),
    model: z.string().min(1),
  }).default(undefined as never),
  thinking: z.union(THINKING_LEVELS).default(undefined as never),
  maxConcurrentRuns: z.natural().min(1).max(Number.MAX_SAFE_INTEGER).step(1).default(4),
}) as unknown as z<PluginConfig>;

export function normalizeConfig(input: {
  defaultModel?: Partial<DefaultModel>;
  thinking?: ThinkingLevel;
  maxConcurrentRuns?: number;
} = {}): PluginConfig {
  const defaultModel = input.defaultModel;
  if (defaultModel !== undefined) {
    const provider = defaultModel.provider;
    const model = defaultModel.model;
    if (typeof provider !== "string" || provider.trim().length === 0
      || typeof model !== "string" || model.trim().length === 0) {
      throw new Error("defaultModel.provider and defaultModel.model must be provided together");
    }
  }

  const maxConcurrentRuns = input.maxConcurrentRuns ?? 4;
  if (!Number.isSafeInteger(maxConcurrentRuns) || maxConcurrentRuns < 1) {
    throw new Error("maxConcurrentRuns must be a positive safe integer");
  }
  if (input.thinking !== undefined && !THINKING_LEVELS.includes(input.thinking)) {
    throw new Error(`unsupported Thinking level: ${String(input.thinking)}`);
  }

  return {
    ...(defaultModel === undefined ? {} : {
      defaultModel: {
        provider: defaultModel.provider!.trim(),
        model: defaultModel.model!.trim(),
      },
    }),
    ...(input.thinking === undefined ? {} : { thinking: input.thinking }),
    maxConcurrentRuns,
  };
}
