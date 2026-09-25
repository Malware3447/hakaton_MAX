import { describe, expect, it } from 'vitest'
import { decode1251 } from './format.ts'
import { buildT1, buildT2, splitName, type T1Input } from './titles.ts'
import { validateTitle } from './testing/xsd.ts'

// ОТГ-2026-1040 из демо-данных: сценарий показа
const t1Input = (over: Partial<T1Input> = {}): T1Input => ({
  number: 'ОТГ-2026-1040',
  date: new Date('2026-09-25T08:00:00Z'),
  createdAt: new Date('2026-09-25T09:40:00Z'),
  senderId: '2DM-9782242514',
  receiverId: '2DM-DEMO-OPER',
  shipper: { name: 'ООО «Волжский завод моторных масел»', inn: '9782242514', kpp: '165001001', phone: '+79172000001' },
  consignee: { name: 'ООО «Волга»', inn: '1167049238', kpp: '116701001', phone: '+79570005194', address: '420032, г. Казань, ул. Тэцевская, 4' },
  carrier: { name: 'ООО «ГрузЛайн-Казань»', inn: '3603931407', kpp: '165501001', phone: '+79170001122' },
  driver: { surname: 'Петров', name: 'Иван', phone: '+79170001122' },
  vehicle: { plate: 'А245КМ116', ownership: 'own', type: 'Грузовой бортовой', brand: 'КАМАЗ 65115', capacityT: 15, volumeM3: 30 },
  cargo: [
    { name: 'Масло трансмиссионное 75W-90, канистра 20 л', places: 40, grossKg: 752, marking: 'ЕАЭС N RU Д-RU.РА01.В.12348/26', packageCode: 'CN', packing: 'Заводская упаковка на поддонах', condition: 'Без повреждений' },
    { name: 'Масло моторное 10W-40 полусинтетическое, бочка 216,5 л', places: 6, grossKg: 1242, marking: 'ЕАЭС N RU Д-RU.РА01.В.12346/26', packageCode: 'CN', packing: 'Бочки на поддонах', condition: 'Без повреждений' },
  ],
  instructions: 'Особых условий нет',
  loading: {
    address: '423600, Республика Татарстан, г. Елабуга, ОЭЗ «Алабуга», ул. Ш-2, 4/1, склад готовой продукции, ворота 3',
    planned: new Date('2026-09-25T08:00:00Z'),
    arrived: new Date('2026-09-25T07:52:00Z'),
    departed: new Date('2026-09-25T09:31:00Z'),
    grossKg: 1994,
    places: 46,
  },
  signer: { surname: 'Соколова', name: 'Марина' },
  guid: '00000000-0000-4000-8000-000000000001',
  ...over,
})

describe('Т1 — сведения грузоотправителя', () => {
  it('ОТГ-2026-1040 проходит официальную XSD ФНС', async () => {
    const t1 = buildT1(t1Input())
    const res = await validateTitle('T1', t1.bytes)
    expect(res.errors).toEqual([])
    expect(res.valid).toBe(true)
  })

  it('имя файла по формату и байты в windows-1251', () => {
    const t1 = buildT1(t1Input())
    expect(t1.fileId).toBe('ON_TRNACLGROT_2DM-DEMO-OPER_2DM-9782242514_20260925_00000000-0000-4000-8000-000000000001')
    const text = decode1251(t1.bytes)
    expect(text).toMatch(/^<\?xml version="1.0" encoding="windows-1251"\?>/)
    expect(text).toContain('НаимОрг="ООО «Волга»"')
    expect(text).toContain('ФДатВрПриб="25.09.2026T10:52:00+03:00"')
    expect(t1.sha256).toMatch(/^[0-9a-f]{64}$/)
  })

  it('перевозчик — ИП: ИНН 12 знаков и ФИО', async () => {
    const t1 = buildT1(
      t1Input({ carrier: { name: 'ИП Хабибуллин Р. Ф.', inn: '165595589478', kpp: null, person: { surname: 'Хабибуллин', name: 'Рустам', patronymic: 'Фаридович' }, phone: '+79170000000' } }),
    )
    expect((await validateTitle('T1', t1.bytes)).valid).toBe(true)
  })

  it('схема ловит ошибку: ИНН не той длины', async () => {
    const t1 = buildT1(t1Input({ consignee: { ...t1Input().consignee, inn: '116704923' } }))
    const res = await validateTitle('T1', t1.bytes)
    expect(res.valid).toBe(false)
    expect(res.errors.join('\n')).toMatch(/ИННЮЛ/)
  })
})

describe('Т2 — приём груза перевозчиком', () => {
  const t1 = buildT1(t1Input())
  const base = {
    createdAt: new Date('2026-09-25T09:45:00Z'),
    senderId: '2DM-3603931407',
    receiverId: '2DM-DEMO-OPER',
    t1: { fileId: t1.fileId, createdAt: new Date('2026-09-25T09:40:00Z'), signatureBase64: Buffer.from('CMS').toString('base64') },
    uid: 'a5b0c7e2-3f4d-4e21-9c8b-1d2e3f4a5b6c',
    signer: { surname: 'Романов', name: 'Олег' },
  }

  it('без замечаний проходит XSD и ссылается на Т1', async () => {
    const t2 = buildT2({ ...base, remarks: null })
    expect((await validateTitle('T2', t2.bytes)).errors).toEqual([])
    expect(decode1251(t2.bytes)).toContain(`ИдФайлИнфГО="${t1.fileId}"`)
  })

  it('с замечаниями водителя при погрузке проходит XSD', async () => {
    const t2 = buildT2({ ...base, remarks: { cargo: 'Недостача 2 канистр', places: 'Принято 44 места из 46' } })
    expect((await validateTitle('T2', t2.bytes)).valid).toBe(true)
    expect(decode1251(t2.bytes)).toContain('ЗамСостГруз="Недостача 2 канистр"')
  })
})

describe('ФИО из профиля MAX', () => {
  it('«Иван Петров» → Петров Иван', () => {
    expect(splitName('Иван Петров')).toEqual({ surname: 'Петров', name: 'Иван' })
    expect(splitName('Марина')).toEqual({ surname: 'Марина', name: 'Марина' })
  })
})
