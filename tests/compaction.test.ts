import { beforeEach, describe, expect, it, vi } from "vitest";
import { compactContext } from "../src/compaction.ts";
import { estimateContextTokens } from "../src/context.ts";
import type { Message } from "../src/types.ts";

const { mockCallModel } = vi.hoisted(() => ({ mockCallModel: vi.fn() }));
vi.mock("../src/llm.ts", () => ({ callModel: mockCallModel }));

function history(): Message[] {
  return [
    { role: "system", content: "先阅读，再修改，最后验证。" },
    { role: "user", content: "旧任务".repeat(400) },
    { role: "assistant", content: "", toolCalls: [
      { id: "old_read", name: "read_file", arguments: { path: "old.ts" } },
    ] },
    { role: "tool", toolCallId: "old_read", content: "旧结果".repeat(1000) },
    { role: "assistant", content: "已读完", usage: { inputTokens: 1000, outputTokens: 20, totalTokens: 1020 } },
    { role: "user", content: "现在继续" },
    { role: "assistant", content: "", toolCalls: [
      { id: "new_read", name: "read_file", arguments: { path: "new.ts" } },
    ], usage: { inputTokens: 1100, outputTokens: 20, totalTokens: 1120 } },
    { role: "tool", toolCallId: "new_read", content: "最新结果".repeat(20) },
    { role: "assistant", content: "接下来验证", usage: { inputTokens: 1200, outputTokens: 20, totalTokens: 1220 } },
  ];
}

describe("compactContext", () => {
  let messages: Message[];
  let before: Message[];
  beforeEach(() => {
    messages = history();
    before = structuredClone(messages);
    mockCallModel.mockReset();
    mockCallModel.mockResolvedValue({ role: "assistant", content: "目标：继续修改；下一步验证。" });
  });

  it("保留系统提示及完整工具交互，序列化旧历史并清除过期用量", async () => {
    const system = messages[0];
    const onUsage = vi.fn();
    const signal = new AbortController().signal;
    expect(await compactContext(messages, { keepRecentTokens: 20, signal, onUsage })).toBe(true);

    expect(messages[0]).toBe(system);
    expect(messages.map((message) => message.role)).toEqual(["system", "user", "assistant", "tool", "assistant"]);
    expect(messages[1].content).toContain("目标：继续修改");
    expect(messages[2]).toMatchObject({ toolCalls: [{ id: "new_read" }] });
    expect(messages[3]).toEqual({ role: "tool", toolCallId: "new_read", content: "最新结果".repeat(20) });
    expect(messages[2]).not.toHaveProperty("usage");
    expect(messages[4]).not.toHaveProperty("usage");
    expect(estimateContextTokens(messages)).toBeLessThan(1220);

    const [prompt, options] = mockCallModel.mock.calls[0];
    expect(options).toEqual({ tools: [], signal, onUsage });
    expect(prompt[1].content).toContain("旧任务");
    expect(prompt[1].content).toContain("现在继续");
    expect(prompt[1].content).toContain("已截断 1000 字符");
    expect(prompt[1].content).not.toContain('"usage"');
    expect(prompt[1].content).not.toContain("new_read");
  });

  it("重复压缩会合并此前摘要，没有新历史时不重复调用模型", async () => {
    await compactContext(messages, { keepRecentTokens: 20 });
    expect(await compactContext(messages, { keepRecentTokens: 20 })).toBe(false);
    expect(mockCallModel).toHaveBeenCalledTimes(1);
    messages.push({ role: "user", content: "新的请求".repeat(100) });
    messages.push({ role: "assistant", content: "继续验证" });
    expect(await compactContext(messages, { keepRecentTokens: 20 })).toBe(true);
    expect(mockCallModel.mock.calls[1][0][1].content).toContain("目标：继续修改");
  });

  it("压缩保存失败时保留原上下文", async () => {
    const before = structuredClone(messages);
    const onCompaction = vi.fn().mockRejectedValue(new Error("保存失败"));

    await expect(compactContext(messages, { keepRecentTokens: 20, onCompaction }))
      .rejects.toThrow("保存失败");
    expect(messages).toEqual(before);
  });

  it("空历史或历史小于保留预算时不调用模型", async () => {
    expect(await compactContext([])).toBe(false);
    expect(await compactContext(messages)).toBe(false);
    expect(messages).toEqual(before);
    expect(mockCallModel).not.toHaveBeenCalled();
  });

  it("模型调用失败时保留原历史及其用量", async () => {
    mockCallModel.mockRejectedValueOnce(new Error("网络断开"));
    await expect(compactContext(messages, { keepRecentTokens: 20 })).rejects.toThrow("网络断开");
    expect(messages).toEqual(before);
  });

  it.each([
    { role: "assistant", content: "  " },
    { role: "assistant", content: "执行命令", toolCalls: [
      { id: "bad", name: "run_bash", arguments: { command: "echo bad" } },
    ] },
  ])("拒绝无效摘要并保留原历史：%j", async (reply) => {
    mockCallModel.mockResolvedValueOnce(reply);
    await expect(compactContext(messages, { keepRecentTokens: 20 })).rejects.toThrow("有效的纯文本摘要");
    expect(messages).toEqual(before);
  });

  it("摘要没有缩短历史时保留原历史", async () => {
    mockCallModel.mockResolvedValueOnce({ role: "assistant", content: "过长摘要".repeat(2000) });
    expect(await compactContext(messages, { keepRecentTokens: 20 })).toBe(false);
    expect(messages).toEqual(before);
  });

  it.each([false, true])("取消发生在调用前=%s 时保留原历史", async (beforeCall) => {
    const controller = new AbortController();
    if (beforeCall) controller.abort();
    mockCallModel.mockImplementationOnce(async () => {
      controller.abort();
      return { role: "assistant", content: "摘要" };
    });
    await expect(compactContext(messages, { keepRecentTokens: 20, signal: controller.signal })).rejects.toThrow();
    expect(messages).toEqual(before);
    expect(mockCallModel).toHaveBeenCalledTimes(beforeCall ? 0 : 1);
  });

  it.each([-1, 0.5, NaN])("拒绝非法的保留预算 %s", async (keepRecentTokens) => {
    await expect(compactContext(messages, { keepRecentTokens })).rejects.toThrow("非负安全整数");
    expect(mockCallModel).not.toHaveBeenCalled();
  });
});
