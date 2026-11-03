import readline from "node:readline/promises";
import { runAgent } from "./agent.ts";
import { compactContext } from "./compaction.ts";
import type { Message, TokenUsage } from "./types.ts";
import { createSessionUsage, recordUsage, formatUsage } from "./usage.ts";
import { appendMessage, createSession } from "./session.ts";

let currentAbortController: AbortController | null = null;
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});
rl.on("close", () => process.exit(0));
rl.on("SIGINT", () => {
  if (currentAbortController) {
    // 关键这一句：按一下遥控器的取消按钮

    currentAbortController.abort();

    currentAbortController = null;
    console.log("\n[已打断]");
  } else {
    process.exit(0);
  }
});

const messages: Message[] = [];
let sessionUsage = createSessionUsage();

function onUsage(usage: TokenUsage | null): void {
  recordUsage(sessionUsage, usage);
  console.log(formatUsage(usage, sessionUsage));
}

let session = await createSession(process.cwd());

async function onMessage(message: Message): Promise<void> {
  await appendMessage(session.filePath, message);
}

const initialTask = process.argv.slice(2).join(" ").trim();
if (initialTask) {
  currentAbortController = new AbortController();
  try {
    await runAgent(initialTask, messages, {
      signal: currentAbortController.signal,
      onUsage,
      onMessage,
    });
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
  } finally {
    // 任务正常结束或出错，清空引用
    currentAbortController = null;
  }
}

repl: while (true) {
  const input = (await rl.question("\nevon > ")).trim();
  if (!input) continue;

  currentAbortController = new AbortController();
  try {
    const options = {
      signal: currentAbortController.signal,
      onUsage,
      onMessage,
    };
    switch (input) {
      case "/exit":
      case "/quit":
        rl.close();
        break repl;
      case "/clear":
        session = await createSession(process.cwd());

        messages.length = 0;
        sessionUsage = createSessionUsage();
        console.log("会话已清空");
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
    // 任务正常结束或出错，清空引用
    currentAbortController = null;
  }
}
