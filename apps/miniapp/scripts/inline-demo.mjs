// Встраивает собранные скрипт и стили в dist-demo/demo.html → dist-demo/nakladnaya-maket.html
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const dir = new URL('../dist-demo/', import.meta.url).pathname
let html = readFileSync(join(dir, 'demo.html'), 'utf8')
html = html.replace(/<link rel="stylesheet"[^>]*href="\.\/([^"]+)"[^>]*>/g, (_, f) => `<style>${readFileSync(join(dir, f), 'utf8')}</style>`)
html = html.replace(/<script type="module"[^>]*src="\.\/([^"]+)"[^>]*><\/script>/g, (_, f) => {
  const js = readFileSync(join(dir, f), 'utf8').replace(/<\/script/g, '<\\/script')
  return `<script type="module">${js}</script>`
})
writeFileSync(join(dir, 'nakladnaya-maket.html'), html)
console.log('nakladnaya-maket.html', Math.round(html.length / 1024), 'КБ')
