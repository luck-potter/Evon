# Evon 演进路线图（对标 pi）

本项目当前是最小可用 SWE-Agent 原型。本路线图旨在指引 Evon 逐步向工业级编码代理（以 `pi` 为标杆）演进。

## 核心原则
- **避免过早抽象**：不急于照搬 Monorepo 或重型自研 TUI，优先解决模型编码的稳定度与核心体验。
- **由内向外迭代**：防御保活 → 交互体验 → 编码工具 → 会话持久 → 生态扩展。

---

## 阶段一：防御与稳定性（Agent 活命底线）
> 目标：消除大输出撑爆 Token、命令卡死与文件越界，保证 Agent 稳定存活。

- [x] **输出截断（Output Truncation）**
  - 为 `run_bash` 和 `read_file` 增加行数与字符数上限（如 1000 行 / 30KB）。
  - 超出限制时保留首尾内容，并在中间插入 `[... truncated N lines ...]` 提示。
- [x] **升级 Bash 执行器**
  - 从 `child_process.exec` 改用 `child_process.spawn`，避免单次大输出冲垮 `maxBuffer` 导致进程直接崩溃。
- [x] **`read_file` 支持分页/切片**
  - 新增可选参数 `offset`（起始行）与 `limit`（读取行数），避免读大文件时一次性打满上下文。
- [x] **工作区目录安全围栏**
  - 校验工具操作路径（`path.resolve`），防止模型越界修改工作区以外的系统文件。

---

## 阶段二：交互形态升级（从批处理脚本到交互式 CLI）
> 目标：摆脱黑盒等待，支持流式输出、持续追问与随时打断。

- [x] **流式输出（Streaming）**
  - 改造 `llm.ts` 对接模型的流式 API，实时打字机回显内容与工具调用状态。
- [ ] **交互式 REPL 会话**
  - 改造 `index.ts`，基于 Node.js `readline/promises` 实现连续对话，任务结束后等待用户输入，支持追问与修正。
- [ ] **优雅打断（AbortSignal / Ctrl+C）**
  - 捕获 `SIGINT`，当模型正在生成或 Bash 正在运行时按一次仅中断当前操作，向上下文回填 `Cancelled by user`，不杀死整个进程。

---

## 阶段三：编码工具链强化（向 pi 工具集靠拢）
> 目标：提升代码探索与修改的成功率。

- [ ] **专用代码检索工具**
  - 实现 `grep`：支持关键词/正则匹配代码行。
  - 实现 `find_files`：结合 `.gitignore` 规则查找文件，避免模型频繁编写低效 bash 命令找文件。
- [ ] **增强 `edit_file` 容错性**
  - 放宽 `old_str` 严苛的完全匹配，支持空白字符容忍（Whitespace-tolerant matching）或 diff 补丁机制。
  - 修改成功后在控制台打印直观的彩色 diff 预览。

---

## 阶段四：上下文与会话持久化（Context & Memory）
> 目标：支持长任务工作流，解决会话丢失与 Token 窗口溢出。

- [ ] **Token 统计与预算监控**
  - 追踪每轮调用的 Prompt Token 与 Completion Token，终端显示消耗明细。
- [ ] **自动上下文压缩（Compaction）**
  - 当上下文接近模型窗口阈值（如 70%）时，保留 system prompt 和最近几轮，触发轻量模型对早期步骤进行摘要压缩。
- [ ] **会话持久化存储**
  - 会话消息流自动记录在 `.evon/sessions/<session_id>.jsonl` 中。
  - 支持 `npm start -- --resume <session_id>` 恢复先前会话。

---

## 阶段五：生态扩展与多模型（平台化）
> 目标：解耦模型供应商，支持外部工具扩展与界面升级。

- [ ] **多模型提供商抽象**
  - 解耦 `llm.ts`，提供统一 Provider 接口，支持 Anthropic Claude（代码能力顶尖）、DeepSeek 等兼容接口。
- [ ] **MCP 客户端支持**
  - 接入 Model Context Protocol (MCP)，允许用户通过配置文件挂载外部工具（浏览器、数据库、外部 API 等）。
- [ ] **轻量终端 UI（TUI）**
  - 引入更优雅的终端渲染库，支持 Markdown 排版、状态栏与快捷命令（如 `/model`, `/undo`, `/compact`）。
