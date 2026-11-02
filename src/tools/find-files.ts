import type { FindFilesArguments } from "../types.ts";
import { spawn } from "node:child_process";
import { realpath, stat } from "node:fs/promises";
import { posix, relative, resolve, sep } from "node:path";
import { resolveSafePath } from "../utils/path.ts";
// import { DEFAULT_MAX_BYTES } from "../utils/truncate.ts";

// 约定：pattern 为 glob，path 默认 "."，limit 默认 100；可选参数为 null 时也采用默认值。
// 无 / 的模式匹配任意层级文件名，有 / 的模式相对于搜索目录。
// 每行返回一个工作区相对路径，按路径排序；无匹配返回「(无匹配)」。
export async function findFiles(
  args: FindFilesArguments,
  workspaceRoot = process.cwd(),
  signal?: AbortSignal,
): Promise<string> {
  // TODO 1：检查 pattern 非空、limit 为正整数，处理默认值及已取消的 signal。
  const pattern = args.pattern;
  const limit = args.limit ?? 100;
  if (!pattern) {
    throw new Error("pattern 不能为空");
  }
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error("limit 必须是正整数");
  }
  if (signal?.aborted) throw new Error("查找文件已被用户取消");

  // TODO 2：校验工作区路径和符号链接的真实目标，确认搜索路径是目录。
  const root = resolve(workspaceRoot);
  const safePath = resolveSafePath(args.path ?? ".", root);
  // 路径文本合法时，仍需检查符号链接最终指向的位置。
  const [realRoot, realTarget] = await Promise.all([
    realpath(root),
    realpath(safePath),
  ]);
  resolveSafePath(realTarget, realRoot);
  const targetStat = await stat(realTarget);
  if (!targetStat.isDirectory()) {
    throw new Error("path 必须是目录");
  }
  // TODO 3：spawn 执行 rg --no-config --no-require-git --files --null --sort=path -- <目录>。

  const argv = [
    "--no-config",
    "--no-require-git",
    "--files",
    "--null",
    "--sort=path",
    "--",
    safePath,
  ];

  const timeoutSignal = AbortSignal.timeout(30_000);
  const combinedSignal = signal
    ? AbortSignal.any([timeoutSignal, signal])
    : timeoutSignal;
  const child = spawn("rg", argv, {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
    signal: combinedSignal,
  });
  child.stdout.setEncoding("utf8");
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });

  // TODO 4：流式解析 NUL 分隔的路径，再用 posix.matchesGlob 筛选，保留 rg 的忽略规则。
  let processError: NodeJS.ErrnoException | undefined;
  child.on("error", (error) => {
    processError = error;
  });

  const closed = new Promise<void>((resolve) => {
    child.once("close", () => resolve());
  });

  // *.ts 匹配任意层级；带 / 的模式相对于搜索目录。
  const glob = pattern.includes("/") ? pattern : `**/${pattern}`;

  let pending = "";
  const files: string[] = [];
  let limitReached = false;
  search: for await (const chunk of child.stdout) {
    pending += chunk;

    const paths = pending.split("\0");

    // 最后一段可能是半条路径，留给下一个数据块。
    pending = paths.pop() ?? "";

    for (const filePath of paths) {
      const absolutePath = resolve(root, filePath);

      // glob 使用相对于搜索目录的路径。
      const matchPath = relative(safePath, absolutePath).split(sep).join("/");

      if (!posix.matchesGlob(matchPath, glob)) continue;

      // 返回值使用相对于工作区的路径。
      const displayPath = relative(root, absolutePath).split(sep).join("/");

      files.push(displayPath);

      if (files.length >= limit) {
        limitReached = true;
        child.kill();
        break search;
      }
    }
  }

  await closed;

  if (signal?.aborted) {
    throw new Error("查找文件已被用户取消");
  }
  if (timeoutSignal.aborted) {
    throw new Error("查找文件超时");
  }
  if (processError) throw processError;

  if (!limitReached && child.exitCode !== 0 && child.exitCode !== 1) {
    throw new Error(
      `rg 执行失败（退出码 ${child.exitCode}）：${stderr.trim() || "命令异常结束"}`,
    );
  }

  let result = files.length > 0 ? files.join("\n") : "(无匹配)";

  if (limitReached) {
    result += `\n[... 已达到文件数量上限 ${limit}，可增大 limit 或缩小搜索范围 ...]`;
  }

  return result;
}
