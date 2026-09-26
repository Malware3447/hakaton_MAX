import { useState } from 'react'
import { Button, Typography } from '@maxhub/max-ui'
import type { Command, Role, Shipment, State, TitleKind } from '../model.ts'
import { webApp } from '../bridge.ts'
import { Loading, Page, useApp, useLoad } from '../shell.tsx'
import { KV, Note, Section, StageBar, Tabs, TopBar, useToast } from '../ui/kit.tsx'
import { IconAlert, IconChat, IconDownload, IconQr, IconSignature } from '../ui/icons.tsx'
import { chatStepFor } from '../chat.tsx'
import { fmtAgo, fmtDay, fmtKg, fmtTime, hasDiscrepancy, REASON_TEXT, ROLE_TITLE, SIGNATURE_TEXT, STATE_TEXT, TITLE_TEXT, TODO } from '../texts.ts'

// Карточка перевозки: шапка (статус, чей ход, этапы, главное действие) и вкладки.

type CardTab = 'summary' | 'cargo' | 'docs' | 'feed'

export function ShipmentScreen({ id }: { id: string }) {
  const { data, back } = useApp()
  const [s, error] = useLoad(() => data.shipment(id), [id])
  const [tab, setTab] = useState<CardTab>('summary')

  if (error) return <Page><TopBar title="Перевозка" onBack={back} /><Note tone="bad">{error.message}</Note></Page>
  if (!s) return <Page><TopBar title="Перевозка" onBack={back} /><Loading /></Page>

  return (
    <Page>
      <TopBar title={s.erpRef} subtitle={`${s.consignee.name}`} onBack={back} />
      <Header s={s} />
      <div className="card-tabs">
        <Tabs
          compact
          items={[
            { key: 'summary', label: 'Сводка' },
            { key: 'cargo', label: 'Груз' },
            { key: 'docs', label: 'Документы' },
            { key: 'feed', label: 'Лента', count: s.events.length },
          ]}
          value={tab}
          onChange={setTab}
        />
      </div>
      {tab === 'summary' && <Summary s={s} />}
      {tab === 'cargo' && <Cargo s={s} />}
      {tab === 'docs' && <Docs s={s} />}
      {tab === 'feed' && <Feed s={s} />}
    </Page>
  )
}

/** Отметки водителя без подписи: одним нажатием прямо в приложении. */
const ONE_TAP: Partial<Record<State, { cmd: Command; label: string; done: string }>> = {
  assigned: { cmd: { type: 'driver.acceptTrip' }, label: 'Принять рейс', done: 'Рейс принят. Когда приедете на склад — «Я на погрузке»' },
  trip_accepted: { cmd: { type: 'driver.arrivedLoading' }, label: 'Я на погрузке', done: 'Отметили прибытие на погрузку' },
  in_transit: { cmd: { type: 'driver.arrivedUnloading' }, label: 'Я на выгрузке', done: 'Отметили прибытие на выгрузку' },
}

function Header({ s }: { s: Shipment }) {
  const { role, data, go, toChat } = useApp()
  const toast = useToast()
  const [carriers] = useLoad(() => data.carriers(), [])
  const [busy, setBusy] = useState(false)
  // Ход роли, но перевозку ведёт коллега по компании — шаги делает он
  const ours = s.turn === role
  const mine = ours && s.canAct
  const turnText =
    s.turn === null
      ? s.state === 'registering'
        ? 'ждём оператора ЭПД (модель)'
        : null
      : mine
        ? 'ваш ход'
        : ours
          ? `ход вашей компании${s.handledBy ? `: ведёт ${s.handledBy}` : ''}`
          : `ход: ${ROLE_TITLE[s.turn].toLowerCase()}`

  const run = async (cmd: Command, done: string) => {
    setBusy(true)
    try {
      await data.execute(s.id, cmd)
      toast({ text: done })
    } catch (e) {
      toast({ text: e instanceof Error ? e.message : String(e) })
    } finally {
      setBusy(false)
    }
  }
  const accept = () => run({ type: 'carrier.accept' }, 'Заявка принята. Теперь назначьте машину и водителя')
  const oneTap = role === 'driver' ? ONE_TAP[s.state] : undefined
  const chat = () => {
    const step = chatStepFor(s, role, carriers ?? [])
    if (step) toChat(step)
  }

  let actions: React.ReactNode = null
  if (mine) {
    if (role === 'carrier' && s.state === 'offered')
      actions = (
        <div className="foot-row">
          <Button size="large" variant="secondary" onClick={() => go({ name: 'decline', id: s.id })}>
            Отклонить
          </Button>
          <Button size="large" stretched loading={busy} onClick={() => void accept()}>
            Принять заявку
          </Button>
        </div>
      )
    else if (role === 'carrier' && s.state === 'carrier_accepted')
      actions = (
        <Button size="large" stretched onClick={() => go({ name: 'assign', id: s.id })}>
          Назначить машину и водителя
        </Button>
      )
    else if (role === 'driver' && s.state === 'loading')
      actions = (
        <div className="foot-row">
          <Button size="large" variant="secondary" onClick={() => go({ name: 'remarks', id: s.id })}>
            Есть замечания
          </Button>
          <Button size="large" stretched iconBefore={<IconChat size={20} />} onClick={chat}>
            Всё верно
          </Button>
        </div>
      )
    else if (role === 'consignee' && s.state === 'receiving')
      actions = (
        <Button size="large" stretched onClick={() => go({ name: 'acceptance', id: s.id })}>
          Принять груз
        </Button>
      )
    else if (oneTap)
      actions = (
        <Button size="large" stretched loading={busy} onClick={() => void run(oneTap.cmd, oneTap.done)}>
          {oneTap.label}
        </Button>
      )
    else if (TODO[s.state])
      actions = (
        <Button size="large" stretched iconBefore={<IconChat size={20} />} onClick={chat}>
          {TODO[s.state]} в чате
        </Button>
      )
  }

  return (
    <div className="card-head">
      <div className="card-status">
        <Typography.Title variant="medium-strong">{STATE_TEXT[s.state]}</Typography.Title>
        {turnText && (
          <span className={`turn${mine ? ' turn-mine' : ''}`}>
            {turnText}
            {s.turn && ` · ${fmtAgo(s.turnSince)}`}
          </span>
        )}
      </div>
      <StageBar state={s.state} />
      {s.declineReason && s.state === 'draft' && (
        <Note tone="warn" icon={<IconAlert size={18} />}>
          Прошлый перевозчик отказался: {s.declineReason}
        </Note>
      )}
      {actions}
      {role === 'driver' && s.uid && (
        <Button size="medium" variant="secondary" stretched iconBefore={<IconQr size={20} />} onClick={() => go({ name: 'qr', id: s.id })}>
          Показать QR-код инспектору
        </Button>
      )}
      {mine && actions && TODO[s.state] && !oneTap && !['offered', 'carrier_accepted', 'receiving'].includes(s.state) && (
        <span className="muted small center-text">Подпись и отметки — кнопкой в чате с ботом: так у подписи есть доказательство</span>
      )}
    </div>
  )
}

function Summary({ s }: { s: Shipment }) {
  return (
    <>
      {hasDiscrepancy(s) && (
        <Note tone="warn" icon={<IconAlert size={18} />}>
          {s.acceptance && s.acceptance.result !== 'full'
            ? `Приёмка ${s.acceptance.result === 'refused' ? 'с отказом от груза' : 'с расхождениями'}${s.acceptance.comment ? `: ${s.acceptance.comment}` : ''}. Подробно — во вкладке «Груз».`
            : `Водитель отметил замечания при погрузке${s.loadingRemarks?.comment ? `: ${s.loadingRemarks.comment}` : ''}.`}
        </Note>
      )}
      <Section title="Маршрут">
        <KV
          rows={[
            ['Погрузка', fmtDay(s.plannedLoadingAt)],
            ['Откуда', s.loadingAddress],
            ['Куда', s.unloadingAddress],
          ]}
        />
      </Section>
      <Section title="Участники">
        <KV
          rows={[
            ['Отправитель', s.shipper.name],
            ['Получатель', s.consignee.name],
            ['Перевозчик', s.carrier?.name ?? 'не назначен'],
            ['Водитель', s.driver?.name ?? '—'],
            ['Машина', s.vehicle ? `${s.vehicle.brand}, ${s.vehicle.plate}` : '—'],
          ]}
        />
      </Section>
      <Section title="Груз">
        <KV
          rows={[
            ['Мест', String(s.cargo.places)],
            ['Масса брутто', fmtKg(s.cargo.grossKg)],
            ['Номер в ГИС ЭПД', s.uid ? `${s.uid} (модель)` : null],
          ]}
        />
      </Section>
    </>
  )
}

function Cargo({ s }: { s: Shipment }) {
  // Отметки из чата — только текстом (он в «Сводке»), по позициям — из формы приложения
  const check = (s.acceptance?.lines.length ? s.acceptance.lines : null) ?? (s.loadingRemarks?.lines.length ? s.loadingRemarks.lines : null)
  const label = s.acceptance?.lines.length ? 'Принято' : 'Принял водитель'
  return (
    <Section title={check ? `Груз: по накладной и ${label.toLowerCase()}` : 'Груз по накладной'}>
      <div className="table-wrap">
        <table className="cargo">
          <thead>
            <tr>
              <th>Наименование</th>
              <th className="num">Мест</th>
              <th className="num">Кг</th>
              {check && <th className="num">{label}</th>}
            </tr>
          </thead>
          <tbody>
            {s.cargo.lines.map((l) => {
              const c = check?.find((x) => x.sku === l.sku)
              const diff = c && (c.qty !== l.qty || c.grossKg !== l.grossKg)
              return (
                <tr key={l.sku} className={diff ? 'diff' : ''}>
                  <td>
                    {l.name}
                    {diff && c?.reason && <span className="reason">{REASON_TEXT[c.reason]}</span>}
                    {diff && c && c.photos.length > 0 && (
                      <span className="thumbs">
                        {c.photos.map((p) => (
                          <img key={p} src={p} alt="Фото повреждения" />
                        ))}
                      </span>
                    )}
                  </td>
                  <td className="num">{l.qty}</td>
                  <td className="num">{l.grossKg.toLocaleString('ru-RU')}</td>
                  {check && <td className="num">{c ? `${c.qty} · ${c.grossKg.toLocaleString('ru-RU')}` : '—'}</td>}
                </tr>
              )
            })}
          </tbody>
          <tfoot>
            <tr>
              <td>Итого</td>
              <td className="num">{s.cargo.places}</td>
              <td className="num">{s.cargo.grossKg.toLocaleString('ru-RU')}</td>
              {check && (
                <td className="num">
                  {check.reduce((n, c) => n + c.qty, 0)} · {check.reduce((n, c) => n + c.grossKg, 0).toLocaleString('ru-RU')}
                </td>
              )}
            </tr>
          </tfoot>
        </table>
      </div>
    </Section>
  )
}

const TITLE_ROLE: Record<TitleKind, Role[]> = { T1: ['shipper'], T2: ['driver', 'carrier'], T3: ['consignee'], T4: ['driver', 'carrier'] }

function Docs({ s }: { s: Shipment }) {
  const { go, role, data } = useApp()
  const [files] = useLoad(() => data.files(s.id), [s.id])
  // В MAX файл скачивает сам клиент по ссылке; в браузере — обычная загрузка
  const download = (url: string, name: string) => (webApp?.downloadFile ? webApp.downloadFile(url, name) : window.open(url, '_blank'))
  return (
    <>
      <Section title="Накладная по частям">
        <ol className="titles">
          {(['T1', 'T2', 'T3', 'T4'] as TitleKind[]).map((k) => {
            const t = s.titles.find((x) => x.kind === k)
            const need = TITLE_ROLE[k]
            const complete = t && need.every((r) => t.signatures.some((g) => g.role === r))
            return (
              <li key={k} className={complete ? 'ti-done' : t ? 'ti-part' : ''}>
                <div className="ti-head">
                  <span className="ti-mark">{complete ? '✓' : t ? '½' : ''}</span>
                  <div>
                    <Typography.Body variant="medium-strong">{TITLE_TEXT[k].name}</Typography.Body>
                    <span className="muted small">подписывает {TITLE_TEXT[k].who}</span>
                  </div>
                </div>
                {t?.signatures.map((g) => (
                  <div key={g.role + g.at} className="sig">
                    <IconSignature size={16} />
                    <span>
                      {g.signerName} · {ROLE_TITLE[g.role].toLowerCase()} · {SIGNATURE_TEXT[g.kind]}
                      <span className="muted"> · {fmtDay(g.at)}</span>
                    </span>
                  </div>
                ))}
                {!complete && <span className="muted small">{t ? 'ждёт второй подписи' : 'ещё не подписана'}</span>}
              </li>
            )
          })}
        </ol>
      </Section>
      <Section title="ГИС ЭПД (модель)">
        {s.uid ? (
          <div className="uid-block">
            <KV rows={[['Номер накладной', s.uid]]} />
            <Button size="medium" variant={role === 'driver' ? 'primary' : 'secondary'} stretched iconBefore={<IconQr size={20} />} onClick={() => go({ name: 'qr', id: s.id })}>
              QR-код на весь экран
            </Button>
          </div>
        ) : (
          <Typography.Body variant="small" className="muted pad">
            Номер и QR-код появятся после подписей отправителя и перевозчика
          </Typography.Body>
        )}
      </Section>
      <Section title="Файлы">
        {!files ? (
          <Loading />
        ) : files.length === 0 ? (
          <Typography.Body variant="small" className="muted pad">
            Файлы появятся после первой подписи: XML по формату ФНС и файлы подписей
          </Typography.Body>
        ) : (
          <div className="files">
            {files.map((f) => (
              <Button key={f.url} size="medium" variant="secondary" iconBefore={<IconDownload size={20} />} onClick={() => download(f.url, f.name)}>
                {f.label}
              </Button>
            ))}
          </div>
        )}
      </Section>
    </>
  )
}

function Feed({ s }: { s: Shipment }) {
  return (
    <Section title="Что происходило">
      <ol className="feed">
        {s.events.map((e) => (
          <li key={e.id}>
            <span className="feed-time">
              {fmtTime(e.at)}
              <br />
              <span className="muted">{fmtDay(e.at).split(',')[0]}</span>
            </span>
            <span className="feed-body">
              {e.text}
              <span className="muted small">{e.actor}</span>
            </span>
          </li>
        ))}
      </ol>
    </Section>
  )
}
