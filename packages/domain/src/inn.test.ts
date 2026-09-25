import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { isValidInn, normalizeInn } from './inn.ts'

describe('ИНН', () => {
  it('все ИНН демо-данных проходят контрольную цифру', () => {
    const seed = JSON.parse(readFileSync(new URL('../../../seed/plant-seed.json', import.meta.url), 'utf8'))
    for (const o of [seed.shipper, ...seed.counterparties, ...seed.carriers]) expect(isValidInn(o.inn), o.inn).toBe(true)
  })

  it('ошибка в одной цифре ловится', () => {
    expect(isValidInn('9782242515')).toBe(false)
  })

  it('ИНН ИП из 12 цифр', () => {
    expect(isValidInn('500100732259')).toBe(true)
    expect(isValidInn('500100732258')).toBe(false)
  })

  it('пробелы и дефисы убираем, мусор отбрасываем', () => {
    expect(normalizeInn(' 978-224 2514 ')).toBe('9782242514')
    expect(normalizeInn('12345')).toBeNull()
  })
})

describe('госномер', async () => {
  const { normalizePlate } = await import('./plate.ts')
  it('номер демо-машины в любом написании', () => {
    expect(normalizePlate('а245км116')).toBe('А245КМ116')
    expect(normalizePlate('A 245 KM 116')).toBe('А245КМ116')
    expect(normalizePlate('А245КМ16')).toBe('А245КМ16')
  })
  it('не номер — null', () => {
    expect(normalizePlate('Б245КМ116')).toBeNull()
    expect(normalizePlate('КАМАЗ')).toBeNull()
  })
})
