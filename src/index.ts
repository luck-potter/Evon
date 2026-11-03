import readline from "node:readline/promises";
import { runAgent } from "./agent.ts";
import { parseCliArgs } from "./cli.ts";
import { compactContext } from "./compaction.ts";
import type { Message, TokenUsage } from "./types.ts";
import { createSessionUsage, recordUsage, formatUsage } from "./usage.ts";
import { appendSessionRecord, createSession, loadSession } from "./session.ts";

let messages: Message[] = [];
let sessionUsage = createSessionUsage();
let session: { id: string; filePath: string };
let initialTask = "";
let resumeId: string | undefined;

try {
  ({ resumeId, initialTask } = parseCliArgs(process.argv.slice(2)));
  if (resumeId !== undefined) {
    const restored = await loadSession(process.cwd(), resumeId);
    session = restored;
    messages = restored.messages;
    sessionUsage = restored.usage;
    console.log(`[已恢复会话] ${session.id}（${messages.length} 条消息）`);
  } else {
    session = await createSession(process.cwd());
    console.log(`[新会话] ${session.id}`);
  }
} catch (error) {
  if (resumeId && error instanceof Error && "code" in error && error.code === "ENOENT") {
    console.error(`找不到会话 ${resumeId}，请检查当前工作目录和会话 ID。`);
  } else {
    console.error(error instanceof Error ? error.message : String(error));
  }
  process.exit(1);
}

let currentAbortController: AbortController | null = null;
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});
rl.on("close", () => process.exit(0));
rl.on("SIGINT", () => {
  if (currentAbortController) {
    currentAbortController.abort();
    currentAbortController = null;
    console.log("\n[已打断]");
  } else {
    process.exit(0);
  }
});

async function onUsage(usage: TokenUsage | null): Promise<void> {
  await appendSessionRecord(session.filePath, { type: "usage", usage });
  recordUsage(sessionUsage, usage);
  console.log(formatUsage(usage, sessionUsage));
}

repl: while (true) {
  const input = initialTask || (await rl.question("\nevon > ")).trim();
  // 启动任务始终作为文本，斜杠命令只在交互输入中生效。
  const command = initialTask ? null : input;
  initialTask = "";
  if (!input) continue;

  currentAbortController = new AbortController();
  try {
    const options = {
      signal: currentAbortController.signal,
      onUsage,
      onMessage: (message: Message) =>
        appendSessionRecord(session.filePath, { type: "message", message }),
      onCompaction: (messages: Message[]) =>
        appendSessionRecord(session.filePath, { type: "compaction", messages }),
    };
    switch (command) {
      case "/exit":
      case "/quit":
        rl.close();
        break repl;
      case "/clear":
        session = await createSession(process.cwd());
        messages.length = 0;
        sessionUsage = createSessionUsage();
        console.log(`会话已清空，新会话：${session.id}`);
        break;
      case "/compact": {
        console.log("[正在压缩上下文]");
        const changed = await compactContext(messages, options);
        console.log(
          changed ? "上下文已压缩" : "上下文未修改：历史不足或摘要未缩短历史。",
        );
        break;
      }
      default:
        await runAgent(input, messages, options);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
  } finally {
    currentAbortController = null;
  }
}
