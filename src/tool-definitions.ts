export const toolDefinitions = [
  {
    type: "function",
    name: "run_bash",
    description:
      "执行本地 shell 命令，超时为 5 秒。返回包含 stdout、stderr、exitCode 和 timedOut 的 JSON 字符串。",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "需要执行的 shell 命令" },
      },
      required: ["command"],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    type: "function",
    name: "read_file",
    description: "按 UTF-8 读取本地文件，返回带行号的文件内容。",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "需要读取的文件路径" },
      },
      required: ["path"],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    type: "function",
    name: "write_file",
    description:
      "按 UTF-8 创建文件或完整覆盖已有文件。父目录必须已存在；空内容会创建空文件或清空已有文件。",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "需要写入的文件路径" },
        content: { type: "string", description: "要原样写入的完整文件内容" },
      },
      required: ["path", "content"],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    type: "function",
    name: "edit_file",
    description:
      "局部修改已有文件。old_str 必须非空且在文件中恰好匹配一次，否则不修改文件；new_str 为空时删除匹配内容。",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "需要修改的已有文件路径" },
        old_str: {
          type: "string",
          description: "需要替换的非空原文，必须在文件中唯一匹配",
        },
        new_str: {
          type: "string",
          description: "替换后的文本，空字符串表示删除原文",
        },
      },
      required: ["path", "old_str", "new_str"],
      additionalProperties: false,
    },
    strict: true,
  },
];
