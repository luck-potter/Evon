import { readFile as fsReadFile } from "node:fs/promises";
import { resolveSafePath } from "../utils/path.ts";
import { truncateHead } from "../utils/truncate.ts";

export async function readFile(
  path: string,
  offset?: number | null,
  limit?: number | null,
  workspaceRoot = process.cwd(),
): Promise<string> {
  const safePath = resolveSafePath(path, workspaceRoot);
  const text = await fsReadFile(safePath, "utf-8");
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
