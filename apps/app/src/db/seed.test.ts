import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { SEED_PATH } from '../paths.ts'
import { dayShiftMs, seedRows, type PlantSeed } from './seed.ts'

const seed = JSON.parse(readFileSync(SEED_PATH, 'utf8')) as PlantSeed

describe('демо-данные', () => {
  it('день генерации сида становится сегодняшним, время суток сохраняется', () => {
    const today = new Date('2026-09-29T15:00:00Z')
    const { shipments } = seedRows(seed, today)
    const s1040 = shipments.find((s) => s.ref === 'ОТГ-2026-1040')!
    expect(s1040.plannedLoadingAt.toISOString()).toBe('2026-09-29T08:00:00.000Z') // 11:00 по Москве
    expect(dayShiftMs('2026-09-23', new Date('2026-09-23T23:59:00Z'))).toBe(0)
  })

  it('в справочнике отправитель, все получатели и перевозчики', () => {
    const { orgs } = seedRows(seed, new Date())
    expect(orgs).toHaveLength(1 + seed.counterparties.length + seed.carriers.length)
    expect(new Set(orgs.map((o) => o.inn)).size).toBe(orgs.length)
  })

  it('в отгрузках нет перевозчика, машины и водителя (решение 24.09)', () => {
    const { shipments } = seedRows(seed, new Date())
    expect(shipments).toHaveLength(17)
    for (const s of shipments) {
      expect(s).not.toHaveProperty('carrierId')
      expect(s).not.toHaveProperty('driverId')
      expect(s.consigneeInn).toMatch(/^\d{10}$/)
    }
  })
})
