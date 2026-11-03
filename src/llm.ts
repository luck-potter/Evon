import type {
  Message,
  ModelReply,
  TokenUsage,
  ToolCall as AgentToolCall,
} from "./types.ts";
import { validateToolCall } from "./tool-validation.ts";
import { toolDefinitions } from "./tool-definitions.ts";
import { callOpenAIChat } from "./providers/openai-chat.ts";
import { callAnthropic } from "./providers/anthropic.ts";
import OpenAI from "openai";

export type ToolCall = OpenAI.Responses.ResponseFunctionToolCall;

export type Provider = "openai-chat" | "openai-responses" | "anthropic";

export interface CallOptions {
  tools?: typeof toolDefinitions;
  onTextDelta?: (delta: string) => void;
  onToolCall?: (call: { name: string }) => void;
  onUsage?: (usage: TokenUsage | null) => void | Promise<void>;
  signal?: AbortSignal;
}

export function resolveProvider(env: NodeJS.ProcessEnv = process.env): Provider {
  const raw = env.PROVIDER?.trim().toLowerCase();
  if (raw) {
    if (raw === "openai-chat" || raw === "deepseek") return "openai-chat";
    if (raw === "openai-responses") return "openai-responses";
    if (raw === "anthropic" || raw === "claude") return "anthropic";
    throw new Error(
      `不支持的 PROVIDER: "${env.PROVIDER}"。可选值为 openai-chat、openai-responses、anthropic。`,
    );
  }

  const baseUrl = env.BASE_URL?.toLowerCase() ?? "";
  const model = (env.MODEL || env.ANTHROPIC_MODEL || "")?.toLowerCase();
  if (model.startsWith("claude") || env.ANTHROPIC_API_KEY) {
    return "anthropic";
  }

  if (baseUrl.includes("deepseek") || model.includes("deepseek")) {
    return "openai-chat";
  }

  return "openai-responses";
}

// 原来的 parseToolCall 简化为代理调用
function parseToolCall(call: ToolCall): AgentToolCall {
  return validateToolCall(call.call_id, call.name, call.arguments);
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

async function callOpenAIResponses(
  messages: Message[],
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
  let tokenUsage: TokenUsage | undefined;

  if (options?.signal?.aborted) {
    throw options.signal.reason ?? new Error("Request was aborted.");
  }

  const stream = await client.responses.create(
    {
      model: process.env.MODEL,
      input: toResponseInput(messages),
      tools: options?.tools ?? toolDefinitions,
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
      const usage = event.response.usage;
      if (usage) {
        tokenUsage = {
          inputTokens: usage.input_tokens ?? 0,
          outputTokens: usage.output_tokens ?? 0,
          totalTokens: usage.total_tokens ?? 0,
        };
        await options?.onUsage?.(tokenUsage);
      } else {
        await options?.onUsage?.(null);
      }
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
    ...(tokenUsage ? { usage: tokenUsage } : {}),
  };
}

export async function callModel(
  messages: Message[],
  options?: CallOptions,
): Promise<ModelReply> {
  const provider = resolveProvider();
  if (provider === "anthropic") {
    return callAnthropic(messages, options);
  }
  if (provider === "openai-chat") {
    return callOpenAIChat(messages, options);
  }
  return callOpenAIResponses(messages, options);
}
