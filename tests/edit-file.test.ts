import { mkdtemp, readFile as fsReadFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { editFile, executeTool } from "../src/tools.ts";

describe("editFile", () => {
  let testDir: string;
  let filePath: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), "mini-swe-agent-edit-file-"));
    filePath = join(testDir, "示例 file.txt");
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it.each([
    {
      name: "替换唯一匹配，保留前后文本且不额外添加换行",
      content: "before old after",
      oldStr: "old",
      newStr: "new",
      expected: "before new after",
    },
    {
      name: "替换多行中文，保留周围的缩进、空行和末尾换行",
      content: "开头\n\n  旧第一行\n\t旧第二行\n\n结尾\n",
      oldStr: "  旧第一行\n\t旧第二行",
      newStr: "  新第一行\n\t新第二行",
      expected: "开头\n\n  新第一行\n\t新第二行\n\n结尾\n",
    },
    {
      name: "把旧文本中的正则特殊字符当作普通文本匹配",
      content: "before [a+b].*? after",
      oldStr: "[a+b].*?",
      newStr: "new",
      expected: "before new after",
    },
    {
      name: "新文本中的替换标记、引号和反斜杠按原样写入",
      content: "before old after",
      oldStr: "old",
      newStr: "$& $$ $` $' $1 \"引号\" \\path",
      expected: "before $& $$ $` $' $1 \"引号\" \\path after",
    },
    {
      name: "允许只包含空格的非空旧文本",
      content: "before  after",
      oldStr: "  ",
      newStr: " ",
      expected: "before after",
    },
    {
      name: "新文本为空时删除匹配内容",
      content: "keep old text",
      oldStr: " old",
      newStr: "",
      expected: "keep text",
    },
    {
      name: "允许删除整个文件的内容，保留空文件",
      content: "old",
      oldStr: "old",
      newStr: "",
      expected: "",
    },
  ])("$name", async ({ content, oldStr, newStr, expected }) => {
    await writeFile(filePath, content, "utf8");

    const result = await editFile(filePath, oldStr, newStr);

    expect(result).toBe("文件修改成功：" + filePath);
    await expect(fsReadFile(filePath, "utf8")).resolves.toBe(expected);
  });

  it.each([
    {
      name: "拒绝空旧文本",
      content: "hello",
      oldStr: "",
      expectedMessage: "文件未修改：old_str 为空",
    },
    {
      name: "找不到旧文本时返回未修改提示",
      content: "hello world",
      oldStr: "missing",
      expectedMessage: "文件未修改：未找到 old_str",
    },
    {
      name: "空文件中找不到非空旧文本时也返回未修改提示",
      content: "",
      oldStr: "old",
      expectedMessage: "文件未修改：未找到 old_str",
    },
    {
      name: "拒绝修改出现多次的旧文本",
      content: "old + old",
      oldStr: "old",
      expectedMessage: "文件未修改：old_str 匹配多处，请提供更完整的旧文本",
    },
    {
      name: "拒绝修改存在重叠匹配的旧文本",
      content: "aaa",
      oldStr: "aa",
      expectedMessage: "文件未修改：old_str 匹配多处，请提供更完整的旧文本",
    },
  ])("$name，并保留原文件", async ({ content, oldStr, expectedMessage }) => {
    await writeFile(filePath, content, "utf8");

    const result = await editFile(filePath, oldStr, "new");

    expect(result).toBe(expectedMessage);
    await expect(fsReadFile(filePath, "utf8")).resolves.toBe(content);
  });

  it("文件不存在时抛出包含文件路径的错误，不创建新文件", async () => {
    await expect(editFile(filePath, "old", "new")).rejects.toThrow(filePath);
    await expect(fsReadFile(filePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("空旧文本不会用于创建新文件", async () => {
    await expect(editFile(filePath, "", "new")).resolves.toBe(
      "文件未修改：old_str 为空",
    );
    await expect(fsReadFile(filePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  describe("executeTool 的 edit_file 分支", () => {
    it("使用 old_str 和 new_str 参数修改文件并返回成功提示", async () => {
      await writeFile(filePath, "return a - b;\n", "utf8");

      const result = await executeTool({
        id: "edit-success",
        name: "edit_file",
        arguments: {
          path: filePath,
          old_str: "return a - b;",
          new_str: "return a + b;",
        },
      });

      expect(result).toBe("文件修改成功：" + filePath);
      await expect(fsReadFile(filePath, "utf8")).resolves.toBe("return a + b;\n");
    });

    it("将未找到旧文本的提示返回给模型，并保留原文件", async () => {
      await writeFile(filePath, "hello", "utf8");

      const result = await executeTool({
        id: "edit-not-found",
        name: "edit_file",
        arguments: { path: filePath, old_str: "missing", new_str: "new" },
      });

      expect(result).toBe("文件未修改：未找到 old_str");
      await expect(fsReadFile(filePath, "utf8")).resolves.toBe("hello");
    });

    it("将文件读取错误转换成工具结果", async () => {
      const result = await executeTool({
        id: "edit-failure",
        name: "edit_file",
        arguments: { path: filePath, old_str: "old", new_str: "new" },
      });

      expect(result).toMatch(/^工具执行失败：/);
      expect(result).toContain(filePath);
      await expect(fsReadFile(filePath)).rejects.toMatchObject({ code: "ENOENT" });
    });
  });
});
