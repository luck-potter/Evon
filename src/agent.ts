import { platform } from "node:os";
import { callModel } from "./llm.ts";
import { executeTool } from "./tools.ts";
import type { Message } from "./types.ts";

export async function runAgent(
  task: string,
  messages: Message[] = [],
  maxSteps = 30,
): Promise<string> {
  if (messages.length === 0) {
    messages.push({
      role: "system",
      content: [
        "你是一个编程助手。先阅读代码，再修改，最后运行测试验证。",
        `操作系统：${platform()}；工作目录：${process.cwd()}`,
        "使用工具完成任务，遇到报错应分析原因并尝试修复。",
        "只在实际验证后宣称成功；无法完成时说明原因。",
      ].join("\n"),
    });
  }
  messages.push({ role: "user", content: task });

  for (let step = 0; step < maxSteps; step++) {
    console.log(`\n[步骤 ${step + 1}/${maxSteps}]`);
    let streamed = false;
    let hasStreamedText = false;
    const reply = await callModel(messages, {
      onTextDelta: (delta) => {
        streamed = true;
        hasStreamedText = true;
        process.stdout.write(delta);
      },
      onToolCall: (call) => {
        if (streamed) {
          process.stdout.write("\n");
          streamed = false;
        }
        console.log(`[准备调用工具] ${call.name}...`);
      },
    });

    if (streamed) process.stdout.write("\n");
    messages.push(reply);

    if (!reply.toolCalls?.length) return reply.content;
    // 只有未流式输出过且存在文本时才兜底打印
    if (!hasStreamedText && reply.content) console.log(reply.content);

    for (const call of reply.toolCalls) {
      console.log(`[工具] ${call.name} : ${JSON.stringify(call.arguments)}`);
      const result = await executeTool(call);
      messages.push({ role: "tool", toolCallId: call.id, content: result });
    }
  }

  throw new Error(`已达到最大步数 ${maxSteps}，任务尚未完成。`);
}
