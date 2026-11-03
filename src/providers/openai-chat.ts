import OpenAI from "openai";
import type {
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from "openai/resources/chat/completions.js";
import { toolDefinitions } from "../tool-definitions.ts";
import { validateToolCall } from "../tool-validation.ts";
import type { CallOptions } from "../llm.ts";
import type { Message, ModelReply, TokenUsage } from "../types.ts";

/**
 * 1. 消息格式映射：项目内部 Message[] -> OpenAI ChatCompletionMessageParam[]
 */
function toChatMessages(messages: Message[]): ChatCompletionMessageParam[] {
  return messages.map((message): ChatCompletionMessageParam => {
    switch (message.role) {
      case "system":
      case "user":
        return { role: message.role, content: message.content };
      case "assistant": {
        const hasToolCalls = Boolean(message.toolCalls?.length);
        return {
          role: "assistant",
          // OpenAI 规范：仅在有 tool_calls 且无正文时 content 填 null；否则填字符串
          content: message.content || (hasToolCalls ? null : ""),
          ...(hasToolCalls
            ? {
                tool_calls: message.toolCalls!.map((tc) => ({
                  id: tc.id,
                  type: "function" as const,
                  function: {
                    name: tc.name,
                    arguments: JSON.stringify(tc.arguments),
                  },
                })),
              }
            : {}),
        };
      }
      case "tool":
        return {
          role: "tool",
          tool_call_id: message.toolCallId,
          content: message.content,
        };
    }
  });
}

/**
 * 2. 工具定义映射：包裹为 { type: "function", function: ... }
 */
function toChatTools(tools: typeof toolDefinitions): ChatCompletionTool[] {
  return tools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description ?? undefined,
      parameters: (tool.parameters ?? undefined) as
        | Record<string, unknown>
        | undefined,
      strict: tool.strict ?? undefined,
    },
  }));
}

/**
 * 3. 核心调用与流式消费
 */
export async function callOpenAIChat(
  messages: Message[],
  options?: CallOptions,
): Promise<ModelReply> {
  if (!process.env.BASE_URL || !process.env.MODEL || !process.env.API_KEY) {
    throw new Error("请在 .env 文件中设置 BASE_URL、MODEL 和 API_KEY。");
  }

  if (options?.signal?.aborted) {
    throw options.signal.reason ?? new Error("Request was aborted.");
  }

  const client = new OpenAI({
    apiKey: process.env.API_KEY,
    baseURL: process.env.BASE_URL,
  });

  const tools = toChatTools(options?.tools ?? toolDefinitions);

  const stream = await client.chat.completions.create(
    {
      model: process.env.MODEL,
      messages: toChatMessages(messages),
      ...(tools.length ? { tools } : {}),
      stream: true,
      stream_options: { include_usage: true },
    },
    ...(options?.signal ? [{ signal: options.signal }] : []),
  );

  let streamedText = "";
  let tokenUsage: TokenUsage | undefined;

  // 借鉴 pi：按 index 累积多工具调用分块
  const toolCallsByIndex = new Map<
    number,
    { id: string; name: string; arguments: string }
  >();

  for await (const chunk of stream) {
    if (options?.signal?.aborted) {
      throw options.signal.reason ?? new Error("Request was aborted.");
    }

    // 1) 处理 Token 统计（通常在最后一个 chunk 带上）
    if (chunk.usage) {
      tokenUsage = {
        inputTokens: chunk.usage.prompt_tokens ?? 0,
        outputTokens: chunk.usage.completion_tokens ?? 0,
        totalTokens: chunk.usage.total_tokens ?? 0,
      };
      await options?.onUsage?.(tokenUsage);
    }

    const choice = chunk.choices?.[0];
    if (!choice) continue;

    // 2) 检查因达到最大 token 截断的异常
    if (choice.finish_reason === "length") {
      throw new Error("模型回复未完成：输出达到最大长度被截断。");
    }

    const delta = choice.delta;
    if (!delta) continue;

    // 3) 兼容 DeepSeek-R1 / 思维链模型（reasoning_content）
    const reasoning = (delta as { reasoning_content?: string })
      ?.reasoning_content;
    if (reasoning) {
      options?.onTextDelta?.(reasoning);
    }

    // 4) 普通正文流式输出
    if (delta.content) {
      streamedText += delta.content;
      options?.onTextDelta?.(delta.content);
    }

    // 5) 流式 Tool Call 累积（按 index 拼接）
    if (delta.tool_calls) {
      for (const tc of delta.tool_calls) {
        const index = tc.index ?? 0;
        let entry = toolCallsByIndex.get(index);
        if (!entry) {
          entry = {
            id: tc.id ?? "",
            name: tc.function?.name ?? "",
            arguments: "",
          };
          toolCallsByIndex.set(index, entry);
          if (entry.name) {
            options?.onToolCall?.({ name: entry.name });
          }
        } else {
          if (tc.id) entry.id = tc.id;
          if (tc.function?.name && !entry.name) {
            entry.name = tc.function.name;
            options?.onToolCall?.({ name: entry.name });
          }
        }
        if (tc.function?.arguments) {
          entry.arguments += tc.function.arguments;
        }
      }
    }
  }

  if (!tokenUsage) {
    await options?.onUsage?.(null);
  }

  // 6) 统一调用在步骤 1 抽离的 validateToolCall 进行校验
  const toolCalls = Array.from(toolCallsByIndex.values()).map((tc) =>
    validateToolCall(tc.id, tc.name, tc.arguments),
  );

  return {
    role: "assistant",
    content: streamedText,
    ...(toolCalls.length ? { toolCalls } : {}),
    ...(tokenUsage ? { usage: tokenUsage } : {}),
  };
}
