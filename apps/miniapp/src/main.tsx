import { StrictMode, useEffect } from 'react'
import { createRoot } from 'react-dom/client'
import { MaxUI, useAppearance } from '@maxhub/max-ui'
import '@maxhub/max-ui/styles.css'
import './styles.css'
import { App } from './App.tsx'

/**
 * Фон всей страницы — цветом темы. Токены MAX UI живут на обёртке MaxUI, до body они не достают:
 * без этого в тёмной теме под коротким экраном и при оттягивании списка видна белая страница.
 */
function PageTheme() {
  const { colorScheme } = useAppearance()
  useEffect(() => {
    const paint = () => {
      const root = document.querySelector('.app-root')
      if (!root) return
      const bg = getComputedStyle(root).backgroundColor
      document.documentElement.style.backgroundColor = bg
      document.body.style.backgroundColor = bg
      document.documentElement.style.colorScheme = colorScheme
    }
    paint()
    // Стили могли ещё грузиться — перекрасить, когда страница загружена
    window.addEventListener('load', paint, { once: true })
    return () => window.removeEventListener('load', paint)
  }, [colorScheme])
  return null
}

// Тема и платформа — как у устройства: MaxUI сам читает prefers-color-scheme и iOS/Android
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <MaxUI resetBody className="app-root">
      <PageTheme />
      <App />
    </MaxUI>
  </StrictMode>,
)
