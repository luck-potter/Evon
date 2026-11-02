import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { editFile, executeTool, readFile, writeFile } from "../src/tools/index.ts";
import { resolveSafePath } from "../src/utils/path.ts";

describe("工作区路径安全围栏", () => {
  const workspaceRoot = process.cwd();

  it("测试正常相对路径：src/tools/index.ts -> 允许", () => {
    const safePath = resolveSafePath("src/tools/index.ts", workspaceRoot);
    expect(safePath).toBe(join(workspaceRoot, "src/tools/index.ts"));
  });

  it("测试正常工作区内绝对路径：${workspaceRoot}/foo.txt -> 允许", () => {
    const target = join(workspaceRoot, "foo.txt");
    const safePath = resolveSafePath(target, workspaceRoot);
    expect(safePath).toBe(target);
  });

  it("测试 ../ 逃逸：../../etc/passwd -> 报错拦截", () => {
    expect(() => resolveSafePath("../../etc/passwd", workspaceRoot)).toThrow(
      "禁止越界访问：../../etc/passwd",
    );
  });

  it("测试敏感绝对路径：/etc/passwd 或系统路径 -> 报错拦截", () => {
    const sensitivePath = resolve("/etc/passwd");
    expect(() => resolveSafePath(sensitivePath, workspaceRoot)).toThrow(
      `禁止越界访问：${sensitivePath}`,
    );
  });

  it("测试前缀混淆：/workspace-other/file -> 报错拦截", () => {
    const mockRoot = resolve("/mock/workspace");
    const confusionPath = resolve("/mock/workspace-other/file.txt");

    expect(() => resolveSafePath(confusionPath, mockRoot)).toThrow(
      `禁止越界访问：${confusionPath}`,
    );
  });

  describe("工具集成安全防御", () => {
    it("readFile 拦截越界路径", async () => {
      await expect(readFile("../../etc/passwd")).rejects.toThrow("禁止越界访问");
    });

    it("writeFile 拦截越界路径", async () => {
      await expect(writeFile("/etc/passwd", "evil")).rejects.toThrow("禁止越界访问");
    });

    it("editFile 拦截越界路径", async () => {
      await expect(editFile("../../etc/passwd", "old", "new")).rejects.toThrow(
        "禁止越界访问",
      );
    });

    it("executeTool 捕获越界错误并向模型返回友好提示", async () => {
      const result = await executeTool({
        id: "jail-breach",
        name: "read_file",
        arguments: { path: "../../etc/passwd" },
      });

      expect(result).toMatch(/^工具执行失败：禁止越界访问：\.\.\/\.\.\/etc\/passwd/);
    });
  });
});
