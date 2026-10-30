# 手搓最小化 SWE-Agent · TypeScript

这是逐步实现用的骨架。主循环、`runBash`、`readFile`、`writeFile` 和用于局部修改已有文件的 `editFile` 已实现；模型 API 尚未接入，目前还不能自主写代码或修复 bug。

## 启动

需要 Node.js 24+。直接运行 TypeScript，类型检查和测试需要安装开发依赖。

```bash
npm install
npm start -- "阅读当前项目，说明它的结构"
npm run typecheck
```

此时会打印步骤编号和“骨架已跑通（占位回复）”，不会请求模型 API。

## 文件分工

```text
src/
├── index.ts   # CLI 入口：接收任务
├── agent.ts   # 主循环：模型 → 工具 → 结果回填 → 模型
├── llm.ts     # 模型接口：下一阶段接入真实 API
├── tools.ts   # 四个原子工具和统一分发
└── types.ts   # 对话消息、工具调用的类型
```

## 工具测试

```bash
npm test
npm run test:watch
npm run typecheck
```

`npm test` 单次运行全部测试；`npm run test:watch` 监听代码变化，自动重跑测试。

- `tests/run-bash.test.ts`：真实执行本地 Node 命令，覆盖 stdout、stderr、特殊字符、退出码和超时。命令转义适用于 macOS/Linux；超时用例约需 5 秒，测试超时上限为 12 秒。
- `tests/read-file.test.ts`：使用临时文件验证行号、中文、缩进、空行和读取错误，以及 `executeTool` 的成功与失败回填；测试结束后自动清理。
- `tests/write-file.test.ts`：使用临时文件验证创建、完整覆盖、清空、中文与特殊字符原样写入，以及父目录缺失和 `executeTool` 的成功与失败回填；测试结束后自动清理。
- `tests/edit-file.test.ts`：使用临时文件验证唯一匹配替换、多行中文、特殊字符原样写入、删除内容、空旧文本、零匹配、多次匹配和重叠匹配，以及 `executeTool` 的成功、未修改提示与失败回填；同时检查最终文件内容，测试结束后自动清理。

为准确检查输出和状态，测试约定 `runBash` 返回 JSON 字符串，例如：

```json
{"stdout":"hello\n","stderr":"","exitCode":0,"timedOut":false}
```

- 正常完成：`exitCode` 为 `0`；即使有 stderr 输出也不代表失败。
- 非零退出：返回实际退出码，同时保留 stdout 和 stderr，不直接抛出命令执行错误。
- 超时：`timedOut` 为 `true`，`exitCode` 为 `null`，保留超时前已收集的两种输出。

`readFile` 返回 `1: 文件内容` 形式的文本。空文件返回 `1: `，末尾换行会额外显示一个编号空行。

`writeFile(path, content)` 按 UTF-8 原样写入完整内容：文件不存在时创建，已存在时完整覆盖，空内容会创建空文件或清空已有文件。父目录必须已存在，不自动创建目录。对应工具名为 `write_file`，参数为 `{ path, content }`；文件系统错误由 `executeTool` 转换成“工具执行失败”结果。

`editFile` 只局部修改已有文件：`oldStr` 必须非空且恰好匹配一次，`newStr` 按原样写入，也可以为空以删除内容。空旧文本、零匹配或多次匹配会返回“文件未修改”提示并保留原文件；文件系统错误由 `executeTool` 转换成“工具执行失败”结果。创建文件或整文件重写使用 `writeFile`。

## 接下来逐步完成

1. 接入模型 API：补齐工具 Schema、参数校验和消息格式转换。
2. 加入输出截断、文件路径检查和命令确认；需要限制 shell 的访问范围时，使用操作系统隔离或容器。

当前的工作目录提示只是提供给模型的上下文，骨架尚未实现沙盒。
