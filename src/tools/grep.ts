import { spawn } from "node:child_process";
import { realpath } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import { createInterface } from "node:readline";
import type { GrepArguments } from "../types.ts";
import { resolveSafePath } from "../utils/path.ts";
import { GREP_MAX_LINE_LENGTH, truncateHead, truncateLine } from "../utils/truncate.ts";

type RipgrepText = { text: string } | { bytes: string };

interface RipgrepEvent {
  type: string;
  data: {
    path: RipgrepText;
    line_number: number;
    lines: RipgrepText;
  };
}

// rg 遇到非 UTF-8 内容时，会在 JSON 中使用 base64 的 bytes 字段。
function decodeText(value: RipgrepText): string {
  return "text" in value ? value.text : Buffer.from(value.bytes, "base64").toString("utf8");
}

export async function grep(
  args: GrepArguments,
  workspaceRoot = process.cwd(),
  signal?: AbortSignal,
): Promise<string> {
  const limit = args.limit ?? 100;
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error("limit 必须是正整数");
  }
  if (signal?.aborted) throw new Error("搜索已被用户取消");

  const root = resolve(workspaceRoot);
  const safePath = resolveSafePath(args.path ?? ".", root);
  // 路径文本合法时，仍需检查符号链接最终指向的位置。
  const [realRoot, realTarget] = await Promise.all([
    realpath(root),
    realpath(safePath),
  ]);
  resolveSafePath(realTarget, realRoot);
  if (signal?.aborted) throw new Error("搜索已被用户取消");

  const argv = [
    "--no-config",
    "--no-require-git",
    "--json",
    "--line-number",
    "--color=never",
    "--sort=path",
  ];
  if (args.glob != null) argv.push("--glob", args.glob);
  if (args.literal) argv.push("--fixed-strings");
  if (args.ignoreCase) argv.push("--ignore-case");
  argv.push("-e", args.pattern, "--", safePath);

  const timeoutSignal = AbortSignal.timeout(30_000);
  const combinedSignal = signal ? AbortSignal.any([timeoutSignal, signal]) : timeoutSignal;
  const child = spawn("rg", argv, {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
    signal: combinedSignal,
  });
  let processError: NodeJS.ErrnoException | undefined;
  child.on("error", (error) => { processError = error; });
  const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
  const reader = createInterface({ input: child.stdout, crlfDelay: Infinity });
  const outputLines: string[] = [];
  let linesTruncated = false;
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => { stderr += chunk; });

  try {
    for await (const line of reader) {
      if (combinedSignal.aborted) break;
      const event: RipgrepEvent = JSON.parse(line);
      if (event.type !== "match") continue;

      const filePath = decodeText(event.data.path);
      const displayPath = relative(root, resolve(root, filePath)).split(sep).join("/");
      const text = decodeText(event.data.lines).replace(/\r/g, "").replace(/\n$/, "");
      const preview = truncateLine(text);
      if (preview.wasTruncated) linesTruncated = true;
      outputLines.push(`${displayPath}:${event.data.line_number}:${preview.text}`);

      if (outputLines.length >= limit) {
        child.kill();
        break;
      }
    }
  } catch (error) {
    child.kill();
    throw new Error(`无法解析 rg 的 JSON 输出：${error instanceof Error ? error.message : String(error)}`);
  } finally {
    reader.close();
    await closed;
  }

  if (signal?.aborted) throw new Error("搜索已被用户取消");
  if (timeoutSignal.aborted) throw new Error("rg 搜索超时（30 秒）");
  if (processError) {
    throw new Error(processError.code === "ENOENT"
      ? "未找到 rg（ripgrep），请先安装并确保它位于 PATH 中"
      : `无法启动 rg：${processError.message}`);
  }
  const matchLimitReached = outputLines.length >= limit;
  if (!matchLimitReached && child.exitCode !== 0 && child.exitCode !== 1) {
    throw new Error(`rg 搜索失败（退出码 ${child.exitCode}）：${stderr.trim() || "命令异常结束"}`);
  }
  if (outputLines.length === 0) return "(无匹配)";

  // 匹配数量已受 limit 控制，这里只应用整体字节上限。
  let result = truncateHead(outputLines.join("\n"), Infinity);
  if (matchLimitReached) {
    result += `\n[... 已达到匹配上限 ${limit} 条，可增大 limit 或缩小搜索范围 ...]`;
  }
  if (linesTruncated) {
    result += `\n[... 部分匹配行已截断至 ${GREP_MAX_LINE_LENGTH} 字符，完整内容请使用 read_file ...]`;
  }
  return result;
}
