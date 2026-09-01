import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['packages/*/tests/**/*.spec.ts'],
    // 端到端用例会真实调用飞书，串行更稳且避免触发限流
    fileParallelism: false,
    testTimeout: 60_000,
  },
})
