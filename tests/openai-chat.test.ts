import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { callOpenAIChat } from "../src/providers/openai-chat.ts";
import type { Message } from "../src/types.ts";

const { createChat } = vi.hoisted(() => ({ createChat: vi.fn() }));

vi.mock("openai", () => ({
  default: class {
    chat = { completions: { create: createChat } };
  },
}));

describe("callOpenAIChat", () => {
  beforeEach(() => {
    createChat.mockReset();
    vi.stubEnv("BASE_URL", "https://api.openai.com/v1");
    vi.stubEnv("API_KEY", "test-key");
    vi.stubEnv("MODEL", "gpt-4o");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("当缺少环境变量时抛出错误", async () => {
    vi.unstubAllEnvs();
    await expect(callOpenAIChat([])).rejects.toThrow("请在 .env 文件中设置");
  });

  it("当信号已打断时直接抛出错误", async () => {
    const controller = new AbortController();
    controller.abort(new Error("已打断"));
    await expect(callOpenAIChat([], { signal: controller.signal })).rejects.toThrow("已打断");
  });

  it("支持流式文本输出与 onTextDelta 回调", async () => {
    createChat.mockResolvedValue(
      (async function* () {
        yield { choices: [{ delta: { content: "Hello " } }] };
        yield { choices: [{ delta: { content: "World!" } }] };
      })(),
    );

    const deltas: string[] = [];
    const reply = await callOpenAIChat([{ role: "user", content: "hi" }], {
      onTextDelta: (d) => deltas.push(d),
    });

    expect(reply).toEqual({
      role: "assistant",
      content: "Hello World!",
    });
    expect(deltas).toEqual(["Hello ", "World!"]);
  });

  it("正确映射各种角色的消息格式", async () => {
    createChat.mockResolvedValue(
      (async function* () {
        yield { choices: [{ delta: { content: "ok" } }] };
      })(),
    );

    const messages: Message[] = [
      { role: "system", content: "sys prompt" },
      { role: "user", content: "user prompt" },
      {
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "call_1",
            name: "read_file",
            arguments: { path: "a.txt" },
          },
        ],
      },
      { role: "tool", toolCallId: "call_1", content: "file content" },
      { role: "assistant", content: "previous plain reply" },
    ];

    await callOpenAIChat(messages);

    expect(createChat).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: [
          { role: "system", content: "sys prompt" },
          { role: "user", content: "user prompt" },
          {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call_1",
                type: "function",
                function: {
                  name: "read_file",
                  arguments: JSON.stringify({ path: "a.txt" }),
                },
              },
            ],
          },
          { role: "tool", tool_call_id: "call_1", content: "file content" },
          { role: "assistant", content: "previous plain reply" },
        ],
      }),
    );
  });

  it("支持流式多工具分块拼接与校验", async () => {
    const onToolCall = vi.fn();
    createChat.mockResolvedValue(
      (async function* () {
        // chunk 1: 工具 0 初始化
        yield {
          choices: [
            {
              delta: {
                tool_calls: [
                  { index: 0, id: "call_1", function: { name: "read_file" } },
                ],
              },
            },
          ],
        };
        // chunk 2: 工具 1 初始化 + 工具 0 参数片段
        yield {
          choices: [
            {
              delta: {
                tool_calls: [
                  { index: 0, function: { arguments: '{"path":' } },
                  { index: 1, id: "call_2", function: { name: "run_bash" } },
                ],
              },
            },
          ],
        };
        // chunk 3: 工具 0 参数补全 + 工具 1 参数片段
        yield {
          choices: [
            {
              delta: {
                tool_calls: [
                  { index: 0, function: { arguments: '"foo.txt"}' } },
                  { index: 1, function: { arguments: '{"command":"ls"}' } },
                ],
              },
            },
          ],
        };
      })(),
    );

    const reply = await callOpenAIChat([], { onToolCall });

    expect(onToolCall).toHaveBeenCalledTimes(2);
    expect(onToolCall).toHaveBeenNthCalledWith(1, { name: "read_file" });
    expect(onToolCall).toHaveBeenNthCalledWith(2, { name: "run_bash" });

    expect(reply.toolCalls).toEqual([
      {
        id: "call_1",
        name: "read_file",
        arguments: { path: "foo.txt" },
      },
      {
        id: "call_2",
        name: "run_bash",
        arguments: { command: "ls" },
      },
    ]);
  });

  it("兼容 DeepSeek-R1 的 reasoning_content 且不混入回复 content", async () => {
    createChat.mockResolvedValue(
      (async function* () {
        yield { choices: [{ delta: { reasoning_content: "思考中..." } as any }] };
        yield { choices: [{ delta: { content: "最终回答" } }] };
      })(),
    );

    const deltas: string[] = [];
    const reply = await callOpenAIChat([], {
      onTextDelta: (d) => deltas.push(d),
    });

    expect(reply.content).toBe("最终回答");
    expect(deltas).toEqual(["思考中...", "最终回答"]);
  });

  it("当回复被最大长度截断时抛出错误", async () => {
    createChat.mockResolvedValue(
      (async function* () {
        yield { choices: [{ delta: { content: "一部分文本" }, finish_reason: "length" }] };
      })(),
    );

    await expect(callOpenAIChat([])).rejects.toThrow("输出达到最大长度被截断");
  });

  it("正确收集 Token 用量并触发 onUsage", async () => {
    const onUsage = vi.fn();
    createChat.mockResolvedValue(
      (async function* () {
        yield { choices: [{ delta: { content: "完成" } }] };
        yield {
          usage: {
            prompt_tokens: 15,
            completion_tokens: 8,
            total_tokens: 23,
          },
        };
      })(),
    );

    const reply = await callOpenAIChat([], { onUsage });

    expect(onUsage).toHaveBeenCalledWith({
      inputTokens: 15,
      outputTokens: 8,
      totalTokens: 23,
    });
    expect(reply.usage).toEqual({
      inputTokens: 15,
      outputTokens: 8,
      totalTokens: 23,
    });
  });

  it("无 usage 时触发 onUsage(null)", async () => {
    const onUsage = vi.fn();
    createChat.mockResolvedValue(
      (async function* () {
        yield { choices: [{ delta: { content: "完成" } }] };
      })(),
    );

    const reply = await callOpenAIChat([], { onUsage });

    expect(onUsage).toHaveBeenCalledWith(null);
    expect(reply.usage).toBeUndefined();
  });

  it("当显式传空 tools 时不在请求中带 tools 参数", async () => {
    createChat.mockResolvedValue(
      (async function* () {
        yield { choices: [{ delta: { content: "ok" } }] };
      })(),
    );

    await callOpenAIChat([], { tools: [] });

    expect(createChat).toHaveBeenCalledWith(
      expect.not.objectContaining({ tools: expect.anything() }),
    );
  });

  it("在流式迭代中如果 signal 中断则抛出异常", async () => {
    const controller = new AbortController();
    createChat.mockResolvedValue(
      (async function* () {
        yield { choices: [{ delta: { content: "1" } }] };
        controller.abort(new Error("中途取消"));
        yield { choices: [{ delta: { content: "2" } }] };
      })(),
    );

    await expect(callOpenAIChat([], { signal: controller.signal })).rejects.toThrow(
      "中途取消",
    );
  });
});
