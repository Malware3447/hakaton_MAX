import { and, desc, eq, inArray } from 'drizzle-orm'
import type { Role, TitleKind } from '@nk/domain'
import { buildT1, buildT2, buildT3, buildT4, splitName, type Party, type PrevTitle, type TitleFile } from '@nk/etrn'
import type { Db } from '../db/client.ts'
import { event, org, participant, person, shipment, signature, title, vehicle } from '../db/schema.ts'

// Титулы перевозки (HAKATON-35): собрать XML из данных перевозки и хранить байты.
// Собранный титул не пересобираем: подписывают и проверяют ровно те байты, что лежат в title.xml.

/** Идентификатор оператора ЭПД в имени файла — у нас модель оператора. */
export const OPERATOR_ID = '2DM-DEMO-OPER'
const participantId = (inn: string) => `2DM-${inn}`

/** Код тары по ОКВГУМ. TODO: сверить коды канистры и бочки с классификатором; пока одна заглушка. */
const PACKAGE_CODE = 'CN'

export interface StoredTitle {
  id: string
  kind: TitleKind
  fileId: string
  bytes: Uint8Array
  sha256: string
  createdAt: Date
}

export class TitleError extends Error {}

export class TitleService {
  constructor(private readonly db: Db) {}

  async get(shipmentId: string, kind: TitleKind): Promise<StoredTitle | null> {
    const [t] = await this.db.select().from(title).where(and(eq(title.shipmentId, shipmentId), eq(title.kind, kind)))
    return t ? { id: t.id, kind: t.kind, fileId: t.idFile, bytes: new Uint8Array(t.xml), sha256: t.sha256, createdAt: t.createdAt } : null
  }

  /** Титул перевозки: уже собранный — как есть, иначе собрать и сохранить. */
  async ensure(shipmentId: string, kind: TitleKind): Promise<StoredTitle> {
    const existing = await this.get(shipmentId, kind)
    if (existing) return existing
    const build = { T1: () => this.buildT1(shipmentId), T2: () => this.buildT2(shipmentId), T3: () => this.buildT3(shipmentId), T4: () => this.buildT4(shipmentId) }[kind]
    const file = await build()
    const prevKind = ({ T1: null, T2: 'T1', T3: 'T2', T4: 'T3' } as const)[kind]
    const prev = prevKind ? await this.get(shipmentId, prevKind) : null
    await this.db
      .insert(title)
      .values({ shipmentId, kind, idFile: file.fileId, xml: Buffer.from(file.bytes), sha256: file.sha256, prevTitleId: prev?.id ?? null })
      .onConflictDoNothing()
    return (await this.get(shipmentId, kind))!
  }

  // ---------- сбор данных ----------

  private async who(shipmentId: string, role: Role) {
    const [row] = await this.db
      .select({ p: person })
      .from(participant)
      .innerJoin(person, eq(person.id, participant.personId))
      .where(and(eq(participant.shipmentId, shipmentId), eq(participant.role, role)))
    return row?.p ?? null
  }

  private async eventAt(shipmentId: string, type: string): Promise<Date | null> {
    const [e] = await this.db
      .select({ at: event.at })
      .from(event)
      .where(and(eq(event.shipmentId, shipmentId), eq(event.type, type)))
      .orderBy(desc(event.at))
      .limit(1)
    return e?.at ?? null
  }

  private async buildT1(shipmentId: string): Promise<TitleFile> {
    const [s] = await this.db.select().from(shipment).where(eq(shipment.id, shipmentId))
    if (!s) throw new TitleError('перевозка не найдена')
    if (!s.carrierOrgId || !s.vehicleId || !s.driverPersonId) throw new TitleError('не назначены перевозчик, машина или водитель')
    const orgs = new Map((await this.db.select().from(org).where(inArray(org.id, [s.shipperOrgId, s.consigneeOrgId, s.carrierOrgId]))).map((o) => [o.id, o]))
    const [car] = await this.db.select().from(vehicle).where(eq(vehicle.id, s.vehicleId))
    const [driver] = await this.db.select().from(person).where(eq(person.id, s.driverPersonId))
    const shipperMan = await this.who(shipmentId, 'shipper')
    const carrierMan = await this.who(shipmentId, 'carrier')
    if (!car?.bodyType || car.capacityT == null || car.volumeM3 == null) throw new TitleError('у машины не заполнены тип кузова, грузоподъёмность или объём')
    if (!driver?.phone) throw new TitleError('нет подтверждённого номера водителя')
    if (!shipperMan?.phone) throw new TitleError('нет подтверждённого номера отправителя')

    const arrived = (await this.eventAt(shipmentId, 'driver.arrivedLoading')) ?? s.turnSince
    // Убытие — момент, когда водитель подтвердил приём груза: дальше машина уезжает
    const departed = (await this.eventAt(shipmentId, 'driver.confirmLoading')) ?? new Date()
    const party = (id: string, phone: string): Party => {
      const o = orgs.get(id)!
      return { name: o.name, inn: o.inn, kpp: o.kpp, phone, person: o.inn.length === 12 ? ipPerson(o.name) : null }
    }
    return buildT1({
      number: s.erpRef,
      date: s.plannedLoadingAt ?? s.createdAt,
      createdAt: new Date(),
      senderId: participantId(orgs.get(s.shipperOrgId)!.inn),
      receiverId: OPERATOR_ID,
      shipper: party(s.shipperOrgId, shipperMan.phone),
      consignee: { ...party(s.consigneeOrgId, s.consigneeContact?.phone ?? shipperMan.phone), address: s.unloadingAddress },
      carrier: party(s.carrierOrgId, carrierMan?.phone ?? driver.phone),
      driver: { ...splitName(driver.name), phone: driver.phone },
      vehicle: {
        plate: car.plate,
        ownership: car.ownership,
        type: `Грузовой ${car.bodyType.toLowerCase()}`,
        brand: car.brand,
        capacityT: car.capacityT,
        volumeM3: car.volumeM3,
      },
      cargo: s.cargo.lines.map((l) => ({
        name: l.name,
        places: l.qty,
        grossKg: l.grossKg,
        marking: l.declaration ? `Декларация ${l.declaration}` : 'Без маркировки',
        packageCode: PACKAGE_CODE,
        packing: /бочк/i.test(l.name) ? 'Бочки на поддонах' : 'Канистры на поддонах',
        condition: s.loadingRemarks ? 'Приняты с замечаниями' : 'Без повреждений',
      })),
      instructions: 'Особых условий нет',
      loading: {
        address: s.loadingAddress,
        planned: s.plannedLoadingAt ?? arrived,
        arrived,
        departed,
        grossKg: s.cargo.grossKg,
        places: s.cargo.places,
      },
      signer: splitName(shipperMan.name),
    })
  }

  /** Предыдущий титул для сцепки: ИдФайл, когда сформирован, и подпись стороны целиком (CMS) для атрибута ЭП. */
  private async prev(shipmentId: string, kind: TitleKind, role: Role, what: string): Promise<PrevTitle> {
    const t = await this.get(shipmentId, kind)
    if (!t) throw new TitleError(`${what} ещё не собран`)
    const [sig] = await this.db
      .select()
      .from(signature)
      .where(and(eq(signature.titleId, t.id), eq(signature.role, role), eq(signature.verified, true)))
      .orderBy(desc(signature.createdAt))
      .limit(1)
    if (!sig) throw new TitleError(`${what} ещё не подписан`)
    // У демо-подписи CMS нет — метка модели вместо подписи
    return { fileId: t.fileId, createdAt: t.createdAt, signatureBase64: Buffer.from(sig.cms ?? Buffer.from('DEMO-SIGNATURE-MODEL')).toString('base64') }
  }

  private async buildT2(shipmentId: string): Promise<TitleFile> {
    const [s] = await this.db.select().from(shipment).where(eq(shipment.id, shipmentId))
    if (!s) throw new TitleError('перевозка не найдена')
    if (!s.uid) throw new TitleError('оператор ещё не выдал номер накладной')
    const t1 = await this.prev(shipmentId, 'T1', 'shipper', 'первый титул')
    const carrierMan = await this.who(shipmentId, 'carrier')
    const [carrierOrg] = s.carrierOrgId ? await this.db.select().from(org).where(eq(org.id, s.carrierOrgId)) : []
    if (!carrierMan || !carrierOrg) throw new TitleError('нет перевозчика')
    return buildT2({
      createdAt: new Date(),
      senderId: participantId(carrierOrg.inn),
      receiverId: OPERATOR_ID,
      t1,
      uid: s.uid,
      remarks: s.loadingRemarks ? { cargo: s.loadingRemarks } : null,
      signer: splitName(carrierMan.name),
    })
  }

  private async buildT3(shipmentId: string): Promise<TitleFile> {
    const [s] = await this.db.select().from(shipment).where(eq(shipment.id, shipmentId))
    if (!s?.uid) throw new TitleError('нет номера накладной')
    if (!s.acceptance) throw new TitleError('приёмка ещё не отмечена')
    const t2 = await this.prev(shipmentId, 'T2', 'carrier', 'титул перевозчика')
    const consigneeMan = await this.who(shipmentId, 'consignee')
    const [consigneeOrg] = await this.db.select().from(org).where(eq(org.id, s.consigneeOrgId))
    if (!consigneeMan || !consigneeOrg) throw new TitleError('нет получателя')
    const arrived = (await this.eventAt(shipmentId, 'driver.arrivedUnloading')) ?? s.turnSince
    const departed = (await this.eventAt(shipmentId, 'consignee.recordAcceptance')) ?? new Date()
    const a = s.acceptance
    return buildT3({
      createdAt: new Date(),
      senderId: participantId(consigneeOrg.inn),
      receiverId: OPERATOR_ID,
      t2,
      uid: s.uid,
      consigneeName: consigneeOrg.name,
      acceptance:
        a.result === 'refused'
          ? { result: 'refused', reason: a.discrepancies ?? 'Отказ от груза' }
          : { result: a.result, discrepancies: a.discrepancies, arrived, departed, places: s.cargo.places, grossKg: s.cargo.grossKg, unloadingAddress: s.unloadingAddress },
      signer: splitName(consigneeMan.name),
    })
  }

  private async buildT4(shipmentId: string): Promise<TitleFile> {
    const [s] = await this.db.select().from(shipment).where(eq(shipment.id, shipmentId))
    if (!s?.uid) throw new TitleError('нет номера накладной')
    const t3 = await this.prev(shipmentId, 'T3', 'consignee', 'титул получателя')
    const carrierMan = await this.who(shipmentId, 'carrier')
    const [carrierOrg] = s.carrierOrgId ? await this.db.select().from(org).where(eq(org.id, s.carrierOrgId)) : []
    if (!carrierMan || !carrierOrg) throw new TitleError('нет перевозчика')
    return buildT4({ createdAt: new Date(), senderId: participantId(carrierOrg.inn), receiverId: OPERATOR_ID, t3, uid: s.uid, signer: splitName(carrierMan.name) })
  }
}

/** ИП в названии: «ИП Хабибуллин Рустам Фаридович» → ФИО. */
function ipPerson(name: string) {
  const words = name.replace(/^(ИП|Индивидуальный предприниматель)\s+/i, '').trim().split(/\s+/)
  return { surname: words[0] ?? name, name: words[1] ?? words[0] ?? name, patronymic: words.slice(2).join(' ') || null }
}
