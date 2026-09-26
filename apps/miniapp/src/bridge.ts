// MAX Bridge (dev.max.ru/docs/webapps/bridge): скрипт st.max.ru/js/max-web-app.js кладёт window.WebApp.
// Вне MAX (обычный браузер) объекта нет или initData пустой — тогда приложение просит открыть его из бота.

interface WebAppBackButton {
  show(): void
  hide(): void
  onClick(cb: () => void): void
  offClick(cb: () => void): void
}

interface WebApp {
  initData: string
  initDataUnsafe: { start_param?: string }
  platform: 'ios' | 'android' | 'desktop' | 'web'
  ready?(): void
  close?(): void
  openMaxLink?(url: string): void
  BackButton?: WebAppBackButton
  enableClosingConfirmation?(): void
  disableClosingConfirmation?(): void
  requestScreenMaxBrightness?(): void
  restoreScreenBrightness?(): void
  downloadFile?(url: string, fileName: string): void
}

declare global {
  interface Window {
    WebApp?: WebApp
  }
}

export const webApp: WebApp | null = typeof window !== 'undefined' && window.WebApp?.initData ? window.WebApp : null

/** Закрыть мини-приложение и вернуть человека в чат с ботом. */
export function closeApp() {
  webApp?.close?.()
}
