import ExcelJS from 'exceljs'
import type { OrgDirectory, OrgRequisites } from '@nk/domain'
import { describe, expect, it } from 'vitest'
import { readSeed } from '../db/boot.ts'
import { sampleRows } from '../db/erp-sample.ts'
import { ImportFileError, buildWorkbook, checkRows, normalizePhone, parseLoadingAt, readWorkbook, type ImportContext, type RawRow } from './erp-import.ts'

const SHIPPER = '9782242514'
const seed = await readSeed()
const demo = new Map<string, OrgRequisites>([...seed.counterparties].map((o) => [o.inn, { inn: o.inn, kpp: o.kpp, name: o.name, address: o.address, source: 'demo', status: 'active' }]))
const directory: OrgDirectory = { findByInn: async (inn) => demo.get(inn) ?? null }
const ctx = (over: Partial<ImportContext> = {}): ImportContext => ({
  shipperInn: SHIPPER,
  defaultLoadingAddress: 'Елабуга, склад',
  directory,
  existing: async () => new Map(),
  now: new Date('2026-09-26T09:00:00Z'),
  ...over,
})
const row = (n: number, cells: RawRow['cells']): RawRow => ({ row: n, cells })
const line = { name: 'Масло 5W-30, канистра 20 л', qty: 10, grossKg: 184 }

describe('загрузка отгрузок из Excel: чтение', () => {
  it('таблица завода читается целиком: 17 отгрузок, 29 позиций, без ошибок', async () => {
    const rows = await readWorkbook(await buildWorkbook(sampleRows(seed)))
    expect(rows).toHaveLength(29)
    const r = await checkRows(rows, ctx())
    expect(r.errors).toEqual([])
    expect(r.shipments).toHaveLength(17)
    const s = r.shipments[0]!
    expect(s).toMatchObject({ ref: 'ОТГ-2026-2040', places: 86, grossKg: 2730, plannedLoadingAt: '2026-09-30T08:00:00.000Z', rows: [2, 3, 4] })
    expect(s.consignee).toEqual({ inn: '1167049238', name: 'ООО «Волга»', contactName: 'Дмитрий К.', phone: '+79570005194' })
  })

  it('колонки узнаём по заголовкам: другой порядок и шапка над таблицей', async () => {
    const wb = new ExcelJS.Workbook()
    const ws = wb.addWorksheet('Лист1')
    ws.addRow(['Выгрузка из 1С'])
    ws.addRow(['Наименование груза', 'Вес брутто, кг', 'Количество, мест', 'ИНН получателя', 'Дата погрузки', 'номер  отгрузки'])
    ws.addRow(['Масло', 100, 5, '1167049238', '01.10.2026 10:00', 'А-1'])
    const rows = await readWorkbook(new Uint8Array(await wb.xlsx.writeBuffer()))
    expect(rows).toEqual([{ row: 3, cells: { name: 'Масло', grossKg: 100, qty: 5, consigneeInn: '1167049238', loadingAt: '01.10.2026 10:00', ref: 'А-1' } }])
  })

  it('не Excel и таблица без нужных колонок — понятная ошибка', async () => {
    await expect(readWorkbook(new TextEncoder().encode('%PDF-1.4'))).rejects.toThrow(ImportFileError)
    const wb = new ExcelJS.Workbook()
    wb.addWorksheet('x').addRow(['Номер отгрузки', 'Дата погрузки', 'ИНН получателя'])
    await expect(readWorkbook(new Uint8Array(await wb.xlsx.writeBuffer()))).rejects.toThrow(/нет колонок: «Наименование груза», «Количество, мест», «Вес брутто, кг»/)
  })
})

describe('загрузка отгрузок из Excel: проверка', () => {
  it('поля отгрузки — из первой строки; в следующей другое значение — ошибка', async () => {
    const r = await checkRows(
      [
        row(2, { ref: 'А-1', loadingAt: '01.10.2026', consigneeInn: '1167049238', ...line }),
        row(3, { ref: 'А-1', ...line }),
        row(4, { consigneeInn: '7856057554', ...line }),
      ],
      ctx(),
    )
    expect(r.errors).toEqual([{ row: 4, ref: 'А-1', text: '«ИНН получателя» отличается от первой строки отгрузки' }])
  })

  it('по ИНН подставляем название и адрес; не нашли — берём из таблицы с пометкой, без названия — ошибка', async () => {
    const ok = await checkRows([row(2, { ref: 'А-1', loadingAt: '01.10.2026', consigneeInn: '1167049238', ...line })], ctx())
    expect(ok.shipments[0]).toMatchObject({ consignee: { name: 'ООО «Волга»' }, unloadingAddress: '420032, г. Казань, ул. Тэцевская, 4', loadingAddress: 'Елабуга, склад', consigneeChecked: true })

    const known = await checkRows([row(2, { ref: 'А-1', loadingAt: '01.10.2026', consigneeInn: '7707083893', consigneeName: 'ПАО Сбербанк', unloadingAddress: 'Москва', ...line })], ctx())
    expect(known.errors).toEqual([])
    expect(known.shipments[0]).toMatchObject({ consignee: { name: 'ПАО Сбербанк' }, consigneeChecked: false })
    expect(known.warnings[0]!.text).toMatch(/не нашёлся в ЕГРЮЛ — название получателя взяли из таблицы/)

    const bad = await checkRows([row(2, { ref: 'А-1', loadingAt: '01.10.2026', consigneeInn: '7707083893', ...line })], ctx())
    expect(bad.errors[0]!.text).toMatch(/впишите название получателя/)
  })

  it('справочник спрашиваем один раз на ИНН', async () => {
    let n = 0
    const counting: OrgDirectory = { findByInn: async (inn) => (n++, demo.get(inn) ?? null) }
    await checkRows(
      [1, 2, 3].map((i) => row(i + 1, { ref: `А-${i}`, loadingAt: '01.10.2026', consigneeInn: '1167049238', ...line })),
      ctx({ directory: counting }),
    )
    expect(n).toBe(1)
  })

  it('уже открытая в боте отгрузка — ошибка; своя неоткрытая — замена с предупреждением', async () => {
    // existing отвечает только про учётку этого отправителя: номера других компаний не мешают (решение 29.09)
    const existing = async () =>
      new Map([
        ['А-2', { started: true }],
        ['А-3', { started: false }],
      ])
    const r = await checkRows(
      [1, 2, 3].map((i) => row(i + 1, { ref: `А-${i}`, loadingAt: '01.10.2026', consigneeInn: '1167049238', ...line })),
      ctx({ existing }),
    )
    expect(r.errors.map((e) => e.ref)).toEqual(['А-2'])
    expect(r.warnings).toEqual([{ row: 4, ref: 'А-3', text: 'отгрузка с таким номером уже есть — заменим её данными из таблицы' }])
  })

  it('получатель — сам отправитель, прошедшая дата, вес больше машины', async () => {
    const r = await checkRows(
      [
        row(2, { ref: 'А-1', loadingAt: '01.10.2026', consigneeInn: SHIPPER, ...line }),
        row(3, { ref: 'А-2', loadingAt: '01.09.2026', consigneeInn: '1167049238', ...line }),
        row(4, { ref: 'А-3', loadingAt: '01.10.2026', consigneeInn: '1167049238', ...line, grossKg: 90_000 }),
      ],
      ctx(),
    )
    expect(r.errors.map((e) => e.text)).toEqual(['получатель совпадает с отправителем', expect.stringMatching(/больше, чем везёт одна машина/)])
    expect(r.warnings.map((w) => w.text)).toEqual(['дата погрузки уже прошла'])
    expect(r.shipments.map((s) => s.ref)).toEqual(['А-2'])
  })
})

describe('загрузка отгрузок из Excel: даты и телефоны', () => {
  it('дата: текст, текст без времени, дата Excel — всё по Москве', () => {
    expect(parseLoadingAt('01.10.2026 10:30')?.toISOString()).toBe('2026-10-01T07:30:00.000Z')
    expect(parseLoadingAt('1.10.2026')?.toISOString()).toBe('2026-10-01T06:00:00.000Z')
    expect(parseLoadingAt(new Date(Date.UTC(2026, 9, 1, 10, 30)))?.toISOString()).toBe('2026-10-01T07:30:00.000Z')
    expect(parseLoadingAt(46296.4375)?.toISOString()).toBe('2026-10-01T07:30:00.000Z')
    expect(parseLoadingAt('31.09.2026')).toBeNull()
    expect(parseLoadingAt('завтра')).toBeNull()
  })

  it('телефон приводим к +7XXXXXXXXXX', () => {
    expect(normalizePhone('8 (917) 200-00-01')).toBe('+79172000001')
    expect(normalizePhone('+7 957 000-51-94')).toBe('+79570005194')
    expect(normalizePhone(9172000001)).toBe('+79172000001')
    expect(normalizePhone('12-34')).toBeNull()
  })
})
