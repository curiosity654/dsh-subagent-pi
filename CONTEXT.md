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
The standard DSH surfaces through which a Pi Child Run is observed. Version 0.1 exposed only a foreground tool result or background Job; version 0.2 adds the official child Session and Subagent Catalog without replacing either result path.
_Avoid_: Custom Pi UI, private result channel, Pi trajectory

**Projection Agent**:
A DSH Agent that shares a Session-backed Pi child's identity and exposes its official registry status while Pi remains the Execution Authority. It projects observation and forwards cancellation but never runs a DSH model loop or supplies execution policy.
_Avoid_: Pi Agent, mirror Agent, second execution Agent

**Session Projection**:
The official DSH Session log that records the subset of Pi Child Run events with exact DSH semantics. It is durable observation state and never Pi conversation state or execution input.
_Avoid_: Mirrored Pi history, execution checkpoint, approximate transcript

**Published Pi Child**:
A Pi Child Run whose native setup has succeeded and whose same-identity DSH Session and Projection Agent have been announced before the first Pi prompt. Before this boundary, failure rolls back without exposing a child identity.
_Avoid_: Starting run, reserved Session, Catalog placeholder

**Child Session Identity**:
The stable DSH identifier shared by a Published Pi Child's Session, Projection Agent, and Delegation Result handle. It is distinct from DSH lifecycle, background Job, and Pi-native runtime identities.
_Avoid_: Run id, Job id, Pi session id

**Projection Failure**:
An infrastructure failure that prevents a Published Pi Child from producing an exact durable Session Projection. It does not redefine or control the Pi execution outcome, but the delegation cannot be reported as successful.
_Avoid_: Pi error, transcript warning, successful degradation

**Cancellation Provenance**:
The first durable DSH cause that requests termination of a Pi Child Run. Later cancellation requests may help quiesce the run but never replace that recorded cause.
_Avoid_: Last cancellation, generic abort flag, Pi stop reason

**Depth Admission**:
The DSH lineage check performed before Pi starts by resolving the requested child depth against `maxDepth`. It limits which DSH Supervisor may launch the run; it does not transfer a recursive budget into Pi.
_Avoid_: Pi recursion limit, provider-managed depth

**Audit Diagnostics**:
Redacted operational records of child and parent identity, Workspace, resolved selection, projection health, terminal outcome, and cleanup. They never duplicate the contentful Session Projection or claim lifecycle, Job, or Pi-native identities.
_Avoid_: Transcript copy, tool trace, lifecycle metadata

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

**Compatibility Baseline**:
The exact DSH, Pi, and Node runtime contract against which a release is designed and verified. It distinguishes a supported launcher environment from merely installed package versions.
_Avoid_: Latest versions, install success, dependency pins

**Session Parity Gate**:
The evidence chain for Session-backed parity: Pi event fixtures, official DSH Session and persistence contracts, provider and v1 regressions, and an authenticated supported-Node UI and restart smoke. No single automated or visual check substitutes for the whole chain.
_Avoid_: Unit-test completion, build success, UI screenshot

**Live Smoke Gate**:
The local rc.7 verification performed after automated tests and linked-bundle preflight: foreground completion, background completion and cancellation, approved Workspace trust taking effect on the next run, and clean plugin unload.
_Avoid_: Unit-test completion, npm publication, remote Harness validation
