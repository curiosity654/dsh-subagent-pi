# Pi Subagent

This context defines how DeepSeek Harness delegates bounded work to Pi while keeping supervision and native execution authority separate.

## Language

**DSH Supervisor**:
The parent DeepSeek Harness Agent that admits, observes, and collects delegated work while retaining orchestration ownership.
_Avoid_: DSH main Agent, controller

**Pi Child Run**:
A bounded, terminal Pi execution created from one standalone delegation by the DSH Supervisor.
_Avoid_: Pi child session, Pi worker session, continuable subagent

**Workspace**:
The project directory inherited from the DSH Supervisor's session and used to scope a Pi Child Run.
_Avoid_: Working directory override, Harness process directory

**Execution Authority**:
The runtime whose native capabilities and policies govern work inside a child run. Pi is the Execution Authority for a Pi Child Run.
_Avoid_: Inherited DSH policy, shared sandbox

**Delegation Result**:
The terminal outcome and available assistant output returned from a Pi Child Run to the DSH Supervisor.
_Avoid_: Child transcript, continued conversation

**Delegation Surface**:
The standard DSH surface through which a Pi Child Run is observed: a tool result for foreground work or a Job for background work. A Pi Child Run does not create a DSH child Session or Subagent Catalog entry in v1.
_Avoid_: Pi Session row, mirrored child transcript, Pi trajectory

**Depth Admission**:
The DSH lineage check performed before Pi starts by resolving the requested child depth against `maxDepth`. It limits which DSH Supervisor may launch the run; it does not transfer a recursive budget into Pi.
_Avoid_: Pi recursion limit, provider-managed depth

**Audit Diagnostics**:
Redacted structured records of run identity, Workspace, resolved model and Thinking, and their resolution sources. They are the v1 audit surface for data that DSH lifecycle events and the Subagent Catalog do not carry.
_Avoid_: Lifecycle metadata, model badge, reasoning transcript

**Workspace Trust**:
Pi's persisted trust decision for the exact Workspace. A Pi Child Run follows an existing native decision and otherwise runs untrusted; only the separate `pi_trust_project` tool may request user-approved persistence of trust.
_Avoid_: SDK default trust, implicit trust, per-run trust override

**Native Runtime Setup**:
The per-run Pi print-mode construction sequence that loads Pi services and model providers, freezes model and Thinking, creates an in-memory session, binds extensions, subscribes to events, and finally submits the prompt.
_Avoid_: Minimal SDK shortcut, persistent child history, emulated interactive mode

**Resolved Selection**:
The provider, model, and Thinking values frozen before a Pi Child Run is published. Model comes from request `agentOptions` or Pi-native fallback; Thinking comes from the plugin override or Pi-native settings and normalization.
_Avoid_: Main-Agent model choice, dynamic per-call selector, mutable global model

**Run Capacity**:
The plugin-wide number of Pi Child Runs admitted from setup through final disposal. V1 admits at most four by default and rejects overflow before publication rather than queueing it.
_Avoid_: Job queue, background-only limit, unbounded foreground fan-out

**Terminal Quiescence**:
The state reached after Pi has stopped producing work, its event listeners are detached, and its session resources are disposed. Cancellation and plugin unload wait for this state rather than treating a timeout as successful cleanup.
_Avoid_: Result settlement, lifecycle end event, best-effort disposal

**Plugin Configuration**:
The standard DSH settings namespace containing only an optional fixed provider/model pair, an optional Thinking override, and the positive `maxConcurrentRuns` limit. It is not a per-delegation model catalog.
_Avoid_: Separate config file, browser model selector, provider fallback layer

**Live Smoke Gate**:
The local rc.7 verification performed after automated tests and linked-bundle preflight: foreground completion, background completion and cancellation, approved Workspace trust taking effect on the next run, and clean plugin unload.
_Avoid_: Unit-test completion, npm publication, remote Harness validation
