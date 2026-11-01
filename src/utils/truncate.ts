export const DEFAULT_MAX_LINES = 2000;
export const DEFAULT_MAX_BYTES = 50 * 1024; // 50KB

function splitLines(content: string): string[] {
  if (!content) return [];
  const lines = content.split("\n");
  if (content.endsWith("\n")) {
    lines.pop();
  }
  return lines;
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
    if (bytes + lineBytes > maxBytes) break;
    output.push(lines[i]);
    bytes += lineBytes;
  }

  const dropped = lines.length - output.length;
  return `${output.join("\n")}\n\n[... 已截断余下 ${dropped} 行 ...]\n`;
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
    if (bytes + lineBytes > maxBytes) break;
    output.unshift(lines[i]);
    bytes += lineBytes;
  }

  const dropped = lines.length - output.length;
  return `\n[... 前面 ${dropped} 行已截断 ...]\n\n${output.join("\n")}`;
}
