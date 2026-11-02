import { mkdtemp, readFile as fsReadFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { applyPatch } from "diff";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { editFile, executeTool } from "../src/tools/index.ts";

describe("editFile", () => {
  let testDir: string;
  let filePath: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(process.cwd(), ".tmp-test-edit-file-"));
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

    const prefix = `文件修改成功：${filePath}\n\n`;
    expect(result.startsWith(prefix)).toBe(true);
    expect(applyPatch(content, result.slice(prefix.length))).toBe(expected);
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

  it.each([
    {
      name: "用 LF 原文匹配 CRLF 文件，保留范围外的换行",
      content: "before\r\nold\r\nvalue\r\nafter\r\n",
      oldStr: "old\nvalue",
      newStr: "new\r\nnext",
      expected: "before\r\nnew\r\nnext\r\nafter\r\n",
    },
    {
      name: "用 CRLF 原文匹配 LF 文件",
      content: "before\nold\nvalue\nafter\n",
      oldStr: "old\r\nvalue",
      newStr: "new\nnext",
      expected: "before\nnew\nnext\nafter\n",
    },
    {
      name: "容忍文件中的行尾空格和 Tab，保留范围外的空白",
      content: "before  \n  old\t \n  value  \nafter\t\n",
      oldStr: "  old\n  value",
      newStr: "  new\n  next",
      expected: "before  \n  new\n  next  \nafter\t\n",
    },
    {
      name: "容忍 old_str 中的行尾空白",
      content: "before\nold\nvalue\nafter\n",
      oldStr: "old \t\nvalue  ",
      newStr: "new\nnext",
      expected: "before\nnew\nnext\nafter\n",
    },
    {
      name: "精确匹配优先于其他容错候选",
      content: "old\nvalue\nold \nvalue\n",
      oldStr: "old\nvalue",
      newStr: "new\nvalue",
      expected: "new\nvalue\nold \nvalue\n",
    },
    {
      name: "换行容错优先于行尾空白容错",
      content: "old\r\nvalue\nold \nvalue\n",
      oldStr: "old\nvalue",
      newStr: "new\r\nvalue",
      expected: "new\r\nvalue\nold \nvalue\n",
    },
    {
      name: "容错匹配仍把正则字符和替换标记当作原文",
      content: "[a+b].*?\t\n$&\n",
      oldStr: "[a+b].*?\n$&",
      newStr: "$& $` $' \\path",
      expected: "$& $` $' \\path\n",
    },
    {
      name: "删除容错匹配的整块文本",
      content: "before\nold \nvalue\nafter\n",
      oldStr: "old\nvalue\n",
      newStr: "",
      expected: "before\nafter\n",
    },
    {
      name: "空白首行不被误判为多个候选",
      content: "before\n \t\nold \nvalue\nafter\n",
      oldStr: "\nold\nvalue",
      newStr: "\nnew\nvalue",
      expected: "before\n\nnew\nvalue\nafter\n",
    },
  ])("$name", async ({ content, oldStr, newStr, expected }) => {
    await writeFile(filePath, content, "utf8");

    const result = await editFile(filePath, oldStr, newStr);

    const prefix = `文件修改成功：${filePath}\n\n`;
    expect(result.startsWith(prefix)).toBe(true);
    expect(applyPatch(content, result.slice(prefix.length))).toBe(expected);
    await expect(fsReadFile(filePath, "utf8")).resolves.toBe(expected);
  });

  it.each([
    { content: "old\r\nvalue\nold\r\nvalue", oldStr: "old\nvalue" },
    { content: "old \nvalue\nold\t\nvalue", oldStr: "old\nvalue" },
    { content: "a\r\na\r\na", oldStr: "a\na" },
    { content: "a \na \na", oldStr: "a\na" },
  ])("拒绝多处或重叠的容错候选 %j，并保留原文件", async ({ content, oldStr }) => {
    await writeFile(filePath, content, "utf8");

    await expect(editFile(filePath, oldStr, "new")).resolves.toBe(
      "文件未修改：old_str 匹配多处，请提供更完整的旧文本",
    );
    await expect(fsReadFile(filePath, "utf8")).resolves.toBe(content);
  });

  it.each([
    { content: "  old\n  value", oldStr: " old\n value" },
    { content: "\told\n\tvalue", oldStr: "  old\n  value" },
    { content: 'const s = "a  b";\n', oldStr: 'const s = "a b";\n' },
    { content: "old\n", oldStr: " \t\n" },
    { content: "old suffix\n", oldStr: "old  " },
  ])("不忽略缩进、行内空白或整段空白 %j", async ({ content, oldStr }) => {
    await writeFile(filePath, content, "utf8");

    await expect(editFile(filePath, oldStr, "new")).resolves.toBe(
      "文件未修改：未找到 old_str",
    );
    await expect(fsReadFile(filePath, "utf8")).resolves.toBe(content);
  });

  it("替换内容相同时返回未修改提示", async () => {
    await writeFile(filePath, "before old after", "utf8");

    await expect(editFile(filePath, "old", "old")).resolves.toBe(
      "文件未修改：替换前后内容相同",
    );
    await expect(fsReadFile(filePath, "utf8")).resolves.toBe("before old after");
  });

  it("超长 diff 被截断时仍完整写入文件", async () => {
    await writeFile(filePath, "old", "utf8");
    const newStr = "新".repeat(30_000);

    const result = await editFile(filePath, "old", newStr);

    expect(result).toContain("文件修改成功：" + filePath);
    expect(result).toContain("已截断");
    expect(Buffer.byteLength(result)).toBeLessThan(53_000);
    await expect(fsReadFile(filePath, "utf8")).resolves.toBe(newStr);
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

      const prefix = `文件修改成功：${filePath}\n\n`;
      expect(result.startsWith(prefix)).toBe(true);
      expect(applyPatch("return a - b;\n", result.slice(prefix.length))).toBe(
        "return a + b;\n",
      );
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

    it("将容错歧义返回给模型，并保留原文件", async () => {
      const content = "old \nvalue\nold\t\nvalue";
      await writeFile(filePath, content, "utf8");

      const result = await executeTool({
        id: "edit-ambiguous",
        name: "edit_file",
        arguments: { path: filePath, old_str: "old\nvalue", new_str: "new" },
      });

      expect(result).toBe("文件未修改：old_str 匹配多处，请提供更完整的旧文本");
      await expect(fsReadFile(filePath, "utf8")).resolves.toBe(content);
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
