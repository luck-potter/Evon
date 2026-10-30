import type { ToolCall } from "./types.ts";

export async function runBash(_command: string): Promise<string> {
  // TODO 1：执行命令，返回 stdout、stderr、退出码，并限制执行时间。
  throw new Error("run_bash 尚未实现");
}

export async function readFile(_path: string): Promise<string> {
  // TODO 2：读取文件，给每行附上行号。
  throw new Error("read_file 尚未实现");
}

export async function editFile(
  _path: string,
  _oldStr: string,
  _newStr: string,
): Promise<string> {
  // TODO 3：检查 old_str 唯一匹配后替换；约定新文件如何创建。
  throw new Error("edit_file 尚未实现");
}

// 工具失败也返回给模型，让主循环有机会根据错误继续处理。
export async function executeTool(call: ToolCall): Promise<string> {
  try {
    switch (call.name) {
      case "run_bash":
        return await runBash(call.arguments.command);
      case "read_file":
        return await readFile(call.arguments.path);
      case "edit_file":
        return await editFile(
          call.arguments.path,
          call.arguments.old_str,
          call.arguments.new_str,
        );
    }
  } catch (error) {
    return `工具执行失败：${error instanceof Error ? error.message : String(error)}`;
  }
}
