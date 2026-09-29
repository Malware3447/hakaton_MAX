// Образец МЧД формата 003 для тестов: проходит официальную XSD (см. poa.test.ts).
// Люди и номера вымышлены; ИНН, СНИЛС и ОГРН с верными контрольными числами.
// Код полномочия 02.114 условный: классификатор полномочий ФНС мы не держим, узнаём по названию.

export interface PoaSampleOptions {
  number?: string
  issuedAt?: string
  validTo?: string
  orgInn?: string
  orgName?: string
  head?: { surname: string; name: string; patronymic?: string; inn: string; snils: string }
  rep?: { surname: string; name: string; patronymic?: string; inn: string; snils: string }
  powerName?: string
}

export const SAMPLE_HEAD = { surname: 'Галиев', name: 'Рустам', patronymic: 'Ильдарович', inn: '165001234562', snils: '112-233-445 95' }
export const SAMPLE_REP = { surname: 'Соколова', name: 'Марина', patronymic: 'Андреевна', inn: '165007654394', snils: '123-456-789 64' }

const fio = (p: { surname: string; name: string; patronymic?: string }) =>
  `<ФИО Фамилия="${p.surname}" Имя="${p.name}"${p.patronymic ? ` Отчество="${p.patronymic}"` : ''}/>`

export function poaSampleXml(o: PoaSampleOptions = {}): string {
  const head = o.head ?? SAMPLE_HEAD
  const rep = o.rep ?? SAMPLE_REP
  return `<?xml version="1.0" encoding="UTF-8"?>
<Доверенность xmlns="urn://x-artefacts/EMCHD_1" ВерсФорм="EMCHD_1" ПрЭлФорм="00000000" ИдФайл="ON_EMCHD_20260929_4f1c2d3e-5a6b-4c7d-8e9f-0a1b2c3d4e5f">
  <Документ>
    <Довер>
      <СвДов ВидДовер="1" ПрПередов="1" ВнНомДовер="МЧД-2026-000417" НомДовер="${o.number ?? '4f1c2d3e-5a6b-4c7d-8e9f-0a1b2c3d4e5f'}" ДатаВыдДовер="${o.issuedAt ?? '2026-09-01'}" СрокДейст="${o.validTo ?? '2026-10-31'}">
        <СведСист>https://m4d.nalog.gov.ru/emchd/check-status?guid=${o.number ?? '4f1c2d3e-5a6b-4c7d-8e9f-0a1b2c3d4e5f'}</СведСист>
      </СвДов>
      <СвДоверит ТипДоверит="1">
        <Доверит>
          <РосОргДовер ЕИОУК="0" ЕИОФЛ="1" ЕИОИП="0">
            <СвРосОрг НаимОрг="${o.orgName ?? 'ООО «Волжский завод моторных масел»'}" ИННЮЛ="${o.orgInn ?? '9782242514'}" КПП="165001001" ОГРН="1161650001237"/>
            <ЛицоБезДов ПолнЮЛ="1">
              <СвФЛ ИННФЛ="${head.inn}" СНИЛС="${head.snils}" Должность="Генеральный директор">
                <СведФЛ>${fio(head)}</СведФЛ>
              </СвФЛ>
            </ЛицоБезДов>
          </РосОргДовер>
        </Доверит>
      </СвДоверит>
      <СвУпПред ТипПред="1">
        <Пред>
          <СведФизЛ ИННФЛ="${rep.inn}" СНИЛС="${rep.snils}" Должность="Диспетчер склада">
            <СведФЛ>${fio(rep)}</СведФЛ>
          </СведФизЛ>
        </Пред>
      </СвУпПред>
      <СвПолн ТипПолн="0" ПрСовмПолн="1">
        <МашПолн КодПолн="02.114" НаимПолн="${o.powerName ?? 'Подписание транспортной накладной и иных перевозочных документов'}"/>
      </СвПолн>
    </Довер>
  </Документ>
</Доверенность>
`
}
