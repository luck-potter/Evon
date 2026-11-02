// 实现时取消下面三行的注释：
import { readdir } from "node:fs/promises";
import { resolveSafePath } from "../utils/path.ts";
import { truncateHead } from "../utils/truncate.ts";

// 约定：只列直接子项，包含隐藏文件，每行一项，目录名后加 /。
// limit 为 undefined 或 null 时默认取 100；空目录返回「(空目录)」。
export async function ls(
  path = ".",
  limit?: number | null,
  workspaceRoot = process.cwd(),
): Promise<string> {
  const safePath = resolveSafePath(path, workspaceRoot);
  const maxItems = limit ?? 100;
  if (!Number.isInteger(maxItems) || maxItems < 1) {
    throw new Error("limit 必须是正整数");
  }
  const items = await readdir(safePath, { withFileTypes: true });
  const sortedItems = items
    .sort((a, b) => a.name.localeCompare(b.name))
    .slice(0, maxItems)
    .map((item) => (item.isDirectory() ? `${item.name}/` : item.name));

  let result = sortedItems.length > 0 ? sortedItems.join("\n") : "(空目录)";
  const remaining = items.length - sortedItems.length;
  if (remaining > 0) {
    result += `\n[... 还有 ${remaining} 项未显示 ...]`;
  }

  return truncateHead(result, 10_000);
}
