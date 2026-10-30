import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // 要比 runBash 的 5 秒限制更长，才能验证它自身的超时行为。
    testTimeout: 12_000,
  },
});
