import { describe, expect, it, vi } from "vitest";

import type { Agent } from "@deepseek-ai/dsh-agent";

import { trustProject } from "../src/trust.js";

function parent(cwd = "/tmp", parentSession?: string): Agent {
  return {
    id: "parent" as Agent["id"],
    session: { header: { cwd, ...(parentSession === undefined ? {} : { parentSession }) } },
  } as unknown as Agent;
}

class FakeStore {
  private decision: boolean | null = null;
  entryPath = "/tmp";
  readonly set = vi.fn((_workspace: string, decision: boolean) => {
    this.decision = decision;
    this.entryPath = _workspace;
  });

  get(): boolean | null {
    return this.decision;
  }

  getEntry(): { path: string; decision: boolean } | null {
    return this.decision === null ? null : { path: this.entryPath, decision: this.decision };
  }
}

describe("trustProject", () => {
  it("persists an approved exact workspace", async () => {
    const store = new FakeStore();
    const approval = { request: vi.fn(async () => "allowed-once" as const) };

    await expect(trustProject({
      parent: parent(),
      store,
      approval,
      signal: new AbortController().signal,
    })).resolves.toEqual({ workspace: "/tmp", trusted: true, changed: true });
    expect(store.set).toHaveBeenCalledWith("/tmp", true);
    expect(approval.request).toHaveBeenCalledWith(expect.objectContaining({
      toolName: "pi_trust_project",
      reason: "Trust project workspace /tmp.",
    }));
  });

  it("requires approval before overwriting a saved false decision", async () => {
    const store = new FakeStore();
    store.set("/tmp", false);
    const approval = { request: vi.fn(async () => "rejected" as const) };

    await expect(trustProject({
      parent: parent(),
      store,
      approval,
      signal: new AbortController().signal,
    })).rejects.toThrow("Project trust was not approved");
    expect(approval.request).toHaveBeenCalledWith(expect.objectContaining({
      reason: "Trust project workspace /tmp; this overwrites the saved \"do not trust\" decision.",
    }));
    expect(store.get()).toBe(false);
  });

  it("is idempotent for an already trusted workspace and rejects child sessions", async () => {
    const store = new FakeStore();
    store.set("/tmp", true);
    const approval = { request: vi.fn() };

    await expect(trustProject({
      parent: parent(),
      store,
      approval,
      signal: new AbortController().signal,
    })).resolves.toEqual({ workspace: "/tmp", trusted: true, changed: false });
    expect(approval.request).not.toHaveBeenCalled();

    await expect(trustProject({
      parent: parent("/tmp", "ancestor"),
      store,
      approval,
      signal: new AbortController().signal,
    })).rejects.toThrow("top-level DSH session");
  });

  it("does not treat inherited trust as an exact workspace decision", async () => {
    const store = new FakeStore();
    store.entryPath = "/";
    store.set("/tmp", true);
    store.entryPath = "/";
    const approval = { request: vi.fn(async () => "allowed-once" as const) };

    await expect(trustProject({
      parent: parent(),
      store,
      approval,
      signal: new AbortController().signal,
    })).resolves.toEqual({ workspace: "/tmp", trusted: true, changed: true });
    expect(approval.request).toHaveBeenCalledWith(expect.objectContaining({
      reason: "Trust project workspace /tmp; this persists an exact decision instead of inheriting trust from /.",
    }));
  });

  it("does not persist trust when cancellation arrives after approval", async () => {
    const store = new FakeStore();
    const controller = new AbortController();
    const approval = {
      request: vi.fn(async () => {
        controller.abort();
        return "allowed-once" as const;
      }),
    };

    await expect(trustProject({
      parent: parent(),
      store,
      approval,
      signal: controller.signal,
    })).rejects.toThrow("aborted");
    expect(store.set).not.toHaveBeenCalled();
  });
});
