import readline from "node:readline/promises";
import { runAgent } from "./agent.ts";
import type { Message } from "./types.ts";

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});
rl.on("close", () => process.exit(0));

const messages: Message[] = [];

const initialTask = process.argv.slice(2).join(" ").trim();
if (initialTask) {
  try {
    await runAgent(initialTask, messages);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
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

  try {
    await runAgent(input, messages);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
  }
}
