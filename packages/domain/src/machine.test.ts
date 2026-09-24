import { describe, expect, it } from 'vitest'
import type { Actor, Command, CommandPayloads, CommandType, PepEvidence } from './commands.ts'
import type { Role, State } from './enums.ts'
import { decide, type Decision, type ShipmentSnapshot } from './machine.ts'

const evidence: PepEvidence = {
  maxUserId: 42,
  phoneSha256: 'ab'.repeat(32),
  callbackId: 'cb-1',
  messageMid: 'mid-1',
  buttonText: 'Всё верно',
  at: '2026-09-29T10:00:00+03:00',
}

const snap = (state: State, extra: Partial<ShipmentSnapshot> = {}): ShipmentSnapshot => ({
  state,
  carrierOrgId: null,
  vehicleId: null,
  driverPersonId: null,
  operatorDocId: null,
  ...extra,
})

const cmd = <T extends CommandType>(type: T, payload: CommandPayloads[T]) => ({ type, shipmentId: 's-1', payload }) as Command
const person = (role: Role): Actor => ({ kind: 'person', personId: `p-${role}`, role })
const operator: Actor = { kind: 'operator' }

function ok(d: Decision) {
  if (!d.ok) throw new Error(`ожидали успех, получили ${d.code}: ${d.message}`)
  return d
}
function err(d: Decision) {
  if (d.ok) throw new Error(`ожидали отказ, получили переход в ${d.to}`)
  return d
}

// Основной путь ОТГ-2026-1040: кто, что и куда ведёт
const MAIN_PATH: [State, Command, Actor, State][] = [
  ['draft', cmd('shipper.offerCarrier', { carrier: { personId: 'p-carrier' }, carrierOrgId: 'org-gruzline' }), person('shipper'), 'offered'],
  ['offered', cmd('carrier.accept', {}), person('carrier'), 'carrier_accepted'],
  ['carrier_accepted', cmd('carrier.assign', { vehicleId: 'veh-1', driver: { personId: 'p-driver' } }), person('carrier'), 'assigned'],
  ['assigned', cmd('driver.acceptTrip', {}), person('driver'), 'trip_accepted'],
  ['trip_accepted', cmd('driver.arrivedLoading', {}), person('driver'), 'loading'],
  ['loading', cmd('driver.confirmLoading', { remarks: null, evidence }), person('driver'), 'loaded'],
  ['loaded', cmd('shipper.signT1', { signatureId: 'sig-1' }), person('shipper'), 't1_signed'],
  ['t1_signed', cmd('carrier.signT2', { signatureId: 'sig-2' }), person('carrier'), 'registering'],
  ['registering', cmd('operator.registered', { operatorDocId: 'op-1', uid: 'UID-1' }), operator, 'in_transit'],
  ['in_transit', cmd('driver.arrivedUnloading', {}), person('driver'), 'unloading'],
  ['unloading', cmd('driver.confirmDelivered', { remarks: null, evidence }), person('driver'), 'receiving'],
  ['receiving', cmd('consignee.recordAcceptance', { result: 'full', discrepancies: null, evidence }), person('consignee'), 'received'],
  ['received', cmd('consignee.signT3', { signatureId: 'sig-3' }), person('consignee'), 't3_signed'],
  ['t3_signed', cmd('carrier.signT4', { signatureId: 'sig-4' }), person('carrier'), 'closed'],
]

describe('основной путь', () => {
  it.each(MAIN_PATH)('%s → %s', (from, command, actor, to) => {
    const d = ok(decide(snap(from), command, actor))
    expect(d.to).toBe(to)
  })

  it('чей ход после каждого шага', () => {
    const turns = MAIN_PATH.map(([from, c, a]) => ok(decide(snap(from), c, a)).turn)
    expect(turns).toEqual([
      'carrier', 'carrier', 'driver', 'driver', 'driver', 'shipper', 'carrier', null,
      'driver', 'driver', 'consignee', 'consignee', 'carrier', null,
    ])
  })
})

describe('права и состояние', () => {
  it('чужая роль не может нажать чужую кнопку', () => {
    expect(err(decide(snap('loaded'), cmd('shipper.signT1', { signatureId: 's' }), person('driver'))).code).toBe('wrong_role')
  })

  it('человек не может выдать себя за оператора', () => {
    const d = decide(snap('registering'), cmd('operator.registered', { operatorDocId: 'op-1', uid: 'U' }), person('carrier'))
    expect(err(d).code).toBe('wrong_actor')
  })

  it('оператор не выполняет команды людей', () => {
    expect(err(decide(snap('offered'), cmd('carrier.accept', {}), operator)).code).toBe('wrong_actor')
  })

  it('повторное нажатие — «уже сделано», а не ошибка', () => {
    expect(err(decide(snap('trip_accepted'), cmd('driver.acceptTrip', {}), person('driver'))).code).toBe('already_done')
  })

  it('действие не в своё время', () => {
    expect(err(decide(snap('draft'), cmd('driver.arrivedLoading', {}), person('driver'))).code).toBe('wrong_state')
  })

  it('после подписи Т1 отменить нельзя, до — можно', () => {
    expect(err(decide(snap('t1_signed'), cmd('shipper.cancel', { reason: null }), person('shipper'))).code).toBe('wrong_state')
    const d = ok(decide(snap('loaded'), cmd('shipper.cancel', { reason: null }), person('shipper')))
    expect(d.to).toBe('cancelled')
    expect(d.turn).toBeNull()
    expect(d.effects).toContainEqual({ kind: 'erpWriteBack', status: 'cancelled' })
  })
})

describe('ветки MVP', () => {
  it('перевозчик отклонил заявку — снова ход отправителя, перевозчик снят', () => {
    const d = ok(decide(snap('offered', { carrierOrgId: 'org-1' }), cmd('carrier.decline', { reason: 'нет машин' }), person('carrier')))
    expect(d.to).toBe('draft')
    expect(d.turn).toBe('shipper')
    expect(d.patch.carrierOrgId).toBeNull()
  })

  it('отказ без причины не принимаем', () => {
    expect(err(decide(snap('offered'), cmd('carrier.decline', { reason: '  ' }), person('carrier'))).code).toBe('invalid_payload')
  })

  it('водитель отказался от рейса — перевозчик назначает другого', () => {
    const d = ok(decide(snap('trip_accepted', { driverPersonId: 'p-driver' }), cmd('driver.declineTrip', { reason: 'сломалась машина' }), person('driver')))
    expect(d.to).toBe('carrier_accepted')
    expect(d.turn).toBe('carrier')
    expect(d.patch.driverPersonId).toBeNull()
  })

  it('замечания на погрузке сохраняются и попадают в простую подпись к Т2', () => {
    const d = ok(decide(snap('loading'), cmd('driver.confirmLoading', { remarks: '  недостача 2 канистры ', evidence }), person('driver')))
    expect(d.patch.loadingRemarks).toBe('недостача 2 канистры')
    expect(d.effects).toContainEqual({ kind: 'recordPep', title: 'T2', role: 'driver', evidence })
  })

  it('частичная приёмка требует описать расхождения', () => {
    const bad = cmd('consignee.recordAcceptance', { result: 'partial', discrepancies: null, evidence })
    expect(err(decide(snap('receiving'), bad, person('consignee'))).code).toBe('invalid_payload')
    const good = cmd('consignee.recordAcceptance', { result: 'refused', discrepancies: 'бочка повреждена', evidence })
    const d = ok(decide(snap('receiving'), good, person('consignee')))
    expect(d.to).toBe('received')
    expect(d.patch.acceptance).toEqual({ result: 'refused', discrepancies: 'бочка повреждена' })
  })

  it('отказ оператора — перевозчик подписывает Т2 заново', () => {
    const d = ok(decide(snap('registering', { operatorDocId: 'op-1' }), cmd('operator.rejected', { operatorDocId: 'op-1', code: '400', message: 'ошибка ГИС' }), operator))
    expect(d.to).toBe('t1_signed')
    expect(d.turn).toBe('carrier')
  })

  it('ответ оператора по чужому документу не принимаем', () => {
    const d = decide(snap('registering', { operatorDocId: 'op-1' }), cmd('operator.registered', { operatorDocId: 'op-2', uid: 'U' }), operator)
    expect(err(d).code).toBe('invalid_payload')
  })
})

describe('назначение по контакту', () => {
  it('найденный водитель назначается сразу', () => {
    const d = ok(decide(snap('carrier_accepted'), cmd('carrier.assign', { vehicleId: 'veh-1', driver: { personId: 'p-ivan' } }), person('carrier')))
    expect(d.patch).toEqual({ vehicleId: 'veh-1', driverPersonId: 'p-ivan' })
    expect(d.effects).toEqual([])
  })

  it('незнакомого в боте водителя приглашаем', () => {
    const ref = { invite: { expectedMaxUserId: 777, expectedPhoneSha256: null, displayName: 'Иван' } }
    const d = ok(decide(snap('carrier_accepted'), cmd('carrier.assign', { vehicleId: 'veh-1', driver: ref }), person('carrier')))
    expect(d.patch.driverPersonId).toBeNull()
    expect(d.effects).toEqual([{ kind: 'invite', role: 'driver', ref }])
  })

  it('без аккаунта MAX назначить нельзя — бот ему не напишет', () => {
    const ref = { invite: { expectedMaxUserId: null, expectedPhoneSha256: 'x', displayName: 'Иван' } }
    const d = decide(snap('draft'), cmd('shipper.offerCarrier', { carrier: ref, carrierOrgId: null }), person('shipper'))
    expect(err(d).message).toMatch(/не пользуется MAX/)
  })

  it('без машины назначить нельзя', () => {
    const d = decide(snap('carrier_accepted'), cmd('carrier.assign', { vehicleId: '', driver: { personId: 'p' } }), person('carrier'))
    expect(err(d).code).toBe('invalid_payload')
  })
})

describe('подписи и последствия', () => {
  it('простую подпись без подтверждённого номера не принимаем', () => {
    const d = decide(snap('unloading'), cmd('driver.confirmDelivered', { remarks: null, evidence: { ...evidence, phoneSha256: '' } }), person('driver'))
    expect(err(d).message).toMatch(/Поделиться номером/)
  })

  it('каждый подписанный титул уходит оператору, Т4 закрывает учётку', () => {
    const titles = MAIN_PATH.flatMap(([from, c, a]) => ok(decide(snap(from), c, a)).effects)
      .filter((e) => e.kind === 'submitTitle')
      .map((e) => (e as { title: string }).title)
    expect(titles).toEqual(['T1', 'T2', 'T3', 'T4'])
    const last = ok(decide(snap('t3_signed'), cmd('carrier.signT4', { signatureId: 's' }), person('carrier')))
    expect(last.effects).toContainEqual({ kind: 'erpWriteBack', status: 'closed' })
  })

  it('после регистрации QR уходит водителю, получатель получает приглашение', () => {
    const d = ok(decide(snap('registering'), cmd('operator.registered', { operatorDocId: 'op-1', uid: 'UID' }), operator))
    expect(d.patch.uid).toBe('UID')
    expect(d.effects).toEqual([{ kind: 'sendQrToDriver' }, { kind: 'inviteConsignee' }])
  })
})
