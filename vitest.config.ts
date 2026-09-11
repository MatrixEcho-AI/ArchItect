import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.ts', 'apps/*/test/**/*.test.ts'],
    environment: 'node',
    // 这套测试里有相当一部分是 CPU 密集的软件光栅化 / 网格化（golden、textured、
    // transform、schematic…），单个用例冷跑就要 1–4 秒。默认的 5 秒是按
    // 「独占机器」定的，而全量跑时 59 个测试文件同时抢 CPU，实测能膨胀 4 倍以上，
    // 结果是随机假红（pick.test.ts 就中过：单独跑 1.3 秒，全量跑 5.9 秒）。
    // 这里给足余量：用例 30 秒、钩子 120 秒（重初始化放 beforeAll 里）。
    testTimeout: 30_000,
    hookTimeout: 120_000,
  },
})
