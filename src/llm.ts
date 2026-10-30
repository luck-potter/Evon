import type { Message, ModelReply } from "./types.ts";
import { toolDefinitions } from "./tool-definitions.ts";
import OpenAI from "openai";

export type ToolCall = OpenAI.Responses.ResponseFunctionToolCall;

export async function callModel(message: Message[]): Promise<ModelReply> {
  // TODO 4：解析模型回复和工具调用，转换工具结果消息。
  // 当前已发送消息和工具定义，尚未解析真实回复。

  if (!process.env.BASE_URL || !process.env.MODEL || !process.env.API_KEY) {
    throw new Error("请在 .env 文件中设置 BASE_URL、MODEL 和 API_KEY。");
  }

  const client = new OpenAI({
    apiKey: process.env.API_KEY,
    baseURL: process.env.BASE_URL,
  });

  const response = await client.responses.create({
    model: process.env.MODEL,
    tools: toolDefinitions,
  });

  return {};
}
