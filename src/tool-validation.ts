import type { ToolCall as AgentToolCall } from "./types.ts";

const toolArgKeys: Record<string, string[]> = {
  run_bash: ["command"],
  ls: ["path"],
  grep: ["pattern"],
  find_files: ["pattern"],
  read_file: ["path"],
  write_file: ["path", "content"],
  edit_file: ["path", "old_str", "new_str"],
};

/**
 * 校验并组装工具调用对象
 * @param id 工具调用 ID（call_id / tool_use_id）
 * @param name 工具名称
 * @param rawArgs 未解析的 JSON 字符串（OpenAI）或已解析的对象（Anthropic）
 */
export function validateToolCall(
  id: string,
  name: string,
  rawArgs: unknown,
): AgentToolCall {
  if (!id) {
    throw new Error(`工具 ${name} 缺少 call_id。`);
  }

  let args = rawArgs;
  // 如果是字符串，先尝试反序列化为 JSON 对象
  if (typeof rawArgs === "string") {
    try {
      args = JSON.parse(rawArgs);
    } catch {
      throw new Error(`工具 ${name} 的参数不是有效 JSON。`);
    }
  }

  // 校验参数必须是非空对象且非数组
  if (args === null || typeof args !== "object" || Array.isArray(args)) {
    throw new Error(`工具 ${name} 的参数必须是对象。`);
  }

  const keys = toolArgKeys[name];
  if (!keys) {
    throw new Error(`未知工具：${name}`);
  }

  const values = args as Record<string, unknown>;
  for (const key of keys) {
    if (typeof values[key] !== "string") {
      throw new Error(`工具 ${name} 的参数 ${key} 必须是字符串。`);
    }
  }

  return {
    id,
    name,
    arguments: values,
  } as AgentToolCall;
}
