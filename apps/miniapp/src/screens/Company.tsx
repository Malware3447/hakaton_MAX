import { useState } from 'react'
import { Button, CellList, CellSimple, Input, Typography } from '@maxhub/max-ui'
import { Loading, Page, useApp, useLoad } from '../shell.tsx'
import { Chip, KV, Note, Section, Sheet, TopBar, useToast } from '../ui/kit.tsx'
import { IconAlert, IconEdit, IconUserPlus } from '../ui/icons.tsx'
import { plural, ROLE_TITLE } from '../texts.ts'

// Компания текущей роли: реквизиты, доверенность, сотрудники и приглашение.

const DAY = 86_400_000

const POA_SOURCE: Record<'file' | 'manual' | 'legacy', (signatureOk: boolean | null) => string> = {
  file: (ok) => (ok ? 'файл доверенности и подпись руководителя' : 'файл доверенности; подпись руководителя не присылали'),
  manual: () => 'введена вручную — компания и представитель не проверены',
  legacy: () => 'записана до проверки доверенностей',
}

export function CompanyScreen() {
  const { back, data, role } = useApp()
  const toast = useToast()
  const [c, , reload] = useLoad(() => data.company(), [role])
  const [editReq, setEditReq] = useState(false)
  const [editPoa, setEditPoa] = useState(false)
  const [invite, setInvite] = useState<string | null>(null)
  if (!c) return <Page><TopBar title="Компания" onBack={back} /><Loading /></Page>

  const poaDays = c.poa ? Math.ceil((new Date(c.poa.validTo).getTime() - Date.now()) / DAY) : null
  const setKind = async (signerKind: 'head' | 'employee') => {
    try {
      await data.saveCompany({ signerKind })
      reload()
    } catch (e) {
      toast({ text: e instanceof Error ? e.message : String(e) })
    }
  }
  const signs = role !== 'driver'
  // Реквизиты, введённые вручную, правит администратор компании в этой роли
  const admin = c.employees.find((e) => e.isMe)?.isAdmin ?? false

  return (
    <Page>
      <TopBar title="Компания" subtitle={ROLE_TITLE[role]} onBack={back} />
      <Section
        title="Реквизиты"
        after={
          !c.verified &&
          admin && (
            <Button size="xsmall" variant="ghost" iconBefore={<IconEdit size={16} />} onClick={() => setEditReq(true)}>
              Изменить
            </Button>
          )
        }
      >
        <KV
          rows={[
            ['Название', c.name],
            ['ИНН', c.inn],
            ['КПП', c.kpp],
            ['Адрес', c.address],
            ['Источник', c.verified ? 'проверено по справочнику (модель)' : 'введено вручную, не проверено'],
          ]}
        />
      </Section>

      {signs && (
        <Section title="Кто подписывает за компанию">
          <div className="signer-kind">
            <div className="chips-wrap">
              <Chip active={c.signerKind === 'head'} onClick={() => void setKind('head')}>
                Я руководитель или ИП
              </Chip>
              <Chip active={c.signerKind === 'employee'} onClick={() => void setKind('employee')}>
                Я сотрудник, по доверенности
              </Chip>
            </div>
            <Typography.Body variant="small" className="muted">
              {c.signerKind === 'head'
                ? 'Вы подписываете сами, доверенность не нужна.'
                : c.signerKind === 'employee'
                  ? 'Сотрудник подписывает за компанию только по действующей машиночитаемой доверенности (МЧД): одной подписи мало.'
                  : 'Ещё не выбрано — бот спросит перед первой подписью.'}
            </Typography.Body>
          </div>
        </Section>
      )}

      {signs && c.signerKind !== 'head' && (
        <Section
          title="Доверенность на подпись"
          after={
            <Button size="xsmall" variant="ghost" iconBefore={<IconEdit size={16} />} onClick={() => setEditPoa(true)}>
              {c.poa ? 'Заменить' : 'Добавить'}
            </Button>
          }
        >
          {c.poa ? (
            <>
              <KV
                rows={[
                  ['Номер', c.poa.number],
                  ['Выдана', c.poa.issuedAt ? new Date(c.poa.issuedAt).toLocaleDateString('ru-RU') : null],
                  ['Действует до', new Date(c.poa.validTo).toLocaleDateString('ru-RU')],
                  ['Проверено', POA_SOURCE[c.poa.source](c.poa.signatureOk)],
                  ['Реестр ФНС', 'не проверен: недоступен с сервера (модель)'],
                ]}
              />
              {poaDays !== null && poaDays <= 14 && (
                <div className="pad">
                  <Note tone={poaDays <= 0 ? 'bad' : 'warn'} icon={<IconAlert size={18} />}>
                    {poaDays <= 0 ? 'Доверенность истекла — подписывать накладные нельзя' : `Истекает через ${poaDays} ${plural(poaDays, 'день', 'дня', 'дней')}. Продлите, чтобы подписи не остановились`}
                  </Note>
                </div>
              )}
              {c.poa.source === 'legacy' && (
                <div className="pad">
                  <Note tone="warn" icon={<IconAlert size={18} />}>
                    Записана только с номером и сроком. Перед подписью бот попросит доверенность заново — с датой выдачи или файлом.
                  </Note>
                </div>
              )}
            </>
          ) : (
            <Typography.Body variant="small" className="muted pad">
              Доверенности нет. Пришлите файл МЧД боту в чат — проверим его и подпись руководителя — или введите номер и даты здесь.
            </Typography.Body>
          )}
        </Section>
      )}

      {c.employees.length > 0 && (
        <Section
          title="Сотрудники"
          after={
            data.features.invite && (
              <Button
                size="xsmall"
                variant="ghost"
                iconBefore={<IconUserPlus size={16} />}
                onClick={async () => {
                  setInvite(await data.invite())
                }}
              >
                Пригласить
              </Button>
            )
          }
        >
          <CellList mode="island">
            {c.employees.map((e) => (
              <CellSimple key={e.name} title={e.isMe ? `${e.name} (вы)` : e.name} subtitle={e.isAdmin ? 'администратор' : 'сотрудник'} />
            ))}
          </CellList>
        </Section>
      )}

      <ReqSheet key={`r${editReq}`} open={editReq} onClose={() => setEditReq(false)} name={c.name} address={c.address} onSaved={() => (reload(), toast({ text: 'Реквизиты сохранены' }))} />
      <PoaSheet key={`p${editPoa}`} open={editPoa} onClose={() => setEditPoa(false)} value={c.poa} onSaved={() => (reload(), toast({ text: 'Доверенность сохранена' }))} />
      <Sheet open={invite !== null} title="Приглашение сотрудника" onClose={() => setInvite(null)}>
        <Typography.Body variant="small" className="muted">
          Перешлите ссылку сотруднику в MAX. По ней он сразу попадёт в компанию с ролью «{ROLE_TITLE[role].toLowerCase()}». Ссылка живёт 7 дней.
        </Typography.Body>
        <div className="invite-link">{invite}</div>
        <div className="foot-row">
          <Button
            size="large"
            stretched
            onClick={() => {
              navigator.clipboard.writeText(invite ?? '').then(
                () => toast({ text: 'Ссылка скопирована' }),
                () => toast({ text: 'Не удалось скопировать — выделите ссылку вручную' }),
              )
            }}
          >
            Скопировать ссылку
          </Button>
        </div>
        <Typography.Body variant="small" className="muted">
          В MAX здесь будет ещё кнопка «Поделиться в чат» (WebApp.shareMaxContent).
        </Typography.Body>
      </Sheet>
    </Page>
  )
}

function ReqSheet(props: { open: boolean; onClose: () => void; name: string; address: string; onSaved: () => void }) {
  const { data } = useApp()
  const toast = useToast()
  const [name, setName] = useState(props.name)
  const [address, setAddress] = useState(props.address)
  const save = async () => {
    try {
      await data.saveCompany({ name, address })
      props.onSaved()
      props.onClose()
    } catch (e) {
      toast({ text: e instanceof Error ? e.message : String(e) })
    }
  }
  return (
    <Sheet
      open={props.open}
      title="Реквизиты"
      onClose={props.onClose}
      footer={
        <Button size="large" stretched disabled={!name.trim() || !address.trim()} onClick={() => void save()}>
          Сохранить
        </Button>
      }
    >
      <div className="form">
        <Note>ИНН не меняется. Реквизиты введены вручную: справочник их не нашёл, поэтому в накладной они с пометкой «не проверено».</Note>
        <label htmlFor="org-name" className="small">
          Название
        </label>
        <Input id="org-name" value={name} onChange={(e) => setName(e.target.value)} />
        <label htmlFor="org-addr" className="small">
          Адрес
        </label>
        <Input id="org-addr" value={address} onChange={(e) => setAddress(e.target.value)} />
      </div>
    </Sheet>
  )
}

function PoaSheet(props: { open: boolean; onClose: () => void; value: { number: string; issuedAt: string | null; validTo: string } | null; onSaved: () => void }) {
  const { data } = useApp()
  const toast = useToast()
  const [number, setNumber] = useState(props.value?.number ?? '')
  const [issuedAt, setIssuedAt] = useState(props.value?.issuedAt?.slice(0, 10) ?? '')
  const [validTo, setValidTo] = useState(props.value?.validTo?.slice(0, 10) ?? '')
  const guid = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(number.trim())
  // Действует до конца указанного дня
  const bad = !!validTo && new Date(`${validTo}T23:59:59`).getTime() < Date.now()
  const save = async () => {
    try {
      await data.saveCompany({ poa: { number: number.trim(), issuedAt, validTo } })
      props.onSaved()
      props.onClose()
    } catch (e) {
      toast({ text: e instanceof Error ? e.message : String(e) })
    }
  }
  return (
    <Sheet
      open={props.open}
      title="Доверенность"
      onClose={props.onClose}
      footer={
        <Button size="large" stretched disabled={!guid || !issuedAt || !validTo || bad} onClick={() => void save()}>
          Сохранить
        </Button>
      }
    >
      <div className="form">
        <label htmlFor="poa-num" className="small">
          Номер машиночитаемой доверенности
        </label>
        <Input
          id="poa-num"
          placeholder="4f1c2d3e-5a6b-4c7d-8e9f-0a1b2c3d4e5f"
          value={number}
          onChange={(e) => setNumber(e.target.value)}
          hint={number.trim() && !guid ? 'Номер из реестра ФНС: 32 знака с дефисами — он есть в самой доверенности' : undefined}
        />
        <label htmlFor="poa-from" className="small">
          Дата выдачи
        </label>
        <Input id="poa-from" type="date" value={issuedAt} onChange={(e) => setIssuedAt(e.target.value)} />
        <label htmlFor="poa-to" className="small">
          Действует до
        </label>
        <Input id="poa-to" type="date" value={validTo} onChange={(e) => setValidTo(e.target.value)} hint={bad ? 'Дата уже прошла' : undefined} />
      </div>
    </Sheet>
  )
}
