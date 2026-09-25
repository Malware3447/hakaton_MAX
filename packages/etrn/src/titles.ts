import { randomUUID } from 'node:crypto'
import { el, toXml, type Node } from './xml.ts'
import { encode1251, fileId, fmtDate, fmtDateTime, fmtKg, fmtTime, sha256hex } from './format.ts'

// Титулы ЭТрН по формату ФНС 5.01 (приказ ЕД-7-26/1065@), схемы — packages/etrn/xsd.
// Сборщик не знает про базу и бота: на входе данные перевозки, на выходе байты файла.
// Эти байты храним в title.xml и ровно их отправляем подписанту и проверяем подпись (HAKATON-41).

export const TITLE_PREFIX = { T1: 'ON_TRNACLGROT', T2: 'ON_TRNACLPPRIN', T3: 'ON_TRNACLGRPO', T4: 'ON_TRNACLPVYN' } as const
export const TITLE_KND = { T1: '1110339', T2: '1110340' } as const

export const PROGRAM = 'Накладная в кармане 0.1'

export interface Person {
  surname: string
  name: string
  patronymic?: string | null
}

/** Участник перевозки: юрлицо (ИНН 10 знаков) или ИП (ИНН 12 знаков, нужны ФИО). */
export interface Party {
  name: string
  inn: string
  kpp: string | null
  /** у ИП — ФИО предпринимателя */
  person?: Person | null
  phone: string
}

/** Вид владения машиной — код ТипВлад. 1 собственность, 3 аренда, 4 лизинг (сверить 2 и 5 с приказом). */
export const OWNERSHIP_CODE = { own: '1', rent: '3', lease: '4', other: '5' } as const

export interface CargoLine {
  name: string
  places: number
  grossKg: number
  /** маркировка, например номер декларации соответствия */
  marking: string
  /** код вида тары по ОКВГУМ, 2 знака */
  packageCode: string
  packing: string
  condition: string
}

export interface T1Input {
  number: string
  date: Date
  createdAt: Date
  /** идентификаторы участников ЭДО для имени файла (выдаёт оператор ЭПД) */
  senderId: string
  receiverId: string
  shipper: Party
  consignee: Party & { address: string }
  carrier: Party
  driver: Person & { phone: string }
  vehicle: { plate: string; ownership: keyof typeof OWNERSHIP_CODE; type: string; brand: string; capacityT: number; volumeM3: number }
  cargo: CargoLine[]
  instructions: string
  loading: { address: string; planned: Date; arrived: Date; departed: Date; grossKg: number; places: number }
  signer: Person
  guid?: string
}

export interface TitleFile {
  kind: 'T1' | 'T2' | 'T3' | 'T4'
  fileId: string
  /** XML в windows-1251 — байты для подписи */
  bytes: Uint8Array
  sha256: string
}

const fio = (p: Person) => el('ФИО', { Фамилия: p.surname, Имя: p.name, Отчество: p.patronymic ?? undefined })

/** ИдСв: ЮЛ — СвЮЛУч, ИП — СвИП с ФИО. */
function idSv(p: Party): Node {
  if (p.inn.length === 12) {
    if (!p.person) throw new Error(`для ИП ${p.inn} нужны ФИО`)
    return el('ИдСв', {}, el('СвИП', { ИННФЛ: p.inn }, fio(p.person)))
  }
  return el('ИдСв', {}, el('СвЮЛУч', { НаимОрг: p.name, ИННЮЛ: p.inn, КПП: p.kpp ?? undefined }))
}

const contact = (tag: string, phone: string) => el(tag, {}, el('Тлф', {}, phone))
const addressInf = (tag: string, text: string) => el(tag, {}, el('АдресИнф', { КодСтр: '643', АдрТекст: text }))

function file(kind: TitleFile['kind'], id: string, doc: Node): TitleFile {
  const bytes = encode1251(toXml(el('Файл', { ИдФайл: id, ВерсПрог: PROGRAM, ВерсФорм: '5.01' }, doc)))
  return { kind, fileId: id, bytes, sha256: sha256hex(bytes) }
}

/** Т1 — сведения грузоотправителя. Подписывается после погрузки: в нём фактические времена и масса. */
export function buildT1(i: T1Input): TitleFile {
  const id = fileId(TITLE_PREFIX.T1, i.receiverId, i.senderId, i.createdAt, i.guid ?? randomUUID())
  const doc = el(
    'Документ',
    { КНД: TITLE_KND.T1, ПоФактХЖ: 'Транспортная накладная', ДатИнфГО: fmtDate(i.createdAt), ВрИнфГО: fmtTime(i.createdAt) },
    el(
      'СодИнфГО',
      { СодОпер: 'Транспортная накладная: сведения грузоотправителя', НомерТрН: i.number, ДатаТрН: fmtDate(i.date), НомЗак: i.number, ДатаЗак: fmtDate(i.date) },
      el('СвГО', { ГОЭксп: '0' }, el('РекИдентГО', {}, idSv(i.shipper), contact('Контакт', i.shipper.phone))),
      el('СвГП', {}, el('РекИдентГП', {}, idSv(i.consignee), contact('Контакт', i.consignee.phone)), addressInf('АдресДостГр', i.consignee.address)),
      el(
        'СвГруз',
        {},
        ...i.cargo.map((c) =>
          el(
            'ОпГруз',
            { НаимГруз: c.name, СостГруз: c.condition, СпУпак: c.packing, ВидТар: c.packageCode, КолМестГр: c.places },
            el('Марк', {}, c.marking),
            el('ПлМасГруз', { МасБрутЗнач: fmtKg(c.grossKg) }),
          ),
        ),
      ),
      el(
        'УказГО',
        { УкНормПрвз: i.instructions },
        el('СвПА', { ЛицоПА: 'Грузоотправитель', СпосПерУкПА: 'Электронное уведомление перевозчика о переадресовке' }, contact('КонтПА', i.shipper.phone)),
      ),
      el('СвПер', {}, idSv(i.carrier), contact('Контакт', i.carrier.phone)),
      el('СвВодит', {}, el('Тлф', {}, i.driver.phone), fio(i.driver)),
      el(
        'СвТС',
        {},
        el(
          'ТС',
          { РегНомер: i.vehicle.plate, ТипВлад: OWNERSHIP_CODE[i.vehicle.ownership] },
          el('ПарТС', { Тип: i.vehicle.type, Марка: i.vehicle.brand, Грузопод: i.vehicle.capacityT.toFixed(2), Вместим: i.vehicle.volumeM3.toFixed(2) }),
        ),
      ),
      el(
        'СвПогруз',
        {
          ЗаявПогр: fmtDateTime(i.loading.planned),
          НалКоорТочВрЗаяв: '0',
          ФДатВрПриб: fmtDateTime(i.loading.arrived),
          НалКоорТочВрФПогр: '0',
          ФДатВрУбыт: fmtDateTime(i.loading.departed),
          НалКоорТочВрФУбыт: '0',
          МасБрутОтгр: fmtKg(i.loading.grossKg),
          // 01 — метод определения массы; расшифровку сверить с приказом
          МетОпрМасс: '01',
          КолМестПрием: i.loading.places,
        },
        addressInf('ФАдресПогр', i.loading.address),
        el('СвЛицПогрГр', { СовпГОП: '1' }),
        el('ВладИнфр', { СовпГОВ: '1' }),
      ),
    ),
    // СтатПодп: '1' — статус подписанта; расшифровку сверить с приказом
    el('Подписант', { СтатПодп: '1' }, fio(i.signer)),
  )
  return file('T1', id, doc)
}

export interface T2Input {
  createdAt: Date
  senderId: string
  receiverId: string
  /** Т1, к которому относится приём: его ИдФайл, когда сформирован и подпись (CMS в base64) */
  t1: { fileId: string; createdAt: Date; signatureBase64: string }
  /** УИД транспортной накладной — выдаёт оператор ЭПД после отправки Т1 */
  uid: string
  /** замечания водителя и перевозчика при приёме груза */
  remarks: { cargo?: string | null; places?: string | null; mass?: string | null } | null
  signer: Person
  guid?: string
}

/** Т2 — перевозчик о приёме груза к перевозке. Сцеплен с Т1 его подписью (атрибут ЭП). */
export function buildT2(i: T2Input): TitleFile {
  const id = fileId(TITLE_PREFIX.T2, i.receiverId, i.senderId, i.createdAt, i.guid ?? randomUUID())
  const r = i.remarks
  const hasRemarks = r && (r.cargo || r.places || r.mass)
  const doc = el(
    'Документ',
    { КНД: TITLE_KND.T2, ПоФактХЖ: 'Транспортная накладная', ДатИнфПрвПрием: fmtDate(i.createdAt), ВрИнфПрвПрием: fmtTime(i.createdAt) },
    el('ИдИнфГО', { ИдФайлИнфГО: i.t1.fileId, ДатФайлИнфГО: fmtDate(i.t1.createdAt), ВрФайлИнфГО: fmtTime(i.t1.createdAt), ЭП: i.t1.signatureBase64 }),
    el(
      'СодИнфПрвПрием',
      { УИД_ТрН: i.uid, СодОпер: 'Груз принят к перевозке' },
      hasRemarks ? el('ЗамПрвПрием', { ЗамСостГруз: r!.cargo ?? undefined, ЗамКолМест: r!.places ?? undefined, ЗамМасс: r!.mass ?? undefined }) : null,
    ),
    el('Подписант', { СтатПодп: '1' }, fio(i.signer)),
  )
  return file('T2', id, doc)
}

/** «Иван Петров» из профиля MAX → Фамилия, Имя. Отчества в профиле MAX нет. */
export function splitName(full: string): Person {
  const parts = full.trim().split(/\s+/)
  if (parts.length === 1) return { surname: parts[0]!, name: parts[0]! }
  if (parts.length === 2) return { surname: parts[1]!, name: parts[0]! }
  return { surname: parts[0]!, name: parts[1]!, patronymic: parts.slice(2).join(' ') }
}
