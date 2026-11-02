import type { TokenUsage } from "./types.ts";

export interface SessionUsage extends TokenUsage {
  unknownCalls: number;
}

export function createSessionUsage(): SessionUsage {
  return { inputTokens: 0, outputTokens: 0, totalTokens: 0, unknownCalls: 0 };
}

export function recordUsage(session: SessionUsage, usage: TokenUsage | null): void {
  // TODO 2：累计本次用量；usage 为 null 时记录未知调用次数。
}

export function formatUsage(usage: TokenUsage | null, session: SessionUsage): string {
  // TODO 3：生成本次用量和会话累计的展示文本，区分未知用量。
  return "";
}
