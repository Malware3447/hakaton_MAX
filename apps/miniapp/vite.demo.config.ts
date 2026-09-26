import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// Макет на моковых данных (npm run build:demo -w @nk/miniapp): одна страница demo.html,
// скрипты и стили потом встраиваются в неё (scripts/inline-demo.mjs), чтобы открыть её как один файл.
export default defineConfig({
  base: './',
  plugins: [react()],
  build: {
    outDir: 'dist-demo',
    emptyOutDir: true,
    assetsInlineLimit: 100_000_000,
    cssCodeSplit: false,
    rollupOptions: { input: 'demo.html', output: { inlineDynamicImports: true } },
  },
})
