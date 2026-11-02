import type OpenAI from "openai";

export const toolDefinitions: OpenAI.Responses.FunctionTool[] = [
  {
    type: "function",
    name: "run_bash",
    description:
      "执行本地 shell 命令，超时为 30 秒。返回包含 stdout、stderr、exitCode 和 timedOut 的 JSON 字符串。",
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
    name: "ls",
    description:
      "列出目录的直接子项，包含隐藏文件，按名称排序，每行一项，目录名后加 /。支持数量限制，超出时提示剩余数量。",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "需要浏览的目录路径，使用 . 表示工作区根目录",
        },
        limit: {
          anyOf: [{ type: "integer", minimum: 1 }, { type: "null" }],
          description: "最多展示的子项数量，传 null 时默认展示前 100 项",
        },
      },
      required: ["path", "limit"],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    type: "function",
    name: "find_files",
    description:
      "按 glob 递归查找文件，返回按路径排序的工作区相对路径，每行一个文件。遵循 .gitignore 等忽略规则，跳过隐藏文件，不跟随遍历中的符号链接。默认最多 100 个文件，达到上限后停止搜索并提示；无匹配返回 (无匹配)。搜索超时为 30 秒，执行失败时返回退出码和错误原因。",
    parameters: {
      type: "object",
      properties: {
        pattern: {
          type: "string",
          description: "文件 glob，例如 *.ts、**/*.test.ts；无 / 时匹配任意层级文件名，有 / 时相对于搜索目录",
        },
        path: {
          anyOf: [{ type: "string" }, { type: "null" }],
          description: "搜索目录，传 null 时搜索整个工作区",
        },
        limit: {
          anyOf: [{ type: "integer", minimum: 1 }, { type: "null" }],
          description: "最多返回的文件数量，达到上限后停止搜索并提示；传 null 时默认 100",
        },
      },
      required: ["pattern", "path", "limit"],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    type: "function",
    name: "grep",
    description:
      "在文件或目录中搜索代码行，返回工作区相对路径:行号:内容。默认按正则匹配、区分大小写，并遵循 .gitignore；可按 glob 过滤文件。默认最多 100 条匹配，达到上限后停止搜索；单行正文最多预览 500 字符，整体正文最多保留头部 50KiB，截断时附加提示。无匹配时返回 (无匹配)。",
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "搜索的正则表达式或普通文本" },
        path: {
          anyOf: [{ type: "string" }, { type: "null" }],
          description: "搜索的文件或目录路径，传 null 时搜索整个工作区",
        },
        glob: {
          anyOf: [{ type: "string" }, { type: "null" }],
          description: "文件 glob 过滤规则，例如 *.ts；传 null 时不过滤",
        },
        literal: {
          anyOf: [{ type: "boolean" }, { type: "null" }],
          description: "为 true 时按普通文本搜索，传 null 时按正则匹配",
        },
        ignoreCase: {
          anyOf: [{ type: "boolean" }, { type: "null" }],
          description: "为 true 时忽略大小写，传 null 时区分大小写",
        },
        limit: {
          anyOf: [{ type: "integer", minimum: 1 }, { type: "null" }],
          description: "所有文件合计的匹配行数上限，达到后停止搜索，传 null 时默认 100 条；整体输出仍受 50KiB 限制",
        },
      },
      required: ["pattern", "path", "glob", "literal", "ignoreCase", "limit"],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    type: "function",
    name: "read_file",
    description:
      "按 UTF-8 读取本地文件，返回文件内容。支持可选的 offset（从 1 开始的起始行号）与 limit（读取行数上限）分页读取。",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "需要读取的文件路径" },
        offset: {
          anyOf: [{ type: "integer" }, { type: "null" }],
          description: "起始行号（从 1 开始，传 null 表示默认从第 1 行开始）",
        },
        limit: {
          anyOf: [{ type: "integer" }, { type: "null" }],
          description: "读取的最大行数（传 null 表示不限制行数）",
        },
      },
      required: ["path", "offset", "limit"],
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
