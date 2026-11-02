import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { callModel } from "../src/llm.ts";

const { createResponse } = vi.hoisted(() => ({ createResponse: vi.fn() }));

vi.mock("openai", () => ({
  default: class {
    responses = { create: createResponse };
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
      },
    };
  })();
}

describe("callModel", () => {
  beforeEach(() => {
    createResponse.mockReset();
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
  });

  it("将返回的工具调用和执行结果正确回填到下一轮输入", async () => {
    createResponse
      .mockResolvedValueOnce(response([functionCall("read_file", { path: "README.md" })]))
      .mockResolvedValueOnce(response([], "已读完"));
    const task = { role: "user" as const, content: "读取 README.md" };
    const reply = await callModel([task]);

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

  it("当 signal 已打断或在流式接收过程中被打断时抛出错误", async () => {
    const controller = new AbortController();
    controller.abort(new Error("用户打断"));

    await expect(callModel([], { signal: controller.signal })).rejects.toThrow(
      "用户打断",
    );
  });
});
