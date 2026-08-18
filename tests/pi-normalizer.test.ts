import { describe, expect, it } from "vitest";

import { createPiNormalizer, normalizePiEvent } from "../src/pi-normalizer.js";

describe("Pi event normalizer", () => {
  it("normalizes text and reasoning deltas with one turn/step position", () => {
    const normalizer = createPiNormalizer();
    expect(normalizer.normalize({ type: "turn_start", turnIndex: 0, timestamp: 1 } as never)).toEqual([
      { type: "turn-start", turn: 1 },
      { type: "step-start", turn: 1, step: 1 },
    ]);
    expect(normalizer.normalize({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "hello" },
    } as never)).toEqual([{ type: "text-delta", turn: 1, step: 1, text: "hello" }]);
    expect(normalizer.normalize({
      type: "message_update",
      assistantMessageEvent: { type: "thinking_delta", delta: "checking" },
    } as never)).toEqual([{ type: "reasoning-delta", turn: 1, step: 1, text: "checking" }]);
  });

  it("maps finalized assistant provenance, usage, and terminal outcome", () => {
    const state = {
      turn: 1,
      step: 1,
      awaitingNextStep: false,
      seenToolResults: new Set<string>(),
    };
    const events = normalizePiEvent({
      type: "message_end",
      message: {
        role: "assistant",
        id: "message-1",
        provider: "openai",
        model: "gpt-test",
        content: [{ type: "text", text: "done" }],
        usage: { input: 3, output: 2, cacheRead: 1, cacheWrite: 0, reasoning: 1, totalTokens: 6, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: "stop",
      },
    } as never, state);

    expect(events).toEqual([
      {
        type: "assistant-message",
        turn: 1,
        step: 1,
        messageId: "message-1",
        provider: "openai",
        model: "gpt-test",
        content: [{ type: "text", text: "done" }],
        usage: { inputTokens: 3, outputTokens: 2, cacheReadTokens: 1, cacheWriteTokens: 0, reasoningTokens: 1 },
      },
      { type: "terminal", reason: "stop" },
    ]);
  });

  it("deduplicates tool results across message_end and tool_execution_end", () => {
    const normalizer = createPiNormalizer();
    const fromMessage = normalizer.normalize({
      type: "message_end",
      message: {
        role: "toolResult",
        toolCallId: "call-1",
        content: [{ type: "text", text: "ok" }],
        isError: false,
      },
    } as never);
    const fromExecution = normalizer.normalize({
      type: "tool_execution_end",
      toolCallId: "call-1",
      result: { content: [{ type: "text", text: "ok" }] },
      isError: false,
    } as never);

    expect(fromMessage).toHaveLength(1);
    expect(fromExecution).toEqual([]);
  });

  it("treats finalized user messages as authoritative and keeps one DSH turn", () => {
    const normalizer = createPiNormalizer();
    expect(normalizer.normalize({ type: "turn_start", turnIndex: 0 } as never)).toHaveLength(2);
    expect(normalizer.normalize({
      type: "message_start",
      message: { role: "user", content: [{ type: "text", text: "prompt" }] },
    } as never)).toEqual([]);
    expect(normalizer.normalize({
      type: "message_end",
      message: { role: "user", content: [{ type: "text", text: "prompt" }] },
    } as never)).toEqual([{
      type: "user-message",
      turn: 1,
      step: 1,
      content: [{ type: "text", text: "prompt" }],
    }]);
    expect(normalizer.normalize({ type: "turn_start", turnIndex: 1 } as never)).toEqual([
      { type: "step-end", turn: 1, step: 1 },
      { type: "step-start", turn: 1, step: 2 },
    ]);

    const nativeCycle = createPiNormalizer();
    nativeCycle.normalize({ type: "turn_start", turnIndex: 0 } as never);
    expect(nativeCycle.normalize({ type: "turn_end" } as never)).toEqual([
      { type: "step-end", turn: 1, step: 1 },
    ]);
    expect(nativeCycle.normalize({ type: "turn_start", turnIndex: 1 } as never)).toEqual([
      { type: "step-start", turn: 1, step: 2 },
    ]);
  });

  it("waits for finalized tool-result messages so parallel completion is emitted in source order", () => {
    const normalizer = createPiNormalizer();
    normalizer.normalize({
      type: "tool_execution_end",
      toolCallId: "call-1",
      result: { content: [{ type: "text", text: "one" }] },
      isError: false,
    } as never);
    normalizer.normalize({
      type: "tool_execution_end",
      toolCallId: "call-2",
      result: { content: [{ type: "text", text: "two" }] },
      isError: false,
    } as never);

    const sourceOrder = [
      ...normalizer.normalize({
        type: "message_end",
        message: { role: "toolResult", toolCallId: "call-2", content: [{ type: "text", text: "two" }], isError: false },
      } as never),
      ...normalizer.normalize({
        type: "message_end",
        message: { role: "toolResult", toolCallId: "call-1", content: [{ type: "text", text: "one" }], isError: false },
      } as never),
    ];
    expect(sourceOrder.map(event => event.type === "tool-result" ? event.callId : "")).toEqual(["call-2", "call-1"]);
  });

  it("does not replay finalized messages from an agent summary", () => {
    const normalizer = createPiNormalizer();
    const finalized = normalizer.normalize({
      type: "message_end",
      message: {
        role: "assistant",
        id: "assistant-1",
        provider: "openai",
        model: "gpt-test",
        content: [{ type: "text", text: "done" }],
        stopReason: "stop",
      },
    } as never);
    expect(finalized.some(item => item.type === "assistant-message")).toBe(true);
    expect(normalizer.normalize({
      type: "agent_end",
      messages: [{
        role: "assistant",
        id: "assistant-1",
        provider: "openai",
        model: "gpt-test",
        content: [{ type: "text", text: "done" }],
        stopReason: "stop",
      }],
      willRetry: false,
    } as never)).toEqual([]);
  });
});
