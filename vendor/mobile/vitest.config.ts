import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vitest/config";

/**
 * 逻辑层单测（api client / poll / stores / tokens / icons）
 * 小程序运行时全局 uni 由各用例按需 mock（tests/helpers/mock-uni.ts）
 */
export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/api/**", "src/composables/**", "src/stores/**", "src/theme/**", "src/utils/**"],
      thresholds: { branches: 80, functions: 80, lines: 80, statements: 80 },
    },
  },
});
