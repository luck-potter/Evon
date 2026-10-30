import { performance } from "node:perf_hooks";
import { describe, expect, it } from "vitest";
import { runBash } from "../src/tools.ts";

// 测试约定：runBash 返回 JSON 字符串。命令失败和超时也返回执行结果，
// 这样 executeTool 可以把完整信息交给模型。超时的 exitCode 为 null。
type BashResult = {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
};

function parseResult(output: string): BashResult {
  let result: unknown;
  try {
    result = JSON.parse(output);
  } catch (cause) {
    throw new Error(
      "runBash 应返回包含 stdout、stderr、exitCode、timedOut 的 JSON 字符串",
      { cause },
    );
  }

  expect(result).toMatchObject({
    stdout: expect.any(String),
    stderr: expect.any(String),
    timedOut: expect.any(Boolean),
  });
  const parsed = result as BashResult;
  expect(parsed.exitCode === null || Number.isInteger(parsed.exitCode)).toBe(true);
  return parsed;
}

// 对当前 macOS/Linux shell 做单引号转义；Node 路径含空格也能执行。
function shellQuote(value: string): string {
  return "'" + value.replaceAll("'", "'\\''") + "'";
}

function nodeCommand(script: string): string {
  return `${shellQuote(process.execPath)} -e ${shellQuote(script)}`;
}

describe("runBash", () => {
  it("成功时保留 stdout", async () => {
    const output = await runBash(nodeCommand('process.stdout.write("normal-stdout")'));

    expect(output).toContain("normal-stdout");
  });

  it("退出码为 0 时，stderr 警告不能被当作失败，且两种输出都应保留", async () => {
    const output = await runBash(nodeCommand(`
      process.stdout.write("successful-output");
      process.stderr.write("warning-only");
    `));

    const result = parseResult(output);
    expect(result.stdout).toBe("successful-output");
    expect(result.stderr).toBe("warning-only");
    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
  });

  it("只写 stderr、退出码为 0 的命令也能成功", async () => {
    const output = await runBash(nodeCommand('process.stderr.write("progress-only")'));

    const result = parseResult(output);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("progress-only");
    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
  });

  it("没有输出时也返回明确的成功退出码", async () => {
    const output = await runBash(nodeCommand("process.exitCode = 0"));

    expect(parseResult(output)).toEqual({
      stdout: "",
      stderr: "",
      exitCode: 0,
      timedOut: false,
    });
  });

  it("完整保留多行输出、中文、引号和反斜杠", async () => {
    const expected = '第一行\n第二行："引号"与\\反斜杠\n';
    const output = await runBash(
      nodeCommand(`process.stdout.write(${JSON.stringify(expected)})`),
    );

    const result = parseResult(output);
    expect(result.stdout).toBe(expected);
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
  });

  it("非零退出时返回 stdout、stderr 和真实退出码", async () => {
    const output = await runBash(nodeCommand(`
      process.stdout.write("failed-test-details");
      process.stderr.write("failure-reason");
      process.exitCode = 7;
    `));

    const result = parseResult(output);
    expect(result.stdout).toBe("failed-test-details");
    expect(result.stderr).toBe("failure-reason");
    expect(result.exitCode).toBe(7);
    expect(result.timedOut).toBe(false);
  });

  it("非零退出但 stderr 为空时，仍保留 stdout 中的诊断信息和退出码", async () => {
    const output = await runBash(nodeCommand(`
      process.stdout.write("diagnostics-on-stdout");
      process.exitCode = 2;
    `));

    const result = parseResult(output);
    expect(result.stdout).toBe("diagnostics-on-stdout");
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(2);
    expect(result.timedOut).toBe(false);
  });

  it("约 5 秒后超时返回，明确标记超时并保留此前的输出", async () => {
    // 正常完成需要 15 秒，应被 runBash 的 5 秒限制提前终止。
    const started = performance.now();
    const output = await runBash(nodeCommand(`
      process.stdout.write("stdout-before-timeout");
      process.stderr.write("stderr-before-timeout");
      setTimeout(() => {}, 15_000);
    `));
    const elapsed = performance.now() - started;

    expect(elapsed, "不应过早结束").toBeGreaterThanOrEqual(4_500);
    expect(elapsed, "应在超时后及时返回").toBeLessThan(10_000);
    const result = parseResult(output);
    expect(result.stdout).toBe("stdout-before-timeout");
    expect(result.stderr).toBe("stderr-before-timeout");
    expect(result.exitCode).toBeNull();
    expect(result.timedOut).toBe(true);
  });
});
