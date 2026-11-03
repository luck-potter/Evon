import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  callAnthropic,
  toAnthropicPayload,
  toAnthropicTools,
} from "../src/providers/anthropic.ts";
import type { Message } from "../src/types.ts";

const { createMessage } = vi.hoisted(() => ({ createMessage: vi.fn() }));

vi.mock("@anthropic-ai/sdk", () => ({
  default: class {
    messages = { create: createMessage };
  },
}));

describe("toAnthropicPayload", () => {
  it("提取顶层 system 消息，并将多个 system 消息以换行合并", () => {
    const messages: Message[] = [
      { role: "system", content: "规则 1" },
      { role: "user", content: "你好" },
      { role: "system", content: "规则 2" },
    ];
    const { system, messages: converted } = toAnthropicPayload(messages);

    expect(system).toBe("规则 1\n\n规则 2");
    expect(converted).toEqual([{ role: "user", content: "你好" }]);
  });

  it("折叠合并连续的 tool 结果到紧随其后的单个 user 消息（多个 tool_result blocks）", () => {
    const messages: Message[] = [
      { role: "user", content: "查询文件并列出目录" },
      {
        role: "assistant",
        content: "正在调用工具",
        toolCalls: [
          { id: "call_1", name: "read_file", arguments: { path: "a.txt" } },
          { id: "call_2", name: "ls", arguments: { path: ".", limit: 5 } },
        ],
      },
      { role: "tool", toolCallId: "call_1", content: "文件 A 内容" },
      { role: "tool", toolCallId: "call_2", content: "file1\nfile2" },
    ];

    const { messages: converted } = toAnthropicPayload(messages);

    expect(converted).toEqual([
      { role: "user", content: "查询文件并列出目录" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "正在调用工具" },
          {
            type: "tool_use",
            id: "call_1",
            name: "read_file",
            input: { path: "a.txt" },
          },
          {
            type: "tool_use",
            id: "call_2",
            name: "ls",
            input: { path: ".", limit: 5 },
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "call_1",
            content: "文件 A 内容",
          },
          {
            type: "tool_result",
            tool_use_id: "call_2",
            content: "file1\nfile2",
          },
        ],
      },
    ]);
  });

  it("相邻同角色消息自动合并以满足角色交替约束", () => {
    const messages: Message[] = [
      { role: "user", content: "第 1 条" },
      { role: "user", content: "第 2 条" },
    ];
    const { messages: converted } = toAnthropicPayload(messages);

    expect(converted).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "第 1 条" },
          { type: "text", text: "第 2 条" },
        ],
      },
    ]);
  });
});

describe("toAnthropicTools", () => {
  it("正确将工具定义转换为 Anthropic input_schema 格式", () => {
    const tools = toAnthropicTools([
      {
        type: "function",
        name: "test_tool",
        description: "测试工具",
        parameters: {
          type: "object",
          properties: { foo: { type: "string" } },
          required: ["foo"],
        },
        strict: true,
      },
    ]);

    expect(tools).toEqual([
      {
        name: "test_tool",
        description: "测试工具",
        input_schema: {
          type: "object",
          properties: { foo: { type: "string" } },
          required: ["foo"],
        },
      },
    ]);
  });
});

describe("callAnthropic", () => {
  beforeEach(() => {
    createMessage.mockReset();
    vi.stubEnv("ANTHROPIC_API_KEY", "test-key");
    vi.stubEnv("MODEL", "claude-3-5-sonnet-20241022");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("缺少 API KEY 或 MODEL 时抛出异常", async () => {
    vi.unstubAllEnvs();
    await expect(callAnthropic([])).rejects.toThrow("请在 .env 文件中设置");
  });

  it("当信号已打断时直接抛出错误", async () => {
    const controller = new AbortController();
    controller.abort(new Error("用户打断"));
    await expect(callAnthropic([], { signal: controller.signal })).rejects.toThrow("用户打断");
  });

  it("支持流式文本输出与 onTextDelta 回调", async () => {
    createMessage.mockResolvedValue(
      (async function* () {
        yield { type: "content_block_start", index: 0, content_block: { type: "text", text: "你好" } };
        yield { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "，世界" } };
        yield { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "！" } };
      })(),
    );

    const deltas: string[] = [];
    const reply = await callAnthropic([{ role: "user", content: "hi" }], {
      onTextDelta: (d) => deltas.push(d),
    });

    expect(reply).toEqual({
      role: "assistant",
      content: "你好，世界！",
    });
    expect(deltas).toEqual(["你好", "，世界", "！"]);
  });

  it("支持流式多工具分块拼接与校验", async () => {
    const onToolCall = vi.fn();
    createMessage.mockResolvedValue(
      (async function* () {
        // chunk 1: 工具 0 (read_file) 启动
        yield {
          type: "content_block_start",
          index: 0,
          content_block: { type: "tool_use", id: "tool_1", name: "read_file", input: {} },
        };
        // chunk 2: 工具 1 (ls) 启动 + 工具 0 参数片段
        yield {
          type: "content_block_delta",
          index: 0,
          delta: { type: "input_json_delta", partial_json: '{"path":' },
        };
        yield {
          type: "content_block_start",
          index: 1,
          content_block: { type: "tool_use", id: "tool_2", name: "ls", input: {} },
        };
        // chunk 3: 工具 0 补全 + 工具 1 参数片段
        yield {
          type: "content_block_delta",
          index: 0,
          delta: { type: "input_json_delta", partial_json: '"foo.txt"}' },
        };
        yield {
          type: "content_block_delta",
          index: 1,
          delta: { type: "input_json_delta", partial_json: '{"path":".","limit":5}' },
        };
      })(),
    );

    const reply = await callAnthropic([], { onToolCall });

    expect(onToolCall).toHaveBeenCalledTimes(2);
    expect(onToolCall).toHaveBeenNthCalledWith(1, { name: "read_file" });
    expect(onToolCall).toHaveBeenNthCalledWith(2, { name: "ls" });

    expect(reply.toolCalls).toEqual([
      {
        id: "tool_1",
        name: "read_file",
        arguments: { path: "foo.txt" },
      },
      {
        id: "tool_2",
        name: "ls",
        arguments: { path: ".", limit: 5 },
      },
    ]);
  });

  it("兼容 thinking_delta 思维链并触发 onTextDelta 且不混入回复 content", async () => {
    createMessage.mockResolvedValue(
      (async function* () {
        yield {
          type: "content_block_delta",
          index: 0,
          delta: { type: "thinking_delta", thinking: "思考规划中..." },
        };
        yield {
          type: "content_block_delta",
          index: 1,
          delta: { type: "text_delta", text: "最终答案" },
        };
      })(),
    );

    const deltas: string[] = [];
    const reply = await callAnthropic([], {
      onTextDelta: (d) => deltas.push(d),
    });

    expect(reply.content).toBe("最终答案");
    expect(deltas).toEqual(["思考规划中...", "最终答案"]);
  });

  it("当因达到 max_tokens 截断时抛出错误", async () => {
    createMessage.mockResolvedValue(
      (async function* () {
        yield {
          type: "message_delta",
          delta: { stop_reason: "max_tokens" },
        };
      })(),
    );

    await expect(callAnthropic([])).rejects.toThrow("输出达到最大长度被截断");
  });

  it("正确收集 Token 用量并触发 onUsage", async () => {
    const onUsage = vi.fn();
    createMessage.mockResolvedValue(
      (async function* () {
        yield {
          type: "message_start",
          message: {
            usage: { input_tokens: 42, output_tokens: 1 },
          },
        };
        yield {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "回答完毕" },
        };
        yield {
          type: "message_delta",
          delta: { stop_reason: "end_turn" },
          usage: { output_tokens: 18 },
        };
      })(),
    );

    const reply = await callAnthropic([], { onUsage });

    expect(onUsage).toHaveBeenCalledWith({
      inputTokens: 42,
      outputTokens: 18,
      totalTokens: 60,
    });
    expect(reply.usage).toEqual({
      inputTokens: 42,
      outputTokens: 18,
      totalTokens: 60,
    });
  });

  it("无 usage 时触发 onUsage(null)", async () => {
    const onUsage = vi.fn();
    createMessage.mockResolvedValue(
      (async function* () {
        yield {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "回答完毕" },
        };
      })(),
    );

    const reply = await callAnthropic([], { onUsage });

    expect(onUsage).toHaveBeenCalledWith(null);
    expect(reply.usage).toBeUndefined();
  });

  it("当显式传空 tools 时不在请求中带 tools 参数", async () => {
    createMessage.mockResolvedValue(
      (async function* () {
        yield {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "ok" },
        };
      })(),
    );

    await callAnthropic([], { tools: [] });

    expect(createMessage).toHaveBeenCalledWith(
      expect.not.objectContaining({ tools: expect.anything() }),
    );
  });

  it("在流式迭代中如果 signal 中断则抛出异常", async () => {
    const controller = new AbortController();
    createMessage.mockResolvedValue(
      (async function* () {
        yield {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "1" },
        };
        controller.abort(new Error("中途打断"));
        yield {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "2" },
        };
      })(),
    );

    await expect(callAnthropic([], { signal: controller.signal })).rejects.toThrow(
      "中途打断",
    );
  });
});
