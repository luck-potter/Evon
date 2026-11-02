import * as childProcess from "node:child_process";
import { access, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { executeTool, grep } from "../src/tools/index.ts";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof childProcess>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});

const { spawn: nativeSpawn } = await vi.importActual<typeof childProcess>("node:child_process");

describe("grep", () => {
  let testDir: string;

  beforeEach(async () => {
    vi.mocked(childProcess.spawn).mockReset();
    testDir = await mkdtemp(join(tmpdir(), "evon-test-grep-"));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await rm(testDir, { recursive: true, force: true });
  });

  async function putFile(path: string, content: string | Buffer): Promise<void> {
    const target = join(testDir, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content);
  }

  function mockRipgrep(script: string) {
    return vi.mocked(childProcess.spawn).mockImplementationOnce((_command, _args, options) =>
      nativeSpawn(process.execPath, ["-e", script], {
        ...options,
        cwd: testDir,
        stdio: ["ignore", "pipe", "pipe"],
      }),
    );
  }

  it("默认递归搜索正则，按路径排序并返回相对路径、行号和原文", async () => {
    await putFile("src/b.ts", "跳过\n  fooBar();  \n");
    await putFile("a.ts", "fooBaz();\nfooOther();\n");

    await expect(grep({ pattern: "foo(Bar|Baz)" }, testDir)).resolves.toBe(
      "a.ts:1:fooBaz();\nsrc/b.ts:2:  fooBar();  ",
    );
  });

  it("literal 按普通文本匹配，保留正则元字符", async () => {
    await putFile("a.ts", "foo.bar\nfooXbar\n");

    await expect(
      grep({ pattern: "foo.bar", literal: true }, testDir),
    ).resolves.toBe("a.ts:1:foo.bar");
  });

  it("默认区分大小写，可用 ignoreCase 忽略大小写", async () => {
    await putFile("a.ts", "HELLO\n");

    await expect(grep({ pattern: "hello" }, testDir)).resolves.toBe("(无匹配)");
    await expect(
      grep({ pattern: "hello", ignoreCase: true }, testDir),
    ).resolves.toBe("a.ts:1:HELLO");
  });

  it("glob 过滤根目录和子目录中的文件", async () => {
    await putFile("a.ts", "needle\n");
    await putFile("src/b.ts", "needle\n");
    await putFile("src/c.js", "needle\n");

    await expect(
      grep({ pattern: "needle", glob: "*.ts" }, testDir),
    ).resolves.toBe("a.ts:1:needle\nsrc/b.ts:1:needle");
  });

  it("支持指定目录、单文件和绝对路径，结果仍相对于工作区", async () => {
    await putFile("root.ts", "needle\n");
    await putFile("src/a.ts", "needle\n");
    await putFile("src/b.ts", "needle\n");

    await expect(
      grep({ pattern: "needle", path: "src" }, testDir),
    ).resolves.toBe("src/a.ts:1:needle\nsrc/b.ts:1:needle");
    await expect(
      grep({ pattern: "needle", path: join(testDir, "src/a.ts") }, testDir),
    ).resolves.toBe("src/a.ts:1:needle");
  });

  it("limit 是所有文件合计的上限，达到上限就停止并提示", async () => {
    await putFile("a.ts", "needle-a1\nneedle-a2\n");
    await putFile("b.ts", "needle-b1\nneedle-b2\n");

    await expect(
      grep({ pattern: "needle", limit: 3 }, testDir),
    ).resolves.toBe(
      "a.ts:1:needle-a1\na.ts:2:needle-a2\nb.ts:1:needle-b1\n" +
        "[... 已达到匹配上限 3 条，可增大 limit 或缩小搜索范围 ...]",
    );
    const all = await grep({ pattern: "needle", limit: 4 }, testDir);
    expect(all.split("\n")).toHaveLength(5);
    expect(all).toContain("已达到匹配上限 4 条");
  });

  it.each([undefined, null])("可选参数为 %s 时采用默认值，上限为 100", async (value) => {
    await putFile("a", Array.from({ length: 101 }, () => "x").join("\n"));

    const result = await grep(
      {
        pattern: "x",
        path: value,
        glob: value,
        literal: value,
        ignoreCase: value,
        limit: value,
      },
      testDir,
    );
    expect(result.split("\n")).toHaveLength(101);
    expect(result).toContain("a:100:x\n[... 已达到匹配上限 100 条");
    expect(result).not.toContain("a:101:x");
  });

  it.each([0, -1, 1.5, NaN, Infinity])("拒绝非法 limit：%s", async (limit) => {
    await expect(grep({ pattern: "x", limit }, testDir)).rejects.toThrow(
      "limit 必须是正整数",
    );
  });

  it("空目录和没有匹配的文件都返回 (无匹配)", async () => {
    await expect(grep({ pattern: "needle" }, testDir)).resolves.toBe("(无匹配)");
    await putFile("a.ts", "other\n");
    await expect(grep({ pattern: "needle" }, testDir)).resolves.toBe("(无匹配)");
  });

  it("遵循根目录及嵌套的 .gitignore，跳过隐藏文件和二进制文件", async () => {
    await putFile(".gitignore", "ignored/\n");
    await putFile("ignored/a.ts", "needle\n");
    await putFile(".hidden", "needle\n");
    await putFile("binary.bin", Buffer.from("\0needle\n"));
    await putFile("src/.gitignore", "skip.ts\n");
    await putFile("src/skip.ts", "needle\n");
    await putFile("src/keep.ts", "needle\n");

    await expect(grep({ pattern: "needle" }, testDir)).resolves.toBe(
      "src/keep.ts:1:needle",
    );
  });

  it("模式和文件名中的引号、空格、$() 与反引号按参数原样传入", async () => {
    const name = "a '$(touch EVON_GREP_SENTINEL)' `touch EVON_GREP_BACKTICK`.ts";
    const pattern = "' $(touch EVON_GREP_SENTINEL) `touch EVON_GREP_BACKTICK`";
    await putFile(name, `${pattern}\n`);

    await expect(
      grep({ pattern, path: name, literal: true, glob: "*.ts" }, testDir),
    ).resolves.toBe(`${name}:1:${pattern}`);
    for (const marker of ["EVON_GREP_SENTINEL", "EVON_GREP_BACKTICK"]) {
      await expect(access(join(testDir, marker))).rejects.toMatchObject({ code: "ENOENT" });
    }
  });

  it("glob 中的 shell 表达式也按原样传递", async () => {
    const name = "$(touch EVON_GREP_GLOB).ts";
    await putFile(name, "needle\n");

    await expect(
      grep({ pattern: "needle", glob: "*$(touch EVON_GREP_GLOB)*.ts" }, testDir),
    ).resolves.toBe(`${name}:1:needle`);
    await expect(access(join(testDir, "EVON_GREP_GLOB"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("以 - 开头的模式和文件名不会被识别为 rg 选项", async () => {
    await putFile("-file.ts", "--flag\n");

    await expect(
      grep({ pattern: "--flag", path: "-file.ts", literal: true }, testDir),
    ).resolves.toBe("-file.ts:1:--flag");
  });

  it("拒绝越界路径和不存在的路径", async () => {
    await expect(grep({ pattern: "x", path: ".." }, testDir)).rejects.toThrow("禁止越界访问");
    await expect(grep({ pattern: "x", path: "missing" }, testDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("拒绝指向工作区外的符号链接，目录搜索也不跟随链接", async () => {
    const outside = await mkdtemp(join(tmpdir(), "evon-test-grep-outside-"));
    try {
      await writeFile(join(outside, "outside.ts"), "needle\n");
      await symlink(outside, join(testDir, "link"));
      await expect(grep({ pattern: "needle", path: "link" }, testDir)).rejects.toThrow("禁止越界访问");
      await expect(grep({ pattern: "needle" }, testDir)).resolves.toBe("(无匹配)");
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("大输出始终返回最前面的匹配，不经过尾部截断", async () => {
    await putFile("a", "x\n".repeat(2005));

    await expect(grep({ pattern: "x", limit: 2 }, testDir)).resolves.toBe(
      "a:1:x\na:2:x\n" +
        "[... 已达到匹配上限 2 条，可增大 limit 或缩小搜索范围 ...]",
    );
  });

  it("超长匹配行保留预览、文件名和行号", async () => {
    await putFile("a.ts", `needle${"a".repeat(100_000)}\n`);

    const result = await grep({ pattern: "needle" }, testDir);
    expect(result).toMatch(/^a\.ts:1:needle/);
    expect(result.split("\n")[0]).toBe(`a.ts:1:needle${"a".repeat(494)}... [已截断]`);
    expect(result).toContain("部分匹配行已截断至 500 字符");
    expect(result).toContain("read_file");
  });

  it("整体输出超过 50KiB 时保留头部，并与匹配数量限制区分", async () => {
    await putFile("a", `${"x".repeat(500)}\n`.repeat(150));

    const result = await grep({ pattern: "x", limit: 200 }, testDir);
    expect(result).toMatch(/^a:1:x/);
    expect(result).toContain("已截断余下");
    expect(result).not.toContain("匹配上限");
    expect(result).not.toContain("a:150:");
    expect(Buffer.byteLength(result, "utf8")).toBeLessThan(50 * 1024 + 200);
  });

  it("提高 limit 后不会被额外的 2000 行上限截断", async () => {
    await putFile("a", "x\n".repeat(2105));

    const result = await grep({ pattern: "x", limit: 3000 }, testDir);
    expect(result.split("\n")).toHaveLength(2105);
    expect(result).toMatch(/a:2105:x$/);
    expect(result).not.toContain("已截断");
  });

  it("正确处理中文、Emoji 和 CRLF 换行", async () => {
    await putFile("中文.ts", "skip\r\n中文 needle😀\r\n");
    await expect(grep({ pattern: "needle" }, testDir)).resolves.toBe("中文.ts:2:中文 needle😀");
  });

  it("解码 rg JSON 中非 UTF-8 内容的 base64 bytes 字段", async () => {
    await putFile("a", Buffer.concat([Buffer.from([0xff]), Buffer.from("needle\n")]));
    await expect(grep({ pattern: "needle" }, testDir)).resolves.toBe("a:1:�needle");
  });

  it("未安装 rg 时给出明确提示", async () => {
    vi.stubEnv("PATH", testDir);
    await expect(grep({ pattern: "needle" }, testDir)).rejects.toThrow("未找到 rg（ripgrep）");
  });

  it("工具分发返回搜索结果，并把非法正则转换成工具错误", async () => {
    await putFile("a.ts", "needle\n");
    await expect(
      executeTool({ id: "grep-ok", name: "grep", arguments: { pattern: "needle" } }, testDir),
    ).resolves.toBe("a.ts:1:needle");
    await expect(
      executeTool({ id: "grep-error", name: "grep", arguments: { pattern: "[" } }, testDir),
    ).resolves.toMatch(/^工具执行失败：rg 搜索失败（退出码 2）：/);
  });

  it("提前取消时不执行命令", async () => {
    const run = vi.mocked(childProcess.spawn);
    const controller = new AbortController();
    controller.abort();

    await expect(grep({ pattern: "x" }, testDir, controller.signal)).rejects.toThrow("搜索已被用户取消");
    expect(run).not.toHaveBeenCalled();
  });

  it("执行期间取消会终止子进程，并与无匹配区分", async () => {
    const controller = new AbortController();
    const run = vi.mocked(childProcess.spawn).mockImplementationOnce((_command, _args, options) => {
      const child = nativeSpawn(process.execPath, ["-e", "setTimeout(() => {}, 10_000)"], {
        ...options,
        cwd: testDir,
        stdio: ["ignore", "pipe", "pipe"],
      });
      child.once("spawn", () => controller.abort());
      return child;
    });

    await expect(grep({ pattern: "x" }, testDir, controller.signal)).rejects.toThrow("搜索已被用户取消");
    expect(run.mock.results[0].value.signalCode).toBe("SIGTERM");
  });

  it("达到匹配上限会终止仍在运行的子进程，终止不视为失败", async () => {
    const events = [
      { type: "begin", data: { path: { text: join(testDir, "a") } } },
      ...[1, 2, 3].map((line) => ({
        type: "match",
        data: { path: { text: join(testDir, "a") }, line_number: line, lines: { text: `x${line}\n` } },
      })),
    ];
    const output = events.map((event) => JSON.stringify(event)).join("\n") + "\n";
    const run = mockRipgrep(`process.stdout.write(${JSON.stringify(output)}); setTimeout(() => {}, 10_000);`);

    const result = await grep({ pattern: "x", limit: 2 }, testDir);
    expect(result).toMatch(/^a:1:x1\na:2:x2\n/);
    expect(result).not.toContain("x3");
    expect(run.mock.results[0].value.signalCode).toBe("SIGTERM");
  });

  it("无效 JSON 会返回错误并终止子进程", async () => {
    const run = mockRipgrep('process.stdout.write("not-json\\n"); setTimeout(() => {}, 10_000);');
    await expect(grep({ pattern: "x" }, testDir)).rejects.toThrow("无法解析 rg 的 JSON 输出");
    expect(run.mock.results[0].value.signalCode).toBe("SIGTERM");
  });

  it("30 秒超时会终止子进程，并与无匹配区分", async () => {
    const controller = new AbortController();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValueOnce(controller.signal);
    const run = vi.mocked(childProcess.spawn).mockImplementationOnce((_command, _args, options) => {
      const child = nativeSpawn(process.execPath, ["-e", "setTimeout(() => {}, 10_000)"], {
        ...options,
        cwd: testDir,
        stdio: ["ignore", "pipe", "pipe"],
      });
      child.once("spawn", () => controller.abort());
      return child;
    });
    await expect(grep({ pattern: "x" }, testDir)).rejects.toThrow("rg 搜索超时");
    expect(timeout).toHaveBeenCalledWith(30_000);
    expect(run.mock.results[0].value.signalCode).toBe("SIGTERM");
  });
});
