import type { FastifyBaseLogger } from 'fastify'
import type { PoaRegistry, RegistryStatus } from '../core/poa.ts'

// Реестр МЧД ФНС (распределённый реестр m4d.nalog.gov.ru, HAKATON-49).
// Открытого API у ФНС нет. Страница «Проверить МЧД» (m4d.nalog.gov.ru/EMCHD/check-status?guid=…)
// берёт статус запросом GET /api/v1/poar-portal/get_info_short?dovelGuid=<номер> с заголовком ApiKey,
// ключ отдаёт сама страница. Формат ответа не опубликован, поэтому разбираем осторожно:
// подпись запрещаем только при явном «отозвана / истекла / не найдена», всё непонятное — «реестр недоступен»,
// а тело ответа пишем в журнал, чтобы подогнать разбор.

export const FNS_POA_URL = 'https://m4d.nalog.gov.ru/api/v1/poar-portal/get_info_short'

/** Ответ реестра помним 10 минут, после сбоя сеть не трогаем 5 минут: подпись не должна ждать таймаута каждый раз. */
export const REGISTRY_TTL_MS = { answer: 10 * 60_000, outage: 5 * 60_000 }

type Answer = Exclude<RegistryStatus, 'unavailable'>

/** Строки статуса из ответа → наш статус. Порядок важен: «недействительна» раньше «действительна». */
const RULES: [RegExp, Answer][] = [
  [/отозван|отмен|аннулир|revok|cancel/i, 'revoked'],
  [/истек|истёк|срок.*(законч|прош)|expired/i, 'expired'],
  [/не\s*найден|отсутств|not[_\s]*found/i, 'not_found'],
  [/недейств|приостановл|invalid|suspend/i, 'revoked'],
  [/действ|зарегистр|active|valid|registered/i, 'active'],
]

export function statusFromText(s: string): Answer | null {
  for (const [re, status] of RULES) if (re.test(s)) return status
  return null
}

/** Строковые значения полей, похожих на статус, на любой глубине ответа. */
function statusStrings(v: unknown, key = '', out: string[] = []): string[] {
  if (typeof v === 'string') {
    if (/status|state|статус|состоян/i.test(key)) out.push(v)
  } else if (Array.isArray(v)) v.forEach((x) => statusStrings(x, key, out))
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) statusStrings(x, k, out)
  return out
}

export class FnsPoaRegistry implements PoaRegistry {
  private readonly cache = new Map<string, { status: Answer; at: number }>()
  private downUntil = 0

  constructor(
    private readonly opts: { url?: string; apiKey?: string | null; timeoutMs?: number },
    private readonly log: Pick<FastifyBaseLogger, 'warn' | 'info'>,
    private readonly fetchFn: typeof fetch = fetch,
    private readonly now: () => number = () => Date.now(),
  ) {}

  async status(number: string): Promise<RegistryStatus> {
    const key = number.toLowerCase()
    const hit = this.cache.get(key)
    if (hit && this.now() - hit.at < REGISTRY_TTL_MS.answer) return hit.status
    if (this.now() < this.downUntil) return 'unavailable'
    const status = await this.ask(key)
    if (status === 'unavailable') this.downUntil = this.now() + REGISTRY_TTL_MS.outage
    else this.cache.set(key, { status, at: this.now() })
    return status
  }

  private async ask(number: string): Promise<RegistryStatus> {
    const url = `${this.opts.url ?? FNS_POA_URL}?dovelGuid=${encodeURIComponent(number)}`
    let res: Response
    let body: string
    try {
      res = await this.fetchFn(url, {
        headers: { Accept: 'application/json', ...(this.opts.apiKey ? { ApiKey: this.opts.apiKey } : {}) },
        signal: AbortSignal.timeout(this.opts.timeoutMs ?? 4000),
      })
      body = await res.text()
    } catch (err) {
      this.log.warn({ err: String(err) }, 'реестр МЧД ФНС не отвечает')
      return 'unavailable'
    }
    let json: unknown = null
    try {
      json = JSON.parse(body)
    } catch {
      /* не JSON — ниже попадёт в «недоступен» */
    }
    const texts = json ? statusStrings(json) : []
    // «не найдена» верим только русскому тексту или 404 с JSON про доверенность: 404 шлюза без тела не в счёт
    if (res.status === 404 && json && /не\s*найден|доверенност/i.test(body)) return 'not_found'
    if (res.ok) {
      for (const t of texts) {
        const s = statusFromText(t)
        if (s) return s
      }
    }
    this.log.warn({ httpStatus: res.status, body: body.slice(0, 500) }, 'реестр МЧД ФНС: ответ не разобран')
    return 'unavailable'
  }
}
