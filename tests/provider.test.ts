import { describe, expect, it, vi } from "vitest";

import type { Agent } from "@deepseek-ai/dsh-agent";
import type { ResolvedSubagentStartRequest } from "@deepseek-ai/dsh-subagent";

import { createPiProvider } from "../src/provider.js";
import { Config, normalizeConfig } from "../src/config.js";
import type { PiSessionFactory } from "../src/pi-session.js";
import type { PiSession, PiSessionEvent, PiSessionStartInput } from "../src/pi-session.js";

function parentAgent(cwd = "/tmp/pi-parent"): Agent {
  return {
    id: "parent-session" as Agent["id"],
    options: {},
    session: {
      header: { cwd },
    },
  } as unknown as Agent;
}

function request(overrides: Partial<ResolvedSubagentStartRequest> = {}): ResolvedSubagentStartRequest {
  return {
    descriptor: {} as ResolvedSubagentStartRequest["descriptor"],
    prompt: [{ type: "text", text: "do the bounded task" }],
    parent: parentAgent(),
    signal: new AbortController().signal,
    ...overrides,
  };
}

describe("normalizeConfig", () => {
  it("defaults run capacity without inventing a model selector", () => {
    expect(normalizeConfig({})).toEqual({ maxConcurrentRuns: 4 });
    expect(Config({} as never)).toEqual({ maxConcurrentRuns: 4 });
  });

  it("rejects partial default model configuration", () => {
    expect(() => normalizeConfig({ defaultModel: { provider: "openai" } })).toThrow(
      "defaultModel.provider and defaultModel.model must be provided together",
    );
    expect(() => Config({ maxConcurrentRuns: 0 } as never)).toThrow();
    expect(() => Config({ defaultModel: { provider: "", model: "model" }, maxConcurrentRuns: 4 } as never)).toThrow();
  });
});

describe("createPiProvider", () => {
  it("advertises only the V1 one-shot depth capability", () => {
    const factory = {} as PiSessionFactory;
    const provider = createPiProvider({ factory, config: normalizeConfig({}) });

    expect(provider.name).toBe("pi");
    expect(provider.inheritsParentContext).toBe(false);
    expect(provider.capabilities).toEqual({
      depthLimit: true,
      outputSchema: false,
      toolFilter: false,
      persona: false,
    });
    expect(provider.prepareContinuable).toBeUndefined();
  });

  it("rejects non-text input before Pi startup", async () => {
    const factory = { start: vi.fn() } as unknown as PiSessionFactory;
    const provider = createPiProvider({ factory, config: normalizeConfig({}) });

    await expect(
      provider.start(
        request({ prompt: [{ type: "image", data: "not-allowed", mimeType: "image/png" }] as never }),
      ),
    ).rejects.toThrow("Pi V1 accepts text content only");
    expect(factory.start).not.toHaveBeenCalled();
  });

  it("rejects maxTokens instead of silently dropping it", async () => {
    const factory = { start: vi.fn() } as unknown as PiSessionFactory;
    const provider = createPiProvider({ factory, config: normalizeConfig({}) });

    await expect(
      provider.start(request({ agentOptions: { maxTokens: 100 } as never })),
    ).rejects.toThrow("agentOptions.maxTokens is not supported in V1");
    expect(factory.start).not.toHaveBeenCalled();
  });

  it("starts one canonical workspace run and returns only the final visible assistant text", async () => {
    const session = new ControlledSession();
    let input: PiSessionStartInput | undefined;
    const factory: PiSessionFactory = {
      start: vi.fn(async value => {
        input = value;
        return session;
      }),
    };
    const provider = createPiProvider({ factory, config: normalizeConfig({}) });

    const run = await provider.start(request({ parent: parentAgent("/tmp") }));
    expect(input).toMatchObject({ cwd: "/tmp", trusted: false });
    session.finish("visible answer");

    await expect(run.result).resolves.toEqual({
      output: [{ type: "text", text: "visible answer" }],
      stopReason: "completed",
    });
    await run.dispose();
    expect(session.abortCalls).toBe(0);
    expect(session.disposeCalls).toBe(1);
  });

  it("maps cancellation to an aborted result and waits for idle cleanup", async () => {
    const session = new ControlledSession();
    const controller = new AbortController();
    const factory: PiSessionFactory = { start: vi.fn(async () => session) };
    const provider = createPiProvider({ factory, config: normalizeConfig({}) });
    const run = await provider.start(request({ parent: parentAgent("/tmp"), signal: controller.signal }));

    controller.abort();
    await expect(run.result).resolves.toMatchObject({ stopReason: "aborted" });
    expect(session.abortCalls).toBe(1);
    expect(session.isIdle).toBe(true);
    await run.dispose();
    expect(session.disposeCalls).toBe(1);
  });

  it("rejects overflow before starting a fifth run", async () => {
    const sessions = Array.from({ length: 5 }, () => new ControlledSession());
    const activeSessions = sessions.slice(0, 4);
    const factory: PiSessionFactory = {
      start: vi.fn(async () => sessions.shift() ?? new ControlledSession()),
    };
    const provider = createPiProvider({ factory, config: normalizeConfig({ maxConcurrentRuns: 4 }) });

    const runs = await Promise.all(
      Array.from({ length: 4 }, () => provider.start(request({ parent: parentAgent("/tmp") }))),
    );
    await expect(provider.start(request({ parent: parentAgent("/tmp") }))).rejects.toThrow(
      "Pi run capacity exhausted",
    );
    expect(factory.start).toHaveBeenCalledTimes(4);
    activeSessions.forEach((session, index) => session.finish(`answer ${index}`));
    await Promise.all(runs.map(run => run.result));
    await Promise.all(runs.map(run => run.dispose()));
  });

  it("shuts down active runs and waits for Pi quiescence", async () => {
    const session = new ControlledSession();
    const provider = createPiProvider({
      factory: { start: vi.fn(async () => session) },
      config: normalizeConfig({}),
    });
    const run = await provider.start(request({ parent: parentAgent("/tmp") }));

    await provider.shutdown();
    await expect(run.result).resolves.toMatchObject({ stopReason: "aborted" });
    expect(session.abortCalls).toBe(1);
    expect(session.disposeCalls).toBe(1);
    await provider.shutdown();
  });

  it("reads a dynamic configuration source for each later run", async () => {
    let current = normalizeConfig({ defaultModel: { provider: "one", model: "model-one" }, thinking: "low" });
    const first = new ControlledSession();
    const second = new ControlledSession();
    const inputs: PiSessionStartInput[] = [];
    const factory: PiSessionFactory = {
      start: vi.fn(async input => {
        inputs.push(input);
        return inputs.length === 1 ? first : second;
      }),
    };
    const provider = createPiProvider({ factory, config: () => current });

    const firstRun = await provider.start(request({ parent: parentAgent("/tmp") }));
    first.finish("one");
    await firstRun.result;
    await firstRun.dispose();

    current = normalizeConfig({ defaultModel: { provider: "two", model: "model-two" }, thinking: "high" });
    const secondRun = await provider.start(request({ parent: parentAgent("/tmp") }));
    second.finish("two");
    await secondRun.result;
    await secondRun.dispose();

    expect(inputs).toMatchObject([
      { model: { provider: "one", model: "model-one" }, thinking: "low" },
      { model: { provider: "two", model: "model-two" }, thinking: "high" },
    ]);
  });

  it("does not finish shutdown while Pi startup is still in flight", async () => {
    const session = new ControlledSession();
    let releaseFactory: (() => void) | undefined;
    let factoryStarted = false;
    const factory: PiSessionFactory = {
      start: vi.fn(() => new Promise<PiSession>(resolve => {
        factoryStarted = true;
        releaseFactory = () => resolve(session);
      })),
    };
    const provider = createPiProvider({ factory, config: normalizeConfig({}) });
    const start = provider.start(request({ parent: parentAgent("/tmp") }));
    await vi.waitFor(() => expect(factoryStarted).toBe(true));

    let shutdownFinished = false;
    const shutdown = provider.shutdown().then(() => {
      shutdownFinished = true;
    });
    await Promise.resolve();
    expect(shutdownFinished).toBe(false);

    releaseFactory?.();
    await expect(start).rejects.toThrow("Pi provider is unloading");
    await shutdown;
    expect(session.disposeCalls).toBe(1);
  });

  it("removes the abort listener when startup fails after subscription", async () => {
    const session = new ControlledSession();
    let listener: (() => void) | undefined;
    let removed = 0;
    let aborted = false;
    const signal = {
      get aborted() {
        return aborted;
      },
      addEventListener: vi.fn((_type: string, callback: () => void) => {
        listener = callback;
        aborted = true;
        callback();
      }),
      removeEventListener: vi.fn(() => {
        removed += 1;
        listener = undefined;
      }),
    } as unknown as AbortSignal;
    const provider = createPiProvider({
      factory: { start: vi.fn(async () => session) },
      config: normalizeConfig({}),
    });

    await expect(provider.start(request({ parent: parentAgent("/tmp"), signal }))).rejects.toThrow("aborted");
    expect(removed).toBe(1);
    expect(session.disposeCalls).toBe(1);
  });
});

class ControlledSession implements PiSession {
  readonly thinkingLevel = "medium" as const;
  readonly availableThinkingLevels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
  readonly model = { provider: "test", model: "test-model" };
  readonly modelSource = "authenticated-fallback" as const;
  readonly thinkingSource = "default-medium" as const;
  abortCalls = 0;
  disposeCalls = 0;
  private idle = true;
  private listeners = new Set<(event: PiSessionEvent) => void>();
  private resolvePrompt: (() => void) | undefined;
  private idleWaiters: Array<() => void> = [];

  get isIdle(): boolean {
    return this.idle;
  }

  subscribe(listener: (event: PiSessionEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  prompt(): Promise<void> {
    this.idle = false;
    return new Promise(resolve => {
      this.resolvePrompt = resolve;
    });
  }

  abort(): Promise<void> {
    this.abortCalls += 1;
    this.emit({ type: "terminal", reason: "aborted" });
    this.finishIdle();
    return Promise.resolve();
  }

  waitForIdle(): Promise<void> {
    if (this.idle) return Promise.resolve();
    return new Promise(resolve => this.idleWaiters.push(resolve));
  }

  dispose(): void {
    this.disposeCalls += 1;
  }

  finish(text: string): void {
    this.emit({ type: "text-delta", text });
    this.emit({ type: "terminal", reason: "stop" });
    this.finishIdle();
  }

  private finishIdle(): void {
    this.idle = true;
    this.resolvePrompt?.();
    this.resolvePrompt = undefined;
    for (const resolve of this.idleWaiters.splice(0)) resolve();
  }

  private emit(event: PiSessionEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}
