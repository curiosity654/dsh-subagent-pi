# dsh-subagent-pi

`dsh-subagent-pi` is a standalone DeepSeek Harness plugin that registers Pi as a native one-shot `SubagentProvider`.

The first version targets DSH `0.1.0-rc.7` and Pi `0.84.1`. Its scope is foreground and standard background delegation, explicit Workspace trust, deterministic model and Thinking resolution, and clean in-process cancellation and disposal. Continuable children, custom subagent visualization, remote workers, workflows, and npm publication are outside V1.

The implementation follows [GitHub Issue #1](https://github.com/curiosity654/dsh-subagent-pi/issues/1). Domain terminology and architectural decisions live in [CONTEXT.md](./CONTEXT.md) and [docs/adr](./docs/adr/).

## Current status

- DSH CLI: `0.1.0-rc.7`; Pi coding agent: `0.84.1`.
- Provider name: `pi` with `depthLimit` only; continuable children are deliberately unsupported.
- Model-facing tools: `pi_subagent` (foreground or standard one-shot background Jobs) and `pi_trust_project` (top-level approval-gated trust persistence).
- Automated gate: `npm run check`.

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

`defaultModel` is an optional fixed provider/model pair. `thinking` is an optional Pi Thinking override, and `maxConcurrentRuns` is a positive safe integer (default `4`). Settings changes apply to later runs. A run inherits only the parent session's canonical Workspace; Pi resolves its native tools, extensions, authentication, and model fallbacks inside a fresh in-memory print-mode session.

## Linked development install

Build the package, then add the checkout as a linked profile bundle:

```sh
npm install
npm run check
dsh plugin --profile web add "link:$PWD"
dsh --profile web --dump-config
```

The package declares its own `dsh.bundle` patch, so profile reconciliation adds the `subagent-pi` row. Remove it with `dsh plugin --profile web remove dsh-subagent-pi` when the smoke run is complete. The linked profile must provide the DSH rc.7 core services and Pi credentials; no credentials or prompt/output text are written by this plugin's diagnostics.
