import { createHash } from 'node:crypto'
import iconv from 'iconv-lite'

// Даты, время, кодировка и имена файлов по формату ЭТрН 5.01 (приказ ФНС ЕД-7-26/1065@).
// Все даты — по Москве: так их видят люди на накладной.

const MSK = 3 * 60 * 60 * 1000
const pad = (n: number) => String(n).padStart(2, '0')
const msk = (d: Date) => new Date(d.getTime() + MSK)

/** ДатаТип: ДД.ММ.ГГГГ */
export const fmtDate = (d: Date) => {
  const m = msk(d)
  return `${pad(m.getUTCDate())}.${pad(m.getUTCMonth() + 1)}.${m.getUTCFullYear()}`
}

/** ВремяТип: ЧЧ:ММ:СС */
export const fmtTime = (d: Date) => {
  const m = msk(d)
  return `${pad(m.getUTCHours())}:${pad(m.getUTCMinutes())}:${pad(m.getUTCSeconds())}`
}

/** ДатаВремяВЗТип: ДД.ММ.ГГГГTЧЧ:ММ:СС+03:00 */
export const fmtDateTime = (d: Date) => `${fmtDate(d)}T${fmtTime(d)}+03:00`

const yyyymmdd = (d: Date) => fmtDate(d).split('.').reverse().join('')

/**
 * ИдФайл: <префикс титула>_<идентификатор получателя>_<идентификатор отправителя>_<ГГГГММДД>_<GUID>.
 * Идентификаторы участников ЭДО выдаёт оператор ЭПД; на хакатоне оператор — модель.
 */
export const fileId = (prefix: string, receiverId: string, senderId: string, at: Date, guid: string) =>
  `${prefix}_${receiverId}_${senderId}_${yyyymmdd(at)}_${guid}`

/** Байты файла: windows-1251, как объявлено в заголовке XML. Именно их подписывают и проверяют. */
export const encode1251 = (xml: string): Uint8Array => new Uint8Array(iconv.encode(xml, 'win1251'))
export const decode1251 = (bytes: Uint8Array) => iconv.decode(Buffer.from(bytes), 'win1251')

export const sha256hex = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')

/** Масса: до трёх знаков после запятой, без лишних нулей. */
export const fmtKg = (kg: number) => String(Math.round(kg * 1000) / 1000)
