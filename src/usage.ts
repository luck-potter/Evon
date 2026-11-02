import type { TokenUsage } from "./types.ts";

export interface SessionUsage extends TokenUsage {
  unknownCalls: number;
}

export function createSessionUsage(): SessionUsage {
  return { inputTokens: 0, outputTokens: 0, totalTokens: 0, unknownCalls: 0 };
}

export function recordUsage(
  session: SessionUsage,
  usage: TokenUsage | null,
): void {
  if (!usage) {
    session.unknownCalls++;
    return;
  }

  session.inputTokens += usage.inputTokens;
  session.outputTokens += usage.outputTokens;
  session.totalTokens += usage.totalTokens;
}

export function formatUsage(
  usage: TokenUsage | null,
  session: SessionUsage,
): string {
  const currentText = usage
    ? `本次: ${usage.inputTokens} in / ${usage.outputTokens} out (${usage.totalTokens} total)`
    : "本次: 未知";

  const unknownSuffix =
    session.unknownCalls > 0 ? ` (+${session.unknownCalls} 次未知调用)` : "";

  return `[Tokens] ${currentText} | 会话累计: ${session.totalTokens} total${unknownSuffix}`;
}
