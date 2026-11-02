import {
  readFile as fsReadFile,
  writeFile as fsWriteFile,
} from "node:fs/promises";
import { resolveSafePath } from "../utils/path.ts";

export async function editFile(
  path: string,
  oldStr: string,
  newStr: string,
  workspaceRoot = process.cwd(),
): Promise<string> {
  const safePath = resolveSafePath(path, workspaceRoot);
  if (!oldStr) return "文件未修改：old_str 为空";

  const content = await fsReadFile(safePath, "utf-8");
  const firstIndex = content.indexOf(oldStr);
  if (firstIndex === -1) return "文件未修改：未找到 old_str";
  if (firstIndex !== content.lastIndexOf(oldStr)) {
    return "文件未修改：old_str 匹配多处，请提供更完整的旧文本";
  }

  await fsWriteFile(
    safePath,
    content.replace(oldStr, () => newStr),
    "utf-8",
  );
  return `文件修改成功：${path}`;
}
