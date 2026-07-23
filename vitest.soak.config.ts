import { defineConfig } from 'vitest/config'

const requestedDurationMs = Number.parseInt(process.env.SOAK_DURATION_MS ?? '300000', 10)
const soakDurationMs =
  Number.isFinite(requestedDurationMs) && requestedDurationMs > 0 ? requestedDurationMs : 300_000

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/soak/**/*.test.ts'],
    reporters: ['default'],
    testTimeout: soakDurationMs + 60_000,
    hookTimeout: 60_000,
  },
})
