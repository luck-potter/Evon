import type { ToolCall } from "./types.ts";
import { spawn } from "node:child_process";
import {
  readFile as fsReadFile,
  writeFile as fsWriteFile,
} from "node:fs/promises";

import { truncateHead, truncateTail } from "./utils/truncate.ts";

export async function runBash(
  command: string,
  timeoutMs = 30_000,
): Promise<string> {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);

  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";

    const child = spawn(command, {
      shell: true,
      signal: timeoutSignal,
    });

    child.stdout?.on("data", (outChunk) => {
      stdout += outChunk.toString("utf-8");
    });

    child.stderr?.on("data", (errChunk) => {
      stderr += errChunk.toString("utf-8");
    });

    child.on("close", (code) => {
      resolve(
        JSON.stringify({
          stdout: truncateTail(stdout),
          stderr: truncateTail(stderr),
          exitCode: code,
          timedOut: timeoutSignal.aborted,
        }),
      );
    });

    child.on("error", (error) => {
      // 超时引发的 AbortError 属于正常中断流程，等待接下来的 close 事件统一 flush 和 resolve
      if (error.name === "AbortError") {
        return;
      }

      resolve(
        JSON.stringify({
          stdout: truncateTail(stdout),
          stderr: truncateTail(stderr || error.message),
          exitCode: null,
          timedOut: timeoutSignal.aborted,
        }),
      );
    });
  });
}

export async function readFile(
  path: string,
  offset?: number | null,
  limit?: number | null,
): Promise<string> {
  const text = await fsReadFile(path, "utf-8");
  const lines = text.split("\n");

  const parsedOffset =
    offset !== undefined && offset !== null ? Number(offset) : 1;
  if (
    Number.isNaN(parsedOffset) ||
    parsedOffset < 1 ||
    parsedOffset > lines.length
  ) {
    return `文件读取失败：offset ${offset} 超出范围`;
  }

  let parsedLimit: number | undefined;
  if (limit !== undefined && limit !== null) {
    parsedLimit = Number(limit);
    if (Number.isNaN(parsedLimit) || parsedLimit < 1) {
      return `文件读取失败：limit ${limit} 必须大于 0`;
    }
  }

  const start = parsedOffset - 1;
  const end =
    parsedLimit !== undefined
      ? Math.min(lines.length, start + parsedLimit)
      : lines.length;

  const content = lines.slice(start, end).join("\n");
  return truncateHead(content);
}

export async function writeFile(
  path: string,
  content: string,
): Promise<string> {
  await fsWriteFile(path, content, "utf-8");
  return `文件写入成功：${path}`;
}

export async function editFile(
  path: string,
  oldStr: string,
  newStr: string,
): Promise<string> {
  if (!oldStr) return "文件未修改：old_str 为空";

  const content = await fsReadFile(path, "utf-8");
  const firstIndex = content.indexOf(oldStr);
  if (firstIndex === -1) return "文件未修改：未找到 old_str";
  if (firstIndex !== content.lastIndexOf(oldStr)) {
    return "文件未修改：old_str 匹配多处，请提供更完整的旧文本";
  }

  await fsWriteFile(
    path,
    content.replace(oldStr, () => newStr),
    "utf-8",
  );
  return `文件修改成功：${path}`;
}

// 工具失败也返回给模型，让主循环有机会根据错误继续处理。
export async function executeTool(call: ToolCall): Promise<string> {
  try {
    const { name, arguments: args } = call;
    switch (name) {
      case "run_bash":
        return await runBash(args.command);
      case "read_file":
        return await readFile(args.path, args.offset, args.limit);
      case "write_file":
        return await writeFile(args.path, args.content);
      case "edit_file":
        return await editFile(args.path, args.old_str, args.new_str);
    }
  } catch (error) {
    return `工具执行失败：${error instanceof Error ? error.message : String(error)}`;
  }
}
