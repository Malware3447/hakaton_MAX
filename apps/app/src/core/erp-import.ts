import ExcelJS from 'exceljs'
import { isValidInn, normalizeInn, type ErpShipment, type OrgDirectory } from '@nk/domain'

// Загрузка отгрузок из Excel (HAKATON-46). Отправитель скачивает шаблон, заполняет его
// и присылает боту файлом. Одна строка — одна позиция груза; строки с одинаковым номером
// отгрузки собираются в одну отгрузку. Поля отгрузки берём из первой её строки, в следующих
// их можно не повторять. Отгрузки попадают в модель учётной системы (mock.erp_shipment),
// дальше — тот же путь, что у отгрузок из демо-данных.

export const SHEET = 'Отгрузки'
export const MAX_FILE_BYTES = 2 * 1024 * 1024
export const MAX_LINES = 500

type Key =
  | 'ref'
  | 'loadingAt'
  | 'consigneeInn'
  | 'consigneeName'
  | 'unloadingAddress'
  | 'contactName'
  | 'phone'
  | 'loadingAddress'
  | 'sku'
  | 'name'
  | 'qty'
  | 'grossKg'
  | 'declaration'

/** Колонки шаблона по порядку. required — обязательна в первой строке отгрузки (для позиций — в каждой). */
export const COLUMNS: { key: Key; title: string; width: number; required?: boolean; hint: string }[] = [
  { key: 'ref', title: 'Номер отгрузки', width: 16, required: true, hint: 'Одинаковый у всех позиций одной отгрузки' },
  { key: 'loadingAt', title: 'Дата погрузки', width: 17, required: true, hint: 'ДД.ММ.ГГГГ ЧЧ:ММ по Москве; без времени — 09:00' },
  { key: 'consigneeInn', title: 'ИНН получателя', width: 14, required: true, hint: '10 цифр, у ИП 12' },
  { key: 'consigneeName', title: 'Получатель', width: 28, hint: 'Можно не заполнять: возьмём из ЕГРЮЛ по ИНН' },
  { key: 'unloadingAddress', title: 'Адрес выгрузки', width: 40, hint: 'Пусто — юридический адрес получателя' },
  { key: 'contactName', title: 'Контакт получателя', width: 20, hint: 'Кто примет груз' },
  { key: 'phone', title: 'Телефон контакта', width: 17, hint: '+7 900 000-00-00' },
  { key: 'loadingAddress', title: 'Адрес погрузки', width: 40, hint: 'Пусто — адрес вашей компании' },
  { key: 'sku', title: 'Артикул', width: 14, hint: 'Необязательно' },
  { key: 'name', title: 'Наименование груза', width: 44, required: true, hint: 'Как в накладной' },
  { key: 'qty', title: 'Количество, мест', width: 11, required: true, hint: 'Целое число' },
  { key: 'grossKg', title: 'Вес брутто, кг', width: 12, required: true, hint: 'Всей позиции, не одного места' },
  { key: 'declaration', title: 'Декларация соответствия', width: 30, hint: 'Необязательно' },
]
const SHIPMENT_KEYS: Key[] = ['loadingAt', 'consigneeInn', 'consigneeName', 'unloadingAddress', 'contactName', 'phone', 'loadingAddress']
const LINE_KEYS: Key[] = ['sku', 'name', 'qty', 'grossKg', 'declaration']

type Cell = string | number | Date | null
export interface RawRow {
  /** номер строки в Excel — его показываем в ошибках */
  row: number
  cells: Partial<Record<Key, Cell>>
}

export class ImportFileError extends Error {}

// ---------- чтение ----------

function cellValue(v: ExcelJS.CellValue): Cell {
  if (v == null) return null
  if (v instanceof Date || typeof v === 'number') return v
  if (typeof v === 'string') return v.trim() || null
  if (typeof v === 'boolean') return String(v)
  if (typeof v === 'object') {
    if ('result' in v) return cellValue(v.result as ExcelJS.CellValue) // формула
    if ('richText' in v) return v.richText.map((t) => t.text).join('').trim() || null
    if ('text' in v) return String(v.text).trim() || null // гиперссылка
  }
  return null
}

const squash = (s: string) => s.toLowerCase().replace(/ё/g, 'е').replace(/[^a-zа-я0-9]/g, '')

/** Прочитать строки листа «Отгрузки» (или первого). Колонки узнаём по заголовкам, порядок не важен. */
export async function readWorkbook(bytes: Uint8Array): Promise<RawRow[]> {
  if (bytes.byteLength > MAX_FILE_BYTES) throw new ImportFileError('Файл больше 2 МБ. Разбейте отгрузки на несколько файлов.')
  const wb = new ExcelJS.Workbook()
  try {
    await wb.xlsx.load(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer)
  } catch {
    throw new ImportFileError('Не получилось открыть файл как таблицу Excel (.xlsx). Сохраните его в формате «Книга Excel» и пришлите ещё раз.')
  }
  const ws = wb.getWorksheet(SHEET) ?? wb.worksheets[0]
  if (!ws) throw new ImportFileError('В файле нет ни одного листа.')

  // Заголовки ищем в первых пяти строках: над таблицей может быть шапка
  const byTitle = new Map(COLUMNS.map((c) => [squash(c.title), c.key]))
  let headerRow = 0
  const colKey = new Map<number, Key>()
  for (let r = 1; r <= Math.min(5, ws.rowCount) && !headerRow; r++) {
    ws.getRow(r).eachCell((cell, col) => {
      const k = byTitle.get(squash(String(cellValue(cell.value) ?? '')))
      if (k) colKey.set(col, k)
    })
    if (colKey.has(1) || colKey.size >= 3) headerRow = r
    else colKey.clear()
  }
  if (!headerRow) throw new ImportFileError('Не нашёл строку заголовков. Возьмите шаблон из бота: названия колонок должны остаться как в нём.')
  const missing = COLUMNS.filter((c) => c.required && ![...colKey.values()].includes(c.key))
  if (missing.length) throw new ImportFileError(`В таблице нет колонок: ${missing.map((c) => `«${c.title}»`).join(', ')}. Возьмите шаблон из бота.`)

  const rows: RawRow[] = []
  for (let r = headerRow + 1; r <= ws.rowCount; r++) {
    const cells: RawRow['cells'] = {}
    for (const [col, key] of colKey) {
      const v = cellValue(ws.getRow(r).getCell(col).value)
      if (v != null) cells[key] = v
    }
    if (Object.keys(cells).length) rows.push({ row: r, cells })
  }
  if (rows.length > MAX_LINES) throw new ImportFileError(`В файле ${rows.length} строк, за раз можно не больше ${MAX_LINES}.`)
  return rows
}

// ---------- проверка ----------

const MSK_MS = 3 * 60 * 60 * 1000
const DAY_MS = 24 * 60 * 60 * 1000

/**
 * Дата погрузки по Москве. В Excel у даты нет часового пояса: exceljs отдаёт Date,
 * у которой UTC-часы равны часам в ячейке, — считаем их московскими.
 */
export function parseLoadingAt(v: Cell): Date | null {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : new Date(v.getTime() - MSK_MS)
  if (typeof v === 'number') {
    // серийный номер Excel: дни от 30.12.1899
    if (v < 40000 || v > 80000) return null
    return new Date(Date.UTC(1899, 11, 30) + Math.round(v * DAY_MS) - MSK_MS)
  }
  if (typeof v !== 'string') return null
  const m = /^(\d{1,2})\.(\d{1,2})\.(\d{4})(?:[ T]+(\d{1,2})[:.](\d{2}))?$/.exec(v.trim())
  if (!m) return null
  const [day, month, year, hh, mm] = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4] ?? 9), Number(m[5] ?? 0)]
  if (month < 1 || month > 12 || hh > 23 || mm > 59) return null
  const d = new Date(Date.UTC(year, month - 1, day, hh, mm))
  if (d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) return null
  return new Date(d.getTime() - MSK_MS)
}

/** «8 (917) 200-00-01», «+7 917 200 00 01» → «+79172000001»; не российский мобильный или городской — null. */
export function normalizePhone(v: Cell): string | null {
  const digits = String(v ?? '').replace(/\D/g, '')
  if (digits.length === 10) return `+7${digits}`
  if (digits.length === 11 && (digits[0] === '7' || digits[0] === '8')) return `+7${digits.slice(1)}`
  return null
}

const num = (v: Cell): number | null => {
  if (typeof v === 'number') return v
  if (typeof v !== 'string') return null
  const n = Number(v.replace(/\s/g, '').replace(',', '.'))
  return Number.isFinite(n) ? n : null
}
const str = (v: Cell) => (v == null ? '' : v instanceof Date ? v.toISOString() : String(v).trim())

export interface ImportedShipment extends ErpShipment {
  plannedLoadingAt: string
  /** строки Excel этой отгрузки */
  rows: number[]
  /** получатель найден в справочнике (демо или ЕГРЮЛ); иначе название взято из таблицы */
  consigneeChecked: boolean
}

export interface ImportIssue {
  row: number | null
  ref: string | null
  text: string
}

export interface ImportCheck {
  shipments: ImportedShipment[]
  errors: ImportIssue[]
  warnings: ImportIssue[]
}

export interface ImportContext {
  shipperInn: string
  /** адрес погрузки по умолчанию — адрес компании отправителя */
  defaultLoadingAddress: string
  directory: OrgDirectory
  /** что уже есть в учётке этого отправителя по этим номерам и начата ли перевозка; у других компаний номера свои */
  existing: (refs: string[]) => Promise<Map<string, { started: boolean }>>
  now?: Date
}

/** Собрать отгрузки из строк и проверить. Ошибка в любой строке — не загружаем ничего. */
export async function checkRows(rows: RawRow[], ctx: ImportContext): Promise<ImportCheck> {
  const errors: ImportIssue[] = []
  const warnings: ImportIssue[] = []
  const err = (row: number | null, ref: string | null, text: string) => errors.push({ row, ref, text })
  const warn = (row: number | null, ref: string | null, text: string) => warnings.push({ row, ref, text })

  if (!rows.length) return { shipments: [], errors: [{ row: null, ref: null, text: 'В таблице нет ни одной строки с отгрузками.' }], warnings }

  // Группируем по номеру; строка без номера продолжает отгрузку над ней
  const groups = new Map<string, RawRow[]>()
  let current: string | null = null
  for (const r of rows) {
    const ref = str(r.cells.ref ?? null)
    // тот же номер ниже, через другие отгрузки — возможно опечатка, но собираем вместе
    if (ref && ref !== current && groups.has(ref)) warn(r.row, ref, 'номер уже встречался выше — позиции собраны в одну отгрузку')
    if (ref) current = ref
    if (!current) {
      err(r.row, null, 'нет номера отгрузки')
      continue
    }
    groups.set(current, [...(groups.get(current) ?? []), r])
  }

  const existing = await ctx.existing([...groups.keys()])
  const orgCache = new Map<string, Awaited<ReturnType<OrgDirectory['findByInn']>>>()
  const now = ctx.now ?? new Date()
  const shipments: ImportedShipment[] = []

  for (const [ref, group] of groups) {
    const first = group[0]!
    const e0 = errors.length
    if (ref.length > 40) err(first.row, ref, 'номер отгрузки длиннее 40 знаков')

    // Поля отгрузки: из первой строки; в остальных — пусто или то же самое
    const head: Partial<Record<Key, Cell>> = {}
    for (const k of SHIPMENT_KEYS) {
      for (const r of group) {
        const v = r.cells[k]
        if (v == null) continue
        if (head[k] == null) head[k] = v
        else if (str(head[k]) !== str(v)) err(r.row, ref, `«${COLUMNS.find((c) => c.key === k)!.title}» отличается от первой строки отгрузки`)
      }
    }

    const was = existing.get(ref)
    if (was?.started) err(first.row, ref, 'эта отгрузка уже открыта в боте — изменить её из таблицы нельзя, заведите под новым номером')
    else if (was) warn(first.row, ref, 'отгрузка с таким номером уже есть — заменим её данными из таблицы')

    const loadingAt = parseLoadingAt(head.loadingAt ?? null)
    if (head.loadingAt == null) err(first.row, ref, 'нет даты погрузки')
    else if (!loadingAt) err(first.row, ref, `дата погрузки «${str(head.loadingAt)}» — нет такой даты или формат не ДД.ММ.ГГГГ ЧЧ:ММ`)
    else if (loadingAt.getTime() < now.getTime() - DAY_MS) warn(first.row, ref, 'дата погрузки уже прошла')
    else if (loadingAt.getTime() > now.getTime() + 366 * DAY_MS) err(first.row, ref, 'дата погрузки больше чем через год')

    let consignee: ImportedShipment['consignee'] | null = null
    let consigneeChecked = false
    let unloading = str(head.unloadingAddress ?? null)
    const inn = normalizeInn(str(head.consigneeInn ?? null))
    if (head.consigneeInn == null) err(first.row, ref, 'нет ИНН получателя')
    else if (!inn || !isValidInn(inn)) err(first.row, ref, `ИНН получателя «${str(head.consigneeInn)}» с ошибкой — проверьте цифры`)
    else if (inn === ctx.shipperInn) err(first.row, ref, 'получатель совпадает с отправителем')
    else {
      if (!orgCache.has(inn)) orgCache.set(inn, await ctx.directory.findByInn(inn))
      const found = orgCache.get(inn)
      const nameCell = str(head.consigneeName ?? null)
      if (found && found.status && found.status !== 'active') err(first.row, ref, `получатель ${found.name} не действует по ЕГРЮЛ`)
      if (found) {
        consigneeChecked = true
        consignee = { inn, name: found.name, contactName: null, phone: null }
        if (!unloading) unloading = found.address
      } else if (nameCell) {
        consignee = { inn, name: nameCell, contactName: null, phone: null }
        warn(first.row, ref, `ИНН ${inn} не нашёлся в ЕГРЮЛ — название получателя взяли из таблицы, не проверено`)
      } else err(first.row, ref, `ИНН ${inn} не нашёлся в ЕГРЮЛ — впишите название получателя`)
    }
    if (!unloading && consignee) err(first.row, ref, 'нет адреса выгрузки')

    const phoneCell = head.phone ?? null
    const phone = phoneCell == null ? null : normalizePhone(phoneCell)
    if (phoneCell != null && !phone) err(first.row, ref, `телефон «${str(phoneCell)}» не похож на российский номер`)
    if (consignee) consignee = { ...consignee, contactName: str(head.contactName ?? null) || null, phone }

    // Позиции
    const lines: ErpShipment['lines'] = []
    for (const r of group) {
      const c = r.cells
      if (LINE_KEYS.every((k) => c[k] == null)) {
        if (r !== first) err(r.row, ref, 'в строке нет груза')
        continue
      }
      const name = str(c.name ?? null)
      const qty = num(c.qty ?? null)
      const kg = num(c.grossKg ?? null)
      if (!name) err(r.row, ref, 'нет наименования груза')
      if (qty == null || !Number.isInteger(qty) || qty <= 0) err(r.row, ref, 'количество мест — целое число больше нуля')
      if (kg == null || kg <= 0) err(r.row, ref, 'вес брутто — число больше нуля')
      else if (kg > 60_000) err(r.row, ref, `вес ${kg} кг — больше, чем везёт одна машина; проверьте, что это килограммы`)
      if (name && qty && kg) lines.push({ sku: str(c.sku ?? null), name, qty, grossKg: kg, declaration: str(c.declaration ?? null) || null })
    }
    if (!group.some((r) => LINE_KEYS.some((k) => r.cells[k] != null))) err(first.row, ref, 'у отгрузки нет ни одной позиции груза')

    if (errors.length > e0 || !consignee || !loadingAt) continue
    const grossKg = Math.round(lines.reduce((s, l) => s + l.grossKg, 0) * 1000) / 1000
    if (grossKg > 60_000) {
      err(first.row, ref, `общий вес ${grossKg} кг — больше, чем везёт одна машина`)
      continue
    }
    shipments.push({
      ref,
      shipperInn: ctx.shipperInn,
      consignee,
      loadingAddress: str(head.loadingAddress ?? null) || ctx.defaultLoadingAddress,
      unloadingAddress: unloading,
      plannedLoadingAt: loadingAt.toISOString(),
      lines,
      places: lines.reduce((s, l) => s + l.qty, 0),
      grossKg,
      rows: group.map((r) => r.row),
      consigneeChecked,
    })
  }
  return { shipments, errors, warnings }
}

// ---------- шаблон ----------

/** Дата для ячейки Excel: UTC-часы = московские (см. parseLoadingAt). */
const excelDate = (iso: string) => new Date(Date.parse(iso) + MSK_MS)

export interface TemplateRow {
  ref: string
  /** ISO-время; пусто — в продолжении отгрузки */
  loadingAt: string
  consigneeInn: string
  consigneeName?: string | null
  unloadingAddress?: string | null
  contactName?: string | null
  phone?: string | null
  loadingAddress?: string | null
  sku?: string | null
  name: string
  qty: number
  grossKg: number
  declaration?: string | null
}

/** Шаблон .xlsx: лист «Отгрузки» с заголовками (и строками, если даны) и лист «Как заполнять». */
export async function buildWorkbook(rows: TemplateRow[] = []): Promise<Uint8Array> {
  const wb = new ExcelJS.Workbook()
  wb.creator = 'Накладная в кармане'
  const ws = wb.addWorksheet(SHEET, { views: [{ state: 'frozen', ySplit: 1 }] })
  ws.columns = COLUMNS.map((c) => ({ header: c.title, key: c.key, width: c.width }))
  const header = ws.getRow(1)
  header.font = { bold: true }
  header.alignment = { vertical: 'middle', wrapText: true }
  header.height = 32
  COLUMNS.forEach((c, i) => {
    const cell = header.getCell(i + 1)
    cell.note = c.hint
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: c.required ? 'FFFCE4B8' : 'FFEDEDED' } }
  })
  ws.getColumn('loadingAt').numFmt = 'dd.mm.yyyy hh:mm'
  ws.getColumn('consigneeInn').numFmt = '@'
  ws.getColumn('phone').numFmt = '@'
  ws.getColumn('grossKg').numFmt = '0.###'
  // дату пишем датой Excel; строку, которая не ISO (например, ошибочную «31.09.2026»), — как есть
  for (const r of rows) ws.addRow({ ...r, loadingAt: /^\d{4}-/.test(r.loadingAt) ? excelDate(r.loadingAt) : r.loadingAt || null })

  const help = wb.addWorksheet('Как заполнять')
  help.columns = [
    { header: 'Колонка', key: 'title', width: 26 },
    { header: 'Обязательна', key: 'req', width: 13 },
    { header: 'Что писать', key: 'hint', width: 60 },
  ]
  help.getRow(1).font = { bold: true }
  for (const c of COLUMNS) help.addRow({ title: c.title, req: c.required ? 'да' : '', hint: c.hint })
  help.addRow({})
  for (const line of [
    'Одна строка — одна позиция груза. Позиции одной отгрузки идут подряд с одинаковым номером.',
    'Дату, ИНН, получателя и адреса достаточно заполнить в первой строке отгрузки.',
    'Мест и вес отгрузки считаются сами — суммой позиций.',
    'Готовый файл пришлите боту в чат. Бот сначала покажет, что понял, и загрузит только после «Загрузить».',
  ])
    help.addRow({ title: line })

  return new Uint8Array(await wb.xlsx.writeBuffer())
}
