import { appendFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  appendSessionRecord,
  createSession,
  loadSession,
  readSessionRecords,
  type SessionRecord,
} from "../src/session.ts";
import type { Message, ToolCall } from "../src/types.ts";

const header: SessionRecord = {
  type: "session",
  version: 1,
  id: "session-test",
  cwd: "/example",
  createdAt: "2026-11-03T00:00:00.000Z",
};
const userRecord: SessionRecord = {
  type: "message",
  message: { role: "user", content: "你好" },
};

describe("readSessionRecords", () => {
  let testDir: string;
  let filePath: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(process.cwd(), ".tmp-test-session-"));
    filePath = join(testDir, "session.jsonl");
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  async function writeRecords(records: unknown[]): Promise<void> {
    await writeFile(filePath, records.map(record => JSON.stringify(record)).join("\n") + "\n", "utf8");
  }

  it("读回真实创建的会话，保留消息顺序、特殊字符、工具调用和用量", async () => {
    const session = await createSession(testDir);
    const toolCalls: ToolCall[] = [
      { id: "bash", name: "run_bash", arguments: { command: "echo hello" } },
      { id: "ls", name: "ls", arguments: { path: ".", limit: null } },
      { id: "grep", name: "grep", arguments: { pattern: "hello", path: "src", glob: "*.ts", literal: true, ignoreCase: false, limit: 10 } },
      { id: "find", name: "find_files", arguments: { pattern: "*.ts", path: null, limit: null } },
      { id: "read", name: "read_file", arguments: { path: "a.ts", offset: null, limit: 0 } },
      { id: "write", name: "write_file", arguments: { path: "a.ts", content: "" } },
      { id: "edit", name: "edit_file", arguments: { path: "a.ts", old_str: "旧", new_str: "新" } },
    ];
    const messages: Message[] = [
      { role: "system", content: "编程助手" },
      { role: "user", content: '第一行\n第二行\t"引号"和\\路径' },
      { role: "assistant", content: "", toolCalls },
      ...toolCalls.map(call => ({ role: "tool" as const, toolCallId: call.id, content: "工具结果或执行失败提示" })),
      { role: "assistant", content: "完成", usage: { inputTokens: 20, outputTokens: 5, totalTokens: 25 } },
    ];
    for (const message of messages) await appendSessionRecord(session.filePath, { type: "message", message });
    const original = await readFile(session.filePath, "utf8");

    const records = await readSessionRecords(session.filePath);

    expect(records[0]).toEqual({
      type: "session", version: 1, id: session.id, cwd: testDir, createdAt: expect.any(String),
    });
    expect(records.slice(1)).toEqual(messages.map(message => ({ type: "message", message })));
    expect(await loadSession(testDir, session.id)).toEqual({
      ...session, messages,
      usage: { inputTokens: 20, outputTokens: 5, totalTokens: 25, unknownCalls: 0 },
    });
    expect(await readFile(session.filePath, "utf8")).toBe(original);
  });

  it("恢复最近一次压缩快照及后续消息，保留系统提示和完整工具交互", async () => {
    const session = await createSession(testDir);
    const system: Message = { role: "system", content: "编程助手" };
    const first: Message[] = [system, { role: "user", content: "第一份摘要" }];
    const latest: Message[] = [
      system,
      { role: "user", content: "合并后的摘要" },
      { role: "assistant", content: "", toolCalls: [
        { id: "read", name: "read_file", arguments: { path: "a.ts" } },
      ] },
      { role: "tool", toolCallId: "read", content: "文件内容" },
    ];
    const next: Message = { role: "assistant", content: "读完了", usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } };
    const records: SessionRecord[] = [
      { type: "message", message: system },
      userRecord,
      { type: "compaction", messages: first },
      { type: "message", message: { role: "user", content: "中间任务" } },
      { type: "compaction", messages: latest },
      { type: "message", message: next },
    ];
    for (const record of records) await appendSessionRecord(session.filePath, record);
    const original = await readFile(session.filePath, "utf8");

    expect(await loadSession(testDir, session.id)).toEqual({
      ...session, messages: [...latest, next],
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15, unknownCalls: 0 },
    });
    expect(await readFile(session.filePath, "utf8")).toBe(original);
  });

  it.each(["compaction", "usage"])("末尾 %s 记录不完整时保留上次状态，恢复后仍能追加", async type => {
    const session = await createSession(testDir);
    const messages: Message[] = [{ role: "user", content: "已保存的摘要" }];
    await appendSessionRecord(session.filePath, userRecord);
    await appendSessionRecord(session.filePath, { type: "compaction", messages });
    const usage = { inputTokens: 10, outputTokens: 5, totalTokens: 15 };
    await appendSessionRecord(session.filePath, { type: "usage", usage });
    await appendFile(session.filePath, `{"type":"${type}",`, "utf8");

    const restored = await loadSession(testDir, session.id);
    expect(restored.messages).toEqual(messages);
    expect(restored.usage.totalTokens).toBe(15);

    const next: Message = { role: "user", content: "继续任务" };
    await appendSessionRecord(session.filePath, { type: "message", message: next });
    await appendSessionRecord(session.filePath, { type: "usage", usage });
    const continued = await loadSession(testDir, session.id);
    expect(continued.messages).toEqual([...messages, next]);
    expect(continued.usage.totalTokens).toBe(30);
  });

  it("兼容旧用量并累计独立记录，回复和快照不重复计数，未保存回复的调用仍计入", async () => {
    const session = await createSession(testDir);
    const usage = { inputTokens: 10, outputTokens: 5, totalTokens: 15 };
    const reply: Message = { role: "assistant", content: "完成", usage };
    const messages: Message[] = [{ role: "user", content: "摘要" }, reply];
    const records: SessionRecord[] = [
      { type: "message", message: reply },
      { type: "usage", usage },
      { type: "message", message: reply },
      { type: "compaction", messages },
      { type: "usage", usage: null },
      { type: "usage", usage },
    ];
    for (const record of records) await appendSessionRecord(session.filePath, record);
    const original = await readFile(session.filePath, "utf8");

    expect(await loadSession(testDir, session.id)).toEqual({
      ...session, messages,
      usage: { inputTokens: 30, outputTokens: 15, totalTokens: 45, unknownCalls: 1 },
    });
    expect(await readFile(session.filePath, "utf8")).toBe(original);
  });

  it.each([
    { name: "LF 且有末尾换行", newline: "\n", trailing: true },
    { name: "LF 且无末尾换行", newline: "\n", trailing: false },
    { name: "CRLF 且有末尾换行", newline: "\r\n", trailing: true },
    { name: "CRLF 且无末尾换行", newline: "\r\n", trailing: false },
  ])("支持 $name", async ({ newline, trailing }) => {
    const records = [header, userRecord];
    const content = records.map(record => JSON.stringify(record)).join(newline) + (trailing ? newline : "");
    await writeFile(filePath, content, "utf8");

    await expect(readSessionRecords(filePath)).resolves.toEqual(records);
    const expectedContent = trailing ? content : `${content}\n`;
    expect(await readFile(filePath, "utf8")).toBe(expectedContent);

    // 再次读取不会重复补换行。
    await expect(readSessionRecords(filePath)).resolves.toEqual(records);
    expect(await readFile(filePath, "utf8")).toBe(expectedContent);
  });

  it("只有会话头的新会话也可以读取", async () => {
    await writeRecords([header]);
    await expect(readSessionRecords(filePath)).resolves.toEqual([header]);
    const session = await createSession(testDir);
    expect(await loadSession(testDir, session.id)).toEqual({
      ...session, messages: [],
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, unknownCalls: 0 },
    });
  });

  it.each(["", " \n\t\r\n", "not json\n{broken"])("空文件或没有可用记录时返回空数组 %#", async content => {
    await writeFile(filePath, content, "utf8");
    await expect(readSessionRecords(filePath)).resolves.toEqual([]);
    expect(await readFile(filePath, "utf8")).toBe(content);
  });

  it.each([
    { name: "中间损坏行", content: `${JSON.stringify(header)}\n{broken}\n${JSON.stringify(userRecord)}\n` },
    { name: "中间及末尾空行", content: `${JSON.stringify(header)}\n \t\n${JSON.stringify(userRecord)}\n\n` },
    { name: "会话头之前的空行和损坏行", content: `\nnot json\n${JSON.stringify(header)}\n${JSON.stringify(userRecord)}\n` },
  ])("跳过 $name，保留完整记录且不修改文件", async ({ content }) => {
    await writeFile(filePath, content, "utf8");
    await expect(readSessionRecords(filePath)).resolves.toEqual([header, userRecord]);
    expect(await readFile(filePath, "utf8")).toBe(content);
  });

  it.each([
    { name: "完整消息缺少末尾换行", tail: "" },
    { name: "最后一行只有半条 JSON", tail: '\n{"type":' },
  ])("$name 时补齐换行，继续追加的消息不会丢失", async ({ tail }) => {
    const content = `${JSON.stringify(header)}\n${JSON.stringify(userRecord)}${tail}`;
    await writeFile(filePath, content, "utf8");

    await expect(readSessionRecords(filePath)).resolves.toEqual([header, userRecord]);
    expect(await readFile(filePath, "utf8")).toBe(`${content}\n`);

    const message: Message = { role: "assistant", content: "恢复后追加的新消息" };
    const record: SessionRecord = { type: "message", message };
    await appendSessionRecord(filePath, record);

    await expect(readSessionRecords(filePath)).resolves.toEqual([header, userRecord, record]);
    expect(await readFile(filePath, "utf8")).toBe(`${content}\n${JSON.stringify(record)}\n`);
  });

  it.each([
    null, 123, [], {}, userRecord,
    { type: "session", version: 1 },
    { ...header, id: 123 },
  ])("会话头不是 session 或缺少字符串 id 时返回空数组 %#", async record => {
    const content = JSON.stringify(record);
    await writeFile(filePath, content, "utf8");
    await expect(readSessionRecords(filePath)).resolves.toEqual([]);
    expect(await readFile(filePath, "utf8")).toBe(content);
  });

  it("第一条可解析记录不是会话头时不继续寻找后面的会话头", async () => {
    await writeRecords([userRecord, header]);
    await expect(readSessionRecords(filePath)).resolves.toEqual([]);
  });

  it("会话头只检查 type 和 id，其他字段交给后续恢复逻辑处理", async () => {
    const minimalHeader = { type: "session", id: "older-session" };
    await writeRecords([minimalHeader, userRecord]);
    await expect(readSessionRecords(filePath)).resolves.toEqual([minimalHeader, userRecord]);
  });

  it("原样保留历史工具参数和用量，不在读取时递归校验", async () => {
    const record = {
      type: "message",
      message: {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "a", name: "ls", arguments: { path: ".", limit: "10" } }],
        usage: { inputTokens: "10", outputTokens: 5, totalTokens: 15 },
      },
    };
    await writeRecords([header, record]);
    await expect(readSessionRecords(filePath)).resolves.toEqual([header, record]);
  });

  it("文件不存在时保留文件系统错误和路径", async () => {
    await expect(readSessionRecords(filePath)).rejects.toMatchObject({ code: "ENOENT", path: filePath });
  });
});
