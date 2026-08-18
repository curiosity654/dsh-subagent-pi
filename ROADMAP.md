# Roadmap

## North star

Make Pi a first-class DeepSeek Harness subagent provider with the same official, Session-backed experience expected from DSH's Codex-style subagents, while keeping Pi as the native execution authority.

The roadmap follows official DSH contracts and UI surfaces. It does not introduce a parallel subagent protocol, custom visualization, or a second execution-policy layer.

## Current baseline — 0.1

The first release establishes the native one-shot provider boundary:

- `pi_subagent` runs foreground work or standard DSH background Jobs;
- each delegation uses the parent Workspace and an isolated in-memory Pi session;
- model, Thinking, trust, cancellation, concurrency, and disposal remain explicit;
- `pi_trust_project` is the only approval-gated path that persists Workspace trust;
- Pi remains responsible for its native models, tools, extensions, skills, authentication, and execution behavior.

The current product boundary is Sessionless: DSH receives lifecycle events and tool/Job results, but the Pi run is not rendered as a child Session in the official Subagent UI.

## Committed next — 0.2: Session-backed one-shot parity

The next release makes every Pi one-shot run a real, durable DSH child Session that the existing DSH UI can render and navigate.

### User-visible outcome

- A Pi delegation appears immediately in the official Subagent Catalog.
- The user can open the child from the parent Session and inspect its rendered transcript while it runs and after it finishes.
- The official UI shows the supported child label, activity, hierarchy, token usage, duration, breadcrumb, and read-only one-shot history.
- Foreground tool results and background Job behavior continue to work as they do in 0.1.

### Capability boundary

- Create a child Session with official `origin`, `parentSession`, Workspace, and delegation-depth lineage.
- Append the official one-shot `subagent/descriptor` for provider `pi`.
- Project Pi user, assistant, reasoning, tool, usage, and terminal events into valid DSH Session events where an official lossless mapping exists.
- Persist enough Session state for the official catalog and transcript to remain available after completion and, when host persistence is configured, after restart.
- Keep lifecycle identity, Job identity, child Session identity, and cleanup consistent.
- Use the existing DSH client UI without adding Pi-specific catalog rows, badges, transcript components, or model selectors.

The DSH Session is an observation and navigation projection. It must not become a second source of execution truth or feed mirrored events back into Pi.

### Exit criteria

- A running Pi child is visible and openable from its parent in the official UI.
- The rendered child history advances as Pi produces supported events.
- Completion, error, cancellation, and parent/plugin teardown leave a valid terminal Session.
- Catalog hierarchy and statistics agree with the persisted child log.
- The existing 0.1 foreground, background, trust, and Pi-native execution contracts remain intact.

## Planned after 0.2 — 0.3: Continuable Session parity

After the one-shot Session projection is proven, add the official continuable-subagent lifecycle rather than creating a Pi-specific continuation channel.

### User-visible outcome

- A parent can continue an existing Pi child through the standard DSH subagent controls.
- The same child Session remains addressable and renders later turns in the official UI.
- A persisted continuable child can be resumed through the official ownership and authorization model.

### Capability boundary

- Implement `prepareContinuable()` and the official continuation/control contracts.
- Give Pi conversation state one durable authority and define how it is reconstructed after restart.
- Preserve parent-child authorization, delegation depth, cancellation, ownership transfer, and cold-resume semantics.
- Keep the ordinary DSH model selector behavior unchanged for addressed subagents.

Before implementation, this phase requires an ADR choosing the durable conversation authority; DSH Session history and Pi native history must not silently diverge.

### Exit criteria

- Multiple parent-to-child turns use the same official child identity.
- Reload and cold resume preserve a coherent transcript and Pi execution context.
- Concurrent delivery, cancellation, unload, and ownership conflicts follow official DSH outcomes.
- No private continuation API or custom UI is required.

## Directional rules

- Roadmap milestones describe product capabilities, not bug-fix, test, packaging, diagnostic, or release chores. Those remain ordinary Issues.
- Each milestone begins with an audit of the then-current DSH and Pi contracts; developer-preview upgrades are explicit compatibility work.
- A capability enters a committed release only after it has a focused GitHub Issue, an authority-boundary review, and observable exit criteria.
- Prefer official DSH Session, projection, subagent-control, Job, approval, and UI contracts over local substitutes.
- Preserve Pi-native execution semantics unless an intentional compatibility trade-off is recorded in an ADR.

GitHub Issues remain the authority for executable scope. This document records sequencing and direction only.
