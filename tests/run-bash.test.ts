import { performance } from "node:perf_hooks";
import { describe, expect, it } from "vitest";
import { runBash } from "../src/tools.ts";

// 对当前 macOS/Linux shell 做单引号转义；Node 路径含空格也能执行。
function shellQuote(value: string): string {
  return "'" + value.replaceAll("'", "'\\''") + "'";
}

function nodeCommand(script: string): string {
  return `${shellQuote(process.execPath)} -e ${shellQuote(script)}`;
}

describe("runBash", () => {
  const multilineOutput = '第一行\n第二行："引号"与\\反斜杠\n';

  it.each([
    {
      name: "成功时保留 stdout",
      script: 'process.stdout.write("normal-stdout")',
      stdout: "normal-stdout",
      stderr: "",
      exitCode: 0,
    },
    {
      name: "退出码为 0 时保留 stdout 和 stderr 警告",
      script: `
        process.stdout.write("successful-output");
        process.stderr.write("warning-only");
      `,
      stdout: "successful-output",
      stderr: "warning-only",
      exitCode: 0,
    },
    {
      name: "只写 stderr、退出码为 0 的命令也能成功",
      script: 'process.stderr.write("progress-only")',
      stdout: "",
      stderr: "progress-only",
      exitCode: 0,
    },
    {
      name: "没有输出时也返回明确的成功退出码",
      script: "process.exitCode = 0",
      stdout: "",
      stderr: "",
      exitCode: 0,
    },
    {
      name: "完整保留多行输出、中文、引号和反斜杠",
      script: `process.stdout.write(${JSON.stringify(multilineOutput)})`,
      stdout: multilineOutput,
      stderr: "",
      exitCode: 0,
    },
    {
      name: "非零退出时返回 stdout、stderr 和真实退出码",
      script: `
        process.stdout.write("failed-test-details");
        process.stderr.write("failure-reason");
        process.exitCode = 7;
      `,
      stdout: "failed-test-details",
      stderr: "failure-reason",
      exitCode: 7,
    },
    {
      name: "非零退出但 stderr 为空时保留 stdout 和退出码",
      script: `
        process.stdout.write("diagnostics-on-stdout");
        process.exitCode = 2;
      `,
      stdout: "diagnostics-on-stdout",
      stderr: "",
      exitCode: 2,
    },
  ])("$name", async ({ script, stdout, stderr, exitCode }) => {
    const output = await runBash(nodeCommand(script));

    expect(JSON.parse(output)).toEqual({ stdout, stderr, exitCode, timedOut: false });
  });

  it("超时后返回，明确标记超时并保留此前的输出", async () => {
    // 正常完成需要 3 秒，应被 500 毫秒限制提前终止。
    const started = performance.now();
    const output = await runBash(
      nodeCommand(`
        process.stdout.write("stdout-before-timeout");
        process.stderr.write("stderr-before-timeout");
        setTimeout(() => {}, 3_000);
      `),
      500,
    );
    const elapsed = performance.now() - started;

    expect(elapsed, "不应过早结束").toBeGreaterThanOrEqual(400);
    expect(elapsed, "应在超时后及时返回").toBeLessThan(2_500);
    expect(JSON.parse(output)).toEqual({
      stdout: "stdout-before-timeout",
      stderr: "stderr-before-timeout",
      exitCode: null,
      timedOut: true,
    });
  });

  it("输出行数过多时，保留尾部输出并截断头部", async () => {
    const output = await runBash(
      nodeCommand(`
        for (let i = 1; i <= 2005; i++) {
          process.stdout.write("line-" + i + "\\n");
        }
      `),
    );

    const parsed = JSON.parse(output);
    expect(parsed.exitCode).toBe(0);
    expect(parsed.stdout).toContain("[... 前面 5 行已截断 ...]");
    expect(parsed.stdout).toContain("line-2005");
    expect(parsed.stdout).not.toContain("line-1\\n");
  });

  it("输出超过 1MB 时不会因 maxBuffer 崩溃，并正确截断", async () => {
    // 产生 2MB 输出，原 exec 会直接抛 ERR_CHILD_PROCESS_STDIO_MAXBUFFER 崩溃
    const output = await runBash(
      nodeCommand("process.stdout.write('a'.repeat(2 * 1024 * 1024))"),
    );

    const parsed = JSON.parse(output);
    expect(parsed.exitCode).toBe(0);
    expect(parsed.timedOut).toBe(false);
    expect(parsed.stdout).toContain("已截断");
  });
});
