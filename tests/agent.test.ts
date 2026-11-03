import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runAgent } from "../src/agent.ts";
import type { Message, ModelReply, ToolCall } from "../src/types.ts";

const stdoutTTY = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");

const { mockCallModel, mockExecuteTool } = vi.hoisted(() => ({
  mockCallModel: vi.fn(),
  mockExecuteTool: vi.fn(),
}));

vi.mock("../src/llm.ts", () => ({
  callModel: mockCallModel,
}));

vi.mock("../src/tools/index.ts", () => ({
  executeTool: mockExecuteTool,
}));

describe("runAgent", () => {
  beforeEach(() => {
    mockCallModel.mockReset();
    mockExecuteTool.mockReset();
    vi.stubEnv("CONTEXT_WINDOW", undefined);
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    if (stdoutTTY) Object.defineProperty(process.stdout, "isTTY", stdoutTTY);
    else Reflect.deleteProperty(process.stdout, "isTTY");
  });

  it("无工具调用时直接返回模型文本并结束", async () => {
    mockCallModel.mockResolvedValueOnce({
      role: "assistant",
      content: "无需使用工具，直接回答：你好！",
    } satisfies ModelReply);

    const result = await runAgent("你好");

    expect(result).toBe("无需使用工具，直接回答：你好！");
    expect(mockCallModel).toHaveBeenCalledTimes(1);

    const history = mockCallModel.mock.calls[0][0];
    expect(history[0]).toEqual(expect.objectContaining({ role: "system" }));
    expect(history[1]).toEqual({ role: "user", content: "你好" });
    expect(mockExecuteTool).not.toHaveBeenCalled();
  });

  it("多轮工具调用流转：执行工具并回填结果后获得最终回复", async () => {
    const toolCall: ToolCall = {
      id: "call_read_1",
      name: "read_file",
      arguments: { path: "package.json" },
    };

    mockCallModel
      .mockResolvedValueOnce({
        role: "assistant",
        content: "我来查看 package.json",
        toolCalls: [toolCall],
      } satisfies ModelReply)
      .mockResolvedValueOnce({
        role: "assistant",
        content: "项目名称是 mini-swe-agent",
      } satisfies ModelReply);

    mockExecuteTool.mockResolvedValueOnce('1: {"name": "mini-swe-agent"}');

    const result = await runAgent("查看项目名称");

    expect(result).toBe("项目名称是 mini-swe-agent");
    expect(mockExecuteTool).toHaveBeenCalledTimes(1);
    expect(mockExecuteTool).toHaveBeenCalledWith(toolCall, process.cwd(), undefined);
    expect(mockCallModel).toHaveBeenCalledTimes(2);

    const history = mockCallModel.mock.calls[1][0];
    expect(history[0]).toEqual(expect.objectContaining({ role: "system" }));
    expect(history[1]).toEqual({ role: "user", content: "查看项目名称" });
    expect(history[2]).toEqual({
      role: "assistant",
      content: "我来查看 package.json",
      toolCalls: [toolCall],
    });
    expect(history[3]).toEqual({
      role: "tool",
      toolCallId: "call_read_1",
      content: '1: {"name": "mini-swe-agent"}',
    });
  });

  it.each([
    { name: "交互终端显示彩色 diff", isTTY: true, noColor: undefined, colored: true },
    { name: "非交互终端显示纯文本 diff", isTTY: false, noColor: undefined, colored: false },
    { name: "NO_COLOR 禁用 diff 配色", isTTY: true, noColor: "1", colored: false },
  ])("$name，回填给模型的结果保持纯文本", async ({ isTTY, noColor, colored }) => {
    Object.defineProperty(process.stdout, "isTTY", {
      configurable: true,
      value: isTTY,
    });
    vi.stubEnv("NO_COLOR", noColor);
    vi.stubEnv("TERM", "xterm-256color");

    const toolCall: ToolCall = {
      id: "call_edit_1",
      name: "edit_file",
      arguments: { path: "example.ts", old_str: "old", new_str: "new" },
    };
    const toolResult =
      "文件修改成功：example.ts\n\n--- example.ts\n+++ example.ts\n@@ -1 +1 @@\n-old\n+new\n";
    mockCallModel
      .mockResolvedValueOnce({ role: "assistant", content: "", toolCalls: [toolCall] })
      .mockResolvedValueOnce({ role: "assistant", content: "修改完成" });
    mockExecuteTool.mockResolvedValueOnce(toolResult);

    const messages: Message[] = [];
    await runAgent("修改示例文件", messages);

    if (colored) {
      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining("\u001b[32m+new\u001b[39m"),
      );
      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining("\u001b[31m-old\u001b[39m"),
      );
    } else {
      expect(console.log).toHaveBeenCalledWith(toolResult);
    }
    expect(mockCallModel.mock.calls[1][0]).toContainEqual({
      role: "tool",
      toolCallId: toolCall.id,
      content: toolResult,
    });
  });

  it("达到最大步数时抛出错误，提示任务尚未完成", async () => {
    const toolCall: ToolCall = {
      id: "call_bash_loop",
      name: "run_bash",
      arguments: { command: "echo loop" },
    };

    mockCallModel.mockResolvedValue({
      role: "assistant",
      content: "继续重试",
      toolCalls: [toolCall],
    } satisfies ModelReply);
    mockExecuteTool.mockResolvedValue('{"stdout":"loop\\n"}');

    await expect(
      runAgent("陷入死循环的任务", [], { maxSteps: 3 }),
    ).rejects.toThrow(
      "已达到最大步数 3，任务尚未完成。",
    );
    expect(mockCallModel).toHaveBeenCalledTimes(3);
    expect(mockExecuteTool).toHaveBeenCalledTimes(3);
  });
  it("连续调用时复用 messages 累积会话上下文", async () => {
    mockCallModel
      .mockResolvedValueOnce({
        role: "assistant",
        content: "第一轮回复",
      } satisfies ModelReply)
      .mockResolvedValueOnce({
        role: "assistant",
        content: "第二轮回复",
      } satisfies ModelReply);

    const messages: Message[] = [];
    await runAgent("第1个问题", messages);
    await runAgent("第2个问题", messages);

    expect(mockCallModel).toHaveBeenCalledTimes(2);
    const secondTurnHistory = mockCallModel.mock.calls[1][0];
    expect(messages.map((m) => m.role)).toEqual([
      "system",
      "user",
      "assistant",
      "user",
      "assistant",
    ]);
  });

  it("若在工具执行阶段被打断，未执行工具回填 Cancelled by user 并退出", async () => {
    const controller = new AbortController();
    const toolCall1: ToolCall = {
      id: "call_1",
      name: "run_bash",
      arguments: { command: "echo 1" },
    };
    const toolCall2: ToolCall = {
      id: "call_2",
      name: "run_bash",
      arguments: { command: "echo 2" },
    };

    mockCallModel.mockResolvedValueOnce({
      role: "assistant",
      content: "准备执行两个工具",
      toolCalls: [toolCall1, toolCall2],
    } satisfies ModelReply);

    mockExecuteTool.mockImplementationOnce(async () => {
      controller.abort();
      return '{"stdout":"1"}';
    });

    const messages: Message[] = [];
    const result = await runAgent("执行任务", messages, {
      signal: controller.signal,
    });

    expect(result).toBe("操作已被用户打断。");
    expect(mockExecuteTool).toHaveBeenCalledTimes(1);
    expect(messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "tool",
          toolCallId: "call_1",
          content: '{"stdout":"1"}',
        }),
        expect.objectContaining({
          role: "tool",
          toolCallId: "call_2",
          content: "Cancelled by user",
        }),
      ]),
    );
  });

  describe("自动上下文压缩", () => {
    let messages: Message[];
    beforeEach(() => {
      vi.stubEnv("CONTEXT_WINDOW", "128000");
      mockCallModel.mockResolvedValue({ role: "assistant", content: "完成" });
      messages = [
        { role: "system", content: "先阅读，再修改。" },
        { role: "user", content: "旧任务".repeat(10000) },
        { role: "assistant", content: "旧任务已完成" },
        { role: "user", content: "近期上下文".repeat(16000) },
        { role: "assistant", content: "就绪", usage: { inputTokens: 111980, outputTokens: 20, totalTokens: 112000 } },
      ];
    });

    it("超过阈值时先摘要再继续任务，保留最新输入并统计摘要用量", async () => {
      const signal = new AbortController().signal;
      const onUsage = vi.fn();
      const usage = { inputTokens: 100, outputTokens: 20, totalTokens: 120 };
      mockCallModel.mockImplementationOnce(async (_messages, options) => {
        options.onUsage(usage);
        return { role: "assistant", content: "旧任务已完成，继续当前任务。" };
      });

      expect(await runAgent("继续", messages, { signal, onUsage })).toBe("完成");
      expect(mockCallModel).toHaveBeenCalledTimes(2);
      expect(mockCallModel.mock.calls[0][1]).toEqual({ tools: [], signal, onUsage });
      expect(onUsage).toHaveBeenCalledWith(usage);
      expect(messages[0]).toEqual({ role: "system", content: "先阅读，再修改。" });
      expect(messages[1].content).toContain("[历史摘要");
      expect(messages.at(-2)).toEqual({ role: "user", content: "继续" });
      expect(messages.filter((message) => message.role === "assistant").every((message) => !message.usage)).toBe(true);
    });

    it.each([0, 128000])("窗口为 %s，禁用或恰好达到阈值时不压缩", async (contextWindow) => {
      vi.stubEnv("CONTEXT_WINDOW", String(contextWindow));
      if (contextWindow) {
        messages[4] = { role: "assistant", content: "就绪", usage: { inputTokens: 111595, outputTokens: 20, totalTokens: 111615 } };
      }
      await runAgent("继续", messages);
      expect(mockCallModel).toHaveBeenCalledTimes(1);
      expect(mockCallModel.mock.calls[0][1]).not.toHaveProperty("tools");
    });

    it("工具回填超过阈值时在下一步压缩，保留调用与结果", async () => {
      messages[4] = { role: "assistant", content: "就绪" };
      const call: ToolCall = { id: "read_1", name: "read_file", arguments: { path: "a.ts" } };
      mockCallModel
        .mockResolvedValueOnce({ role: "assistant", content: "", toolCalls: [call], usage: { inputTokens: 111580, outputTokens: 20, totalTokens: 111600 } })
        .mockResolvedValueOnce({ role: "assistant", content: "旧任务摘要" });
      mockExecuteTool.mockResolvedValueOnce("工具结果".repeat(40));

      await runAgent("继续", messages);
      expect(mockCallModel).toHaveBeenCalledTimes(3);
      expect(mockCallModel.mock.calls[1][1]).toMatchObject({ tools: [] });
      expect(messages.at(-3)).toMatchObject({ role: "assistant", toolCalls: [call] });
      expect(messages.at(-2)).toEqual({ role: "tool", toolCallId: call.id, content: "工具结果".repeat(40) });
      expect(mockExecuteTool).toHaveBeenCalledTimes(1);
    });

    it.each(["调用失败", "摘要过长"])("%s 时保留历史并停止本轮任务", async (failure) => {
      const before = structuredClone(messages);
      if (failure === "调用失败") mockCallModel.mockRejectedValueOnce(new Error("网络断开"));
      else mockCallModel.mockResolvedValueOnce({ role: "assistant", content: "摘要".repeat(20000) });

      await expect(runAgent("继续", messages)).rejects.toThrow(failure === "调用失败" ? "网络断开" : "自动压缩未能将上下文降至预算内");
      expect(messages).toEqual([...before, { role: "user", content: "继续" }]);
      expect(mockCallModel).toHaveBeenCalledTimes(1);
      expect(mockExecuteTool).not.toHaveBeenCalled();
    });

    it("压缩后保留内容仍超过预算时停止，不继续调用模型", async () => {
      messages[3] = { role: "user", content: "近期上下文".repeat(100000) };
      mockCallModel.mockResolvedValueOnce({ role: "assistant", content: "旧任务摘要" });

      await expect(runAgent("继续", messages)).rejects.toThrow("自动压缩未能将上下文降至预算内");
      expect(mockCallModel).toHaveBeenCalledTimes(1);
      expect(messages[1].content).toContain("旧任务摘要");
      expect(messages.at(-1)).toEqual({ role: "user", content: "继续" });
    });

    it("摘要期间取消时保留历史，不再继续调用模型", async () => {
      const before = structuredClone(messages);
      const controller = new AbortController();
      mockCallModel.mockImplementationOnce(async () => {
        controller.abort();
        return { role: "assistant", content: "摘要" };
      });
      expect(await runAgent("继续", messages, { signal: controller.signal })).toBe("操作已被用户打断。");
      expect(messages).toEqual([...before, { role: "user", content: "继续" }, { role: "assistant", content: "操作已被用户取消。" }]);
      expect(mockCallModel).toHaveBeenCalledTimes(1);
    });

    it.each(["abc", "-1", "0.5", "36384"])("拒绝非法窗口 %s，保留历史且不调用模型", async (value) => {
      vi.stubEnv("CONTEXT_WINDOW", value);
      const before = structuredClone(messages);
      await expect(runAgent("继续", messages)).rejects.toThrow("CONTEXT_WINDOW");
      expect(messages).toEqual(before);
      expect(mockCallModel).not.toHaveBeenCalled();
    });
  });
});
