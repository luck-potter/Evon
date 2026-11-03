import Anthropic from "@anthropic-ai/sdk";
import { toolDefinitions } from "../tool-definitions.ts";
import { validateToolCall } from "../tool-validation.ts";
import type { CallOptions } from "../llm.ts";
import type { Message, ModelReply, TokenUsage } from "../types.ts";

/**
 * 提取顶层 system 消息与映射 Anthropic 消息
 * 吸收自 pi：
 * 1. 顶层提取 system
 * 2. 连续 tool 结果折叠合并为紧随其后的单个 user 消息（多个 tool_result blocks）
 * 3. 严格交替角色（合并相邻同角色消息，满足 Anthropic 严苛的角色交替校验）
 */
export function toAnthropicPayload(messages: Message[]): {
  system?: string;
  messages: Anthropic.MessageParam[];
} {
  const system =
    messages
      .filter((m) => m.role === "system")
      .map((m) => m.content)
      .join("\n\n") || undefined;

  const result: Anthropic.MessageParam[] = [];

  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];
    if (message.role === "system") {
      continue;
    }

    if (message.role === "user") {
      const last = result[result.length - 1];
      if (last && last.role === "user") {
        if (typeof last.content === "string") {
          last.content = [
            { type: "text", text: last.content },
            { type: "text", text: message.content },
          ];
        } else if (Array.isArray(last.content)) {
          last.content.push({ type: "text", text: message.content });
        }
      } else {
        result.push({ role: "user", content: message.content });
      }
    } else if (message.role === "assistant") {
      const blocks: Array<
        Anthropic.TextBlockParam | Anthropic.ToolUseBlockParam
      > = [];
      if (message.content && message.content.trim().length > 0) {
        blocks.push({ type: "text", text: message.content });
      }
      for (const tc of message.toolCalls ?? []) {
        blocks.push({
          type: "tool_use",
          id: tc.id,
          name: tc.name,
          input: tc.arguments,
        });
      }

      const last = result[result.length - 1];
      if (last && last.role === "assistant") {
        if (typeof last.content === "string") {
          last.content = [{ type: "text", text: last.content }, ...blocks];
        } else if (Array.isArray(last.content)) {
          last.content.push(...blocks);
        }
      } else {
        result.push({
          role: "assistant",
          content: blocks.length ? blocks : message.content,
        });
      }
    } else if (message.role === "tool") {
      // 吸收自 pi：收集连续的 tool 结果，合并为一个 user 消息下的多个 tool_result blocks
      const toolResults: Anthropic.ToolResultBlockParam[] = [];
      let j = i;
      while (j < messages.length && messages[j].role === "tool") {
        const toolMsg = messages[j] as Extract<Message, { role: "tool" }>;
        toolResults.push({
          type: "tool_result",
          tool_use_id: toolMsg.toolCallId,
          content: toolMsg.content,
        });
        j++;
      }
      i = j - 1;

      const last = result[result.length - 1];
      if (last && last.role === "user") {
        if (typeof last.content === "string") {
          last.content = [
            { type: "text", text: last.content },
            ...toolResults,
          ];
        } else if (Array.isArray(last.content)) {
          last.content.push(...toolResults);
        }
      } else {
        result.push({
          role: "user",
          content: toolResults,
        });
      }
    }
  }

  return { system, messages: result };
}

/**
 * 工具定义映射：转换内部 toolDefinitions -> Anthropic Tool[]
 */
export function toAnthropicTools(
  tools: typeof toolDefinitions,
): Anthropic.Tool[] {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description ?? undefined,
    input_schema: (tool.parameters ?? {
      type: "object",
      properties: {},
    }) as Anthropic.Tool.InputSchema,
  }));
}

/**
 * 核心调用与流式消费
 */
export async function callAnthropic(
  messages: Message[],
  options?: CallOptions,
): Promise<ModelReply> {
  const apiKey = process.env.ANTHROPIC_API_KEY ?? process.env.API_KEY;
  const model = process.env.ANTHROPIC_MODEL ?? process.env.MODEL;
  const baseURL =
    process.env.ANTHROPIC_BASE_URL ||
    (process.env.BASE_URL && !process.env.BASE_URL.includes("openai.com")
      ? process.env.BASE_URL
      : undefined);

  if (!apiKey || !model) {
    throw new Error(
      "请在 .env 文件中设置 ANTHROPIC_API_KEY（或 API_KEY）和 MODEL。",
    );
  }

  if (options?.signal?.aborted) {
    throw options.signal.reason ?? new Error("Request was aborted.");
  }

  const client = new Anthropic({
    apiKey,
    ...(baseURL ? { baseURL } : {}),
  });

  const tools = toAnthropicTools(options?.tools ?? toolDefinitions);
  const { system, messages: anthropicMessages } = toAnthropicPayload(messages);
  const maxTokens =
    Number(process.env.ANTHROPIC_MAX_TOKENS || process.env.MAX_TOKENS) || 8192;

  const stream = await client.messages.create(
    {
      model,
      max_tokens: maxTokens,
      messages: anthropicMessages.length
        ? anthropicMessages
        : [{ role: "user", content: "" }],
      ...(system ? { system } : {}),
      ...(tools.length ? { tools } : {}),
      stream: true,
    },
    ...(options?.signal ? [{ signal: options.signal }] : []),
  );

  let streamedText = "";
  let inputTokens = 0;
  let outputTokens = 0;
  let hasUsage = false;

  const toolCallsByIndex = new Map<
    number,
    { id: string; name: string; arguments: string }
  >();

  for await (const event of stream) {
    if (options?.signal?.aborted) {
      throw options.signal.reason ?? new Error("Request was aborted.");
    }

    switch (event.type) {
      case "message_start":
        if (event.message?.usage) {
          hasUsage = true;
          inputTokens = event.message.usage.input_tokens ?? 0;
          outputTokens = event.message.usage.output_tokens ?? 0;
        }
        break;

      case "content_block_start":
        if (event.content_block.type === "text") {
          if (event.content_block.text) {
            streamedText += event.content_block.text;
            options?.onTextDelta?.(event.content_block.text);
          }
        } else if (event.content_block.type === "tool_use") {
          const initialArgs =
            event.content_block.input &&
            typeof event.content_block.input === "object" &&
            Object.keys(event.content_block.input).length > 0
              ? JSON.stringify(event.content_block.input)
              : "";
          toolCallsByIndex.set(event.index, {
            id: event.content_block.id,
            name: event.content_block.name,
            arguments: initialArgs,
          });
          options?.onToolCall?.({ name: event.content_block.name });
        }
        break;

      case "content_block_delta":
        if (event.delta.type === "text_delta") {
          streamedText += event.delta.text;
          options?.onTextDelta?.(event.delta.text);
        } else if (event.delta.type === "input_json_delta") {
          const tc = toolCallsByIndex.get(event.index);
          if (tc) {
            tc.arguments += event.delta.partial_json;
          }
        } else if (event.delta.type === "thinking_delta") {
          options?.onTextDelta?.(
            (event.delta as { thinking: string }).thinking,
          );
        }
        break;

      case "message_delta":
        if (event.delta?.stop_reason === "max_tokens") {
          throw new Error("模型回复未完成：输出达到最大长度被截断。");
        }
        if (event.usage) {
          hasUsage = true;
          if (event.usage.output_tokens != null) {
            outputTokens = event.usage.output_tokens;
          }
        }
        break;
    }
  }

  let tokenUsage: TokenUsage | undefined;
  if (hasUsage) {
    tokenUsage = {
      inputTokens,
      outputTokens,
      totalTokens: inputTokens + outputTokens,
    };
    await options?.onUsage?.(tokenUsage);
  } else {
    await options?.onUsage?.(null);
  }

  const toolCalls = Array.from(toolCallsByIndex.values()).map((tc) =>
    validateToolCall(tc.id, tc.name, tc.arguments || "{}"),
  );

  return {
    role: "assistant",
    content: streamedText,
    ...(toolCalls.length ? { toolCalls } : {}),
    ...(tokenUsage ? { usage: tokenUsage } : {}),
  };
}
