# Evon · 最小化 SWE-Agent（TypeScript）

这是一个逐步构建的编程代理原型，已接通真实模型 API 和“模型 → 工具 → 结果回填 → 模型”的主循环。支持流式输出、连续对话、Ctrl+C 打断，以及目录浏览、文件读写、局部编辑和 shell 命令执行。

## 启动

需要 Node.js 24+。项目直接运行 TypeScript；安装依赖后即可启动、测试和检查类型。

```bash
npm install
```

首次使用时复制配置模板：

```bash
cp .env.example .env
```

编辑 `.env`，填写以下配置：

| 变量 | 用途 |
| --- | --- |
| `BASE_URL` | 模型服务的 API 基础地址 |
| `API_KEY` | 模型服务的访问密钥 |
| `MODEL` | 实际调用的模型 ID |

当前模型适配器使用 Responses API，模型服务需支持流式输出和函数工具调用。

直接启动交互会话，或在启动时传入第一个任务：

```bash
npm start
npm start -- "阅读当前项目，说明它的结构"
```

运行时会显示步骤编号、模型逐步生成的文本和工具调用状态。任务完成后回到 `evon >` 提示符，可继续追问；同一进程内会保留对话上下文。

| 输入或操作 | 行为 |
| --- | --- |
| 普通文本 | 发起任务或继续追问 |
| `/clear` | 清空当前对话上下文 |
| `/exit` 或 `/quit` | 退出程序 |
| 任务执行中按 Ctrl+C | 取消当前任务，随后可继续输入 |
| 等待输入时按 Ctrl+C | 退出程序 |

当前会话保存在内存中，退出程序后不会保留。启动目录即工作区；`ls` 和文件工具会校验操作路径的工作区范围，`run_bash` 以当前进程权限执行 shell 命令，尚无进程沙盒。

## 文件分工

```text
src/
├── index.ts             # CLI 入口：初始任务、REPL、会话命令与中断
├── agent.ts             # 主循环：模型 → 工具 → 结果回填 → 模型
├── llm.ts               # Responses API 适配与流式事件处理
├── tool-definitions.ts  # 提供给模型的工具描述与参数定义
├── types.ts             # 对话消息、工具调用的类型
├── tools/               # 每个原子工具单独存放
│   ├── index.ts         # 统一导出和工具分发
│   ├── ls.ts            # 浏览目录的直接子项
│   ├── run-bash.ts      # 执行 shell 命令
│   ├── read-file.ts     # 分页读取文件
│   ├── write-file.ts    # 创建或完整覆盖文件
│   └── edit-file.ts     # 局部修改文件
└── utils/
    ├── path.ts          # 工作区路径校验
    └── truncate.ts      # 按行数与 UTF-8 字节数截断输出
```

## 测试与类型检查

```bash
npm test
npm run test:watch
npm run typecheck
```

`npm test` 单次运行全部测试；`npm run test:watch` 监听代码变化，自动重跑测试。模型适配器和主循环测试使用 mock，不消耗 API 额度；文件与命令工具测试会创建临时文件或执行本地命令。

- `tests/ls.test.ts`：使用临时目录验证文件与目录标记、隐藏文件、排序、直接子项、数量限制、默认参数、路径校验、错误回填和长输出截断；测试结束后自动清理。
- `tests/run-bash.test.ts`：真实执行本地 Node 命令，覆盖 stdout、stderr、特殊字符、退出码、超时、外部中断和输出截断。命令转义适用于 macOS/Linux，测试超时上限为 12 秒。
- `tests/read-file.test.ts`：使用临时文件验证 UTF-8 原文、缩进、空行、分页、输出截断和读取错误，以及 `executeTool` 的成功与失败回填；测试结束后自动清理。
- `tests/write-file.test.ts`：使用临时文件验证创建、完整覆盖、清空、中文与特殊字符原样写入，以及父目录缺失和 `executeTool` 的成功与失败回填；测试结束后自动清理。
- `tests/edit-file.test.ts`：使用临时文件验证唯一匹配替换、多行中文、特殊字符原样写入、删除内容、空旧文本、零匹配、多次匹配和重叠匹配，以及 `executeTool` 的成功、未修改提示与失败回填；同时检查最终文件内容，测试结束后自动清理。
- `tests/llm.test.ts` 和 `tests/agent.test.ts`：验证流式事件、工具调用解析、结果回填、多轮会话、步数限制和取消流程。
- `tests/path.test.ts` 和 `tests/truncate.test.ts`：验证工作区路径校验和输出截断边界。

## 工具行为

`ls` 列出目录的直接子项，包含隐藏文件，按名称排序，每行一项，目录名后加 `/`。使用 `path: "."` 浏览工作区根目录；`limit` 省略或为 `null` 时默认展示前 100 项，必须为正整数。超出数量限制时提示剩余项数，输出正文超过 50KiB 时保留头部并附加截断提示；空目录返回 `(空目录)`。

为准确检查输出和状态，测试约定 `runBash` 返回 JSON 字符串，例如：

```json
{"stdout":"hello\n","stderr":"","exitCode":0,"timedOut":false}
```

- 正常完成：`exitCode` 为 `0`；即使有 stderr 输出也不代表失败。
- 非零退出：返回实际退出码，同时保留 stdout 和 stderr，不直接抛出命令执行错误。
- 超时：`timedOut` 为 `true`，`exitCode` 为 `null`，保留超时前已收集的两种输出。

模型调用 `run_bash` 的超时为 30 秒。回填时，stdout 和 stderr 的正文各自保留末尾最多 2000 行或 50KiB，超出时附加截断提示。

`read_file` 按 UTF-8 返回文件原文，不添加行号；空文件返回空字符串，未截断时保留原有换行。支持 `offset`（从 1 开始的起始行号）和 `limit`（读取行数）；省略或传 `null` 时分别表示从第 1 行开始、读取到文件末尾。选取的正文超过 2000 行或 50KiB 时保留头部并附加截断提示，可通过分页继续读取。

`writeFile(path, content)` 按 UTF-8 原样写入完整内容：文件不存在时创建，已存在时完整覆盖，空内容会创建空文件或清空已有文件。父目录必须已存在，不自动创建目录。对应工具名为 `write_file`，参数为 `{ path, content }`；文件系统错误由 `executeTool` 转换成“工具执行失败”结果。

`editFile` 只局部修改已有文件：`oldStr` 必须非空且恰好匹配一次，`newStr` 按原样写入，也可以为空以删除内容。空旧文本、零匹配或多次匹配会返回“文件未修改”提示并保留原文件；文件系统错误由 `executeTool` 转换成“工具执行失败”结果。创建文件或整文件重写使用 `writeFile`。

## 接下来逐步完成

详细对标 `pi` 的完整 5 阶段演进路线见 [ROADMAP.md](ROADMAP.md)。

近期核心优先项：

1. **代码检索**：补齐专用 `grep` 和遵循 `.gitignore` 的 `find_files` 工具。
2. **编辑体验**：增强 `edit_file` 的匹配容错，并提供修改后的 diff 预览。
3. **长任务支持**：增加 Token 统计、上下文压缩和会话持久化。
