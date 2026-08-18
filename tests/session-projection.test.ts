import { describe, expect, it, vi } from "vitest";

import { appendFile, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import { AgentRegistry } from "@deepseek-ai/dsh-agent";
import { Session, SessionId, SessionStore } from "@deepseek-ai/dsh-session";
import { JsonlSessionPersistence } from "@deepseek-ai/dsh-session-persistence-jsonl";
import { SessionProjectionRegistry } from "@deepseek-ai/dsh-session-projection";
import { SubagentRuntime } from "@deepseek-ai/dsh-subagent";
import { TokenMeter } from "@deepseek-ai/dsh-token-meter";

import {
  createSessionProjectionFactory,
  createSessionProjectionHost,
  type SessionProjectionHost,
} from "../src/session-projection.js";
import type { PiRunEvent } from "../src/pi-session.js";

function parentAgent(): Agent {
  const session = Session.create(SessionId("parent-session"));
  return {
    id: session.id,
    options: {},
    session,
    ctx: {},
  } as unknown as Agent;
}

function host(): {
  host: SessionProjectionHost;
  child: Session;
  entered: { session: boolean; agent: boolean };
} {
  const child = Session.create(SessionId("child-session"));
  const entered = { session: false, agent: false };
  const sessionDetach = vi.fn(() => {
    entered.session = false;
  });
  const agentDetach = vi.fn(() => {
    entered.agent = false;
  });
  const host: SessionProjectionHost = {
    context: {} as never,
    sessions: {
      prepare: vi.fn(() => child),
      enter: vi.fn(() => {
        entered.session = true;
        return sessionDetach;
      }),
      announce: vi.fn(),
      flush: vi.fn(async () => true),
    },
    agents: {
      enter: vi.fn(() => {
        entered.agent = true;
        return agentDetach;
      }),
      announce: vi.fn(),
    },
  };
  return { host, child, entered };
}

function event(event: PiRunEvent): PiRunEvent {
  return event;
}

describe("SessionProjectionHandle", () => {
  it("drives the official persistence, projection, token-meter, and subagent services", async () => {
    const root = await mkdtemp(join(tmpdir(), "dsh-subagent-pi-"));
    const context = new Context();
    const fibers = [] as Awaited<ReturnType<typeof context.plugin>>[];
    try {
      fibers.push(await context.plugin(SessionStore));
      fibers.push(await context.plugin(AgentRegistry));
      fibers.push(await context.plugin(SessionProjectionRegistry));
      fibers.push(await context.plugin(TokenMeter));
      fibers.push(await context.plugin(JsonlSessionPersistence, {
        root,
        compression: "none",
        writeBatchMaxDelayMs: 1,
      }));
      fibers.push(await context.plugin(SubagentRuntime));

      const sessions = context.get("sessions");
      const projections = context.get("sessionProjections");
      const tokenMeter = context.get("tokenMeter");
      const persistence = context.get("sessionPersistence");
      if (sessions === undefined || projections === undefined || tokenMeter === undefined || persistence === undefined) {
        throw new Error("official Session-backed services did not mount");
      }
      const parentSession = sessions.create(SessionId("real-parent"), { meta: { cwd: "/tmp" } });
      const parent = {
        id: parentSession.id,
        options: {},
        session: parentSession,
        ctx: context,
      } as unknown as Agent;
      const factory = createSessionProjectionFactory(createSessionProjectionHost(context));
      const handle = await factory.prepare({
        parent,
        workspace: "/tmp",
        delegationDepth: 1,
        provider: "pi",
        label: "official services",
        model: { provider: "openai", model: "gpt-test" },
        childSessionId: "real-child",
      });
      const child = handle.localAgent.session;
      handle.publish("prompt");
      handle.project(event({
        type: "assistant-message",
        turn: 1,
        step: 1,
        messageId: "assistant-1",
        provider: "openai",
        model: "gpt-test",
        content: [{ type: "text", text: "done" }],
        usage: { inputTokens: 3, outputTokens: 2 },
      }));

      expect(projections.snapshot(child).values.subagent).toMatchObject({ mode: "one-shot", label: "official services" });
      expect(tokenMeter.measure(child).totalTokens).toBeGreaterThan(0);

      await handle.finalize("stop");
      await handle.dispose();
      const persisted = await persistence.load(handle.id);
      expect(persisted.events.map(item => item.type)).toContain("turn/end");
      expect(persisted.events.map(item => item.type)).toContain("assistant/message");
    } finally {
      for (const fiber of fibers.reverse()) await fiber.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("leaves crash repair to the official persistence coordinator", async () => {
    const root = await mkdtemp(join(tmpdir(), "dsh-subagent-pi-repair-"));
    const context = new Context();
    const fibers = [] as Awaited<ReturnType<typeof context.plugin>>[];
    try {
      fibers.push(await context.plugin(SessionStore));
      fibers.push(await context.plugin(JsonlSessionPersistence, {
        root,
        compression: "none",
        writeBatchMaxDelayMs: 1,
      }));
      const sessions = context.get("sessions");
      const persistence = context.get("sessionPersistence");
      if (sessions === undefined || persistence === undefined) throw new Error("official persistence did not mount");
      const session = sessions.prepare(SessionId("repair-child"), {
        meta: { cwd: "/tmp", origin: "subagent", delegationDepth: 1 },
      });
      session.append("turn/start", { turn: 1 });
      session.append("step/start", { turn: 1, step: 1 });
      await persistence.create(session.header);
      await persistence.append(session.id, session.events);
      const location = persistence.locate(session.header);
      if (location === undefined) throw new Error("official persistence did not expose a repair location");
      await appendFile(location.path, "{\"torn\":");

      const repaired = await persistence.load(session.id);
      expect(repaired.events.at(-2)?.type).toBe("step/end");
      expect(repaired.events.at(-1)?.type).toBe("turn/end");
    } finally {
      for (const fiber of fibers.reverse()) await fiber.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("uses the real rc.7 Session and Agent registries for publication and detach", async () => {
    const context = new Context();
    await context.plugin(SessionStore);
    await context.plugin(AgentRegistry);
    context.on("session/flush", () => undefined);
    const sessions = context.get("sessions");
    const agents = context.get("agents");
    if (sessions === undefined || agents === undefined) throw new Error("rc.7 registry services did not mount");
    const parentSession = sessions.create(SessionId("real-parent"), { meta: { cwd: "/tmp" } });
    const parent = { id: parentSession.id, options: {}, session: parentSession, ctx: context } as unknown as Agent;
    const projector = createSessionProjectionFactory({ context, sessions, agents });
    const handle = await projector.prepare({
      parent,
      workspace: "/tmp",
      delegationDepth: 1,
      provider: "pi",
      label: "real registry",
      model: { provider: "openai", model: "gpt-test" },
      childSessionId: "real-child",
    });
    handle.publish("prompt");
    expect(sessions.get(handle.id)).toBe(handle.localAgent.session);
    expect(agents.get(handle.id)).toBe(handle.localAgent);
    await handle.finalize("stop");
    await handle.dispose();
    expect(sessions.get(handle.id)).toBeUndefined();
    expect(agents.get(handle.id)).toBeUndefined();
  });

  it("fails activation instead of silently retaining a Sessionless path", () => {
    const context = { get: vi.fn(() => undefined) };
    expect(() => createSessionProjectionHost(context as never)).toThrow(
      "Pi Session-backed parity requires official Session, Agent, persistence, projection capabilities",
    );
  });

  it("rejects malformed capability objects during activation", () => {
    const context = { get: vi.fn(() => ({})) };
    expect(() => createSessionProjectionHost(context as never)).toThrow(
      "Pi Session-backed parity requires official Session, Agent, persistence, projection capabilities",
    );
  });

  it("publishes one same-identity one-shot child before Pi events", async () => {
    const fixture = host();
    const parent = parentAgent();
    const factory = createSessionProjectionFactory(fixture.host);
    const handle = await factory.prepare({
      parent,
      workspace: "/tmp",
      delegationDepth: 1,
      provider: "pi",
      label: "bounded task",
      model: { provider: "openai", model: "gpt-test" },
      childSessionId: "child-session",
    });

    handle.publish("do the bounded task");

    expect(handle.id).toBe(fixture.child.id);
    expect(handle.localAgent.id).toBe(handle.id);
    expect(fixture.entered).toEqual({ session: true, agent: true });
    expect(fixture.host.sessions.prepare).toHaveBeenCalledWith(handle.id, {
      meta: {
        cwd: "/tmp",
        parentSession: parent.session.id,
        origin: "subagent",
        delegationDepth: 1,
      },
    });
    expect(fixture.child.events.map(item => item.type)).toEqual([
      "turn/start",
      "subagent/descriptor",
      "step/start",
      "user/message",
    ]);
    expect(fixture.child.events[1]?.data).toMatchObject({
      version: 2,
      mode: "one-shot",
      provider: "pi",
      label: "bounded task",
    });
  });

  it("projects text, reasoning, assistant provenance, tool pairing, and terminal flush order", async () => {
    const fixture = host();
    const factory = createSessionProjectionFactory(fixture.host);
    const handle = await factory.prepare({
      parent: parentAgent(),
      workspace: "/tmp",
      delegationDepth: 1,
      provider: "pi",
      model: { provider: "openai", model: "gpt-test" },
    });
    handle.publish("prompt");

    handle.project(event({ type: "text-delta", turn: 1, step: 1, text: "hello" }));
    handle.project(event({ type: "reasoning-delta", turn: 1, step: 1, text: "checking" }));
    handle.project(event({
      type: "assistant-message",
      turn: 1,
      step: 1,
      messageId: "assistant-1",
      content: [{ type: "text", text: "hello" }],
      usage: { inputTokens: 3, outputTokens: 2, cacheReadTokens: 1, cacheWriteTokens: 0, reasoningTokens: 1 },
    }));
    handle.project(event({
      type: "tool-call",
      turn: 1,
      step: 1,
      callId: "call-1",
      name: "read",
      arguments: { path: "README.md" },
    }));
    handle.project(event({
      type: "tool-result",
      turn: 1,
      step: 1,
      callId: "call-1",
      content: [{ type: "text", text: "contents" }],
      isError: false,
    }));

    const finalize = await handle.finalize("stop");

    expect(finalize).toEqual({ projectionFailure: undefined });
    expect(fixture.child.events.map(item => item.type)).toContain("assistant/chunk");
    expect(fixture.child.events.map(item => item.type)).toContain("tool/call");
    expect(fixture.child.events.map(item => item.type)).toContain("tool/result");
    const assistant = fixture.child.events.find(item => item.type === "assistant/message");
    expect(assistant).toMatchObject({
      data: {
        message: { source: { kind: "model", provider: "openai", model: "gpt-test" } },
        usage: { inputTokens: 3, outputTokens: 2, cacheReadTokens: 1, cacheWriteTokens: 0, reasoningTokens: 1 },
      },
    });
    expect(fixture.child.events.at(-1)).toMatchObject({
      type: "turn/end",
      data: { reason: { kind: "completed" } },
    });
    expect(fixture.host.sessions.flush).toHaveBeenCalledWith(fixture.child);
    expect(handle.localAgent.status).toBe("idle");
  });

  it("replaces cumulative assistant usage snapshots instead of duplicating the surface", async () => {
    const fixture = host();
    const factory = createSessionProjectionFactory(fixture.host);
    const handle = await factory.prepare({
      parent: parentAgent(),
      workspace: "/tmp",
      delegationDepth: 1,
      provider: "pi",
      model: { provider: "openai", model: "gpt-test" },
    });
    handle.publish("prompt");
    const base = {
      type: "assistant-message" as const,
      turn: 1,
      step: 1,
      messageId: "assistant-1",
      content: [{ type: "text" as const, text: "hello" }],
    };
    handle.project(event({ ...base, usage: { inputTokens: 1, outputTokens: 1 } }));
    handle.project(event({ ...base, usage: { inputTokens: 2, outputTokens: 3 } }));

    const messages = fixture.child.events.filter(item => item.type === "assistant/message");
    expect(messages).toHaveLength(2);
    expect(messages[1]).toMatchObject({
      surfaceOp: { op: "replace" },
      data: { usage: { inputTokens: 2, outputTokens: 3 } },
    });
  });

  it("does not append an identical finalized assistant summary twice", async () => {
    const fixture = host();
    const factory = createSessionProjectionFactory(fixture.host);
    const handle = await factory.prepare({
      parent: parentAgent(),
      workspace: "/tmp",
      delegationDepth: 1,
      provider: "pi",
      model: { provider: "openai", model: "gpt-test" },
    });
    handle.publish("prompt");
    const message = {
      type: "assistant-message" as const,
      turn: 1,
      step: 1,
      messageId: "assistant-1",
      provider: "openai",
      model: "gpt-test",
      content: [{ type: "text" as const, text: "done" }],
      usage: { inputTokens: 2, outputTokens: 1 },
    };
    handle.project(event(message));
    handle.project(event(message));

    expect(fixture.child.events.filter(item => item.type === "assistant/message")).toHaveLength(1);
  });

  it("freezes ordinary projection after a failure and performs bounded terminal recovery", async () => {
    const fixture = host();
    const flush = fixture.host.sessions.flush as ReturnType<typeof vi.fn>;
    flush.mockRejectedValueOnce(new Error("flush failed"));
    const failures: unknown[] = [];
    const factory = createSessionProjectionFactory(fixture.host);
    const handle = await factory.prepare({
      parent: parentAgent(),
      workspace: "/tmp",
      delegationDepth: 1,
      provider: "pi",
      model: { provider: "openai", model: "gpt-test" },
      onProjectionFailure: failure => failures.push(failure),
    });
    handle.publish("prompt");
    handle.project(event({ type: "text-delta", turn: 1, step: 1, text: "hello" }));

    const finalize = await handle.finalize("stop");

    expect(finalize.projectionFailure?.error).toBeInstanceOf(Error);
    expect(failures).toHaveLength(1);
    expect(handle.diagnostics.unsupportedCounts).toEqual({});
    expect(handle.localAgent.status).toBe("idle");
  });

  it("keeps unsupported-only tool results paired with an empty envelope", async () => {
    const fixture = host();
    const factory = createSessionProjectionFactory(fixture.host);
    const handle = await factory.prepare({
      parent: parentAgent(),
      workspace: "/tmp",
      delegationDepth: 1,
      provider: "pi",
      model: { provider: "openai", model: "gpt-test" },
    });
    handle.publish("prompt");
    handle.project(event({
      type: "tool-call",
      turn: 1,
      step: 1,
      callId: "call-1",
      name: "image_tool",
      arguments: "{}",
    }));
    handle.project(event({
      type: "tool-result",
      turn: 1,
      step: 1,
      callId: "call-1",
      content: [{ type: "image", data: "raw", mimeType: "image/png" }],
      isError: false,
    }));

    const result = fixture.child.events.find(item => item.type === "tool/result");
    expect(result).toMatchObject({ data: { message: { content: [{ type: "tool-result", content: [] }] } } });
    expect(handle.diagnostics.unsupportedCounts).toEqual({ image: 1 });
  });
});
