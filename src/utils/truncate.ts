export const DEFAULT_MAX_LINES = 2000;
export const DEFAULT_MAX_BYTES = 50 * 1024; // 50KB
export const GREP_MAX_LINE_LENGTH = 500;

// 只截断匹配正文，由调用方保留路径和行号。
export function truncateLine(
  line: string,
  maxChars = GREP_MAX_LINE_LENGTH,
): { text: string; wasTruncated: boolean } {
  if (line.length <= maxChars) return { text: line, wasTruncated: false };
  // 不在 UTF-16 代理对中间切断 Emoji 等字符。
  const preview = line.slice(0, maxChars).replace(/[\uD800-\uDBFF]$/, "");
  return { text: `${preview}... [已截断]`, wasTruncated: true };
}

function splitLines(content: string): string[] {
  if (!content) return [];
  const lines = content.split("\n");
  if (content.endsWith("\n")) {
    lines.pop();
  }
  return lines;
}

// 在 UTF-8 字符边界截断字节，防止切断多字节字符（如中文或 Emoji）
function truncateStringToBytes(
  str: string,
  maxBytes: number,
  fromEnd = false,
): string {
  const buf = Buffer.from(str, "utf-8");
  if (buf.length <= maxBytes) return str;

  if (fromEnd) {
    let start = buf.length - maxBytes;
    while (start < buf.length && (buf[start] & 0xc0) === 0x80) start++;
    return buf.subarray(start).toString("utf-8");
  }

  let end = maxBytes;
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end--;
  return buf.subarray(0, end).toString("utf-8");
}

// 供 read_file 使用：保留前 N 行
export function truncateHead(
  content: string,
  maxLines = DEFAULT_MAX_LINES,
  maxBytes = DEFAULT_MAX_BYTES,
): string {
  const totalBytes = Buffer.byteLength(content, "utf-8");
  const lines = splitLines(content);
  const totalLines = lines.length;

  if (totalLines <= maxLines && totalBytes <= maxBytes) {
    return content;
  }

  const output: string[] = [];
  let bytes = 0;

  for (let i = 0; i < lines.length && i < maxLines; i++) {
    const lineBytes = Buffer.byteLength(lines[i], "utf-8") + (i > 0 ? 1 : 0);
    if (bytes + lineBytes > maxBytes) {
      if (output.length === 0) {
        output.push(truncateStringToBytes(lines[i], maxBytes, false));
      }
      break;
    }
    output.push(lines[i]);
    bytes += lineBytes;
  }

  const dropped = lines.length - output.length;
  const note = dropped > 0 ? `余下 ${dropped} 行` : "余下内容";
  return `${output.join("\n")}\n\n[... 已截断${note} ...]\n`;
}

// 供 run_bash 使用：保留后 N 行
export function truncateTail(
  content: string,
  maxLines = DEFAULT_MAX_LINES,
  maxBytes = DEFAULT_MAX_BYTES,
): string {
  const totalBytes = Buffer.byteLength(content, "utf-8");
  const lines = splitLines(content);
  const totalLines = lines.length;

  if (totalLines <= maxLines && totalBytes <= maxBytes) {
    return content;
  }

  const output: string[] = [];
  let bytes = 0;

  for (let i = lines.length - 1; i >= 0 && output.length < maxLines; i--) {
    const lineBytes =
      Buffer.byteLength(lines[i], "utf-8") + (output.length > 0 ? 1 : 0);
    if (bytes + lineBytes > maxBytes) {
      if (output.length === 0) {
        output.unshift(truncateStringToBytes(lines[i], maxBytes, true));
      }
      break;
    }
    output.unshift(lines[i]);
    bytes += lineBytes;
  }

  const dropped = lines.length - output.length;
  const note = dropped > 0 ? `前面 ${dropped} 行` : "前面部分内容";
  return `\n[... ${note}已截断 ...]\n\n${output.join("\n")}`;
}
