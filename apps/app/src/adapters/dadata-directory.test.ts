import { describe, expect, it } from 'vitest'
import type { OrgDirectory } from '@nk/domain'
import { ChainDirectory, DadataDirectory, russianQuotes } from './dadata-directory.ts'

const silent = { warn: () => {} }

/** Ответ DaData в формате из документации dadata.ru/api/find-party. */
const party = (over: Record<string, unknown> = {}) => ({
  suggestions: [
    {
      value: 'ООО "МОТОРИКА"',
      data: {
        inn: '7719402047',
        kpp: '772301001',
        ogrn: '1157746078984',
        type: 'LEGAL',
        name: { short_with_opf: 'ООО "МОТОРИКА"', full_with_opf: 'ОБЩЕСТВО С ОГРАНИЧЕННОЙ ОТВЕТСТВЕННОСТЬЮ "МОТОРИКА"' },
        address: { value: 'г Москва, Походный проезд, домовладение 3, стр 2', unrestricted_value: '125373, г Москва, Походный проезд, домовладение 3, стр 2' },
        state: { status: 'ACTIVE' },
        ...over,
      },
    },
  ],
})

const fakeFetch = (status: number, body: unknown, seen?: { init?: RequestInit }) =>
  (async (_url: string, init?: RequestInit) => {
    if (seen) seen.init = init
    return new Response(JSON.stringify(body), { status })
  }) as unknown as typeof fetch

describe('DaData: компания по ИНН', () => {
  it('реквизиты из ответа: название в «ёлочках», КПП, ОГРН, адрес с индексом', async () => {
    const seen: { init?: RequestInit } = {}
    const d = new DadataDirectory('KEY', silent, fakeFetch(200, party(), seen))
    expect(await d.findByInn('7719402047')).toEqual({
      inn: '7719402047',
      kpp: '772301001',
      name: 'ООО «МОТОРИКА»',
      address: '125373, г Москва, Походный проезд, домовладение 3, стр 2',
      source: 'dadata',
      ogrn: '1157746078984',
      status: 'active',
    })
    expect((seen.init!.headers as Record<string, string>).Authorization).toBe('Token KEY')
    expect(JSON.parse(String(seen.init!.body))).toEqual({ query: '7719402047', branch_type: 'MAIN' })
  })

  it('статус ликвидации передаётся дальше', async () => {
    const d = new DadataDirectory('KEY', silent, fakeFetch(200, party({ state: { status: 'LIQUIDATED' } })))
    expect((await d.findByInn('7719402047'))?.status).toBe('liquidated')
  })

  it('не нашли, 401 без ключа, сеть упала — «не нашли», а не ошибка', async () => {
    expect(await new DadataDirectory('KEY', silent, fakeFetch(200, { suggestions: [] })).findByInn('7719402047')).toBeNull()
    expect(await new DadataDirectory('BAD', silent, fakeFetch(401, {})).findByInn('7719402047')).toBeNull()
    const broken = (async () => {
      throw new Error('ECONNRESET')
    }) as unknown as typeof fetch
    expect(await new DadataDirectory('KEY', silent, broken).findByInn('7719402047')).toBeNull()
  })

  it('кавычки: только парные меняем на «ёлочки»', () => {
    expect(russianQuotes('ПАО "СБЕРБАНК РОССИИ"')).toBe('ПАО «СБЕРБАНК РОССИИ»')
  })
})

describe('цепочка справочников', () => {
  it('первый нашедший отвечает: демо-данные раньше DaData', async () => {
    const calls: string[] = []
    const one = (name: string, found: boolean): OrgDirectory => ({
      async findByInn(inn) {
        calls.push(name)
        return found ? { inn, kpp: null, name, address: '', source: name === 'demo' ? 'demo' : 'dadata' } : null
      },
    })
    const chain = new ChainDirectory([one('demo', true), one('dadata', true)])
    expect((await chain.findByInn('1'))?.name).toBe('demo')
    expect(calls).toEqual(['demo'])
    expect((await new ChainDirectory([one('demo', false), one('dadata', true)]).findByInn('1'))?.name).toBe('dadata')
  })
})
