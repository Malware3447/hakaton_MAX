import { sql } from 'drizzle-orm'
import {
  bigint,
  boolean,
  customType,
  index,
  integer,
  jsonb,
  numeric,
  pgSchema,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import type { AcceptanceResult, ActorKind, Role, SignatureKind, State, TitleKind, VehicleOwnership } from '@nk/domain'

// Схема базы. Описание полей и зачем они — docs/model-i-sostoyaniya.md, раздел 2.
// Миграции и загрузка сида — HAKATON-23. Контракт живой: меняем по ходу разработки.

const bytea = customType<{ data: Buffer }>({ dataType: () => 'bytea' })
const id = () => uuid('id').primaryKey().default(sql`uuidv7()`)
const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow()

// ---------- Организации и люди ----------

export const org = pgTable(
  'org',
  {
    id: id(),
    inn: text('inn').notNull(),
    kpp: text('kpp'),
    name: text('name').notNull(),
    address: text('address').notNull(),
    /** false — реквизиты введены руками, справочник их не нашёл */
    verified: boolean('verified').notNull().default(true),
    /** откуда реквизиты: demo — демо-данные (модель), dadata — ЕГРЮЛ через DaData, manual — вручную */
    requisitesSource: text('requisites_source').$type<'demo' | 'dadata' | 'manual'>(),
    ogrn: text('ogrn'),
    erpKind: text('erp_kind').$type<'mock' | null>(),
    isDemo: boolean('is_demo').notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('org_inn_uq').on(t.inn)],
)

export const person = pgTable('person', {
  id: id(),
  /** единственный способ узнать человека и написать ему */
  maxUserId: bigint('max_user_id', { mode: 'number' }).notNull().unique(),
  name: text('name').notNull(),
  /** sha256 подтверждённого номера, только после согласия; сам номер не храним */
  phoneSha256: text('phone_sha256'),
  consentAt: timestamp('consent_at', { withTimezone: true }),
  /** текущая роль; null — показываем корневое меню ролей */
  activeRole: text('active_role').$type<Role>(),
  createdAt: createdAt(),
})

/** Роль человека. Одна организация на роль человека: уникально (person_id, role). */
export const membership = pgTable(
  'membership',
  {
    id: id(),
    personId: uuid('person_id').notNull().references(() => person.id),
    role: text('role').$type<Role>().notNull(),
    /** у водителя пусто, пока его не назначил перевозчик */
    orgId: uuid('org_id').references(() => org.id),
    isAdmin: boolean('is_admin').notNull().default(false),
    canSign: boolean('can_sign').notNull().default(false),
    poaNumber: text('poa_number'),
    poaValidTo: timestamp('poa_valid_to', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('membership_person_role_uq').on(t.personId, t.role), index('membership_org_idx').on(t.orgId)],
)

/** Машины перевозчика: вводятся диспетчером при первом назначении, дальше выбираются кнопкой. */
export const vehicle = pgTable(
  'vehicle',
  {
    id: id(),
    orgId: uuid('org_id').notNull().references(() => org.id),
    plate: text('plate').notNull(),
    brand: text('brand').notNull(),
    ownership: text('ownership').$type<VehicleOwnership>().notNull(),
    ownerName: text('owner_name'),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('vehicle_org_plate_uq').on(t.orgId, t.plate)],
)

// ---------- Перевозка ----------

const activeStates = sql.raw(
  `state not in ('draft', 'closed', 'cancelled')`,
)

export const shipment = pgTable(
  'shipment',
  {
    id: id(),
    erpRef: text('erp_ref').notNull(),
    shipperOrgId: uuid('shipper_org_id').notNull().references(() => org.id),
    carrierOrgId: uuid('carrier_org_id').references(() => org.id),
    consigneeOrgId: uuid('consignee_org_id').notNull().references(() => org.id),
    loadingAddress: text('loading_address').notNull(),
    unloadingAddress: text('unloading_address').notNull(),
    plannedLoadingAt: timestamp('planned_loading_at', { withTimezone: true }),
    cargo: jsonb('cargo')
      .$type<{ lines: { sku: string; name: string; qty: number; grossKg: number; declaration: string | null }[]; places: number; grossKg: number }>()
      .notNull(),
    vehicleId: uuid('vehicle_id').references(() => vehicle.id),
    driverPersonId: uuid('driver_person_id').references(() => person.id),
    state: text('state').$type<State>().notNull().default('draft'),
    turn: text('turn').$type<Role>(),
    turnSince: timestamp('turn_since', { withTimezone: true }).notNull().defaultNow(),
    loadingRemarks: text('loading_remarks'),
    acceptance: jsonb('acceptance').$type<{ result: AcceptanceResult; discrepancies: string | null }>(),
    uid: text('uid'),
    operatorDocId: text('operator_doc_id'),
    /** защита от параллельной записи; в кнопки не передаётся */
    version: integer('version').notNull().default(0),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('shipment_erp_ref_uq').on(t.shipperOrgId, t.erpRef),
    // одна активная перевозка на машину и на водителя
    uniqueIndex('shipment_active_vehicle_uq').on(t.vehicleId).where(activeStates),
    uniqueIndex('shipment_active_driver_uq').on(t.driverPersonId).where(activeStates),
    index('shipment_turn_idx').on(t.turn, t.turnSince),
  ],
)

/** Участник: роль в конкретной перевозке. Пока человек не вошёл, person_id пуст и живёт приглашение. */
export const participant = pgTable(
  'participant',
  {
    id: id(),
    shipmentId: uuid('shipment_id').notNull().references(() => shipment.id),
    role: text('role').$type<Role>().notNull(),
    personId: uuid('person_id').references(() => person.id),
    inviteTokenSha256: text('invite_token_sha256').unique(),
    inviteExpiresAt: timestamp('invite_expires_at', { withTimezone: true }),
    inviteSingleUse: boolean('invite_single_use').notNull().default(false),
    /** из пересланного контакта: по нему сверяем того, кто пришёл по ссылке */
    expectedMaxUserId: bigint('expected_max_user_id', { mode: 'number' }),
    expectedPhoneSha256: text('expected_phone_sha256'),
    identityMismatch: boolean('identity_mismatch').notNull().default(false),
    invitedByPersonId: uuid('invited_by_person_id').references(() => person.id),
    source: text('source').$type<'link' | 'contact' | 'known'>(),
    joinedAt: timestamp('joined_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('participant_shipment_role_uq').on(t.shipmentId, t.role), index('participant_person_idx').on(t.personId)],
)

// ---------- Документы ----------

export const title = pgTable(
  'title',
  {
    id: id(),
    shipmentId: uuid('shipment_id').notNull().references(() => shipment.id),
    kind: text('kind').$type<TitleKind>().notNull(),
    idFile: text('id_file').notNull(),
    xml: bytea('xml').notNull(),
    sha256: text('sha256').notNull(),
    streebog: text('streebog'),
    prevTitleId: uuid('prev_title_id'),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('title_shipment_kind_uq').on(t.shipmentId, t.kind)],
)

/** Подпись. На Т2 и Т4 их две: простая подпись водителя и подпись перевозчика. */
export const signature = pgTable(
  'signature',
  {
    id: id(),
    shipmentId: uuid('shipment_id').notNull().references(() => shipment.id),
    titleKind: text('title_kind').$type<TitleKind>().notNull(),
    /** пусто у простой подписи водителя, пока титул ещё не собран */
    titleId: uuid('title_id').references(() => title.id),
    role: text('role').$type<Role>().notNull(),
    kind: text('kind').$type<SignatureKind>().notNull(),
    signerPersonId: uuid('signer_person_id').notNull().references(() => person.id),
    cms: bytea('cms'),
    signerName: text('signer_name'),
    signerSnils: text('signer_snils'),
    verified: boolean('verified').notNull().default(false),
    verifyResult: text('verify_result'),
    /** для pep_max — доказательства нажатия (PepEvidence) */
    evidence: jsonb('evidence').$type<Record<string, unknown>>(),
    createdAt: createdAt(),
  },
  (t) => [index('signature_shipment_idx').on(t.shipmentId, t.titleKind)],
)

// ---------- Бот ----------

/** Живая карточка: одно сообщение на участника, перерисовывается на месте. */
export const card = pgTable(
  'card',
  {
    shipmentId: uuid('shipment_id').notNull().references(() => shipment.id),
    personId: uuid('person_id').notNull().references(() => person.id),
    mid: text('mid').notNull(),
    renderHash: text('render_hash').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.shipmentId, t.personId] })],
)

/** Сообщение меню у человека — чтобы перерисовывать его, а не слать новое. */
export const menuMessage = pgTable('menu_message', {
  personId: uuid('person_id').primaryKey().references(() => person.id),
  mid: text('mid').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

/** Незаконченное действие человека: шаг анкеты или «жду контакт». Одно на человека. */
export const dialog = pgTable('dialog', {
  personId: uuid('person_id').primaryKey().references(() => person.id),
  step: text('step').notNull(),
  shipmentId: uuid('shipment_id').references(() => shipment.id),
  context: jsonb('context').$type<Record<string, unknown>>().notNull().default({}),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
})

/** Журнал: из него лента перевозки и метрики. Пишется на каждое действие, включая неудачные. */
export const event = pgTable(
  'event',
  {
    id: id(),
    shipmentId: uuid('shipment_id').references(() => shipment.id),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
    type: text('type').notNull(),
    actorKind: text('actor_kind').$type<ActorKind>().notNull(),
    actorPersonId: uuid('actor_person_id').references(() => person.id),
    actorRole: text('actor_role').$type<Role>(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default({}),
  },
  (t) => [index('event_shipment_at_idx').on(t.shipmentId, t.at)],
)

/** Обновления MAX. MAX повторяет доставку до 10 раз — ключ отсекает повторы. */
export const inbox = pgTable('inbox', {
  key: text('key').primaryKey(),
  receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
  processedAt: timestamp('processed_at', { withTimezone: true }),
  attempts: integer('attempts').notNull().default(0),
  payload: jsonb('payload').notNull(),
  error: text('error'),
})

// ---------- Модели внешних систем (помечаются «модель» в интерфейсе и README) ----------

export const mock = pgSchema('mock')

export const mockOrgRegistry = mock.table('org_registry', {
  inn: text('inn').primaryKey(),
  kpp: text('kpp'),
  name: text('name').notNull(),
  address: text('address').notNull(),
})

/** Отгрузки учётной системы. Перевозчика, машину и водителя учётка не задаёт (решение 24.09). */
export const mockErpShipment = mock.table('erp_shipment', {
  ref: text('ref').primaryKey(),
  shipperInn: text('shipper_inn').notNull(),
  consigneeInn: text('consignee_inn').notNull(),
  consigneeName: text('consignee_name').notNull(),
  loadingAddress: text('loading_address').notNull(),
  unloadingAddress: text('unloading_address').notNull(),
  plannedLoadingAt: timestamp('planned_loading_at', { withTimezone: true }),
  lines: jsonb('lines').$type<{ sku: string; name: string; qty: number; grossKg: number; declaration: string | null }[]>().notNull(),
  places: integer('places').notNull(),
  grossKg: numeric('gross_kg', { mode: 'number' }).notNull(),
  createdAt: createdAt(),
})

export const mockErpWriteback = mock.table('erp_writeback', {
  id: id(),
  ref: text('ref').notNull(),
  status: jsonb('status').notNull(),
  at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
})

export const mockEpdDocument = mock.table('epd_document', {
  operatorDocId: text('operator_doc_id').primaryKey(),
  status: text('status').$type<'sent' | 'registered' | 'rejected'>().notNull().default('sent'),
  uid: text('uid'),
  rejectCode: text('reject_code'),
  rejectMessage: text('reject_message'),
  createdAt: createdAt(),
  registeredAt: timestamp('registered_at', { withTimezone: true }),
})

export const mockEpdTitle = mock.table('epd_title', {
  id: id(),
  operatorDocId: text('operator_doc_id').notNull().references(() => mockEpdDocument.operatorDocId),
  kind: text('kind').$type<TitleKind>().notNull(),
  fileName: text('file_name').notNull(),
  xml: bytea('xml').notNull(),
  /** подписи в base64 */
  signatures: jsonb('signatures').$type<string[]>().notNull(),
  receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
})

/** Ручки сбоев для демо: недоступен, отказ в Т2, ошибка ГИС, задержка QR. */
export const mockEpdSettings = mock.table('epd_settings', {
  key: text('key').primaryKey(),
  value: jsonb('value').notNull(),
})
