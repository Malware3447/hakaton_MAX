import { describe, expect, it } from 'vitest'
import { RateLimiter } from './limiter.ts'

describe('лимиты MAX', () => {
  it('в один диалог не больше 2 сообщений в секунду, в разные — без ожидания', async () => {
    let t = 0
    const waits: number[] = []
    const lim = new RateLimiter(30, 2, () => t, async (ms) => {
      waits.push(ms)
      t += ms
    })
    await lim.acquire('u1')
    await lim.acquire('u1')
    await lim.acquire('u2')
    expect(waits).toEqual([])
    await lim.acquire('u1')
    expect(waits).toEqual([1000])
  })

  it('общий лимит 30 в секунду', async () => {
    let t = 0
    const lim = new RateLimiter(30, 2, () => t, async (ms) => {
      t += ms
    })
    for (let i = 0; i < 31; i++) await lim.acquire(`u${i}`)
    expect(t).toBe(1000)
  })
})
