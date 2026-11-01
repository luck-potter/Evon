import { describe, expect, it } from "vitest";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  truncateHead,
  truncateTail,
} from "../src/utils/truncate.ts";

describe("truncateHead", () => {
  it("未超过限制时原样返回", () => {
    const content = "line 1\nline 2\nline 3";
    expect(truncateHead(content)).toBe(content);
  });

  it("超过 maxLines 时截断末尾并保留前 maxLines 行", () => {
    const lines = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`);
    const content = lines.join("\n");

    const result = truncateHead(content, 3, 10_000);
    expect(result).toBe("line 1\nline 2\nline 3\n\n[... 已截断余下 7 行 ...]\n");
  });

  it("超过 maxBytes 时在字节超限处截断", () => {
    const lines = ["12345", "67890", "abcde"]; // 每行 5 字节 + 1 换行
    const content = lines.join("\n"); // 总共 17 字节

    // 限制 12 字节：前两行 5+1+5 = 11 字节，第三行加入后为 17 字节超标
    const result = truncateHead(content, 100, 12);
    expect(result).toBe("12345\n67890\n\n[... 已截断余下 1 行 ...]\n");
  });

  it("正确按 UTF-8 字节计算中文", () => {
    // 每个汉字 3 字节，"你好世界" = 12 字节
    const lines = ["你好", "世界", "编程"];
    const content = lines.join("\n");

    // 限制 15 字节：前两行 6+1+6 = 13 字节，第三行加入后 13+1+6 = 20 字节超标
    const result = truncateHead(content, 100, 15);
    expect(result).toBe("你好\n世界\n\n[... 已截断余下 1 行 ...]\n");
  });

  it("单行超过 maxBytes 时截断该行头部内容并保留 UTF-8 边界", () => {
    const content = "你好世界，这是一段很长的单行文本";
    // "你好世界" = 12 字节，限制 13 字节时应保留 "你好世界"，不能切碎后续的逗号或汉字
    const result = truncateHead(content, 100, 13);
    expect(result).toBe("你好世界\n\n[... 已截断余下内容 ...]\n");
  });

  it("空字符串直接返回", () => {
    expect(truncateHead("")).toBe("");
  });
});

describe("truncateTail", () => {
  it("未超过限制时原样返回", () => {
    const content = "line 1\nline 2\nline 3";
    expect(truncateTail(content)).toBe(content);
  });

  it("超过 maxLines 时截断头部并保留后 maxLines 行", () => {
    const lines = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`);
    const content = lines.join("\n");

    const result = truncateTail(content, 3, 10_000);
    expect(result).toBe("\n[... 前面 7 行已截断 ...]\n\nline 8\nline 9\nline 10");
  });

  it("超过 maxBytes 时在字节超限处倒序截断", () => {
    const lines = ["12345", "67890", "abcde"]; // 每行 5 字节
    const content = lines.join("\n");

    // 限制 12 字节：后两行 5+1+5 = 11 字节
    const result = truncateTail(content, 100, 12);
    expect(result).toBe("\n[... 前面 1 行已截断 ...]\n\n67890\nabcde");
  });

  it("正确按 UTF-8 字节倒序截断中文", () => {
    const lines = ["第一行", "第二行", "第三行"]; // 每行 9 字节
    const content = lines.join("\n");

    // 限制 20 字节：后两行 9+1+9 = 19 字节
    const result = truncateTail(content, 100, 20);
    expect(result).toBe("\n[... 前面 1 行已截断 ...]\n\n第二行\n第三行");
  });

  it("单行超过 maxBytes 时截断该行尾部内容并保留 UTF-8 边界", () => {
    const content = "这是一段很长的单行文本，你好世界";
    // "你好世界" = 12 字节，限制 13 字节时应保留 "你好世界"
    const result = truncateTail(content, 100, 13);
    expect(result).toBe("\n[... 前面部分内容已截断 ...]\n\n你好世界");
  });

  it("空字符串直接返回", () => {
    expect(truncateTail("")).toBe("");
  });
});
