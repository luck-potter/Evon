import type { Message } from "./types.ts";

export interface CompactionSettings {
  enabled: boolean;
  reserveTokens: number;
  keepRecentTokens: number;
}

export const defaultCompactionSettings: CompactionSettings = {
  enabled: true,
  reserveTokens: 16384,
  keepRecentTokens: 20000,
};

export function shouldCompact(
  contextTokens: number,
  contextWindow: number,
  settings: CompactionSettings = defaultCompactionSettings,
): boolean {
  if (!settings.enabled) return false;

  return contextTokens > contextWindow - settings.reserveTokens;
}

export function estimateMessageTokens(message: Message): number {
  let chars = message.content.length;

  if (message.role === "assistant") {
    for (const call of message.toolCalls ?? []) {
      chars += call.name.length;
      chars += JSON.stringify(call.arguments).length;
    }
  }

  // shortcut: 按字符数 / 4 粗估，需要精确预算时换用对应模型的分词器。
  return Math.ceil(chars / 4);
}

// 修改或压缩历史前缀后，须清除受影响消息的旧 usage。
export function estimateContextTokens(messages: readonly Message[]): number {
  let trailingTokens = 0;

  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.role === "assistant" && message.usage) {
      const { totalTokens, inputTokens, outputTokens } = message.usage;
      const usageTokens = totalTokens || inputTokens + outputTokens;
      if (usageTokens > 0) return usageTokens + trailingTokens;
    }
    trailingTokens += estimateMessageTokens(message);
  }

  return trailingTokens;
}
