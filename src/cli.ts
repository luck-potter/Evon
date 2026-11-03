export function parseCliArgs(args: string[]): {
  resumeId?: string;
  initialTask: string;
} {
  let resumeId: string | undefined;
  const task: string[] = [];

  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--") {
      task.push(...args.slice(index + 1));
      break;
    }

    if (arg === "--resume" || arg.startsWith("--resume=")) {
      if (resumeId !== undefined) throw new Error("--resume 只能指定一次。");
      const id = arg === "--resume" ? args[++index] : arg.slice("--resume=".length);
      if (!id || id.startsWith("--")) {
        throw new Error("--resume 需要会话 ID，例如：npm start -- --resume <sessionId>");
      }
      if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(id)) {
        throw new Error("无效的会话 ID，请传入 .jsonl 文件名中的 ID，不含路径和扩展名。");
      }
      resumeId = id;
    } else {
      task.push(arg);
    }
  }

  return { resumeId, initialTask: task.join(" ").trim() };
}
