import type { Message, ModelReply } from "./types.ts";

export async function callModel(_messages: Message[]): Promise<ModelReply> {
  // TODO 4：发送 messages 和工具的 JSON Schema，解析模型回复和 tool_calls。
  // 当前是占位回复，不会请求 API，也不会自主执行工具。
  return {
    role: "assistant",
    content: "骨架已跑通（占位回复）。下一步：实现 src/tools.ts 中的 runBash。",
  };
}
