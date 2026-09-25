import type { Role, SignatureKind, TitleKind } from '@nk/domain'
import type { Db } from '../db/client.ts'
import { signature } from '../db/schema.ts'

// Подписи титулов (HAKATON-36, HAKATON-41). Проверку подписи «Госключа» делает модуль Егора
// (packages/etrn, verifyGoskeySignature) — здесь только стык под его вход и выход.

export interface SignatureCheck {
  name: string
  ok: boolean
  /** причина по-русски — показываем человеку */
  message: string
}

export interface SignatureVerification {
  ok: boolean
  level: 'unep' | 'ukep' | null
  signer: { fullName: string | null; inn: string | null; snils: string | null; certificate: string } | null
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
    const [row] = await this.db
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
      })
      .returning({ id: signature.id })
    return row!.id
  }
}
