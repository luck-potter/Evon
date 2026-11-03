import { platform } from "node:os";
import { compactContext } from "./compaction.ts";
import { defaultCompactionSettings, estimateContextTokens, shouldCompact } from "./context.ts";
import { callModel } from "./llm.ts";
import { executeTool } from "./tools/index.ts";
import type { Message, ModelReply, TokenUsage } from "./types.ts";
import { formatDiff } from "./utils/format-diff.ts";

export interface RunAgentOptions {
  maxSteps?: number;
  signal?: AbortSignal;
  onUsage?: (usage: TokenUsage | null) => void;
}

export async function runAgent(
  task: string,
  messages: Message[] = [],
  options: RunAgentOptions = {},
): Promise<string> {
  const { maxSteps = 30, signal, onUsage } = options;
  const contextWindow = Number(process.env.CONTEXT_WINDOW ?? 0);
  const minimumWindow = defaultCompactionSettings.reserveTokens + defaultCompactionSettings.keepRecentTokens;
  if (contextWindow !== 0 && (!Number.isSafeInteger(contextWindow) || contextWindow <= minimumWindow)) {
    throw new Error(`CONTEXT_WINDOW 必须为 0 或大于 ${minimumWindow} 的安全整数（0 关闭自动压缩）。`);
  }
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
    // 1. 每轮 step 开始前检查是否已打断
    if (signal?.aborted) {
      return "操作已被用户打断。";
    }

    // 2. 调用模型：加 try-catch 捕获模型生成阶段的中断（比如 fetch 被 abort）
    let reply: ModelReply;
    let streamed = false;
    let hasStreamedText = false;
    try {
      if (contextWindow > 0 && shouldCompact(estimateContextTokens(messages), contextWindow)) {
        console.log("[正在自动压缩上下文]");
        await compactContext(messages, { signal, onUsage });
        if (shouldCompact(estimateContextTokens(messages), contextWindow)) {
          throw new Error("自动压缩未能将上下文降至预算内，请使用 /clear 清理会话或减少输入。");
        }
        console.log("上下文已自动压缩");
      }
      console.log(`\n[步骤 ${step + 1}/${maxSteps}]`);
      reply = await callModel(messages, {
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
        onUsage: (usage) => {
          if (streamed) {
            process.stdout.write("\n");
            streamed = false; // 消费掉换行，避免 callModel 结束后多出一个空行
          }
          onUsage?.(usage);
        },
        signal,
      });
    } catch (error) {
      // 如果是在模型思考/流式输出时按下了 Ctrl+C
      if (signal?.aborted) {
        if (streamed) process.stdout.write("\n");
        messages.push({ role: "assistant", content: "操作已被用户取消。" });
        return "操作已被用户打断。";
      }
      throw error;
    }

    if (streamed) process.stdout.write("\n");
    messages.push(reply);

    if (!reply.toolCalls?.length) return reply.content;
    // 只有未流式输出过且存在文本时才兜底打印
    if (!hasStreamedText && reply.content) console.log(reply.content);

    // 3. 执行工具：改用普通 for 循环，方便在被打断时拿到剩余工具的索引
    for (const call of reply.toolCalls) {
      // 只要被打断了，后续所有工具不再执行，直接填 Cancelled by user
      if (signal?.aborted) {
        messages.push({
          role: "tool",
          toolCallId: call.id,
          content: "Cancelled by user",
        });
        continue;
      }

      console.log(`[工具] ${call.name} : ${JSON.stringify(call.arguments)}`);
      const result = await executeTool(call, process.cwd(), signal);
      // 终端展示时着色，回填给模型的 result 保留纯文本。
      if (call.name === "edit_file") {
        console.log(formatDiff(result));
      }

      messages.push({ role: "tool", toolCallId: call.id, content: result });
    }

    // 本轮工具处理完毕（或被中断跳过），若是打断状态则直接退出
    if (signal?.aborted) {
      return "操作已被用户打断。";
    }
  }

  throw new Error(`已达到最大步数 ${maxSteps}，任务尚未完成。`);
}
