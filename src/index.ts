import { runAgent } from "./agent.ts";

const task = process.argv.slice(2).join(" ").trim();

if (!task) {
  console.log('用法：npm start -- "你的任务"');
} else {
  try {
    await runAgent(task);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
