import { randomUUID } from "node:crypto";
import path from "node:path";
import { mkdir, writeFile, readFile, appendFile } from "node:fs/promises";
import type { Message, TokenUsage } from "./types.ts";
import { createSessionUsage, recordUsage, type SessionUsage } from "./usage.ts";

export type SessionRecord =
  | {
      type: "session";
      version: 1;
      id: string;
      cwd: string;
      createdAt: string;
    }
  | {
      type: "message";
      message: Message;
    }
  | {
      type: "compaction";
      messages: Message[];
    }
  | {
      type: "usage";
      usage: TokenUsage | null;
    };

export async function createSession(
  cwd: string,
): Promise<{ id: string; filePath: string }> {
  const id = randomUUID();
  const sessionsDir = path.join(cwd, ".evon", "sessions");

  await mkdir(sessionsDir, { recursive: true });
  const filePath = path.join(sessionsDir, `${id}.jsonl`);
  const record: SessionRecord = {
    type: "session",
    version: 1,
    id,
    cwd,
    createdAt: new Date().toISOString(),
  };
  await writeFile(filePath, JSON.stringify(record) + "\n", {
    encoding: "utf8",
    flag: "wx",
  });

  return { id, filePath };
}

export async function appendSessionRecord(
  filePath: string,
  record: SessionRecord,
): Promise<void> {
  await appendFile(filePath, JSON.stringify(record) + "\n", {
    encoding: "utf8",
  });
}

/** 像 pi 一样宽松读取历史：跳过损坏行，只检查会话头，不递归校验消息。 */
export async function readSessionRecords(
  filePath: string,
): Promise<SessionRecord[]> {
  const content = await readFile(filePath, { encoding: "utf8" });
  const records: SessionRecord[] = [];

  for (const line of content.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const record = JSON.parse(line) as SessionRecord;
      if (record) records.push(record);
    } catch {
      // 保留仍能解析的历史，包括最后一行写到一半时的完整记录。
    }
  }

  const header = records[0];
  if (header?.type !== "session" || typeof header.id !== "string") return [];

  if (!content.endsWith("\n")) {
    await appendFile(filePath, "\n", "utf8");
  }

  return records;
}

export async function loadSession(
  cwd: string,
  sessionId: string,
): Promise<{
  id: string;
  filePath: string;
  messages: Message[];
  usage: SessionUsage;
}> {
  const filePath = path.join(cwd, ".evon", "sessions", `${sessionId}.jsonl`);
  const records = await readSessionRecords(filePath);
  if (records.length === 0) {
    throw new Error(`会话 ${sessionId} 不存在或已损坏。`);
  }
  let messages: Message[] = [];
  const usage = createSessionUsage();
  let hasUsageRecords = false;
  for (const record of records) {
    if (record.type === "message") {
      messages.push(record.message);
      // 旧会话从回复累计；新 usage 记录先于回复写入，避免重复计数。
      if (!hasUsageRecords && record.message.role === "assistant" && record.message.usage) {
        recordUsage(usage, record.message.usage);
      }
    } else if (record.type === "compaction") {
      messages = record.messages;
    } else if (record.type === "usage") {
      hasUsageRecords = true;
      recordUsage(usage, record.usage);
    }
  }
  return { id: sessionId, filePath, messages, usage };
}
