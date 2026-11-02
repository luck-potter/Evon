import { stripVTControlCharacters } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { formatDiff } from "../src/utils/format-diff.ts";

const result = [
  "文件修改成功：example.ts",
  "",
  "Index: example.ts",
  "===================================================================",
  "--- example.ts",
  "+++ example.ts",
  "@@ -1,3 +1,3 @@",
  " keep",
  "---old",
  "+++new",
  " last",
  "@@ -20 +20 @@",
  "-旧尾行",
  "\\ No newline at end of file",
  "+新尾行",
  "\\ No newline at end of file",
  "",
  "[... 已截断余下 10 行 ...]",
  "",
].join("\n");

describe("formatDiff", () => {
  beforeEach(() => {
    vi.stubEnv("NO_COLOR", undefined);
    vi.stubEnv("TERM", "xterm-256color");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("区分文件标题与差异块中的 +++ / ---，为多个差异块着色并保留原文", () => {
    const formatted = formatDiff(result, true);

    expect(formatted).toContain("\u001b[90m--- example.ts\u001b[39m");
    expect(formatted).toContain("\u001b[90m+++ example.ts\u001b[39m");
    expect(formatted).toContain("\u001b[90m@@ -1,3 +1,3 @@\u001b[39m");
    expect(formatted).toContain("\u001b[90m@@ -20 +20 @@\u001b[39m");
    expect(formatted).toContain("\u001b[31m---old\u001b[39m");
    expect(formatted).toContain("\u001b[32m+++new\u001b[39m");
    expect(formatted).toContain("\u001b[31m-旧尾行\u001b[39m");
    expect(formatted).toContain("\u001b[32m+新尾行\u001b[39m");
    expect(formatted).toContain("\n keep\n");
    expect(formatted).toContain("\n\\ No newline at end of file\n");
    expect(formatted).toContain("\n[... 已截断余下 10 行 ...]\n");
    expect(stripVTControlCharacters(formatted)).toBe(result);
  });

  it("保留 CRLF 换行，并在换行前重置颜色", () => {
    const crlf = result.replaceAll("\n", "\r\n");
    const formatted = formatDiff(crlf, true);

    expect(formatted).toContain("\u001b[32m+++new\u001b[39m\r\n");
    expect(stripVTControlCharacters(formatted)).toBe(crlf);
  });

  it.each(["1", "0", "false"])("NO_COLOR=%s 时返回纯文本", (noColor) => {
    vi.stubEnv("NO_COLOR", noColor);
    expect(formatDiff(result, true)).toBe(result);
  });

  it("NO_COLOR 为空字符串时允许配色", () => {
    vi.stubEnv("NO_COLOR", "");
    expect(formatDiff(result, true)).toContain("\u001b[32m");
  });

  it("非交互终端即使设置 FORCE_COLOR 也返回纯文本", () => {
    vi.stubEnv("FORCE_COLOR", "1");
    expect(formatDiff(result, false)).toBe(result);
  });

  it("TERM=dumb 时返回纯文本", () => {
    vi.stubEnv("TERM", "dumb");
    expect(formatDiff(result, true)).toBe(result);
  });

  it.each(["", "文件未修改：未找到 old_str", "工具执行失败：ENOENT"])(
    "普通提示原样输出：%s",
    (text) => {
      expect(formatDiff(text, true)).toBe(text);
    },
  );
});
