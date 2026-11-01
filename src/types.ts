// 工具调用：模型告诉我们“用哪个工具、传什么参数”。
export type ToolCall =
  | { id: string; name: "run_bash"; arguments: { command: string } }
  | {
      id: string;
      name: "read_file";
      arguments: {
        path: string;
        offset?: number | null;
        limit?: number | null;
      };
    }
  | {
      id: string;
      name: "write_file";
      arguments: { path: string; content: string };
    }
  | {
      id: string;
      name: "edit_file";
      arguments: { path: string; old_str: string; new_str: string };
    };

// 先用自己的消息格式，后续在 llm.ts 中转换成模型 API 的格式。
export type Message =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string; toolCalls?: ToolCall[] }
  | { role: "tool"; toolCallId: string; content: string };

export type ModelReply = Extract<Message, { role: "assistant" }>;
