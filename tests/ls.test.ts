import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { executeTool, ls } from "../src/tools/index.ts";

describe("ls", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(process.cwd(), ".tmp-test-ls-"));
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it("列出文件和目录，目录名以 / 结尾", async () => {
    await writeFile(join(testDir, "a file.txt"), "", "utf8");
    await mkdir(join(testDir, "src"));

    await expect(ls(testDir)).resolves.toBe("a file.txt\nsrc/");
  });

  it("包含隐藏文件，并按名称排序", async () => {
    for (const name of ["z.txt", ".hidden", "a.txt"]) {
      await writeFile(join(testDir, name), "", "utf8");
    }

    await expect(ls(".", undefined, testDir)).resolves.toBe(
      ".hidden\na.txt\nz.txt",
    );
  });

  it("只列直接子项，不递归列出子目录内容", async () => {
    await mkdir(join(testDir, "src"));
    await writeFile(join(testDir, "src", "nested.ts"), "", "utf8");

    await expect(ls(".", undefined, testDir)).resolves.toBe("src/");
  });

  it("空目录返回 (空目录)，未提供 path 时浏览工作区根目录", async () => {
    await expect(ls(undefined, undefined, testDir)).resolves.toBe("(空目录)");
  });

  it("先排序再应用 limit，并提示还有多少项未显示", async () => {
    for (const name of ["z.txt", "b.txt", "a.txt"]) {
      await writeFile(join(testDir, name), "", "utf8");
    }

    await expect(ls(".", 1, testDir)).resolves.toBe(
      "a.txt\n[... 还有 2 项未显示 ...]",
    );
    await expect(ls(".", 3, testDir)).resolves.toBe("a.txt\nb.txt\nz.txt");
  });

  it.each([undefined, null])(
    "limit 为 %s 时默认展示前 100 项",
    async (limit) => {
      await Promise.all(
        Array.from({ length: 101 }, (_, index) =>
          writeFile(
            join(testDir, `file-${String(index + 1).padStart(3, "0")}.txt`),
            "",
            "utf8",
          ),
        ),
      );

      const result = await ls(".", limit, testDir);
      const lines = result.split("\n");
      expect(lines).toHaveLength(101);
      expect(lines[0]).toBe("file-001.txt");
      expect(lines[99]).toBe("file-100.txt");
      expect(lines[100]).toBe("[... 还有 1 项未显示 ...]");
      expect(result).not.toContain("file-101.txt");
    },
  );

  it.each([0, -1, 1.5, NaN, Infinity, -Infinity])(
    "拒绝非法 limit：%s",
    async (limit) => {
      await expect(ls(".", limit, testDir)).rejects.toThrow(
        "limit 必须是正整数",
      );
    },
  );

  it("相对路径基于 workspaceRoot 解析，并拒绝越界路径", async () => {
    await mkdir(join(testDir, "nested"));
    await writeFile(join(testDir, "nested", "inside.txt"), "", "utf8");

    await expect(ls("nested", undefined, testDir)).resolves.toBe("inside.txt");
    await expect(ls("..", undefined, testDir)).rejects.toThrow(
      "禁止越界访问：..",
    );
  });

  it("目录不存在或传入文件路径时抛出错误", async () => {
    await writeFile(join(testDir, "file.txt"), "", "utf8");

    await expect(ls("missing", undefined, testDir)).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(ls("file.txt", undefined, testDir)).rejects.toMatchObject({
      code: "ENOTDIR",
    });
  });

  it("输出超过 50KiB 时截断，保留头部和有效 UTF-8 文本", async () => {
    // 每个文件名少于 255 字节，总输出超过字节上限但不触发行数上限。
    const names = Array.from(
      { length: 230 },
      (_, index) => `${String(index).padStart(3, "0")}-${"文".repeat(75)}.txt`,
    );
    await Promise.all(
      names.map((name) => writeFile(join(testDir, name), "", "utf8")),
    );

    const result = await ls(".", names.length, testDir);

    expect(result).toContain(names[0]);
    expect(result).not.toContain(names[names.length - 1]);
    expect(result).toMatch(/\[\.\.\. 已截断余下 \d+ 行 \.\.\.\]/);
    expect(result).not.toContain("\uFFFD");
    expect(Buffer.byteLength(result, "utf8")).toBeLessThan(50 * 1024 + 100);
  });

  it("executeTool 转发 path、limit、workspaceRoot，并捕获错误", async () => {
    await mkdir(join(testDir, "nested"));
    await writeFile(join(testDir, "nested", "a.txt"), "", "utf8");
    await writeFile(join(testDir, "nested", "z.txt"), "", "utf8");

    await expect(
      executeTool(
        {
          id: "ls-success",
          name: "ls",
          arguments: { path: "nested", limit: 1 },
        },
        testDir,
      ),
    ).resolves.toBe("a.txt\n[... 还有 1 项未显示 ...]");

    const missingResult = await executeTool(
      { id: "ls-missing", name: "ls", arguments: { path: "missing" } },
      testDir,
    );
    expect(missingResult).toMatch(/^工具执行失败：/);
    expect(missingResult).toContain("missing");

    await expect(
      executeTool(
        { id: "ls-outside", name: "ls", arguments: { path: ".." } },
        testDir,
      ),
    ).resolves.toBe("工具执行失败：禁止越界访问：..");
  });
});
