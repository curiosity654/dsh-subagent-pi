# dsh-subagent-pi

`dsh-subagent-pi` is a standalone DeepSeek Harness plugin that will register Pi as a native one-shot `SubagentProvider`.

The first version targets DSH `0.1.0-rc.7` and Pi `0.84.1`. Its scope is foreground and standard background delegation, explicit Workspace trust, deterministic model and Thinking resolution, and clean in-process cancellation and disposal. Continuable children, custom subagent visualization, remote workers, workflows, and npm publication are outside V1.

Implementation has not started. The agreed contract is tracked in [GitHub Issue #1](https://github.com/curiosity654/dsh-subagent-pi/issues/1). Domain terminology and architectural decisions live in [CONTEXT.md](./CONTEXT.md) and [docs/adr](./docs/adr/).

## Current status

- V1 contract aligned against the locally installed DSH rc.7 packages.
- Provider name: `pi`.
- Model-facing tools: `pi_subagent` and `pi_trust_project`.
- Next step: implement Issue #1 test-first and pass the linked local smoke gates.
