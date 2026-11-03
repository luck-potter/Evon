import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { callModel, resolveProvider } from "../src/llm.ts";

const { createResponse, createChat, createAnthropicMessage } = vi.hoisted(() => ({
  createResponse: vi.fn(),
  createChat: vi.fn(),
  createAnthropicMessage: vi.fn(),
}));

vi.mock("openai", () => ({
  default: class {
    responses = { create: createResponse };
    chat = { completions: { create: createChat } };
  },
}));

vi.mock("@anthropic-ai/sdk", () => ({
  default: class {
    messages = { create: createAnthropicMessage };
  },
}));

function functionCall(name: string, args: unknown) {
  return {
    type: "function_call",
    id: `fc_${name}`,
    call_id: `call_${name}`,
    name,
    arguments: JSON.stringify(args),
  };
}

function response(
  output: unknown[] = [],
  text = "",
  extras?: {
    status?: string;
    error?: { message: string } | null;
    incomplete_details?: { reason: string } | null;
    usage?: { input_tokens: number; output_tokens: number; total_tokens: number } | null;
  },
) {
  return (async function* () {
    if (text) {
      yield { type: "response.output_text.delta", delta: text };
    }
    for (const item of output) {
      yield { type: "response.output_item.added", item };
    }
    const status = extras?.status ?? "completed";
    if (status === "failed") {
      yield {
        type: "response.failed",
        response: {
          status: "failed",
          error: extras?.error ?? { message: "生成失败" },
          output,
          output_text: text,
        },
      };
      return;
    }
    if (status === "incomplete") {
      yield {
        type: "response.incomplete",
        response: {
          status: "incomplete",
          incomplete_details: extras?.incomplete_details ?? { reason: "max_output_tokens" },
          output,
          output_text: text,
        },
      };
      return;
    }
    yield {
      type: "response.completed",
      response: {
        status: "completed",
        error: null,
        incomplete_details: null,
        output,
        output_text: text,
        ...(extras?.usage !== undefined ? { usage: extras.usage } : {}),
      },
    };
  })();
}

describe("callModel", () => {
  beforeEach(() => {
    createResponse.mockReset();
    createChat.mockReset();
    createAnthropicMessage.mockReset();
    vi.stubEnv("BASE_URL", "https://model.invalid/v1");
    vi.stubEnv("API_KEY", "test-key");
    vi.stubEnv("MODEL", "test-model");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("返回真实文本，并将任务传给模型", async () => {
    createResponse.mockResolvedValue(response([], "第一行\n  第二行\n"));
    const messages = [{ role: "user" as const, content: "介绍当前项目" }];

    await expect(callModel(messages)).resolves.toEqual({
      role: "assistant",
      content: "第一行\n  第二行\n",
    });
    expect(createResponse).toHaveBeenCalledWith(expect.objectContaining({
      model: "test-model",
      input: messages,
      stream: true,
    }));
  });

  it("解析已注册工具，使用 call_id 并保留参数值", async () => {
    const calls = [
      { name: "run_bash", args: { command: "printf '你好\n'" } },
      { name: "ls", args: { path: "目录", limit: 3 } },
      { name: "grep", args: { pattern: "runAgent", path: "src", glob: "*.ts", literal: true, ignoreCase: false, limit: 10 } },
      { name: "find_files", args: { pattern: "**/*.test.ts", path: null, limit: null } },
      { name: "read_file", args: { path: "目录/文件.txt" } },
      { name: "write_file", args: { path: "empty.txt", content: "" } },
      { name: "edit_file", args: { path: "a.ts", old_str: "旧\n$&", new_str: "" } },
    ];
    createResponse.mockResolvedValue(response(
      calls.map(({ name, args }) => functionCall(name, args)),
      "先检查代码",
    ));

    await expect(callModel([])).resolves.toEqual({
      role: "assistant",
      content: "先检查代码",
      toolCalls: calls.map(({ name, args }) => ({
        id: `call_${name}`,
        name,
        arguments: args,
      })),
    });
    expect(createResponse.mock.calls[0]?.[0].tools).toContainEqual(expect.objectContaining({
      name: "find_files",
      strict: true,
    }));
  });

  it("将返回的工具调用和执行结果正确回填到下一轮输入", async () => {
    createResponse
      .mockResolvedValueOnce(response([functionCall("read_file", { path: "README.md" })], "", {
        usage: { input_tokens: 12, output_tokens: 5, total_tokens: 17 },
      }))
      .mockResolvedValueOnce(response([], "已读完"));
    const task = { role: "user" as const, content: "读取 README.md" };
    const reply = await callModel([task]);
    expect(reply.usage).toEqual({ inputTokens: 12, outputTokens: 5, totalTokens: 17 });

    await callModel([
      task,
      reply,
      { role: "tool", toolCallId: "call_read_file", content: "1: 项目说明" },
    ]);

    expect(createResponse.mock.calls[1]?.[0].input).toEqual([
      task,
      {
        type: "function_call",
        call_id: "call_read_file",
        name: "read_file",
        arguments: "{\"path\":\"README.md\"}",
      },
      {
        type: "function_call_output",
        call_id: "call_read_file",
        output: "1: 项目说明",
      },
    ]);
  });

  it("拒绝格式损坏的工具参数 JSON", async () => {
    createResponse.mockResolvedValue(response([{
      ...functionCall("read_file", {}),
      arguments: "{",
    }]));
    await expect(callModel([])).rejects.toThrow("不是有效 JSON");
  });

  it.each([null, [], 42, "README.md"])("拒绝非对象参数 %j", async (args) => {
    createResponse.mockResolvedValue(response([functionCall("read_file", args)]));
    await expect(callModel([])).rejects.toThrow("参数必须是对象");
  });

  it.each([{}, { path: 42 }])("拒绝缺失或类型错误的必填参数 %j", async (args) => {
    createResponse.mockResolvedValue(response([functionCall("read_file", args)]));
    await expect(callModel([])).rejects.toThrow("参数 path 必须是字符串");
  });

  it("拒绝未知工具", async () => {
    createResponse.mockResolvedValue(response([functionCall("unknown_tool", {})]));
    await expect(callModel([])).rejects.toThrow("未知工具：unknown_tool");
  });

  it.each([{}, { pattern: 42 }])("拒绝 find_files 缺失或类型错误的模式 %j", async (args) => {
    createResponse.mockResolvedValue(response([functionCall("find_files", args)]));
    await expect(callModel([])).rejects.toThrow("工具 find_files 的参数 pattern 必须是字符串");
  });

  it("拒绝缺少关联 ID 的工具调用", async () => {
    createResponse.mockResolvedValue(response([{
      ...functionCall("read_file", { path: "README.md" }),
      call_id: "",
    }]));
    await expect(callModel([])).rejects.toThrow("缺少 call_id");
  });

  it("将生成失败作为错误返回", async () => {
    createResponse.mockResolvedValue(
      response([], "", {
        status: "failed",
        error: { message: "生成失败" },
      }),
    );
    await expect(callModel([])).rejects.toThrow("模型回复失败：生成失败");
  });

  it("不将截断的回复当作完整结果", async () => {
    createResponse.mockResolvedValue(
      response([], "尚未完成的文本", {
        status: "incomplete",
        incomplete_details: { reason: "max_output_tokens" },
      }),
    );
    await expect(callModel([])).rejects.toThrow("模型回复未完成：max_output_tokens");
  });

  it("触发 onTextDelta 和 onToolCall 回调", async () => {
    const onTextDelta = vi.fn();
    const onToolCall = vi.fn();
    createResponse.mockResolvedValue(
      response([functionCall("read_file", { path: "a.txt" })], "思考中..."),
    );

    await callModel([], { onTextDelta, onToolCall });

    expect(onTextDelta).toHaveBeenCalledWith("思考中...");
    expect(onToolCall).toHaveBeenCalledWith({ name: "read_file" });
  });

  it("当返回 usage 时触发 onUsage，并将转换后的用量保存在回复中", async () => {
    const onUsage = vi.fn();
    createResponse.mockResolvedValue(
      response([], "ok", {
        usage: { input_tokens: 12, output_tokens: 5, total_tokens: 17 },
      }),
    );

    const reply = await callModel([], { onUsage });

    expect(onUsage).toHaveBeenCalledWith({
      inputTokens: 12,
      outputTokens: 5,
      totalTokens: 17,
    });
    expect(reply.usage).toEqual({ inputTokens: 12, outputTokens: 5, totalTokens: 17 });
  });

  it.each([undefined, null])("当 usage 为 %j 时触发 onUsage(null)，回复不附带用量", async (usage) => {
    const onUsage = vi.fn();
    createResponse.mockResolvedValue(response([], "ok", { usage }));

    const reply = await callModel([], { onUsage });

    expect(onUsage).toHaveBeenCalledWith(null);
    expect(reply).not.toHaveProperty("usage");
  });

  it.each([undefined, { input_tokens: 10, output_tokens: 5, total_tokens: 15 }])("等待异步用量保存，写入失败时拒绝返回回复 %#", async usage => {
    createResponse.mockResolvedValue(response([], "回复", { usage }));
    const onUsage = async () => {
      await new Promise(resolve => setImmediate(resolve));
      throw new Error("用量写入失败");
    };
    await expect(callModel([], { onUsage })).rejects.toThrow("用量写入失败");
  });

  it("当 stream 抛出 error 事件时抛出错误", async () => {
    createResponse.mockResolvedValue(
      (async function* () {
        yield { type: "error", message: "网络连接中断" };
      })(),
    );
    await expect(callModel([])).rejects.toThrow("模型回复失败：网络连接中断");
  });

  it("透传 signal 给 OpenAI SDK", async () => {
    createResponse.mockResolvedValue(response([], "ok"));
    const controller = new AbortController();

    await callModel([], { signal: controller.signal });

    expect(createResponse).toHaveBeenCalledWith(
      expect.anything(),
      { signal: controller.signal },
    );
  });

  it("摘要请求可以显式关闭工具", async () => {
    createResponse.mockResolvedValue(response([], "历史摘要"));
    await callModel([], { tools: [] });
    expect(createResponse).toHaveBeenCalledWith(expect.objectContaining({ tools: [] }));
  });

  it("当 signal 已打断或在流式接收过程中被打断时抛出错误", async () => {
    const controller = new AbortController();
    controller.abort(new Error("用户打断"));

    await expect(callModel([], { signal: controller.signal })).rejects.toThrow(
      "用户打断",
    );
  });
});

describe("resolveProvider", () => {
  it("未配置且非 deepseek 时默认返回 openai-responses", () => {
    expect(resolveProvider({})).toBe("openai-responses");
  });

  it("支持显式配置 PROVIDER 并支持别名与大小写容错", () => {
    expect(resolveProvider({ PROVIDER: "openai-chat" })).toBe("openai-chat");
    expect(resolveProvider({ PROVIDER: "  OPENAI-CHAT  " })).toBe("openai-chat");
    expect(resolveProvider({ PROVIDER: "openai-responses" })).toBe("openai-responses");
    expect(resolveProvider({ PROVIDER: "deepseek" })).toBe("openai-chat");
    expect(resolveProvider({ PROVIDER: "anthropic" })).toBe("anthropic");
    expect(resolveProvider({ PROVIDER: "claude" })).toBe("anthropic");
  });

  it("未配置 PROVIDER 时若 BASE_URL 或 MODEL 包含 deepseek 则自动选 openai-chat", () => {
    expect(resolveProvider({ BASE_URL: "https://api.deepseek.com/v1" })).toBe("openai-chat");
    expect(resolveProvider({ MODEL: "deepseek-chat" })).toBe("openai-chat");
    expect(resolveProvider({ MODEL: "DeepSeek-R1" })).toBe("openai-chat");
  });

  it("未配置 PROVIDER 时若 MODEL 以 claude 开头或设置 ANTHROPIC_API_KEY 则自动选 anthropic", () => {
    expect(resolveProvider({ MODEL: "claude-3-5-sonnet" })).toBe("anthropic");
    expect(resolveProvider({ ANTHROPIC_API_KEY: "ant-key" })).toBe("anthropic");
  });

  it("指定不支持的 PROVIDER 时抛出异常", () => {
    expect(() => resolveProvider({ PROVIDER: "unsupported-provider" })).toThrow(
      "不支持的 PROVIDER",
    );
  });
});

describe("callModel 路由分发", () => {
  beforeEach(() => {
    createResponse.mockReset();
    createChat.mockReset();
    vi.stubEnv("BASE_URL", "https://model.invalid/v1");
    vi.stubEnv("API_KEY", "test-key");
    vi.stubEnv("MODEL", "test-model");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("当 PROVIDER=openai-chat 时分发至 chat.completions.create", async () => {
    vi.stubEnv("PROVIDER", "openai-chat");
    createChat.mockResolvedValue(
      (async function* () {
        yield { choices: [{ delta: { content: "来自 chat" } }] };
      })(),
    );

    const reply = await callModel([{ role: "user", content: "hi" }]);
    expect(reply.content).toBe("来自 chat");
    expect(createChat).toHaveBeenCalled();
    expect(createResponse).not.toHaveBeenCalled();
  });

  it("当未指定 PROVIDER 且 MODEL 含 deepseek 时自动分发至 chat.completions.create", async () => {
    vi.stubEnv("MODEL", "deepseek-chat");
    createChat.mockResolvedValue(
      (async function* () {
        yield { choices: [{ delta: { content: "来自 deepseek" } }] };
      })(),
    );

    const reply = await callModel([{ role: "user", content: "hi" }]);
    expect(reply.content).toBe("来自 deepseek");
    expect(createChat).toHaveBeenCalled();
    expect(createResponse).not.toHaveBeenCalled();
  });

  it("当 PROVIDER=anthropic 时分发至 Anthropic messages.create", async () => {
    vi.stubEnv("PROVIDER", "anthropic");
    vi.stubEnv("ANTHROPIC_API_KEY", "ant-key");
    vi.stubEnv("MODEL", "claude-3-5-sonnet");
    createAnthropicMessage.mockResolvedValue(
      (async function* () {
        yield {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "来自 claude" },
        };
      })(),
    );

    const reply = await callModel([{ role: "user", content: "hi" }]);
    expect(reply.content).toBe("来自 claude");
    expect(createAnthropicMessage).toHaveBeenCalled();
    expect(createResponse).not.toHaveBeenCalled();
    expect(createChat).not.toHaveBeenCalled();
  });
});
