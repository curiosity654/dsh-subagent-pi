# dsh-subagent-pi

`dsh-subagent-pi` is a standalone DeepSeek Harness plugin that registers Pi as a native, Session-backed one-shot `SubagentProvider`.

Version 0.2 targets DSH `0.1.0-rc.7`, Pi `0.84.2`, and Node `>=22.19.0`. Each published delegation owns one durable DSH child Session and same-identity read-only Projection Agent while Pi remains the sole execution authority. Continuation, custom subagent visualization, remote workers, workflows, and npm publication remain out of scope.

The implementation follows [GitHub Issue #2](https://github.com/curiosity654/dsh-subagent-pi/issues/2). Product direction is recorded in [ROADMAP.md](./ROADMAP.md), while domain terminology and architectural decisions live in [CONTEXT.md](./CONTEXT.md) and [docs/adr](./docs/adr/).

## Current status

 - DSH CLI: `0.1.0-rc.7`; Pi coding agent: `0.84.2`.
- Provider name: `pi` with `depthLimit` only; continuable children are deliberately unsupported.
- Model-facing tools: `pi_subagent` (foreground or standard one-shot background Jobs) and `pi_trust_project` (top-level approval-gated trust persistence).
 - Automated gate: `npm run check` (typecheck, tests, and build).

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

The package declares its own `dsh.bundle` patch, so profile reconciliation adds the `subagent-pi` row. Remove it with `dsh plugin --profile web remove dsh-subagent-pi` when the smoke run is complete. The linked profile must provide the DSH rc.7 Session, Agent, persistence, and projection services plus Pi credentials; activation fails rather than degrading to Sessionless behavior. No credentials or prompt/output text are written by this plugin's diagnostics.
