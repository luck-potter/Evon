// 仅用于终端展示；工具返回值和会话消息保留纯文本 diff。
export function formatDiff(
  text: string,
  isTTY = process.stdout.isTTY === true,
): string {
  if (!isTTY || process.env.NO_COLOR || process.env.TERM === "dumb") return text;

  let inHunk = false;
  return text.replace(/^[^\r\n]+/gm, (line) => {
    let color: number | undefined;

    if (/^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/.test(line)) {
      inHunk = true;
      color = 90;
    } else if (inHunk) {
      // 进入差异块后，+++ / --- 也可能是实际增删的代码。
      if (line.startsWith("+")) color = 32;
      else if (line.startsWith("-")) color = 31;
    } else if (
      line.startsWith("Index: ") ||
      /^=+$/.test(line) ||
      line.startsWith("--- ") ||
      line.startsWith("+++ ")
    ) {
      color = 90;
    }

    return color === undefined ? line : `\u001b[${color}m${line}\u001b[39m`;
  });
}
