import { useEffect, useState } from 'react'
import { Button, CellList, CellSimple, Switch, Textarea, Typography } from '@maxhub/max-ui'
import type { AcceptanceResult, CargoLine, DiscrepancyReason, LineCheck, Shipment, Vehicle } from '../model.ts'
import { Loading, Page, useApp, useLoad } from '../shell.tsx'
import { BottomBar, Chip, Note, NumberStepper, Section, TopBar, useToast } from '../ui/kit.tsx'
import { IconCamera, IconChat, IconClose, IconPlus, IconUserPlus } from '../ui/icons.tsx'
import { acceptanceChatStep, remarksChatStep } from '../chat.tsx'
import { fmtKg, missingForWaybill, OWNERSHIP_TEXT, REASON_TEXT } from '../texts.ts'
import { VehicleSheet } from './Fleet.tsx'

// Формы, которые в чате неудобны. Подпись всё равно в чате: «Готово» уводит туда с итогом формы.

function useShipment(id: string) {
  const { data } = useApp()
  return useLoad(() => data.shipment(id), [id])[0]
}

const initialChecks = (lines: CargoLine[]): LineCheck[] => lines.map((l) => ({ sku: l.sku, qty: l.qty, grossKg: l.grossKg, reason: null, photos: [] }))

/** Позиции груза: сколько принято и почему не сошлось. Общая для приёмки и замечаний водителя. */
function LineChecks(props: { s: Shipment; value: LineCheck[]; onChange: (v: LineCheck[]) => void; photos: boolean; disabled?: boolean }) {
  const set = (i: number, patch: Partial<LineCheck>) => props.onChange(props.value.map((c, k) => (k === i ? { ...c, ...patch } : c)))
  return (
    <>
      {props.s.cargo.lines.map((l, i) => {
        const c = props.value[i]!
        const diff = c.qty !== l.qty || c.grossKg !== l.grossKg
        const perPlace = l.grossKg / l.qty
        return (
          <Section key={l.sku}>
            <div className={`line-check${diff ? ' line-diff' : ''}`}>
              <Typography.Body variant="medium-strong">{l.name}</Typography.Body>
              <span className="muted small">
                По накладной: {l.qty} мест · {fmtKg(l.grossKg)}
              </span>
              <div className="lc-row">
                <label htmlFor={`qty-${l.sku}`} className="small">
                  Принято мест
                </label>
                <NumberStepper
                  id={`qty-${l.sku}`}
                  label="Принято мест"
                  value={c.qty}
                  max={l.qty * 2}
                  onChange={(qty) => set(i, { qty, grossKg: Math.round(qty * perPlace * 10) / 10, reason: qty === l.qty ? null : (c.reason ?? (qty < l.qty ? 'shortage' : 'surplus')) })}
                />
              </div>
              <div className="lc-row">
                <label htmlFor={`kg-${l.sku}`} className="small">
                  Масса, кг
                </label>
                <input id={`kg-${l.sku}`} className="kg-input" inputMode="decimal" value={c.grossKg} disabled={props.disabled} onChange={(e) => set(i, { grossKg: Number(e.target.value.replace(',', '.').replace(/[^\d.]/g, '')) || 0 })} />
              </div>
              {diff && (
                <>
                  <span className="small">Причина</span>
                  <div className="chips-wrap">
                    {(Object.keys(REASON_TEXT) as DiscrepancyReason[]).map((r) => (
                      <Chip key={r} active={c.reason === r} tone="warn" onClick={() => set(i, { reason: r })}>
                        {REASON_TEXT[r]}
                      </Chip>
                    ))}
                  </div>
                  {props.photos && <Photos value={c.photos} onChange={(photos) => set(i, { photos })} id={`ph-${l.sku}`} />}
                </>
              )}
            </div>
          </Section>
        )
      })}
    </>
  )
}

function Photos(props: { value: string[]; onChange: (v: string[]) => void; id: string }) {
  return (
    <div className="photos">
      {props.value.map((p) => (
        <span key={p} className="photo">
          <img src={p} alt="Фото повреждения" />
          <button type="button" aria-label="Убрать фото" onClick={() => props.onChange(props.value.filter((x) => x !== p))}>
            <IconClose size={14} />
          </button>
        </span>
      ))}
      <label htmlFor={props.id} className="photo-add">
        <IconCamera size={22} />
        <span>Фото</span>
      </label>
      <input
        id={props.id}
        type="file"
        accept="image/*"
        capture="environment"
        multiple
        hidden
        onChange={(e) => {
          const files = [...(e.target.files ?? [])]
          props.onChange([...props.value, ...files.map((f) => URL.createObjectURL(f))])
          e.target.value = ''
        }}
      />
    </div>
  )
}

export function AcceptanceForm({ id }: { id: string }) {
  const { back, toChat, data } = useApp()
  const s = useShipment(id)
  const [checks, setChecks] = useState<LineCheck[] | null>(null)
  const [refused, setRefused] = useState(false)
  const [comment, setComment] = useState('')
  useEffect(() => {
    if (s && !checks) setChecks(initialChecks(s.cargo.lines))
  }, [s, checks])
  if (!s || !checks) return <Page><TopBar title="Приёмка" onBack={back} /><Loading /></Page>

  const same = checks.every((c, i) => c.qty === s.cargo.lines[i]!.qty && c.grossKg === s.cargo.lines[i]!.grossKg)
  const result: AcceptanceResult = refused ? 'refused' : same ? 'full' : 'partial'
  const missingReason = !refused && checks.some((c, i) => (c.qty !== s.cargo.lines[i]!.qty || c.grossKg !== s.cargo.lines[i]!.grossKg) && !c.reason)
  const lines = refused ? checks.map((c) => ({ ...c, qty: 0, grossKg: 0, reason: c.reason ?? ('damage' as const) })) : checks
  const resultText = { full: 'Принято без расхождений', partial: 'Принято с расхождениями', refused: 'Отказ от груза' }[result]

  return (
    <Page bottom>
      <TopBar title="Приёмка груза" subtitle={s.erpRef} onBack={back} />
      <Note>Сверьте каждую позицию. Если не сошлось — укажите, сколько принято, и причину{data.features.photos ? ', сфотографируйте повреждения' : ''}.</Note>
      <Section>
        <label className="switch-row" htmlFor="refuse">
          <span>
            <Typography.Body variant="medium-strong">Отказаться от груза целиком</Typography.Body>
            <span className="muted small">груз вернётся с водителем</span>
          </span>
          <Switch id="refuse" checked={refused} onChange={(e) => setRefused(e.target.checked)} />
        </label>
      </Section>
      {!refused && <LineChecks s={s} value={checks} onChange={setChecks} photos={data.features.photos} />}
      <Section title="Комментарий">
        <Textarea id="acc-comment" placeholder={refused ? 'Почему отказываетесь от груза' : 'Что ещё важно указать в накладной'} value={comment} onChange={(e) => setComment(e.target.value)} rows={3} />
      </Section>
      <BottomBar>
        <div className={`result result-${result}`}>{resultText}</div>
        {missingReason && <span className="small warn-text">Укажите причину у позиций, где не сошлось</span>}
        <Button
          size="large"
          stretched
          disabled={missingReason || (refused && !comment.trim())}
          iconBefore={<IconChat size={20} />}
          onClick={() => toChat(acceptanceChatStep(s, { result, lines, comment: comment.trim() || null }))}
        >
          Готово — подтвердить в чате
        </Button>
      </BottomBar>
    </Page>
  )
}

export function RemarksForm({ id }: { id: string }) {
  const { back, toChat } = useApp()
  const s = useShipment(id)
  const [checks, setChecks] = useState<LineCheck[] | null>(null)
  const [comment, setComment] = useState('')
  useEffect(() => {
    if (s && !checks) setChecks(initialChecks(s.cargo.lines))
  }, [s, checks])
  if (!s || !checks) return <Page><TopBar title="Замечания" onBack={back} /><Loading /></Page>
  const any = comment.trim() || checks.some((c, i) => c.qty !== s.cargo.lines[i]!.qty || c.grossKg !== s.cargo.lines[i]!.grossKg)
  return (
    <Page bottom>
      <TopBar title="Замечания при погрузке" subtitle={s.erpRef} onBack={back} />
      <Note>Отметьте, что не сходится с накладной. Отправитель увидит замечания до своей подписи.</Note>
      <LineChecks s={s} value={checks} onChange={setChecks} photos={false} />
      <Section title="Комментарий">
        <Textarea id="rem-comment" placeholder="Например: две канистры с подтёками" value={comment} onChange={(e) => setComment(e.target.value)} rows={3} />
      </Section>
      <BottomBar>
        <Button size="large" stretched disabled={!any} iconBefore={<IconChat size={20} />} onClick={() => toChat(remarksChatStep(s, { lines: checks, comment: comment.trim() || null }))}>
          Готово — подписать в чате
        </Button>
      </BottomBar>
    </Page>
  )
}

const DECLINE_REASONS = ['Нет свободных машин', 'Не подходит дата погрузки', 'Не работаем по этому направлению', 'Другое']

export function DeclineForm({ id }: { id: string }) {
  const { back, data } = useApp()
  const toast = useToast()
  const s = useShipment(id)
  const [reason, setReason] = useState(DECLINE_REASONS[0]!)
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  if (!s) return <Page><TopBar title="Отказ" onBack={back} /><Loading /></Page>
  const final = reason === 'Другое' ? text.trim() : text.trim() ? `${reason}. ${text.trim()}` : reason
  const submit = async () => {
    setBusy(true)
    try {
      await data.execute(s.id, { type: 'carrier.decline', reason: final })
      toast({ text: 'Заявка отклонена, отправитель увидит причину' })
      back()
      back()
    } catch (e) {
      toast({ text: e instanceof Error ? e.message : String(e) })
      setBusy(false)
    }
  }
  return (
    <Page bottom>
      <TopBar title="Отклонить заявку" subtitle={s.erpRef} onBack={back} />
      <Section title="Причина">
        <CellList mode="island">
          {DECLINE_REASONS.map((r) => (
            <CellSimple key={r} title={r} before={<span className="radio-dot" data-on={reason === r} />} onClick={() => setReason(r)} />
          ))}
        </CellList>
      </Section>
      <Section title={reason === 'Другое' ? 'Напишите причину' : 'Уточнение, если нужно'}>
        <Textarea id="decline-text" value={text} onChange={(e) => setText(e.target.value)} rows={3} placeholder="Отправитель увидит этот текст" />
      </Section>
      <BottomBar>
        <Button size="large" stretched variant="destructive" loading={busy} disabled={!final} onClick={() => void submit()}>
          Отклонить заявку
        </Button>
      </BottomBar>
    </Page>
  )
}

export function AssignForm({ id }: { id: string }) {
  const { back, data, toChat } = useApp()
  const toast = useToast()
  const s = useShipment(id)
  const [vehicles, , reloadVehicles] = useLoad(() => data.vehicles(), [])
  const [drivers] = useLoad(() => data.drivers(), [])
  const [vehicleId, setVehicleId] = useState<string | null>(null)
  const [driverId, setDriverId] = useState<string | null>(null)
  const [edit, setEdit] = useState<Vehicle | 'new' | null>(null)
  const [busy, setBusy] = useState(false)
  if (!s || !vehicles || !drivers) return <Page><TopBar title="Машина и водитель" onBack={back} /><Loading /></Page>

  const submit = async () => {
    setBusy(true)
    try {
      await data.execute(s.id, { type: 'carrier.assign', vehicleId: vehicleId!, driverId: driverId! })
      toast({ text: 'Водителю ушло сообщение с рейсом' })
      back()
    } catch (e) {
      toast({ text: e instanceof Error ? e.message : String(e) })
      setBusy(false)
    }
  }
  const newDriver = () =>
    toChat({
      shipmentId: s.id,
      text: `${s.erpRef}\nПерешлите сюда контакт водителя из записной книжки MAX: скрепка → «Контакт». Если водителя ещё нет в боте, я дам ссылку-приглашение.`,
      buttons: [],
      handoff: { kind: 'driverContact', vehicleId },
    })
  // Перевозчик может поехать сам — как «Я сам за рулём» в боте
  const self = drivers.some((d) => d.isMe) ? [] : [{ id: 'self', name: 'Я сам за рулём', busyWith: null, isMe: true }]

  return (
    <Page bottom>
      <TopBar title="Машина и водитель" subtitle={`${s.erpRef} · ${s.cargo.places} мест, ${fmtKg(s.cargo.grossKg)}`} onBack={back} />
      <Section title="Машина" after={<Button size="xsmall" variant="ghost" iconBefore={<IconPlus size={16} />} onClick={() => setEdit('new')}>Добавить</Button>}>
        {vehicles.length === 0 ? (
          <Typography.Body variant="small" className="muted pad">
            Машин пока нет — добавьте первую
          </Typography.Body>
        ) : (
          <CellList mode="island">
            {vehicles.map((v) => {
              const missing = missingForWaybill(v)
              return (
                <CellSimple
                  key={v.id}
                  title={`${v.plate} · ${v.brand}`}
                  // Решение 26.09: машина может везти несколько рейсов за раз (сборный груз) — занятость только подсказка
                  subtitle={missing ? `для накладной не хватает: ${missing} — нажмите, чтобы дополнить` : v.busyWith ? `уже в рейсе ${v.busyWith}` : OWNERSHIP_TEXT[v.ownership]}
                  before={<span className="radio-dot" data-on={vehicleId === v.id} />}
                  onClick={() => (missing ? setEdit(v) : setVehicleId(v.id))}
                />
              )
            })}
          </CellList>
        )}
      </Section>
      <Section title="Водитель">
        <CellList mode="island">
          {[...self, ...drivers].map((d) => (
            <CellSimple key={d.id} title={d.name} subtitle={d.busyWith ? `сейчас в рейсе ${d.busyWith}` : d.id === 'self' ? 'станете и водителем своей компании' : 'свободен'} before={<span className="radio-dot" data-on={driverId === d.id} />} onClick={() => setDriverId(d.id)} />
          ))}
          <CellSimple title="Новый водитель" subtitle="переслать его контакт в чате" before={<IconUserPlus size={22} />} onClick={newDriver} />
        </CellList>
      </Section>
      <BottomBar>
        <Button size="large" stretched disabled={!vehicleId || !driverId} loading={busy} onClick={() => void submit()}>
          Назначить
        </Button>
      </BottomBar>
      <VehicleSheet
        open={edit !== null}
        vehicle={edit === 'new' ? null : edit}
        onClose={() => setEdit(null)}
        onSaved={(list) => {
          reloadVehicles()
          const saved = edit === 'new' ? list.at(-1) : list.find((v) => v.id === (edit as Vehicle | null)?.id)
          if (saved && !missingForWaybill(saved)) setVehicleId(saved.id)
        }}
      />
    </Page>
  )
}
