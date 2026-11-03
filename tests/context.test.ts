import { describe, expect, it } from "vitest";
import { estimateContextTokens, estimateMessageTokens, shouldCompact } from "../src/context.ts";
import type { Message } from "../src/types.ts";

const zeroUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };

describe("shouldCompact", () => {
  const settings = { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 };

  it.each([[111615, false], [111616, false], [111617, true]] as const)(
    "上下文为 %i 时是否超过触发线：%s", (tokens, expected) => {
      expect(shouldCompact(tokens, 128000, settings)).toBe(expected);
    },
  );

  it("禁用自动压缩时不触发", () => {
    expect(shouldCompact(200000, 128000, { ...settings, enabled: false })).toBe(false);
  });
});

describe("estimateMessageTokens", () => {
  it.each(["system", "user", "tool"] as const)("估算 %s 正文并向上取整", (role) => {
    const message: Message = role === "tool"
      ? { role, content: "abcde", toolCallId: "read_1" }
      : { role, content: "abcde" };
    expect(estimateMessageTokens(message)).toBe(2);
  });

  it("空消息为零，工具调用的名称和参数参与估算", () => {
    expect(estimateMessageTokens({ role: "assistant", content: "" })).toBe(0);
    expect(estimateMessageTokens({
      role: "assistant", content: "",
      toolCalls: [{ id: "read_1", name: "read_file", arguments: { path: "a" } }],
    })).toBe(6);
  });
});

describe("estimateContextTokens", () => {
  it.each<[string, Message[], number]>([
    ["空历史", [], 0],
    ["没有用量时估算全部消息", [
      { role: "system", content: "abcd" },
      { role: "assistant", content: "", toolCalls: [
        { id: "read_1", name: "read_file", arguments: { path: "a" } },
      ] },
      { role: "tool", toolCallId: "read_1", content: "abcdefgh" },
    ], 9],
    ["最新用量加新增消息，不重复累计历史", [
      { role: "assistant", content: "旧回复", usage: { ...zeroUsage, totalTokens: 10000 } },
      { role: "assistant", content: "x".repeat(400), toolCalls: [
        { id: "read_1", name: "read_file", arguments: { path: "a" } },
      ], usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 } },
      { role: "tool", toolCallId: "read_1", content: "abcdefgh" },
      { role: "user", content: "abcd" },
    ], 123],
    ["优先采用 totalTokens", [
      { role: "assistant", content: "", usage: { inputTokens: 12, outputTokens: 5, totalTokens: 20 } },
    ], 20],
    ["totalTokens 为零时使用输入与输出之和", [
      { role: "assistant", content: "", usage: { inputTokens: 12, outputTokens: 5, totalTokens: 0 } },
    ], 17],
    ["全零用量回退到消息估算", [
      { role: "assistant", content: "abcde", usage: zeroUsage },
    ], 2],
  ])("%s", (_name, messages, expected) => {
    expect(estimateContextTokens(messages)).toBe(expected);
  });

  it.each([undefined, zeroUsage])("最新用量为 %j 时回退到之前有效用量", (usage) => {
    const messages: Message[] = [
      { role: "assistant", content: "旧回复", usage: { ...zeroUsage, totalTokens: 17 } },
      { role: "user", content: "abcd" },
      { role: "assistant", content: "abcde", usage },
    ];
    expect(estimateContextTokens(messages)).toBe(20);
  });
});
