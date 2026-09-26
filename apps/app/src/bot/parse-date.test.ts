import { describe, expect, it } from 'vitest'
import { parseRuDate } from './bot.ts'

describe('дата доверенности ДД.ММ.ГГГГ', () => {
  it('настоящая дата — конец дня по Москве', () => {
    expect(parseRuDate('31.10.2026')?.toISOString()).toBe('2026-10-31T20:59:59.000Z')
    expect(parseRuDate(' 1.3.2027 ')?.toISOString()).toBe('2027-03-01T20:59:59.000Z')
    expect(parseRuDate('29.02.2028')).not.toBeNull()
  })

  it('несуществующая дата не принимается и не «переносится» (находка 26.09)', () => {
    for (const s of ['11.20.2027', '31.02.2027', '29.02.2027', '00.05.2027', '32.01.2027', '15.00.2027', '10.10.1999', '2027-10-10', '10.10.27']) {
      expect(parseRuDate(s), s).toBeNull()
    }
  })
})
