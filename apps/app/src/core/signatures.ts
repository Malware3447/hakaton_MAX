import { and, desc, eq, gte, sql } from 'drizzle-orm'
import { allowedCommands, type CommandType, type Role, type SignatureKind, type TitleKind } from '@nk/domain'
import type { Db } from '../db/client.ts'
import { shipment, signature } from '../db/schema.ts'

// Подписи титулов (HAKATON-36, HAKATON-41). Проверку подписи «Госключа» делает модуль Егора
// (packages/etrn, verifyGoskeySignature) — здесь только стык под его вход и выход.

/** Команда, которую двигает подпись титула: пока она разрешена, перевозка ждёт эту подпись. */
const SIGN_COMMAND: Record<TitleKind, CommandType> = { T1: 'shipper.signT1', T2: 'carrier.signT2', T3: 'consignee.signT3', T4: 'carrier.signT4' }

/**
 * Подпись не записана: перевозка её сейчас не ждёт. already — эта сторона титул уже подписала
 * (второе нажатие «Демо-подпись», ответ «Госключа» прислали ещё раз), иначе — подписывать ещё рано.
 */
export class SignatureNotAwaited extends Error {
  constructor(readonly already: boolean) {
    super(already ? 'титул уже подписан' : 'перевозка сейчас не ждёт этой подписи')
  }
}

export interface SignatureCheck {
  name: string
  ok: boolean
  /** причина по-русски — показываем человеку */
  message: string
}

export interface SignatureVerification {
  ok: boolean
  level: 'unep' | 'ukep' | null
  signer: { fullName: string | null; inn: string | null; snils: string | null; personInn?: string | null; certificate: string } | null
  checks: SignatureCheck[]
}

/** Проверка присланного .sig. Реализация — адаптер к verifyGoskeySignature с хранилищем корней УЦ. */
export interface SignatureVerifier {
  verify(input: {
    /** наш XML титула, ровно те байты, что отправили подписанту */
    document: Uint8Array
    sig: Uint8Array
    /** ИНН стороны, которая подписывает титул */
    expectedInn: string
    /** ИНН, который человек назвал при подключении компании; для УНЭП в сертификате ИНН нет */
    declaredInn: string | null
    /** когда титул отправили на подпись: подпись раньше — чужая */
    sentAt: Date | null
  }): Promise<SignatureVerification>
}

export class SignatureService {
  constructor(private readonly db: Db) {}

  /**
   * Записать подпись титула — одну на сторону, пока перевозка её ждёт (находка 29.09). Вторая подпись
   * того же титула ломала сцепку: следующий титул берёт последнюю подпись, а оператору ЭПД уже ушла
   * первая — перевозка навсегда оставалась в регистрации. Проверка и запись — одной транзакцией под
   * блокировкой строки перевозки, как в ShipmentService.execute: одновременные нажатия (обновления
   * вебхука обрабатываются параллельно) идут по очереди.
   *
   * Сторона уже подписала титул в этом состоянии перевозки, а её команда ещё не прошла (второе нажатие,
   * повтор после сбоя), — вернёт id той подписи, новую не пишет. Перевозка подписи не ждёт — SignatureNotAwaited.
   */
  async record(input: {
    shipmentId: string
    titleId: string
    titleKind: TitleKind
    role: Role
    kind: SignatureKind
    personId: string
    cms: Uint8Array | null
    signerName: string | null
    signerSnils: string | null
    verified: boolean
    verifyResult: string
  }): Promise<string> {
    return this.db.transaction(async (tx) => {
      const [s] = await tx.select({ state: shipment.state }).from(shipment).where(eq(shipment.id, input.shipmentId)).for('update')
      const same = and(eq(signature.titleId, input.titleId), eq(signature.role, input.role), eq(signature.verified, true))
      if (!s || !allowedCommands(s.state, input.role).includes(SIGN_COMMAND[input.titleKind])) {
        const [done] = await tx.select({ id: signature.id }).from(signature).where(same).limit(1)
        throw new SignatureNotAwaited(Boolean(done))
      }
      // Подпись этого круга — с тех пор, как перевозка пришла в это состояние (turn_since): после отказа
      // оператора перевозчик подписывает Т2 заново, и это новая подпись, а не повтор
      const [earlier] = await tx
        .select({ id: signature.id })
        .from(signature)
        .innerJoin(shipment, eq(shipment.id, signature.shipmentId))
        .where(and(same, gte(signature.createdAt, shipment.turnSince)))
        .orderBy(desc(signature.createdAt))
        .limit(1)
      if (earlier) return earlier.id

      const [row] = await tx
        .insert(signature)
        .values({
          shipmentId: input.shipmentId,
          titleId: input.titleId,
          titleKind: input.titleKind,
          role: input.role,
          kind: input.kind,
          signerPersonId: input.personId,
          cms: input.cms ? Buffer.from(input.cms) : null,
          signerName: input.signerName,
          signerSnils: input.signerSnils,
          verified: input.verified,
          verifyResult: input.verifyResult,
          // Время записи, а не начала транзакции: сравниваем с turn_since, которое поставил переход до блокировки
          createdAt: sql`clock_timestamp()`,
        })
        .returning({ id: signature.id })
      return row!.id
    })
  }
}
