import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { executeTool, readFile } from "../src/tools/index.ts";

describe("readFile", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(process.cwd(), ".tmp-test-read-file-"));
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it.each([
    {
      name: "单行文件直接返回内容",
      content: "const answer = 42;",
      expected: "const answer = 42;",
    },
    {
      name: "按 UTF-8 读取多行中文",
      content: "第一行\n第二行\n第三行",
      expected: "第一行\n第二行\n第三行",
    },
    {
      name: "保留中间的空行、空格缩进和制表符",
      content: "function greet() {\n\n  return '你好';\n\t}",
      expected: "function greet() {\n\n  return '你好';\n\t}",
    },
    {
      name: "保留引号和反斜杠",
      content: 'const message = "你好\\\\世界";',
      expected: 'const message = "你好\\\\世界";',
    },
    {
      name: "空文件返回空字符串",
      content: "",
      expected: "",
    },
    {
      name: "保留文件末尾换行",
      content: "第一行\n",
      expected: "第一行\n",
    },
  ])("$name", async ({ content, expected }) => {
    const filePath = join(testDir, "示例 file.txt");
    await writeFile(filePath, content, "utf8");

    await expect(readFile(filePath)).resolves.toBe(expected);
  });

  it("文件不存在时抛出包含文件路径的错误", async () => {
    const filePath = join(testDir, "missing.txt");

    await expect(readFile(filePath)).rejects.toThrow(filePath);
  });

  it("executeTool 的 read_file 分支返回文件内容", async () => {
    const filePath = join(testDir, "tool-input.txt");
    await writeFile(filePath, "第一行\n第二行", "utf8");

    const result = await executeTool({
      id: "read-success",
      name: "read_file",
      arguments: { path: filePath },
    });

    expect(result).toBe("第一行\n第二行");
  });

  it("executeTool 将读取错误转换成工具结果", async () => {
    const filePath = join(testDir, "missing.txt");

    const result = await executeTool({
      id: "read-failure",
      name: "read_file",
      arguments: { path: filePath },
    });

    expect(result).toMatch(/^工具执行失败：/);
    expect(result).toContain(filePath);
  });

  it("文件行数超出限制时输出被截断", async () => {
    const lines = Array.from({ length: 2005 }, (_, i) => `内容 ${i + 1}`);
    const filePath = join(testDir, "large-file.txt");
    await writeFile(filePath, lines.join("\n"), "utf8");

    const result = await readFile(filePath);
    expect(result).toContain("内容 1");
    expect(result).toContain("内容 2000");
    expect(result).not.toContain("内容 2001");
    expect(result).toContain("[... 已截断余下 5 行 ...]");
  });

  describe("分页读取 (offset & limit)", () => {
    it("支持指定 offset 和 limit 分页读取", async () => {
      const filePath = join(testDir, "pagination.txt");
      await writeFile(
        filePath,
        "line 1\nline 2\nline 3\nline 4\nline 5",
        "utf8",
      );

      const result = await readFile(filePath, 2, 3);
      expect(result).toBe("line 2\nline 3\nline 4");
    });

    it("仅指定 offset 时读取至文件末尾", async () => {
      const filePath = join(testDir, "offset-only.txt");
      await writeFile(filePath, "line 1\nline 2\nline 3", "utf8");

      const result = await readFile(filePath, 2);
      expect(result).toBe("line 2\nline 3");
    });

    it("offset 超出范围时返回友好错误提示", async () => {
      const filePath = join(testDir, "out-of-bounds.txt");
      await writeFile(filePath, "line 1\nline 2", "utf8");

      const resultZero = await readFile(filePath, 0);
      expect(resultZero).toBe("文件读取失败：offset 0 超出范围");

      const resultTooLarge = await readFile(filePath, 5);
      expect(resultTooLarge).toBe("文件读取失败：offset 5 超出范围");
    });

    it("limit 小于 1 时返回友好错误提示", async () => {
      const filePath = join(testDir, "invalid-limit.txt");
      await writeFile(filePath, "line 1\nline 2", "utf8");

      const result = await readFile(filePath, 1, 0);
      expect(result).toBe("文件读取失败：limit 0 必须大于 0");
    });

    it("executeTool 正确转发 offset 与 limit 参数", async () => {
      const filePath = join(testDir, "tool-pagination.txt");
      await writeFile(filePath, "line 1\nline 2\nline 3", "utf8");

      const result = await executeTool({
        id: "read-paged",
        name: "read_file",
        arguments: { path: filePath, offset: 2, limit: 1 },
      });

      expect(result).toBe("line 2");
    });
  });
});
