import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // тесты с базой (TEST_DATABASE_URL) сбрасывают одну базу — по одному файлу за раз
    fileParallelism: false,
    include: ['apps/*/src/**/*.test.ts', 'packages/*/src/**/*.test.ts'],
  },
})
