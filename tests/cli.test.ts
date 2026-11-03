import { describe, expect, it } from "vitest";
import { parseCliArgs } from "../src/cli.ts";

describe("parseCliArgs", () => {
  it.each([
    { args: [], resumeId: undefined, initialTask: "" },
    { args: ["阅读项目", "并说明结构"], resumeId: undefined, initialTask: "阅读项目 并说明结构" },
    { args: ["--resume", "session-123"], resumeId: "session-123", initialTask: "" },
    { args: ["--resume", "session-123", "继续", "修复"], resumeId: "session-123", initialTask: "继续 修复" },
    { args: ["继续修复", "--resume", "session-123"], resumeId: "session-123", initialTask: "继续修复" },
    { args: ["--resume=session-123", "继续"], resumeId: "session-123", initialTask: "继续" },
    { args: ["--", "解释", "--resume"], resumeId: undefined, initialTask: "解释 --resume" },
    { args: ["--resume", "session-123", "--", "--resume", "的用法"], resumeId: "session-123", initialTask: "--resume 的用法" },
    { args: ["解释", "--verbose", "选项"], resumeId: undefined, initialTask: "解释 --verbose 选项" },
  ])("解析参数 %#", ({ args, resumeId, initialTask }) => {
    expect(parseCliArgs(args)).toEqual({ resumeId, initialTask });
  });

  it.each([
    ["--resume"], ["--resume", ""], ["--resume="], ["--resume", "--"],
  ])("缺少会话 ID 时拒绝启动 %#", (...args) => {
    expect(() => parseCliArgs(args)).toThrow("--resume 需要会话 ID");
  });

  it.each(["../other", "a/b", "a\\b", "/absolute", "session.jsonl", "two words"])(
    "拒绝路径或非法 ID：%s",
    id => expect(() => parseCliArgs(["--resume", id])).toThrow("无效的会话 ID"),
  );

  it("拒绝重复指定会话", () => {
    expect(() => parseCliArgs(["--resume", "first", "--resume=second"])).toThrow("只能指定一次");
  });
});
