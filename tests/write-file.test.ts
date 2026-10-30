import {
  mkdtemp,
  readFile as fsReadFile,
  rm,
  writeFile as fsWriteFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { executeTool, writeFile } from "../src/tools.ts";

describe("writeFile", () => {
  let testDir: string;
  let filePath: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), "mini-swe-agent-write-file-"));
    filePath = join(testDir, "示例 file.txt");
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it.each([
    {
      name: "创建新文件，不额外添加换行",
      content: "hello",
    },
    {
      name: "原样写入多行中文、缩进、空行、特殊字符和末尾换行",
      content: "第一行\n\n  第二行\n\t$& $$ $` $' $1 \"引号\" \\path\n",
    },
    {
      name: "允许创建空文件",
      content: "",
    },
  ])("$name", async ({ content }) => {
    const result = await writeFile(filePath, content);

    expect(result).toBe("文件写入成功：" + filePath);
    await expect(fsReadFile(filePath, "utf8")).resolves.toBe(content);
  });

  it.each([
    { name: "完整覆盖已有文件，不残留旧内容", content: "new" },
    { name: "允许清空已有文件", content: "" },
  ])("$name", async ({ content }) => {
    await fsWriteFile(filePath, "original content that is longer", "utf8");

    const result = await writeFile(filePath, content);

    expect(result).toBe("文件写入成功：" + filePath);
    await expect(fsReadFile(filePath, "utf8")).resolves.toBe(content);
  });

  it("父目录不存在时抛出包含路径的错误，不自动创建目录", async () => {
    const missingParent = join(testDir, "missing");
    const missingFile = join(missingParent, "file.txt");

    await expect(writeFile(missingFile, "hello")).rejects.toThrow(missingFile);
    await expect(fsReadFile(missingParent)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  describe("executeTool 的 write_file 分支", () => {
    it.each([
      { name: "创建新文件", exists: false },
      { name: "覆盖已有文件", exists: true },
    ])("使用 path 和 content 参数$name并返回成功提示", async ({ exists }) => {
      if (exists) await fsWriteFile(filePath, "old content", "utf8");

      const result = await executeTool({
        id: "write-success",
        name: "write_file",
        arguments: { path: filePath, content: "新内容\n" },
      });

      expect(result).toBe("文件写入成功：" + filePath);
      await expect(fsReadFile(filePath, "utf8")).resolves.toBe("新内容\n");
    });

    it("将文件写入错误转换成工具结果", async () => {
      const missingFile = join(testDir, "missing", "file.txt");

      const result = await executeTool({
        id: "write-failure",
        name: "write_file",
        arguments: { path: missingFile, content: "hello" },
      });

      expect(result).toMatch(/^工具执行失败：/);
      expect(result).toContain(missingFile);
      await expect(fsReadFile(missingFile)).rejects.toMatchObject({
        code: "ENOENT",
      });
    });
  });
});
