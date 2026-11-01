import readline from "node:readline/promises";
import { runAgent } from "./agent.ts";
import type { Message } from "./types.ts";

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

const initialTask = process.argv.slice(2).join(" ").trim();
if (initialTask) {
  currentAbortController = new AbortController();
  try {
    await runAgent(initialTask, messages, {
      signal: currentAbortController.signal,
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

  switch (input) {
    case "/exit":
    case "/quit":
      rl.close();
      break repl;
    case "/clear":
      messages.length = 0;
      console.log("会话已清空");
      continue;
  }

  currentAbortController = new AbortController();
  try {
    await runAgent(input, messages, {
      signal: currentAbortController.signal,
    });
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
  } finally {
    // 任务正常结束或出错，清空引用
    currentAbortController = null;
  }
}
