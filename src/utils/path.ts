import path from "node:path";

export function resolveSafePath(
  targetPath: string,
  workspaceRoot = process.cwd(),
): string {
  const root = path.resolve(workspaceRoot);
  const resolved = path.resolve(root, targetPath);

  // 核心校验：用 relative 判断是否发生逃逸
  const rel = path.relative(root, resolved);

  // 1. 如果 rel 以 ".." 开头，说明它必须“向上翻墙”才能到达 -> 越界！
  // 2. 如果 rel 是绝对路径（Windows 跨盘符），说明直接在别的盘 -> 越界！
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`禁止越界访问：${targetPath}`);
  }

  return resolved;
}
