import { describe, it } from "vitest";

// 实现 ls 后，把下面的 todo 逐个改成测试。
// 临时目录的创建和清理可参考 read-file.test.ts。
describe("ls", () => {
  it.todo("列出文件和目录，目录名以 / 结尾");
  it.todo("包含隐藏文件，并按名称排序");
  it.todo("只列直接子项，不递归列出子目录内容");
  it.todo("空目录返回 (空目录)");
  it.todo("先排序再应用 limit，并提示还有多少项未显示");
  it.todo("limit 未提供或为 null 时默认展示前 100 项");
  it.todo("拒绝为零、负数、小数或非有限数的 limit");
  it.todo("相对路径基于 workspaceRoot 解析，并拒绝越界路径");
  it.todo("目录不存在或传入文件路径时抛出错误");
  it.todo("输出过长时复用 truncateHead 截断");
  it.todo("executeTool 转发 path、limit、workspaceRoot，并捕获错误");
});
