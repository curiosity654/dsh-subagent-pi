# Require explicit approval for persistent Workspace trust

A Pi Child Run follows a trust decision already stored by Pi for its exact Workspace. When no decision exists, it runs untrusted and does not prompt, silently elevate, or persist a new decision. The DSH Supervisor may instead invoke the separate `pi_trust_project` tool, which must obtain user approval before writing trust to Pi's native trust store. `pi_subagent` never modifies that store.

This keeps unattended foreground and background delegation safe while preserving an explicit path to enable Workspace-scoped Pi settings, extensions, skills, and other protected project resources. Trust mutation remains visibly separate from task execution and is auditable as an approved DSH tool action.

`pi_trust_project` accepts no path argument and operates only on the calling top-level DSH Supervisor's canonical Workspace. An exact saved `true` is idempotent; inherited trust still requires approval before an exact Workspace entry is written, and an existing `false` may be overwritten only when the approval reason says so. DSH's `allowed-once` outcome authorizes the single native trust-store write; every other outcome fails closed. The decision affects later Pi Child Runs, never a run whose trust was already frozen.
