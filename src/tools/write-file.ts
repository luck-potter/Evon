import { writeFile as fsWriteFile } from "node:fs/promises";
import { resolveSafePath } from "../utils/path.ts";

export async function writeFile(
  path: string,
  content: string,
  workspaceRoot = process.cwd(),
): Promise<string> {
  const safePath = resolveSafePath(path, workspaceRoot);
  await fsWriteFile(safePath, content, "utf-8");
  return `文件写入成功：${path}`;
}
