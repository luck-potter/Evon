import {
  readFile as fsReadFile,
  writeFile as fsWriteFile,
} from "node:fs/promises";
import { createPatch } from "diff";
import { truncateHead } from "../utils/truncate.ts";
import { resolveSafePath } from "../utils/path.ts";

type MatchRange = { start: number; end: number };
type MatchResult = MatchRange | "ambiguous" | null;

// 把用户文本作为普通字符匹配，避免 .* 等字符变成正则语法。
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function findUnique(content: string, pattern: string): MatchResult {
  const regex = new RegExp(pattern, "g");
  const first = regex.exec(content);

  if (!first) return null;

  // 从下一个字符继续找，重叠的匹配也算歧义。
  regex.lastIndex = first.index + 1;
  if (regex.exec(content)) {
    return "ambiguous";
  }

  return {
    start: first.index,
    end: first.index + first[0].length,
  };
}

function findEditRange(content: string, oldStr: string): MatchResult {
  if (!oldStr) throw new Error("old_str 不能为空");

  // 1. 精确匹配。
  const exact = findUnique(content, escapeRegExp(oldStr));
  if (exact) return exact;

  // 纯空白文本只接受精确匹配。
  if (!oldStr.trim()) return null;

  const lines = oldStr.replace(/\r\n/g, "\n").split("\n");

  // 2. 只放宽换行：每个换行可匹配 LF 或 CRLF。
  const newlinePattern = lines.map(escapeRegExp).join("\\r?\\n");
  const newlineMatch = findUnique(content, newlinePattern);
  if (newlineMatch) return newlineMatch;

  // 3. 再放宽行尾空格和 Tab，保留缩进与行内空白。
  const whitespacePattern = lines
    .map((line, i) => {
      const trimmed = line.replace(/[ \t]+$/, "");
      const literal = escapeRegExp(trimmed);

      if (i < lines.length - 1) {
        // 首行是空白行时，从实际行首开始匹配。
        const start = i === 0 && !trimmed ? "(?:^|(?<=\\n))" : "";
        return `${start}${literal}[ \\t]*\\r?\\n`;
      }

      // 最后一行有待忽略的尾部空白时，确认它位于实际行尾。
      return trimmed !== line ? `${literal}[ \\t]*(?=\\r?\\n|$)` : literal;
    })
    .join("");

  return findUnique(content, whitespacePattern);
}

export async function editFile(
  path: string,
  oldStr: string,
  newStr: string,
  workspaceRoot = process.cwd(),
): Promise<string> {
  const safePath = resolveSafePath(path, workspaceRoot);
  if (!oldStr) return "文件未修改：old_str 为空";

  const content = await fsReadFile(safePath, "utf-8");

  // 1. 在变量中生成修改后的内容，还没写入文件
  const range = findEditRange(content, oldStr);
  if (range === "ambiguous") {
    return "文件未修改：old_str 匹配多处，请提供更完整的旧文本";
  }
  if (!range) {
    return "文件未修改：未找到 old_str";
  }
  const updatedContent =
    content.slice(0, range.start) + newStr + content.slice(range.end);

  if (updatedContent === content) {
    return "文件未修改：替换前后内容相同";
  }

  // 2. 比较修改前后的整份文本，生成 diff
  const diff = createPatch(
    path, // 文件名
    content, // 修改前
    updatedContent, // 修改后
    undefined, // 不添加额外的旧文件说明
    undefined, // 不添加额外的新文件说明
    { context: 3 }, // 展示变化前后各三行
  );

  // 3. 真正写入文件
  await fsWriteFile(safePath, updatedContent, "utf-8");

  // 4. 写入成功后，返回成功提示和 diff
  return `文件修改成功：${path}\n\n${truncateHead(diff)}`;
}
