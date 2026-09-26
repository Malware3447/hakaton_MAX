import type { OrgDirectory, OrgRequisites } from '@nk/domain'
import type { FastifyBaseLogger } from 'fastify'

// Справочник организаций — DaData, «Найти компанию по ИНН» (findById/party): данные ЕГРЮЛ и ЕГРИП.
// Документация: dadata.ru/api/find-party. Бесплатно до 10 000 запросов в день, нужен ключ API.
// Сбой DaData не должен ломать подключение: ошибка → «не нашли», дальше ручной ввод.

const URL_FIND = 'https://suggestions.dadata.ru/suggestions/api/4_1/rs/findById/party'

const STATUS: Record<string, OrgRequisites['status']> = {
  ACTIVE: 'active',
  LIQUIDATING: 'liquidating',
  LIQUIDATED: 'liquidated',
  BANKRUPT: 'bankrupt',
  REORGANIZING: 'reorganizing',
}

interface PartySuggestion {
  value: string
  data: {
    inn: string
    kpp?: string | null
    ogrn?: string | null
    type?: 'LEGAL' | 'INDIVIDUAL'
    name?: { short_with_opf?: string | null; full_with_opf?: string | null }
    address?: { value?: string | null; unrestricted_value?: string | null } | null
    state?: { status?: string | null } | null
  }
}

/** ООО "МОТОРИКА" → ООО «МОТОРИКА»: так названия записаны в демо-данных и накладной. */
export const russianQuotes = (s: string) => s.replace(/"([^"]*)"/g, '«$1»')

/** Кэш ответов DaData: реализация на таблице org_lookup_cache — OrgLookupCacheDb. */
export interface OrgLookupCache {
  get(inn: string): Promise<{ found: OrgRequisites | null; fetchedAt: Date } | null>
  put(inn: string, found: OrgRequisites | null): Promise<void>
}

const DAY_MS = 24 * 60 * 60 * 1000
/** Найденную компанию помним неделю (статус в ЕГРЮЛ меняется редко), «не нашли» — сутки. */
export const CACHE_TTL_MS = { found: 7 * DAY_MS, missing: DAY_MS }

class DadataUnavailable extends Error {}

export class DadataDirectory implements OrgDirectory {
  constructor(
    private readonly apiKey: string,
    private readonly log: Pick<FastifyBaseLogger, 'warn'>,
    private readonly fetchFn: typeof fetch = fetch,
    private readonly cache: OrgLookupCache | null = null,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async findByInn(inn: string): Promise<OrgRequisites | null> {
    const hit = await this.cache?.get(inn).catch((err) => {
      this.log.warn({ err }, 'кэш DaData недоступен')
      return null
    })
    if (hit && this.now().getTime() - hit.fetchedAt.getTime() < (hit.found ? CACHE_TTL_MS.found : CACHE_TTL_MS.missing)) return hit.found
    try {
      const found = await this.fetchParty(inn)
      await this.cache?.put(inn, found).catch((err) => this.log.warn({ err }, 'не записать ответ DaData в кэш'))
      return found
    } catch (err) {
      // DaData недоступна: лучше устаревший ответ из кэша, чем никакого; сбой в кэш не пишем
      if (!(err instanceof DadataUnavailable)) this.log.warn({ err }, 'DaData недоступна')
      return hit?.found ?? null
    }
  }

  /** Запрос к DaData. null — ИНН нет в ЕГРЮЛ; исключение — DaData не ответила. */
  private async fetchParty(inn: string): Promise<OrgRequisites | null> {
    const res = await this.fetchFn(URL_FIND, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: `Token ${this.apiKey}` },
      // Головная организация: у филиалов тот же ИНН, но свой КПП и адрес
      body: JSON.stringify({ query: inn, branch_type: 'MAIN' }),
      signal: AbortSignal.timeout(5000),
    })
    if (!res.ok) {
      this.log.warn({ status: res.status }, 'DaData не ответила')
      throw new DadataUnavailable(String(res.status))
    }
    const { suggestions } = (await res.json()) as { suggestions?: PartySuggestion[] }
    const d = suggestions?.find((s) => s.data.inn === inn)?.data
    if (!d) return null
    const name = d.name?.short_with_opf || d.name?.full_with_opf || suggestions![0]!.value
    return {
      inn: d.inn,
      kpp: d.kpp ?? null,
      name: russianQuotes(name),
      address: d.address?.unrestricted_value || d.address?.value || '',
      source: 'dadata',
      ogrn: d.ogrn ?? null,
      status: STATUS[d.state?.status ?? 'ACTIVE'] ?? 'active',
    }
  }
}

/** Спрашиваем справочники по очереди: первый, кто нашёл, отвечает. */
export class ChainDirectory implements OrgDirectory {
  constructor(private readonly chain: OrgDirectory[]) {}

  async findByInn(inn: string): Promise<OrgRequisites | null> {
    for (const d of this.chain) {
      const found = await d.findByInn(inn)
      if (found) return found
    }
    return null
  }
}
