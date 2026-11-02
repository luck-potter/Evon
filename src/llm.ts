import type {
  Message,
  ModelReply,
  TokenUsage,
  ToolCall as AgentToolCall,
} from "./types.ts";
import { toolDefinitions } from "./tool-definitions.ts";
import OpenAI from "openai";

export type ToolCall = OpenAI.Responses.ResponseFunctionToolCall;

export interface CallOptions {
  onTextDelta?: (delta: string) => void;
  onToolCall?: (call: { name: string }) => void;
  onUsage?: (usage: TokenUsage | null) => void;
  signal?: AbortSignal;
}

const toolArgKeys: Record<string, string[]> = {
  run_bash: ["command"],
  ls: ["path"],
  grep: ["pattern"],
  find_files: ["pattern"],
  read_file: ["path"],
  write_file: ["path", "content"],
  edit_file: ["path", "old_str", "new_str"],
};

function parseToolCall(call: ToolCall): AgentToolCall {
  if (!call.call_id) throw new Error(`工具 ${call.name} 缺少 call_id。`);

  let args: unknown;
  try {
    args = JSON.parse(call.arguments);
  } catch {
    throw new Error(`工具 ${call.name} 的参数不是有效 JSON。`);
  }

  if (args === null || typeof args !== "object" || Array.isArray(args)) {
    throw new Error(`工具 ${call.name} 的参数必须是对象。`);
  }

  const keys = toolArgKeys[call.name];
  if (!keys) throw new Error(`未知工具：${call.name}`);

  const values = args as Record<string, unknown>;
  for (const key of keys) {
    if (typeof values[key] !== "string") {
      throw new Error(`工具 ${call.name} 的参数 ${key} 必须是字符串。`);
    }
  }

  return {
    id: call.call_id,
    name: call.name,
    arguments: values,
  } as AgentToolCall;
}

function toResponseInput(messages: Message[]): OpenAI.Responses.ResponseInput {
  return messages.flatMap((message): OpenAI.Responses.ResponseInput => {
    if (message.role === "tool") {
      return [
        {
          type: "function_call_output",
          call_id: message.toolCallId,
          output: message.content,
        },
      ];
    }

    const input: OpenAI.Responses.ResponseInput = [];
    if (message.role !== "assistant" || message.content) {
      input.push({ role: message.role, content: message.content });
    }

    if (message.role === "assistant") {
      for (const call of message.toolCalls ?? []) {
        input.push({
          type: "function_call",
          call_id: call.id,
          name: call.name,
          arguments: JSON.stringify(call.arguments),
        });
      }
    }

    return input;
  });
}

export async function callModel(
  message: Message[],
  options?: CallOptions,
): Promise<ModelReply> {
  if (!process.env.BASE_URL || !process.env.MODEL || !process.env.API_KEY) {
    throw new Error("请在 .env 文件中设置 BASE_URL、MODEL 和 API_KEY。");
  }

  const client = new OpenAI({
    apiKey: process.env.API_KEY,
    baseURL: process.env.BASE_URL,
  });

  let completedResponse: OpenAI.Responses.Response | undefined;
  let streamedText = "";

  if (options?.signal?.aborted) {
    throw options.signal.reason ?? new Error("Request was aborted.");
  }

  const stream = await client.responses.create(
    {
      model: process.env.MODEL,
      input: toResponseInput(message),
      tools: toolDefinitions,
      stream: true,
    },
    ...(options?.signal ? [{ signal: options.signal }] : []),
  );

  for await (const event of stream) {
    if (options?.signal?.aborted) {
      throw options.signal.reason ?? new Error("Request was aborted.");
    }
    if (event.type === "response.output_text.delta") {
      streamedText += event.delta;
      options?.onTextDelta?.(event.delta);
    } else if (event.type === "response.output_item.added") {
      if (event.item.type === "function_call") {
        options?.onToolCall?.({ name: event.item.name });
      }
    } else if (event.type === "response.completed") {
      completedResponse = event.response;
      // TODO 1：将 response.usage 转换为 TokenUsage，通过 onUsage 上报。
      // TODO：约定缺失用量、请求失败或取消时的上报方式，避免重复上报。
    } else if (event.type === "response.failed") {
      throw new Error(
        `模型回复失败：${event.response.error?.message ?? "未知错误"}`,
      );
    } else if (event.type === "response.incomplete") {
      const reason =
        event.response.incomplete_details?.reason ?? event.response.status;
      throw new Error(`模型回复未完成：${reason}`);
    } else if (event.type === "error") {
      throw new Error(`模型回复失败：${event.message}`);
    }
  }

  if (!completedResponse) {
    throw new Error("模型未返回有效回复。");
  }

  if (completedResponse.error) {
    throw new Error(`模型回复失败：${completedResponse.error.message}`);
  }

  if (completedResponse.status && completedResponse.status !== "completed") {
    const reason =
      completedResponse.incomplete_details?.reason ?? completedResponse.status;
    throw new Error(`模型回复未完成：${reason}`);
  }

  const toolCalls = completedResponse.output
    .filter((item): item is ToolCall => item.type === "function_call")
    .map(parseToolCall);

  return {
    role: "assistant",
    content: completedResponse.output_text || streamedText,
    ...(toolCalls.length ? { toolCalls } : {}),
  };
}
