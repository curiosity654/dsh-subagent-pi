# dsh-subagent-pi

`dsh-subagent-pi` is an experimental community plugin that registers [Pi](https://github.com/earendil-works/pi) as a native, Session-backed one-shot `SubagentProvider` for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH).

Each delegation runs in a fresh in-memory Pi session while a durable DSH child Session exposes the supported transcript, hierarchy, activity, token usage, and duration through the standard Subagent UI. Pi remains the sole execution authority; the DSH Session is an observation and navigation projection, not Pi conversation state.

Version 0.2 is pre-1.0 software pinned to developer-preview dependencies. It is useful for bounded one-shot delegation, but it is not a general workflow runner or a hardened remote-research execution environment.

## What it provides

- Provider `pi` for foreground work and standard one-shot background Jobs through `pi_subagent`.
- A real DSH child Session that remains inspectable after completion and host restart.
- Projection of supported Pi user, assistant, reasoning, tool, usage, and terminal events into official DSH Session events.
- Approval-gated exact-Workspace trust persistence through the separate top-level `pi_trust_project` tool.
- Explicit model, Thinking, cancellation, concurrency, cleanup, and diagnostic boundaries.

## Compatibility

Version 0.2 targets this exact baseline:

| Component | Supported version |
| --- | --- |
| DSH | `0.1.0-rc.7` |
| Pi coding agent and Pi AI | `0.84.2` |
| Node.js | `>=22.19.0` |

The DSH profile must provide the rc.7 Session, Agent, Session persistence, and Session projection services. Pi authentication and model configuration must already work for the account running DSH. Activation fails instead of silently degrading to a Sessionless provider when required services are missing.

## Security and data model

- Pi is the execution authority. DSH tool filters, approval policy, sandbox, prompts, skills, and compaction are not inherited by Pi Child Runs.
- `pi_trust_project` approves only persistent trust for the calling top-level DSH Workspace. It is not an approval gate for every Pi tool call.
- An untrusted run may still load Pi global and user resources; trust controls protected project-local settings, extensions, skills, and related resources.
- Tool permissions, approval gates, MCP, and sandboxing exist only when loaded Pi extensions provide them. Review the effective Pi configuration before delegating work in a sensitive Workspace.
- Pi runs in-process with DSH. Version 0.2 has no hard execution or teardown timeout and cannot force-terminate an isolated worker. A stuck native tool may delay cancellation, unload, and capacity release until Pi becomes idle.
- `maxConcurrentRuns` limits admitted Pi runs; it does not cap CPU, memory, I/O, recursive scan size, or external side effects.
- Supported Pi transcript content is persisted through the host's normal DSH Session retention and persistence policy. Separately, this plugin's Audit Diagnostics remain content-free: they do not duplicate prompts, assistant/reasoning text, tool arguments/results, credentials, or raw settings.

Use the plugin only in Workspaces and Pi environments whose native execution policy you understand. Add a Pi approval or sandbox extension when the task requires stronger enforcement.

## Install

Install the published package into a DSH profile:

```sh
dsh plugin --profile web add dsh-subagent-pi@0.2.0
dsh --profile web --dump-config
```

For development, clone and link the checkout instead:

```sh
git clone https://github.com/curiosity654/dsh-subagent-pi.git
cd dsh-subagent-pi
npm ci
npm run check
dsh plugin --profile web add "link:$PWD"
dsh --profile web --dump-config
```

The package declares its own `dsh.bundle` patch, so profile reconciliation adds the `subagent-pi` row. Restart any long-running DSH host after adding, updating, or removing the plugin.

## Configuration

The plugin owns the standard `subagent-pi` settings namespace:

```yaml
subagent-pi:
  # defaultModel:
  #   provider: <provider-id>
  #   model: <model-id>
  thinking: medium
  maxConcurrentRuns: 4
```

`defaultModel` is an optional fixed provider/model pair. `thinking` is an optional Pi Thinking override. `maxConcurrentRuns` is a positive safe integer with a default of `4`. Settings changes apply only to later runs.

Each run inherits the parent Session's canonical Workspace. Pi resolves native tools, extensions, authentication, model fallback, and trusted resources inside a fresh print-mode session.

## Usage

Ask the DSH Supervisor to delegate a bounded, self-contained task. For example:

```text
Use the pi_subagent tool to inspect this Workspace and summarize its test structure. Perform read-only operations only.
```

The child appears in the standard DSH Subagent Catalog while it runs. Its Session remains read-only after completion. Use the standard `run_in_background` option when the task should be represented as a DSH background Job.

When a project-local Pi extension or skill is intentionally required, ask the top-level DSH Supervisor to invoke `pi_trust_project`. The approved trust decision affects later Pi runs, never a run that is already active.

## Limitations

- Pi children are one-shot. Follow-up, steering, continuation, and cold resume of Pi conversation state are unsupported.
- Delegation input is text-only. Output schemas, provider-side tool filtering, personas, and per-call `maxTokens` are unsupported.
- There is no Pi-specific UI, remote worker transport, workflow engine, internal queue, or hard resource budget.
- Pi extensions that require an interactive UI follow their native print-mode behavior; this plugin does not emulate one.
- Session Projection intentionally omits Pi-only data that has no exact official DSH representation.

See [ROADMAP.md](./ROADMAP.md) for planned capability work.

## Development and verification

Run the automated gate with:

```sh
npm ci
npm run check
```

`npm run check` runs TypeScript checking, the Vitest suite, and the production build. Release verification additionally requires an authenticated linked DSH smoke covering foreground and background work, cancellation, Workspace trust, clean unload, and persisted Session history after restart.

The version 0.2 implementation follows [GitHub Issue #2](https://github.com/curiosity654/dsh-subagent-pi/issues/2). Domain terminology and architecture decisions are recorded in [CONTEXT.md](./CONTEXT.md) and [docs/adr](./docs/adr/).

## Removal

```sh
dsh plugin --profile web remove dsh-subagent-pi
```

Restart a running DSH host after removal.

## License

[MIT](./LICENSE)
