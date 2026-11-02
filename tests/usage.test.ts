import { describe, expect, it } from "vitest";
import {
  createSessionUsage,
  formatUsage,
  recordUsage,
} from "../src/usage.ts";

describe("createSessionUsage", () => {
  it("创建全零初始化的会话用量对象", () => {
    expect(createSessionUsage()).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      unknownCalls: 0,
    });
  });
});

describe("recordUsage", () => {
  it("正确累加单次与多次正常用量", () => {
    const session = createSessionUsage();

    recordUsage(session, {
      inputTokens: 100,
      outputTokens: 50,
      totalTokens: 150,
    });
    expect(session).toEqual({
      inputTokens: 100,
      outputTokens: 50,
      totalTokens: 150,
      unknownCalls: 0,
    });

    recordUsage(session, {
      inputTokens: 40,
      outputTokens: 10,
      totalTokens: 50,
    });
    expect(session).toEqual({
      inputTokens: 140,
      outputTokens: 60,
      totalTokens: 200,
      unknownCalls: 0,
    });
  });

  it("当 usage 为 null 时递增 unknownCalls 且不改变已统计 token", () => {
    const session = createSessionUsage();
    recordUsage(session, {
      inputTokens: 10,
      outputTokens: 20,
      totalTokens: 30,
    });

    recordUsage(session, null);
    expect(session).toEqual({
      inputTokens: 10,
      outputTokens: 20,
      totalTokens: 30,
      unknownCalls: 1,
    });

    recordUsage(session, null);
    expect(session.unknownCalls).toBe(2);
  });
});

describe("formatUsage", () => {
  it("格式化正常单次用量且无未知调用的文本", () => {
    const session = {
      inputTokens: 100,
      outputTokens: 20,
      totalTokens: 120,
      unknownCalls: 0,
    };
    const usage = {
      inputTokens: 100,
      outputTokens: 20,
      totalTokens: 120,
    };

    expect(formatUsage(usage, session)).toBe(
      "[Tokens] 本次: 100 in / 20 out (120 total) | 会话累计: 120 total",
    );
  });

  it("当本次用量为 null 且存在未知调用时正确展示", () => {
    const session = {
      inputTokens: 100,
      outputTokens: 20,
      totalTokens: 120,
      unknownCalls: 1,
    };

    expect(formatUsage(null, session)).toBe(
      "[Tokens] 本次: 未知 | 会话累计: 120 total (+1 次未知调用)",
    );
  });

  it("当本次用量正常但历史上存在未知调用时，同时展示本次详情与累计未知后缀", () => {
    const session = {
      inputTokens: 150,
      outputTokens: 30,
      totalTokens: 180,
      unknownCalls: 2,
    };
    const usage = {
      inputTokens: 50,
      outputTokens: 10,
      totalTokens: 60,
    };

    expect(formatUsage(usage, session)).toBe(
      "[Tokens] 本次: 50 in / 10 out (60 total) | 会话累计: 180 total (+2 次未知调用)",
    );
  });
});
