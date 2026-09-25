// Лимиты MAX Bot API: не больше 30 запросов в секунду всего и 2 сообщений в секунду в один диалог.
// Процесс у нас один, поэтому хватает ограничителя в памяти: скользящее окно в одну секунду.

const WINDOW_MS = 1000

export class RateLimiter {
  private readonly global: number[] = []
  private readonly perKey = new Map<string, number[]>()

  constructor(
    private readonly globalPerSecond = 30,
    private readonly keyPerSecond = 2,
    private readonly now = () => Date.now(),
    private readonly sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
  ) {}

  /** Дождаться права на запрос. key — диалог (user_id); без key учитывается только общий лимит. */
  async acquire(key?: string): Promise<void> {
    for (;;) {
      const t = this.now()
      const g = prune(this.global, t)
      const k = key ? prune(this.perKey.get(key) ?? [], t) : null
      const waitG = g.length >= this.globalPerSecond ? g[0]! + WINDOW_MS - t : 0
      const waitK = k && k.length >= this.keyPerSecond ? k[0]! + WINDOW_MS - t : 0
      const wait = Math.max(waitG, waitK)
      if (wait <= 0) {
        g.push(t)
        if (key && k) {
          k.push(t)
          this.perKey.set(key, k)
        }
        return
      }
      await this.sleep(wait)
    }
  }
}

function prune(arr: number[], t: number): number[] {
  while (arr.length && arr[0]! <= t - WINDOW_MS) arr.shift()
  return arr
}
