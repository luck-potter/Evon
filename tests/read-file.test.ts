import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { executeTool, readFile } from "../src/tools.ts";

describe("readFile", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), "mini-swe-agent-read-file-"));
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it.each([
    {
      name: "单行文件的行号从 1 开始",
      content: "const answer = 42;",
      expected: "1: const answer = 42;",
    },
    {
      name: "按 UTF-8 读取多行中文，并连续编号",
      content: "第一行\n第二行\n第三行",
      expected: "1: 第一行\n2: 第二行\n3: 第三行",
    },
    {
      name: "保留中间的空行、空格缩进和制表符",
      content: "function greet() {\n\n  return '你好';\n\t}",
      expected: "1: function greet() {\n2: \n3:   return '你好';\n4: \t}",
    },
    {
      name: "保留引号和反斜杠",
      content: 'const message = "你好\\\\世界";',
      expected: '1: const message = "你好\\\\世界";',
    },
    // 当前约定：空文件也显示第 1 行；末尾换行会产生一个编号空行。
    {
      name: "空文件返回带行号的空行",
      content: "",
      expected: "1: ",
    },
    {
      name: "保留文件末尾换行产生的空行",
      content: "第一行\n",
      expected: "1: 第一行\n2: ",
    },
  ])("$name", async ({ content, expected }) => {
    // 文件名同时包含中文和空格，验证实际文件路径的处理。
    const filePath = join(testDir, "示例 file.txt");
    await writeFile(filePath, content, "utf8");

    await expect(readFile(filePath)).resolves.toBe(expected);
  });

  it("文件不存在时抛出包含文件路径的错误", async () => {
    const filePath = join(testDir, "missing.txt");

    await expect(readFile(filePath)).rejects.toThrow(filePath);
  });

  it("executeTool 的 read_file 分支返回带行号的文件内容", async () => {
    const filePath = join(testDir, "tool-input.txt");
    await writeFile(filePath, "第一行\n第二行", "utf8");

    const result = await executeTool({
      id: "read-success",
      name: "read_file",
      arguments: { path: filePath },
    });

    expect(result).toBe("1: 第一行\n2: 第二行");
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
});
