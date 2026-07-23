import { defineConfig } from 'vite'

export default defineConfig({
  build: {
    target: ['chrome111', 'safari16.4', 'firefox128'],
  },
  server: {
    host: '127.0.0.1',
  },
})
