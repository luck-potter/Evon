import * as childProcess from "node:child_process";
import { access, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { executeTool, findFiles } from "../src/tools/index.ts";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof childProcess>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});

const { spawn: nativeSpawn } = await vi.importActual<typeof childProcess>("node:child_process");

describe("findFiles", () => {
  let testDir: string;

  beforeEach(async () => {
    vi.mocked(childProcess.spawn).mockReset();
    testDir = await mkdtemp(join(tmpdir(), "evon-test-find-files-"));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await rm(testDir, { recursive: true, force: true });
  });

  async function putFile(path: string, content: string | Buffer = ""): Promise<void> {
    const target = join(testDir, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content);
  }

  function mockRipgrep(script: string, onSpawn?: () => void) {
    return vi.mocked(childProcess.spawn).mockImplementationOnce((_command, _args, options) => {
      const child = nativeSpawn(process.execPath, ["-e", script], {
        ...options,
        cwd: testDir,
        stdio: ["ignore", "pipe", "pipe"],
      });
      if (onSpawn) child.once("spawn", onSpawn);
      return child;
    });
  }

  it("递归匹配文件名，按路径排序，只返回文件的工作区相对路径", async () => {
    await putFile("src/b.ts");
    await putFile("a.ts");
    await putFile("src/c.js");
    await mkdir(join(testDir, "directory.ts"));

    await expect(findFiles({ pattern: "*.ts" }, testDir)).resolves.toBe("a.ts\nsrc/b.ts");
  });

  it("支持包含目录的 glob、**、?、字符集合和花括号", async () => {
    await putFile("src/a.test.ts");
    await putFile("src/deep/b.test.ts");
    await putFile("src/c.ts");
    await putFile("readme.md");

    await expect(findFiles({ pattern: "src/**/[ab].test.?s" }, testDir)).resolves.toBe(
      "src/a.test.ts\nsrc/deep/b.test.ts",
    );
    await expect(findFiles({ pattern: "*.{md,ts}" }, testDir)).resolves.toBe(
      "readme.md\nsrc/a.test.ts\nsrc/c.ts\nsrc/deep/b.test.ts",
    );
  });

  it("path 支持相对和绝对目录，模式相对此目录，结果仍相对于工作区", async () => {
    await putFile("a.ts");
    await putFile("src/a.ts");
    await putFile("src/deep/b.ts");

    for (const path of ["src", join(testDir, "src")]) {
      await expect(findFiles({ pattern: "deep/*.ts", path }, testDir)).resolves.toBe(
        "src/deep/b.ts",
      );
    }
  });

  it.each([undefined, null])("可选参数为 %s 时采用默认值，默认上限为 100", async (value) => {
    for (let i = 0; i <= 100; i++) await putFile(`${String(i).padStart(3, "0")}.ts`);

    const result = await findFiles({ pattern: "*.ts", path: value, limit: value }, testDir);
    expect(result.split("\n")).toHaveLength(101);
    expect(result).toMatch(/^000\.ts\n/);
    expect(result).toContain("099.ts\n[... 已达到文件数量上限 100");
    expect(result).not.toContain("100.ts");
  });

  it.each([0, -1, 1.5, NaN, Infinity])("拒绝非法 limit：%s", async (limit) => {
    await expect(findFiles({ pattern: "*", limit }, testDir)).rejects.toThrow("limit 必须是正整数");
    expect(childProcess.spawn).not.toHaveBeenCalled();
  });

  it("空模式在启动子进程前报错", async () => {
    await expect(findFiles({ pattern: "" }, testDir)).rejects.toThrow("pattern 不能为空");
    expect(childProcess.spawn).not.toHaveBeenCalled();
  });

  it("空目录和没有匹配的目录返回 (无匹配)", async () => {
    await expect(findFiles({ pattern: "*" }, testDir)).resolves.toBe("(无匹配)");
    await putFile("a.ts");
    await expect(findFiles({ pattern: "*.js" }, testDir)).resolves.toBe("(无匹配)");
  });

  it("遵循根目录及嵌套的忽略规则，匹配 glob 也不重新包含被忽略的文件", async () => {
    await putFile(".gitignore", "ignored.ts\nignored/\nnode_modules/\n");
    await putFile(".ignore", "local.ts\n");
    await putFile("ignored.ts");
    await putFile("local.ts");
    await putFile("ignored/a.ts");
    await putFile("node_modules/pkg/index.ts");
    await putFile(".hidden.ts");
    await putFile(".hidden/inside.ts");
    await putFile("src/.gitignore", "skip.ts\n");
    await putFile("src/skip.ts");
    await putFile("src/keep.ts");

    await expect(findFiles({ pattern: "*.ts" }, testDir)).resolves.toBe("src/keep.ts");
    await expect(findFiles({ pattern: "ignored.ts" }, testDir)).resolves.toBe("(无匹配)");
  });

  it("**/* 也能列出空文件和二进制文件", async () => {
    await putFile("empty.txt");
    await putFile("assets/image.bin", Buffer.from([0, 255, 1]));

    await expect(findFiles({ pattern: "**/*" }, testDir)).resolves.toBe(
      "assets/image.bin\nempty.txt",
    );
  });

  it("达到文件上限时提示，文件数恰好等于上限时也提示", async () => {
    await putFile("a.ts");
    await putFile("b.ts");

    await expect(findFiles({ pattern: "*.ts", limit: 1 }, testDir)).resolves.toBe(
      "a.ts\n[... 已达到文件数量上限 1，可增大 limit 或缩小搜索范围 ...]",
    );
    await expect(findFiles({ pattern: "*.ts", limit: 2 }, testDir)).resolves.toBe(
      "a.ts\nb.ts\n[... 已达到文件数量上限 2，可增大 limit 或缩小搜索范围 ...]",
    );
  });

  it("文件名及模式中的引号、空格、$() 与反引号不会被 shell 执行", async () => {
    const name = "-文件 '$(touch EVON_FIND_SENTINEL)' `touch EVON_FIND_BACKTICK`.ts";
    await putFile(name);

    await expect(findFiles({ pattern: name }, testDir)).resolves.toBe(name);
    for (const marker of ["EVON_FIND_SENTINEL", "EVON_FIND_BACKTICK"]) {
      await expect(access(join(testDir, marker))).rejects.toMatchObject({ code: "ENOENT" });
    }
  });

  it("目录名中的 shell 表达式和 - 前缀按原样传递", async () => {
    const path = "-目录 $(touch EVON_FIND_PATH)";
    await putFile(`${path}/a.ts`);

    await expect(findFiles({ pattern: "*.ts", path }, testDir)).resolves.toBe(`${path}/a.ts`);
    await expect(access(join(testDir, "EVON_FIND_PATH"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("NUL 分隔不会把文件名中的换行符误当作路径分隔符", async () => {
    const name = "中文😀\n文件.ts";
    await putFile(name);

    await expect(findFiles({ pattern: "*.ts" }, testDir)).resolves.toBe(name);
  });

  it("拒绝越界、不存在和非目录路径", async () => {
    await putFile("a.ts");
    await expect(findFiles({ pattern: "*", path: ".." }, testDir)).rejects.toThrow("禁止越界访问");
    await expect(findFiles({ pattern: "*", path: "missing" }, testDir)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(findFiles({ pattern: "*", path: "a.ts" }, testDir)).rejects.toThrow("path 必须是目录");
    expect(childProcess.spawn).not.toHaveBeenCalled();
  });

  it("拒绝工作区外的目录符号链接，遍历时不跟随文件或目录符号链接", async () => {
    const outside = await mkdtemp(join(tmpdir(), "evon-test-find-outside-"));
    try {
      await writeFile(join(outside, "outside.ts"), "");
      await symlink(outside, join(testDir, "link"));
      await symlink(join(outside, "outside.ts"), join(testDir, "link.ts"));

      await expect(findFiles({ pattern: "*", path: "link" }, testDir)).rejects.toThrow("禁止越界访问");
      await expect(findFiles({ pattern: "**/*" }, testDir)).resolves.toBe("(无匹配)");
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("流式解码跨数据块的 UTF-8 字符和未完成的 NUL 路径", async () => {
    const output = Buffer.from(`${join(testDir, "中文😀.ts")}\0${join(testDir, "b.ts")}\0`);
    const split = Buffer.byteLength(`${testDir}/`) + 1;
    mockRipgrep(`
      const data = Buffer.from(${JSON.stringify(output.toString("base64"))}, "base64");
      process.stdout.write(data.subarray(0, ${split}));
      setTimeout(() => process.stdout.write(data.subarray(${split})), 20);
    `);

    await expect(findFiles({ pattern: "*.ts" }, testDir)).resolves.toBe("中文😀.ts\nb.ts");
  });

  it("达到上限会终止仍在运行的子进程，未匹配文件不计入上限", async () => {
    const output = ["a.js", "b.ts", "c.ts", "d.ts"].map((name) => join(testDir, name)).join("\0") + "\0";
    const run = mockRipgrep(`process.stdout.write(${JSON.stringify(output)}); setTimeout(() => {}, 10_000);`);

    const result = await findFiles({ pattern: "*.ts", limit: 2 }, testDir);
    expect(result).toMatch(/^b\.ts\nc\.ts\n/);
    expect(result).toContain("已达到文件数量上限 2");
    expect(result).not.toContain("a.js");
    expect(result).not.toContain("d.ts");
    expect(run.mock.results[0].value.signalCode).toBe("SIGTERM");
  });

  it("未安装 rg 时保留启动错误", async () => {
    vi.stubEnv("PATH", testDir);
    await expect(findFiles({ pattern: "*" }, testDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("非零退出时返回退出码及 stderr 原因，不把已输出的文件误报为成功", async () => {
    mockRipgrep(`
      process.stdout.write(${JSON.stringify(`${join(testDir, "a.ts")}\0`)});
      process.stderr.write("  权限不足：无法读取 src/private\\n");
      process.exitCode = 2;
    `);

    await expect(findFiles({ pattern: "*.ts" }, testDir)).rejects.toThrow(
      "rg 执行失败（退出码 2）：权限不足：无法读取 src/private",
    );
  });

  it("stderr 为空时仍返回退出码和兜底错误信息", async () => {
    mockRipgrep("process.exitCode = 3;");
    await expect(findFiles({ pattern: "*" }, testDir)).rejects.toThrow(
      "rg 执行失败（退出码 3）：命令异常结束",
    );
  });

  it("退出码为 0 时 stderr 警告不影响正常结果", async () => {
    mockRipgrep(`
      process.stdout.write(${JSON.stringify(`${join(testDir, "a.ts")}\0`)});
      process.stderr.write("warning only\\n");
    `);

    await expect(findFiles({ pattern: "*.ts" }, testDir)).resolves.toBe("a.ts");
  });

  it("持续消费大量 stderr，避免错误输出填满管道后阻塞", async () => {
    mockRipgrep(`
      process.stderr.write("x".repeat(1024 * 1024));
      process.stderr.write("\\npermission denied at end\\n");
      process.exitCode = 2;
    `);

    await expect(findFiles({ pattern: "*" }, testDir)).rejects.toThrow("permission denied at end");
  });

  it("工具分发返回文件列表，并把 stderr 原因作为工具错误回填", async () => {
    await putFile("src/a.ts");
    await expect(executeTool({
      id: "find-ok", name: "find_files", arguments: { pattern: "*.ts", path: "src", limit: 5 },
    }, testDir)).resolves.toBe("src/a.ts");

    mockRipgrep('process.stderr.write("permission denied\\n"); process.exitCode = 2;');
    await expect(executeTool({
      id: "find-error", name: "find_files", arguments: { pattern: "*" },
    }, testDir)).resolves.toBe("工具执行失败：rg 执行失败（退出码 2）：permission denied");
  });

  it("提前取消时不启动子进程", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(findFiles({ pattern: "*" }, testDir, controller.signal)).rejects.toThrow("查找文件已被用户取消");
    expect(childProcess.spawn).not.toHaveBeenCalled();
  });

  it("通过工具分发取消时终止子进程，不把取消误报成退出码错误", async () => {
    const controller = new AbortController();
    const run = mockRipgrep("setTimeout(() => {}, 10_000);", () => controller.abort());

    await expect(executeTool({
      id: "find-abort", name: "find_files", arguments: { pattern: "*" },
    }, testDir, controller.signal)).resolves.toBe("工具执行失败：查找文件已被用户取消");
    expect(run.mock.results[0].value.signalCode).toBe("SIGTERM");
  });

  it("30 秒超时终止子进程，不把超时误报成退出码错误", async () => {
    const controller = new AbortController();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValueOnce(controller.signal);
    const run = mockRipgrep("setTimeout(() => {}, 10_000);", () => controller.abort());

    await expect(findFiles({ pattern: "*" }, testDir)).rejects.toThrow("查找文件超时");
    expect(timeout).toHaveBeenCalledWith(30_000);
    expect(run.mock.results[0].value.signalCode).toBe("SIGTERM");
  });
});
