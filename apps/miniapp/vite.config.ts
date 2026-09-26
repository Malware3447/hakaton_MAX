import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// Мини-приложение отдаёт тот же сервер, что и бот: сборка по /app, API по /api.
// В разработке Vite проксирует /api на локальный сервер (PORT из .env, по умолчанию dev-бот на 3100).
export default defineConfig({
  base: '/app/',
  plugins: [react()],
  server: {
    port: 5173,
    proxy: { '/api': `http://127.0.0.1:${process.env.API_PORT ?? 3100}` },
  },
  build: { outDir: 'dist', emptyOutDir: true },
})
