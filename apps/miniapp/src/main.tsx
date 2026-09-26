import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { MaxUI } from '@maxhub/max-ui'
import '@maxhub/max-ui/styles.css'
import './styles.css'
import { App } from './App.tsx'

// Тема и платформа — как у устройства: MaxUI сам читает prefers-color-scheme и iOS/Android
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <MaxUI resetBody>
      <App />
    </MaxUI>
  </StrictMode>,
)
