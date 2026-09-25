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

export class DadataDirectory implements OrgDirectory {
  constructor(
    private readonly apiKey: string,
    private readonly log: Pick<FastifyBaseLogger, 'warn'>,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  async findByInn(inn: string): Promise<OrgRequisites | null> {
    try {
      const res = await this.fetchFn(URL_FIND, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: `Token ${this.apiKey}` },
        // Головная организация: у филиалов тот же ИНН, но свой КПП и адрес
        body: JSON.stringify({ query: inn, branch_type: 'MAIN' }),
        signal: AbortSignal.timeout(5000),
      })
      if (!res.ok) {
        this.log.warn({ status: res.status }, 'DaData не ответила')
        return null
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
    } catch (err) {
      this.log.warn({ err }, 'DaData недоступна')
      return null
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
