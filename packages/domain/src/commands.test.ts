import { describe, expect, it } from 'vitest'
import { TRANSITIONS, TURN_BY_STATE, allowedCommands } from './commands.ts'
import { STATES, type State } from './enums.ts'

// Проверки самой таблицы переходов. Поведение decide() — в тестах HAKATON-22.

describe('таблица переходов', () => {
  it('основной путь ведёт из draft в closed', () => {
    const skip = new Set(['carrier.decline', 'driver.declineTrip', 'operator.rejected', 'shipper.cancel'])
    let state: State = 'draft'
    const path: State[] = [state]
    while (state !== 'closed') {
      const next = TRANSITIONS.find((t) => t.from.includes(state) && !skip.has(t.command))
      expect(next, `нет перехода из ${state}`).toBeDefined()
      state = next!.to
      path.push(state)
    }
    expect(path).toHaveLength(15)
  })

  it('у каждого состояния задан чей ход', () => {
    for (const s of STATES) expect(TURN_BY_STATE).toHaveProperty(s)
  })

  it('кнопки роли совпадают с тем, чей ход', () => {
    for (const s of STATES) {
      const turn = TURN_BY_STATE[s]
      if (!turn) continue
      expect(allowedCommands(s, turn).length, `у ${turn} нет действий в ${s}`).toBeGreaterThan(0)
    }
  })

  it('после подписи Т1 отмена невозможна', () => {
    expect(allowedCommands('t1_signed', 'shipper')).not.toContain('shipper.cancel')
    expect(allowedCommands('loaded', 'shipper')).toContain('shipper.cancel')
  })
})
