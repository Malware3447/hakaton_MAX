import type { FastifyBaseLogger } from 'fastify'
import type { MaxApi } from './api.ts'
import type { MaxUpdate } from './types.ts'

/** Long polling: забираем обновления по одному запросу, обрабатываем по очереди. */
export function startPolling(api: MaxApi, handle: (u: MaxUpdate) => Promise<void>, log: FastifyBaseLogger) {
  let marker: number | undefined
  let stopped = false
  const loop = async () => {
    while (!stopped) {
      try {
        const { updates, marker: next } = await api.getUpdates(marker)
        if (next !== undefined) marker = next
        for (const u of updates) {
          try {
            await handle(u)
          } catch (e) {
            log.error({ err: e, type: u.update_type }, 'ошибка обработки обновления')
          }
        }
      } catch (e) {
        if (stopped) break
        log.warn({ err: e }, 'getUpdates не удался, повтор через 3 с')
        await new Promise((r) => setTimeout(r, 3000))
      }
    }
  }
  void loop()
  return () => {
    stopped = true
  }
}
