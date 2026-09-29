import { describe, expect, it } from 'vitest'
import { FNS_POA_URL, FnsPoaRegistry, REGISTRY_TTL_MS, statusFromText } from './fns-poa-registry.ts'

const NUM = '4f1c2d3e-5a6b-4c7d-8e9f-0a1b2c3d4e5f'
const silent = { warn: () => {}, info: () => {} }

const reply = (status: number, body: unknown, seen?: { url?: string; init?: RequestInit; calls: number }) =>
  (async (url: string, init?: RequestInit) => {
    if (seen) Object.assign(seen, { url, init, calls: seen.calls + 1 })
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status })
  }) as unknown as typeof fetch

describe('реестр МЧД ФНС: статус по номеру', () => {
  it('запрос как у страницы «Проверить МЧД»: номер в dovelGuid, ключ в заголовке ApiKey', async () => {
    const seen = { calls: 0 } as { url?: string; init?: RequestInit; calls: number }
    const r = new FnsPoaRegistry({ apiKey: 'K' }, silent, reply(200, { status: 'Действительна' }, seen))
    expect(await r.status(NUM.toUpperCase())).toBe('active')
    expect(seen.url).toBe(`${FNS_POA_URL}?dovelGuid=${NUM}`)
    expect((seen.init!.headers as Record<string, string>).ApiKey).toBe('K')
  })

  it.each([
    [{ status: 'Действительна' }, 'active'],
    [{ data: { poaStatus: 'ACTIVE' } }, 'active'],
    [{ result: [{ statusName: 'Отозвана доверителем' }] }, 'revoked'],
    [{ state: 'Недействительна' }, 'revoked'],
    [{ status: 'Истек срок действия' }, 'expired'],
    [{ status: 'EXPIRED' }, 'expired'],
    [{ status: 'Доверенность не найдена' }, 'not_found'],
  ])('ответ %j → %s', async (body, want) => {
    expect(await new FnsPoaRegistry({}, silent, reply(200, body)).status(NUM)).toBe(want)
  })

  it('404 с русским текстом про доверенность — «не найдена»', async () => {
    expect(await new FnsPoaRegistry({}, silent, reply(404, { message: 'Доверенность не найдена' })).status(NUM)).toBe('not_found')
  })

  it.each([
    ['404 шлюза', 404, { timestamp: 1, status: 404, error: 'Not Found', path: '/api/v1/x' }],
    ['страница вместо JSON', 200, '<html>Проверка статуса</html>'],
    ['нет ключа', 401, { message: 'Api Key was not provided' }],
    ['ошибка сервера', 502, 'Bad Gateway'],
    ['непонятный статус', 200, { status: 'XYZ' }],
    ['статуса нет', 200, { guid: NUM }],
  ])('%s — «реестр недоступен», подпись не блокируем', async (_n, code, body) => {
    const warns: unknown[] = []
    const r = new FnsPoaRegistry({}, { ...silent, warn: (o: unknown) => warns.push(o) }, reply(code, body))
    expect(await r.status(NUM)).toBe('unavailable')
    expect(warns).toHaveLength(1)
  })

  it('нет связи или таймаут — «недоступен», и 5 минут реестр не дёргаем', async () => {
    let t = 0
    let calls = 0
    const down = (async () => {
      calls++
      throw new TypeError('fetch failed')
    }) as unknown as typeof fetch
    const r = new FnsPoaRegistry({}, silent, down, () => t)
    expect(await r.status(NUM)).toBe('unavailable')
    t += REGISTRY_TTL_MS.outage - 1
    expect(await r.status(NUM)).toBe('unavailable')
    expect(calls).toBe(1)
    t += 2
    await r.status(NUM)
    expect(calls).toBe(2)
  })

  it('настоящий таймаут обрывает запрос', async () => {
    const hang = ((_u: string, init?: RequestInit) =>
      new Promise((_, rej) => init!.signal!.addEventListener('abort', () => rej(init!.signal!.reason)))) as unknown as typeof fetch
    expect(await new FnsPoaRegistry({ timeoutMs: 50 }, silent, hang).status(NUM)).toBe('unavailable')
  })

  it('ответ помним 10 минут, потом спрашиваем снова', async () => {
    let t = 0
    const seen = { calls: 0 }
    const r = new FnsPoaRegistry({}, silent, reply(200, { status: 'Действительна' }, seen), () => t)
    await r.status(NUM)
    await r.status(NUM)
    expect(seen.calls).toBe(1)
    t += REGISTRY_TTL_MS.answer
    await r.status(NUM)
    expect(seen.calls).toBe(2)
  })

  it('«недействительна» не путаем с «действительна»', () => {
    expect(statusFromText('Недействительна')).toBe('revoked')
    expect(statusFromText('Действительна')).toBe('active')
    expect(statusFromText('что-то')).toBeNull()
  })
})
