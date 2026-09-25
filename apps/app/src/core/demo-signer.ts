import { eq } from 'drizzle-orm'
import type { Role, SignatureProvider, SignatureRecord, SignRequest, TitleKind } from '@nk/domain'
import type { DemoCa } from '@nk/etrn'
import type { Db } from '../db/client.ts'
import { person, title } from '../db/schema.ts'
import type { ShipmentService } from './shipments.ts'
import type { SignatureService } from './signatures.ts'
import type { TitleService } from './titles.ts'

// Демо-подпись организации (HAKATON-36), модель: для тех, у кого нет «Госключа».
// Подписываем ровно байты титула сертификатом демо-УЦ на ИНН стороны, проверяем своей же проверкой
// и сохраняем настоящую CMS — её base64 встаёт в атрибут ЭП следующего титула.

export class DemoSignError extends Error {}

export class DemoCaSigner implements SignatureProvider {
  readonly kind = 'demo_ca' as const

  constructor(
    private readonly db: Db,
    private readonly ca: DemoCa,
    private readonly shipments: ShipmentService,
    private readonly titles: TitleService,
    private readonly signatures: SignatureService,
  ) {}

  /** Собрать титул; человеку делать ничего не нужно — подпись сразу. Бросает TitleError. */
  async request(shipmentId: string, kind: TitleKind): Promise<SignRequest> {
    const t = await this.titles.ensure(shipmentId, kind)
    return { titleId: t.id, kind: this.kind, userAction: 'none' }
  }

  /** Подписать титул от имени организации стороны role, проверить и записать. cms не нужен: подписываем сами. */
  async accept(titleId: string, signerPersonId: string, role: Role): Promise<SignatureRecord> {
    const [t] = await this.db.select().from(title).where(eq(title.id, titleId))
    if (!t) throw new DemoSignError('титул не найден')
    const view = await this.shipments.view(t.shipmentId, role)
    const org = ({ shipper: view?.shipper, carrier: view?.carrier, consignee: view?.consignee, driver: null } as const)[role]
    if (!org) throw new DemoSignError('не знаем организацию подписанта')

    const document = new Uint8Array(t.xml)
    const cms = await this.ca.sign(document, { inn: org.inn, name: org.name })
    const res = await this.ca.verify({ document, sig: cms, expectedInn: org.inn })
    if (!res.ok) throw new DemoSignError(`демо-подпись не прошла проверку: ${res.checks.filter((c) => !c.ok).map((c) => c.message).join('; ')}`)

    const [p] = await this.db.select({ name: person.name }).from(person).where(eq(person.id, signerPersonId))
    const signerName = p?.name ?? null
    const id = await this.signatures.record({
      shipmentId: t.shipmentId,
      titleId,
      titleKind: t.kind,
      role,
      kind: this.kind,
      personId: signerPersonId,
      cms,
      signerName,
      signerSnils: null,
      verified: true,
      verifyResult: `Демо-подпись (модель) от имени ${org.name}, ИНН ${org.inn}: ${res.checks.map((c) => `${c.name} ok`).join(', ')}`,
    })
    return { id, titleId, role, kind: this.kind, signerName, verified: true }
  }
}
