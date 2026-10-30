import { platform } from "node:os";
import { callModel } from "./llm.ts";
import { executeTool } from "./tools.ts";
import type { Message } from "./types.ts";

export async function runAgent(task: string, maxSteps = 10): Promise<string> {
  const messages: Message[] = [
    {
      role: "system",
      content: [
        "你是一个编程助手。先阅读代码，再修改，最后运行测试验证。",
        `操作系统：${platform()}；工作目录：${process.cwd()}`,
        "使用工具完成任务，遇到报错应分析原因并尝试修复。",
        "只在实际验证后宣称成功；无法完成时说明原因。",
      ].join("\n"),
    },
    { role: "user", content: task },
  ];

  for (let step = 0; step < maxSteps; step++) {
    console.log(`\n[步骤 ${step + 1}/${maxSteps}]`);
    const reply = await callModel(messages);
    messages.push(reply);

    if (!reply.toolCalls?.length) return reply.content;
    if (reply.content) console.log(reply.content);

    for (const call of reply.toolCalls) {
      console.log(`[工具] ${call.name}`);
      const result = await executeTool(call);
      messages.push({ role: "tool", toolCallId: call.id, content: result });
    }
  }

  throw new Error(`已达到最大步数 ${maxSteps}，任务尚未完成。`);
}
