import type { PersonRef } from './commands.ts'
import type { Role, SignatureKind, TitleKind, VehicleOwnership } from './enums.ts'

// Интерфейсы всего внешнего. Ядро знает только их.
// На хакатоне за каждым стоит модель на таблицах схемы mock, но интерфейс рассчитан
// на замену настоящим сервисом (решение 24.09): все вызовы асинхронные, могут упасть
// и повторяются из очереди заданий, а не внутри транзакции execute().

// ---------- Учётная система отправителя ----------

export interface ErpShipment {
  ref: string // номер отгрузки: ОТГ-2026-1040
  shipperInn: string
  consignee: { inn: string; name: string }
  loadingAddress: string
  unloadingAddress: string
  plannedLoadingAt: string | null
  lines: { sku: string; name: string; qty: number; grossKg: number; declaration: string | null }[]
  places: number
  grossKg: number
}

export type WaybillStatus =
  | { kind: 'in_progress'; state: string }
  | { kind: 'closed'; uid: string; closedAt: string }
  | { kind: 'cancelled'; reason: string | null }

/** Реализации: MockErp (таблицы mock.erp_*); после хакатона — МойСклад, 1С. */
export interface ErpAdapter {
  /** отгрузки, готовые к перевозке, новее since */
  listShipments(shipperInn: string, since: string | null): Promise<ErpShipment[]>
  getShipment(ref: string): Promise<ErpShipment | null>
  /** вернуть в учётку номер накладной, УИД, статус */
  writeBack(ref: string, status: WaybillStatus): Promise<void>
}

// ---------- Справочник организаций ----------

export interface OrgRequisites {
  inn: string
  kpp: string | null
  name: string
  address: string
}

/** Реализации: MockDirectory (mock.org_registry); на пилоте — ЕГРЮЛ или DaData. */
export interface OrgDirectory {
  /** null — не нашли; тогда бот предлагает ввести реквизиты руками с пометкой «не проверено» */
  findByInn(inn: string): Promise<OrgRequisites | null>
}

// ---------- Оператор ЭПД и ГИС ЭПД ----------

/** Файл титула: XML собирает packages/etrn, оператор его только принимает. */
export interface TitleFile {
  kind: TitleKind
  fileName: string // ИдФайл по формату ФНС
  xml: Uint8Array // windows-1251
  sha256: string
}

export type OperatorStatus =
  | { kind: 'sent' }
  | { kind: 'registered'; uid: string }
  | { kind: 'rejected'; code: string; message: string }

/**
 * Реализации: MockEpd (mock.epd_*, отвечает с задержкой через задание); на пилоте — Диадок, Такском.
 * operatorDocId один на накладную: submit первого титула его создаёт, остальные дописываются.
 */
export interface EpdOperator {
  submit(operatorDocId: string | null, title: TitleFile, signatures: Uint8Array[]): Promise<{ operatorDocId: string }>
  status(operatorDocId: string): Promise<OperatorStatus>
  /** анимированный GIF QR-кода; есть после регистрации */
  qr(operatorDocId: string): Promise<Uint8Array>
}

// ---------- Подписи ----------

export interface SignRequest {
  titleId: string
  kind: SignatureKind
  /** что показать человеку: для goskey — XML и инструкция, для demo_ca — ничего, подпись сразу */
  userAction: 'none' | 'forward_to_goskey'
}

export interface SignatureRecord {
  id: string
  titleId: string
  role: Role
  kind: SignatureKind
  signerName: string | null
  verified: boolean
}

/** Реализации: demo_ca (openssl gost), goskey (приём .sig от @goskey_bot). pep_max пишет ядро само. */
export interface SignatureProvider {
  readonly kind: SignatureKind
  request(shipmentId: string, title: TitleKind, signerPersonId: string, role: Role): Promise<SignRequest>
  /** принять подпись (для goskey — присланный .sig), проверить и сохранить */
  accept(titleId: string, signerPersonId: string, role: Role, cms: Uint8Array | null): Promise<SignatureRecord>
}

// ---------- Мессенджер ----------

export interface Button {
  text: string
  /** callback: действие и перевозка; link: адрес; request_contact: поделиться номером */
  kind: 'callback' | 'link' | 'request_contact'
  payload: string
}

export interface OutMessage {
  text: string
  buttons?: Button[][]
  /** файл отправляется отдельным сообщением: в MAX файл — единственное вложение */
  file?: { name: string; bytes: Uint8Array }
}

/** Реализации: MaxMessenger (очередь, лимиты, повторы); в тестах и при MAX_MODE=off — заглушка. */
export interface Messenger {
  /** новое сообщение в личку; возвращает mid */
  send(maxUserId: number, message: OutMessage): Promise<{ mid: string }>
  /** перерисовать сообщение на месте (живая карточка, меню) */
  edit(mid: string, message: OutMessage): Promise<void>
  /** ответ на нажатие: всплывающее уведомление и/или правка сообщения */
  answerCallback(callbackId: string, notification: string | null, message?: OutMessage): Promise<void>
}

// ---------- Люди и машины (для назначения) ----------

export interface VehicleInput {
  plate: string // без пробелов, заглавными: А245КМ116
  brand: string
  ownership: VehicleOwnership
  ownerName: string | null // владелец при аренде и лизинге
}

/** Результат поиска по пересланному контакту. Найти можно только того, кто запускал бота. */
export type ContactMatch =
  | { found: true; personId: string; roles: Role[] }
  | { found: false; ref: Extract<PersonRef, { invite: unknown }> }
