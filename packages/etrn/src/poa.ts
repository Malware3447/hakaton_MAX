// Машиночитаемая доверенность (МЧД) формата 003, EMCHD_1 — схема xsd/ON_EMCHD_1_928_00_01_01_01.xsd
// (ГНИВЦ ФНС). Задача HAKATON-49: сотрудник подписывает накладную за компанию только по действующей МЧД.
//
// Здесь три шага, и ни один не ходит в сеть сам:
// 1. parsePoa — разобрать файл МЧД и достать то, что проверяем и пишем в титул;
// 2. checkPoa — сверить МЧД с нашей компанией, человеком и сегодняшней датой;
// 3. verifyPoaSignature — проверить подпись руководителя под файлом (та же проверка ГОСТ, что у «Госключа»).
// Статус в реестре ФНС (зарегистрирована, не отозвана) — отдельный адаптер в приложении: с сервера в США
// реестр m4d.nalog.gov.ru недоступен.

import { XMLParser } from 'fast-xml-parser'
import { isValidInn, normalizeInn } from '@nk/domain'
import { decode1251 } from './format.ts'
import type { PkiStore } from './pki.ts'
import { verifyGoskeySignature, type Check as SigCheck, type GoskeyVerification } from './signature-verify.ts'

export const POA_FORMAT = 'EMCHD_1'
const GUID = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i

export interface PoaPerson {
  surname: string
  name: string
  patronymic: string | null
  /** ИНН физлица, 12 цифр */
  inn: string | null
  /** СНИЛС только цифрами */
  snils: string | null
  position: string | null
}

export interface PoaPrincipal {
  /** org — российское юрлицо, ip — ИП, person — физлицо, foreign — иностранная организация */
  kind: 'org' | 'ip' | 'person' | 'foreign'
  name: string | null
  /** ИНН юрлица (10) или ИП (12) */
  inn: string | null
  kpp: string | null
  ogrn: string | null
  /** кто подписывает доверенность за юрлицо без доверенности (руководитель); у ИП — сам ИП */
  head: PoaPerson | null
}

export interface PoaRepresentative {
  kind: 'person' | 'org' | 'ip' | 'branch' | 'foreign'
  person: PoaPerson | null
  orgInn: string | null
  orgName: string | null
}

export interface PoaPower {
  code: string
  name: string
}

export interface PoaDocument {
  version: string
  /** единый регистрационный номер — он же ИдентДовер в титуле ЭТрН */
  number: string
  internalNumber: string | null
  /** ГГГГ-ММ-ДД */
  issuedAt: string
  validTo: string
  /** выдана в порядке передоверия */
  retrust: boolean
  principals: PoaPrincipal[]
  representatives: PoaRepresentative[]
  powers: { text: string | null; machine: PoaPower[]; joint: boolean }
}

export class PoaFormatError extends Error {}

// ---------- 1. Разбор ----------

type X = Record<string, unknown>
const obj = (v: unknown): X | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as X) : null)
const arr = (v: unknown): X[] => (Array.isArray(v) ? v : v === undefined ? [] : [v]).map(obj).filter((x): x is X => !!x)
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : typeof v === 'number' ? String(v) : null)
const at = (x: X | null, name: string) => str(x?.[`@${name}`])
const digits = (s: string | null) => (s ? s.replace(/\D/g, '') || null : null)

function decode(bytes: Uint8Array): string {
  const head = Buffer.from(bytes.subarray(0, 200)).toString('latin1')
  const enc = /encoding=["']([^"']+)["']/i.exec(head)?.[1]?.toLowerCase()
  if (enc === 'windows-1251' || enc === 'cp1251') return decode1251(bytes)
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes).replace(/^﻿/, '')
}

function person(fl: X | null, extra: { inn?: string | null; snils?: string | null; position?: string | null } = {}): PoaPerson | null {
  // СвФЛТип: атрибуты ИННФЛ, СНИЛС, Должность и вложенный СведФЛ/ФИО
  const sved = obj(fl?.['СведФЛ'])
  const fio = obj(sved?.['ФИО']) ?? obj(fl?.['ФИО'])
  if (!fio) return null
  return {
    surname: at(fio, 'Фамилия') ?? '',
    name: at(fio, 'Имя') ?? '',
    patronymic: at(fio, 'Отчество'),
    inn: normalizeInn(extra.inn ?? at(fl, 'ИННФЛ') ?? '') ,
    snils: digits(extra.snils ?? at(fl, 'СНИЛС')),
    position: extra.position ?? at(fl, 'Должность'),
  }
}

function principal(entry: X): PoaPrincipal {
  const d = obj(entry['Доверит'])
  const ros = obj(d?.['РосОргДовер'])
  if (ros) {
    const org = obj(ros['СвРосОрг'])
    const bez = obj(ros['ЛицоБезДов'])
    // руководитель — физлицо, действующее от имени юрлица без доверенности
    const fl = arr(bez?.['СвФЛ'])[0] ?? null
    return { kind: 'org', name: at(org, 'НаимОрг'), inn: normalizeInn(at(org, 'ИННЮЛ') ?? ''), kpp: at(org, 'КПП'), ogrn: at(org, 'ОГРН'), head: person(fl) }
  }
  const ip = obj(d?.['ИПДовер'])
  if (ip) {
    const head = person(ip, { inn: at(ip, 'ИННФЛ'), snils: at(ip, 'СНИЛС') })
    return { kind: 'ip', name: at(ip, 'НаимИП'), inn: normalizeInn(at(ip, 'ИННФЛ') ?? ''), kpp: null, ogrn: at(ip, 'ОГРНИП'), head }
  }
  const fl = obj(d?.['ФЛДовер'])
  if (fl) return { kind: 'person', name: null, inn: normalizeInn(at(fl, 'ИННФЛ') ?? ''), kpp: null, ogrn: null, head: person(fl) }
  return { kind: 'foreign', name: null, inn: null, kpp: null, ogrn: null, head: null }
}

function representative(entry: X): PoaRepresentative {
  const p = obj(entry['Пред'])
  const fl = obj(p?.['СведФизЛ'])
  if (fl) return { kind: 'person', person: person(fl), orgInn: null, orgName: null }
  const ip = obj(p?.['СведИП'])
  if (ip) return { kind: 'ip', person: person(ip, { inn: at(ip, 'ИННФЛ'), snils: at(ip, 'СНИЛС') }), orgInn: normalizeInn(at(ip, 'ИННФЛ') ?? ''), orgName: at(ip, 'НаимИП') }
  const org = obj(p?.['СведОрг']) ?? obj(p?.['СведФилиал'])
  if (org) return { kind: p?.['СведФилиал'] ? 'branch' : 'org', person: null, orgInn: normalizeInn(at(org, 'ИННЮЛ') ?? ''), orgName: at(org, 'НаимОрг') }
  return { kind: 'foreign', person: null, orgInn: null, orgName: null }
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@',
  removeNSPrefix: true,
  parseAttributeValue: false,
  parseTagValue: false,
  trimValues: true,
})

/** Разобрать файл МЧД. Бросает PoaFormatError с объяснением по-русски, если это не МЧД формата 003. */
export function parsePoa(bytes: Uint8Array): PoaDocument {
  let root: X
  try {
    root = obj(parser.parse(decode(bytes))) ?? {}
  } catch (e) {
    throw new PoaFormatError(`файл не читается как XML: ${(e as Error).message}`)
  }
  const d = obj(root['Доверенность'])
  if (!d) throw new PoaFormatError('это не машиночитаемая доверенность: нет элемента «Доверенность»')
  const version = at(d, 'ВерсФорм') ?? ''
  if (version !== POA_FORMAT) throw new PoaFormatError(`доверенность формата «${version || '?'}», а принимаем единый формат 003 (${POA_FORMAT})`)
  const doc = obj(d['Документ'])
  const direct = obj(doc?.['Довер'])
  const retrustNode = obj(doc?.['Передов'])
  const body = direct ?? retrustNode
  if (!body) throw new PoaFormatError('в доверенности нет сведений о доверенности')

  const sv = obj(direct ? body['СвДов'] : body['СвПереДовер'])
  const number = at(sv, 'НомДовер')
  const issuedAt = at(sv, 'ДатаВыдДовер')
  const validTo = at(sv, 'СрокДейст')
  if (!number || !issuedAt || !validTo) throw new PoaFormatError('в доверенности нет номера, даты выдачи или срока действия')

  const principals = direct ? arr(body['СвДоверит']).map(principal) : arr(body['СвПередПолн']).map((e) => principal({ Доверит: { РосОргДовер: obj(e['ПередПолн'])?.['РосОргПерПолн'], ИПДовер: obj(e['ПередПолн'])?.['ИППерПолн'] } }))
  const representatives = arr(direct ? body['СвУпПред'] : body['СвПолучПолн']).map(representative)
  const polnNode = obj(body['СвПолн'])
  const machine = arr(polnNode?.['МашПолн']).map((m) => ({ code: at(m, 'КодПолн') ?? '', name: at(m, 'НаимПолн') ?? '' }))
  return {
    version,
    number: number.toLowerCase(),
    internalNumber: at(sv, 'ВнНомДовер'),
    issuedAt,
    validTo,
    retrust: !direct,
    principals,
    representatives,
    powers: { text: str(polnNode?.['ТекстПолн']), machine, joint: at(polnNode, 'ПрСовмПолн') === '1' },
  }
}

// ---------- 2. Проверка содержимого ----------

export type PoaCheckName = 'format' | 'number' | 'issued' | 'valid_to' | 'principal' | 'representative' | 'powers' | 'retrust' | 'registry'

export interface PoaCheck {
  name: PoaCheckName
  ok: boolean
  /** warning — не мешает подписи, но показать человеку */
  level: 'error' | 'warning' | 'info'
  message: string
}

export interface PoaContext {
  /** ИНН компании, за которую подписывают */
  orgInn: string
  /** как человек записан у нас (имя из MAX или подтверждённое ФИО) */
  personName: string
  /** ИНН или СНИЛС представителя, если уже знаем (из сертификата подписи) */
  personInn?: string | null
  personSnils?: string | null
  now?: Date
  /** за сколько дней до конца срока предупреждать */
  warnDays?: number
}

export interface PoaCheckResult {
  ok: boolean
  checks: PoaCheck[]
  /** представитель, которого узнали в этом человеке */
  representative: PoaPerson | null
  daysLeft: number
}

const norm = (s: string) => s.toLowerCase().replace(/ё/g, 'е').replace(/[^а-яa-z]/g, '')
const DAY = 86_400_000
const dayStart = (d: Date) => Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())
const parseDay = (s: string) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s)
  return m ? Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : NaN
}

/** Совпадает ли представитель с человеком: по ИНН или СНИЛС, если известны, иначе по фамилии и имени. */
export function samePerson(p: PoaPerson, who: { name: string; inn?: string | null; snils?: string | null }): boolean {
  if (who.inn && p.inn) return normalizeInn(who.inn) === p.inn
  if (who.snils && p.snils) return who.snils.replace(/\D/g, '') === p.snils
  const words = who.name.split(/\s+/).map(norm).filter(Boolean)
  return !!p.surname && !!p.name && words.includes(norm(p.surname)) && words.includes(norm(p.name))
}

/**
 * Полномочия на перевозочные документы. Классификатор полномочий ФНС мы не держим, поэтому узнаём
 * по словам в названии или тексте. Не узнали — предупреждение, а не отказ: решает человек.
 */
const TRANSPORT = /(перевоз|транспортн|накладн|эпд|этрн|грузоотправ|грузополуч|приемк|приёмк|отгрузк)/i
const SIGN_ANY = /(подпис[а-я]* (любых|все|всех)|без ограничен|все полномочия|в полном объеме)/i

export function checkPoa(poa: PoaDocument, ctx: PoaContext): PoaCheckResult {
  const now = ctx.now ?? new Date()
  const warnDays = ctx.warnDays ?? 14
  const checks: PoaCheck[] = []
  const add = (name: PoaCheckName, ok: boolean, message: string, level: PoaCheck['level'] = ok ? 'info' : 'error') => checks.push({ name, ok, level, message })

  add('format', true, 'единый формат МЧД 003')
  add('number', GUID.test(poa.number), GUID.test(poa.number) ? `номер ${poa.number}` : `номер «${poa.number}» не похож на номер из реестра ФНС`)

  const today = dayStart(now)
  const issued = parseDay(poa.issuedAt)
  const until = parseDay(poa.validTo)
  if (Number.isNaN(issued)) add('issued', false, `дата выдачи «${poa.issuedAt}» не читается`)
  else add('issued', issued <= today, issued <= today ? `выдана ${ru(poa.issuedAt)}` : `дата выдачи ${ru(poa.issuedAt)} ещё не наступила`)
  const daysLeft = Number.isNaN(until) ? -1 : Math.round((until - today) / DAY)
  if (Number.isNaN(until)) add('valid_to', false, `срок действия «${poa.validTo}» не читается`)
  else if (daysLeft < 0) add('valid_to', false, `срок действия закончился ${ru(poa.validTo)}`)
  else if (daysLeft <= warnDays) add('valid_to', true, `действует до ${ru(poa.validTo)} — осталось ${daysLeft} дн., пора продлить`, 'warning')
  else add('valid_to', true, `действует до ${ru(poa.validTo)}`)

  const orgInn = normalizeInn(ctx.orgInn)
  const p = poa.principals.find((x) => x.inn && x.inn === orgInn)
  if (poa.principals.length !== 1) add('principal', !!p, p ? `доверителей ${poa.principals.length}, среди них ваша компания` : `доверителей ${poa.principals.length}, вашей компании (ИНН ${orgInn}) среди них нет`)
  else if (!p) add('principal', false, `доверенность выдана другой компанией: ИНН ${poa.principals[0]!.inn ?? '—'}${poa.principals[0]!.name ? ` (${poa.principals[0]!.name})` : ''}, а ваша — ${orgInn}`)
  else if (p.inn && !isValidInn(p.inn)) add('principal', false, `у доверителя ИНН ${p.inn} с ошибкой в контрольной цифре`)
  else add('principal', true, `доверитель — ${p.name ?? 'ваша компания'}, ИНН ${p.inn}`)

  const people = poa.representatives.flatMap((r) => (r.person ? [r.person] : []))
  const me = people.find((x) => samePerson(x, { name: ctx.personName, inn: ctx.personInn, snils: ctx.personSnils })) ?? null
  if (!people.length) add('representative', false, 'представитель в доверенности — организация, а подписывать должен человек')
  else if (!me) add('representative', false, `доверенность выдана ${people.map(fio).join(', ')}, а не вам (${ctx.personName})`)
  else add('representative', true, `представитель — ${fio(me)}${me.inn ? `, ИНН ${me.inn}` : ''}`)

  if (poa.retrust) add('retrust', true, 'доверенность в порядке передоверия: проверяем только последнее звено', 'warning')

  const texts = [poa.powers.text ?? '', ...poa.powers.machine.map((m) => m.name)]
  if (texts.some((t) => TRANSPORT.test(t) || SIGN_ANY.test(t))) add('powers', true, 'есть полномочия на перевозочные документы')
  else add('powers', true, 'не нашли в полномочиях перевозочные документы — проверьте, что доверенность даёт право подписывать транспортную накладную', 'warning')

  return { ok: checks.every((c) => c.ok), checks, representative: me, daysLeft }
}

const ru = (iso: string) => iso.split('-').reverse().join('.')
export const fio = (p: PoaPerson) => [p.surname, p.name, p.patronymic].filter(Boolean).join(' ')

// ---------- 3. Подпись руководителя под файлом МЧД ----------

export interface PoaSignatureResult {
  ok: boolean
  signature: GoskeyVerification
  /** подписал тот, кто вправе выдать доверенность: руководитель юрлица или сам ИП */
  signerIsHead: SigCheck
}

/**
 * Доверенность подписывает доверитель квалифицированной подписью: за юрлицо — руководитель
 * (сертификат УЦ ФНС с ИНН юрлица), ИП — сам. Проверка подписи — та же, что у «Госключа»:
 * хеш, математика, цепочка до корня Минцифры, отзыв, сроки, ИНН. УНЭП для доверенности не годится.
 */
export async function verifyPoaSignature(input: { poa: PoaDocument; file: Uint8Array; sig: Uint8Array; orgInn: string; pki: PkiStore; now?: Date; anchorName?: string }): Promise<PoaSignatureResult> {
  const signature = await verifyGoskeySignature({ document: input.file, sig: input.sig, expectedInn: input.orgInn, pki: input.pki, now: input.now, anchorName: input.anchorName })
  const p = input.poa.principals.find((x) => x.inn === normalizeInn(input.orgInn))
  const head = p?.head ?? null
  const s = signature.signer
  let signerIsHead: SigCheck
  if (signature.level !== 'ukep') signerIsHead = { name: 'chain', ok: false, message: 'доверенность подписана не квалифицированной подписью' }
  else if (!head || !s) signerIsHead = { name: 'inn', ok: false, message: 'в доверенности нет сведений о руководителе, который её подписал' }
  else {
    const byId = (head.snils && s.snils && head.snils === s.snils.replace(/\D/g, '')) || (head.inn && s.personInn && head.inn === s.personInn)
    const byName = !!s.surname && norm(s.surname) === norm(head.surname)
    const ok = head.snils && s.snils ? !!byId : byName
    signerIsHead = { name: 'inn', ok, message: ok ? `подписал руководитель: ${fio(head)}` : `подписал ${s.fullName ?? 'не руководитель'}, а в доверенности руководитель — ${fio(head)}` }
  }
  return { ok: signature.ok && signerIsHead.ok, signature, signerIsHead }
}
