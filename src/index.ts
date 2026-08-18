import type { Context } from "@deepseek-ai/cordis";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { apply as applyToolSubagent } from "@deepseek-ai/dsh-tool-subagent";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { installSettingsSection, settingsNamespace } from "@deepseek-ai/dsh-settings";

import { Config, normalizeConfig, type PluginConfig } from "./config.js";
import { createProjectTrustResolver, SdkPiSessionFactory } from "./sdk-factory.js";
import { createPiProvider } from "./provider.js";
import { trustProject } from "./trust.js";

export { Config, normalizeConfig } from "./config.js";
export { createPiProvider } from "./provider.js";
export { SdkPiSessionFactory, createProjectTrustResolver } from "./sdk-factory.js";
export { canonicalWorkspace } from "./workspace.js";
export { trustProject } from "./trust.js";
export type { PluginConfig } from "./config.js";

export const name = "dsh-subagent-pi";
export const inject = ["subagents", "tools"];

const SETTINGS_NAMESPACE = settingsNamespace("subagent-pi");

export function apply(ctx: Context, config: PluginConfig): void {
  const normalized = normalizeConfig(config);
  let currentSource: () => PluginConfig = () => normalized;
  const currentConfig = (): PluginConfig => normalizeConfig(currentSource());
  // Resolve Pi's native agent directory once for the plugin lifetime. Every
  // child then shares one native ProjectTrustStore while each session remains
  // in-memory and disposable.
  const agentDir = getAgentDir();
  const trust = createProjectTrustResolver(agentDir);
  const provider = createPiProvider({
    factory: new SdkPiSessionFactory(agentDir),
    config: currentConfig,
    agentDir,
    resolveTrust: trust.resolve,
    onDiagnostic: diagnostic => {
      ctx.logger.debug("pi-subagent diagnostic: %s", JSON.stringify(diagnostic));
    },
  });
  ctx.subagents.registerProvider(provider);
  ctx.effect(() => async () => {
    await provider.shutdown();
  }, "pi-subagent provider shutdown");

  applyToolSubagent(ctx, {
    provider: "pi",
    toolName: "pi_subagent",
    enableRunInBackground: true,
    backgroundMode: "one-shot",
    maxDepth: 3,
  });

  ctx.tools.register(defineTool({
    name: "pi_trust_project",
    description: "Persist Pi project trust for the exact top-level Workspace after approval. A saved false decision is explicitly disclosed before overwrite.",
    parameters: {
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          workspace: { type: "string", required: true },
          trusted: { type: "boolean", required: true, const: true },
          changed: { type: "boolean", required: true },
        },
      },
      render: (_args, value) => {
        const result = value as { workspace: string; trusted: boolean; changed: boolean };
        return [{
          type: "text",
          text: result.changed
            ? `Pi project trust saved for ${result.workspace}`
            : `Pi project trust already enabled for ${result.workspace}`,
        }];
      },
    },
    async execute(_args, exec) {
      const parent = exec.agent;
      if (parent === undefined) throw new Error("pi_trust_project requires a calling agent");
      const approval = ctx.get("approval");
      return trustProject({
        parent,
        store: trust.store,
        ...(approval === undefined ? {} : { approval }),
        callId: exec.callId,
        signal: exec.signal,
      });
    },
  }));

  installSettingsSection(ctx, SETTINGS_NAMESPACE, Config, normalized, {
    setSource: source => {
      currentSource = source;
    },
    validate: value => {
      normalizeConfig(value);
    },
    onChange: () => {
      // `currentConfig()` reads the resolved namespace for every admitted run,
      // so model, Thinking, and capacity changes are applied to later runs.
      void currentConfig();
    },
  });
}

export default { name, inject, Config, apply };
