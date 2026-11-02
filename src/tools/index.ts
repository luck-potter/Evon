import type { ToolCall } from "../types.ts";
import { editFile } from "./edit-file.ts";
import { findFiles } from "./find-files.ts";
import { grep } from "./grep.ts";
import { ls } from "./ls.ts";
import { readFile } from "./read-file.ts";
import { runBash } from "./run-bash.ts";
import { writeFile } from "./write-file.ts";

export { editFile, findFiles, grep, ls, readFile, runBash, writeFile };

// 工具失败也返回给模型，让主循环有机会根据错误继续处理。
export async function executeTool(
  call: ToolCall,
  workspaceRoot = process.cwd(),
  signal?: AbortSignal,
): Promise<string> {
  try {
    const { name, arguments: args } = call;
    switch (name) {
      case "run_bash":
        return await runBash(args.command, 30_000, signal);
      case "ls":
        return await ls(args.path, args.limit, workspaceRoot);
      case "grep":
        return await grep(args, workspaceRoot, signal);
      case "find_files":
        return await findFiles(args, workspaceRoot, signal);
      case "read_file":
        return await readFile(
          args.path,
          args.offset,
          args.limit,
          workspaceRoot,
        );
      case "write_file":
        return await writeFile(args.path, args.content, workspaceRoot);
      case "edit_file":
        return await editFile(
          args.path,
          args.old_str,
          args.new_str,
          workspaceRoot,
        );
    }
  } catch (error) {
    return `工具执行失败：${error instanceof Error ? error.message : String(error)}`;
  }
}
