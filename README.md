# 手搓最小化 SWE-Agent · TypeScript

这是逐步实现用的骨架。主循环已经串好，模型使用占位回复，三个工具留有 TODO；目前还不能自主写代码或修复 bug。

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
├── tools.ts   # 三个原子工具和统一分发
└── types.ts   # 对话消息、工具调用的类型
```

## runBash 测试

```bash
npm test
npm run test:watch
npm run typecheck
```

测试位于 `tests/run-bash.test.ts`，使用 Vitest 的 `describe`、`it` 和 `expect`。
`npm test` 单次运行全部测试；`npm run test:watch` 监听代码变化，自动重跑测试。
测试会真实执行本地 Node 命令，覆盖正常输出、stderr 警告、空输出、多行中文输出、非零退出和超时。
命令的引号转义适用于当前的 macOS/Linux shell；其中超时用例会实际等待约 5 秒。
`vitest.config.ts` 将单个用例的超时设为 12 秒，留出验证 `runBash` 自身超时行为的时间。

为准确检查输出和状态，测试约定 `runBash` 返回 JSON 字符串，例如：

```json
{"stdout":"hello\n","stderr":"","exitCode":0,"timedOut":false}
```

- 正常完成：`exitCode` 为 `0`；即使有 stderr 输出也不代表失败。
- 非零退出：返回实际退出码，同时保留 stdout 和 stderr，不直接抛出命令执行错误。
- 超时：`timedOut` 为 `true`，`exitCode` 为 `null`，保留超时前已收集的两种输出。

这些测试是下一步完善 `runBash` 的验收标准；当前实现尚未满足全部约定，运行时会有失败用例。

## 接下来逐步完成

1. 实现 `runBash`：运行命令，收集 stdout、stderr、退出码，处理超时。
2. 实现 `readFile`：读取文件并附上行号。
3. 实现 `editFile`：唯一匹配替换，并明确创建新文件的方式。
4. 接入模型 API：补齐工具 Schema、参数校验和消息格式转换。
5. 加入输出截断、文件路径检查和命令确认；需要限制 shell 的访问范围时，使用操作系统隔离或容器。

当前的工作目录提示只是提供给模型的上下文，骨架尚未实现沙盒。
