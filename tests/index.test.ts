import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appendMessage, createSession, readSessionRecords } from "../src/session.ts";
import type { Message } from "../src/types.ts";

const entryPoint = fileURLToPath(new URL("../src/index.ts", import.meta.url));

describe("CLI 会话恢复", () => {
  let testDir: string;
  let sessionsDir: string;
  let server: Server;
  let baseURL: string;
  let requests: { input: { role: string; content: string }[] }[];
  let children: ChildProcessWithoutNullStreams[];

  beforeEach(async () => {
    testDir = await mkdtemp(join(process.cwd(), ".tmp-test-cli-"));
    sessionsDir = join(testDir, ".evon", "sessions");
    requests = [];
    children = [];
    server = createServer(async (req, res) => {
      let body = "";
      for await (const chunk of req) body += chunk;
      requests.push(JSON.parse(body));
      const text = `模拟回复 ${requests.length}`;
      const events = [
        { type: "response.output_text.delta", delta: text },
        {
          type: "response.completed",
          response: {
            status: "completed", error: null, output: [], output_text: text,
            usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
          },
        },
      ];
      res.writeHead(200, { "content-type": "text/event-stream" });
      for (const event of events) res.write(`data: ${JSON.stringify(event)}\n\n`);
      res.end("data: [DONE]\n\n");
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("模拟模型启动失败");
    baseURL = `http://127.0.0.1:${address.port}/v1`;
  });

  afterEach(async () => {
    await Promise.all(children.map(child => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      return new Promise<void>(resolve => {
        child.once("close", () => resolve());
        child.kill("SIGKILL");
      });
    }));
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(testDir, { recursive: true, force: true });
  });

  function startCli(args: string[]) {
    const child = spawn(process.execPath, [entryPoint, ...args], {
      cwd: testDir,
      env: {
        ...process.env,
        BASE_URL: baseURL,
        API_KEY: "local-test-only",
        MODEL: "mock-model",
        CONTEXT_WINDOW: "0",
      },
      stdio: "pipe",
    });
    children.push(child);
    let output = "";
    let errors = "";
    child.stdout.on("data", chunk => { output += chunk.toString(); });
    child.stderr.on("data", chunk => { errors += chunk.toString(); });
    const closed = new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", code => resolve(code));
    });
    return {
      child,
      closed,
      get output() { return output; },
      get errors() { return errors; },
      async waitForPrompt(count = 1) {
        await vi.waitFor(() => {
          expect(output.split("evon > ").length - 1, errors || output).toBeGreaterThanOrEqual(count);
        }, { timeout: 5000, interval: 10 });
      },
      async stop() {
        child.stdin.write("/exit\n");
        expect(await closed).toBe(0);
      },
    };
  }

  it("新建对话退出后恢复，继续写原文件；清空后转入新会话", async () => {
    const first = startCli(["首轮任务"]);
    await first.waitForPrompt();
    const [fileName] = await readdir(sessionsDir);
    const id = fileName.slice(0, -".jsonl".length);
    const filePath = join(sessionsDir, fileName);
    const original = await readFile(filePath, "utf8");
    expect(await readSessionRecords(filePath)).toHaveLength(4);
    expect(first.output).toContain(`[新会话] ${id}`);
    expect(requests).toHaveLength(1);
    await first.stop();

    const resumed = startCli(["--resume", id]);
    await resumed.waitForPrompt();
    expect(resumed.output).toContain(`[已恢复会话] ${id}`);
    expect(requests).toHaveLength(1);
    expect(await readFile(filePath, "utf8")).toBe(original);
    expect(await readdir(sessionsDir)).toEqual([fileName]);

    resumed.child.stdin.write("继续追问\n");
    await resumed.waitForPrompt(2);
    expect(requests[1].input.map(message => message.role)).toEqual(["system", "user", "assistant", "user"]);
    expect(requests[1].input.slice(1)).toEqual([
      { role: "user", content: "首轮任务" },
      { role: "assistant", content: "模拟回复 1" },
      { role: "user", content: "继续追问" },
    ]);
    expect(await readSessionRecords(filePath)).toHaveLength(6);
    const continued = await readFile(filePath, "utf8");
    expect(continued.startsWith(original)).toBe(true);
    expect(await readdir(sessionsDir)).toEqual([fileName]);

    resumed.child.stdin.write("/clear\n");
    await resumed.waitForPrompt(3);
    const files = await readdir(sessionsDir);
    expect(files).toHaveLength(2);
    const newFile = files.find(file => file !== fileName)!;
    resumed.child.stdin.write("新会话的问题\n");
    await resumed.waitForPrompt(4);
    expect(requests[2].input).toHaveLength(2);
    expect(requests[2].input[1]).toEqual({ role: "user", content: "新会话的问题" });
    expect(await readSessionRecords(join(sessionsDir, newFile))).toHaveLength(4);
    expect(await readFile(filePath, "utf8")).toBe(continued);
    await resumed.stop();
  });

  it("恢复时携带初始任务，模型收到历史和任务而不会收到 CLI 参数", async () => {
    const session = await createSession(testDir);
    const history: Message[] = [
      { role: "system", content: "已有的系统提示" },
      { role: "user", content: "之前的任务" },
      { role: "assistant", content: "之前的回复" },
    ];
    for (const message of history) await appendMessage(session.filePath, message);

    const cli = startCli([`--resume=${session.id}`, "继续", "修复"]);
    await cli.waitForPrompt();
    expect(requests).toHaveLength(1);
    expect(requests[0].input).toEqual([...history, { role: "user", content: "继续 修复" }]);
    expect(await readSessionRecords(session.filePath)).toHaveLength(6);
    expect(await readdir(sessionsDir)).toEqual([`${session.id}.jsonl`]);
    await cli.stop();
  });

  it("没有启动参数时新建会话并等待输入", async () => {
    const cli = startCli([]);
    await cli.waitForPrompt();
    const files = await readdir(sessionsDir);
    expect(files).toHaveLength(1);
    expect(await readSessionRecords(join(sessionsDir, files[0]))).toHaveLength(1);
    expect(requests).toHaveLength(0);
    await cli.stop();
  });

  it.each(["/clear", "/compact", "/exit", "/quit"])("启动任务 %s 作为文本发送，不执行交互命令", async task => {
    const cli = startCli([task]);
    await cli.waitForPrompt();
    expect(requests).toHaveLength(1);
    expect(requests[0].input[1]).toEqual({ role: "user", content: task });
    expect(await readdir(sessionsDir)).toHaveLength(1);
    await cli.stop();
  });

  it.each([
    { args: ["--resume"], error: "--resume 需要会话 ID" },
    { args: ["--resume", "../outside"], error: "无效的会话 ID" },
    { args: ["--resume", "missing-session"], error: "找不到会话 missing-session" },
  ])("启动失败时报告 $error，不创建新会话", async ({ args, error }) => {
    const cli = startCli(args);
    expect(await cli.closed).toBe(1);
    expect(cli.errors).toContain(error);
    expect(cli.output).not.toContain("evon > ");
    expect(requests).toHaveLength(0);
    await expect(readdir(sessionsDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("无效会话报错退出，原文件保持不变", async () => {
    const session = await createSession(testDir);
    await writeFile(session.filePath, "not json", "utf8");
    const cli = startCli(["--resume", session.id]);
    expect(await cli.closed).toBe(1);
    expect(cli.errors).toContain("已损坏");
    expect(requests).toHaveLength(0);
    expect(await readFile(session.filePath, "utf8")).toBe("not json");
    expect(await readdir(sessionsDir)).toEqual([`${session.id}.jsonl`]);
  });
});
