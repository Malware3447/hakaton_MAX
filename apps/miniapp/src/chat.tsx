import { useState } from 'react'
import { Button, Typography } from '@maxhub/max-ui'
import type { AcceptanceResult, ChatStep, Command, LineCheck, OrgBrief, Role, Shipment } from './model.ts'
import { useApp } from './shell.tsx'
import { IconChat } from './ui/icons.tsx'
import { fmtKg, REASON_TEXT, route } from './texts.ts'

// Шаги, которые делаются в чате: подписи и простые отметки с доказательством нажатия кнопки в MAX.
// В MAX приложение закрывается (WebApp.close), бот присылает это сообщение, нажатие выполняет команду.
// В макете то же сообщение показываем окном поверх приложения.

export function ChatSheet(props: { step: ChatStep | null; onClose: () => void; onDone: (shipmentId: string) => void }) {
  const { data } = useApp()
  const [busy, setBusy] = useState(false)
  const [reply, setReply] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  if (!props.step) return null
  const step = props.step

  const press = async (cmd: Command, label: string) => {
    setBusy(true)
    setError(null)
    try {
      await data.execute(step.shipmentId, cmd)
      setReply(`«${label}» — готово. Карточка перевозки обновлена у всех участников.`)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const close = () => {
    const done = reply !== null
    setReply(null)
    setError(null)
    if (done) props.onDone(step.shipmentId)
    else props.onClose()
  }

  return (
    <div className="chat-layer" role="dialog" aria-modal="true" aria-label="Чат с ботом">
      <div className="chat">
        <div className="chat-head">
          <IconChat size={20} />
          <div>
            <Typography.Body variant="medium-strong">Накладная в кармане</Typography.Body>
            <span className="muted small">чат с ботом</span>
          </div>
        </div>
        <p className="chat-hint">В MAX приложение закроется, и это сообщение придёт в чат. Подпись и отметки делаются нажатием кнопки под ним.</p>
        <div className="chat-feed">
          <div className="bubble">
            {step.text.split('\n').map((line, i) => (
              <p key={i}>{line}</p>
            ))}
          </div>
          {!reply && (
            <div className="inline-kb">
              {step.buttons.map((b) => (
                <button key={b.label} type="button" className={b.primary ? 'kb-primary' : ''} disabled={busy} onClick={() => void press(b.command, b.label)}>
                  {b.label}
                </button>
              ))}
            </div>
          )}
          {reply && <div className="bubble bubble-ok">{reply}</div>}
          {error && <div className="bubble bubble-bad">{error}</div>}
        </div>
        <Button size="large" stretched variant={reply ? 'primary' : 'secondary'} onClick={close}>
          {reply ? 'Вернуться в приложение' : 'Закрыть'}
        </Button>
      </div>
    </div>
  )
}

const lineSummary = (s: Shipment, lines: LineCheck[]) =>
  lines
    .map((l) => {
      const c = s.cargo.lines.find((x) => x.sku === l.sku)!
      if (l.qty === c.qty && l.grossKg === c.grossKg) return null
      return `• ${c.name}: ${l.qty} из ${c.qty} шт${l.reason ? `, ${REASON_TEXT[l.reason]}` : ''}${l.photos.length ? `, фото: ${l.photos.length}` : ''}`
    })
    .filter(Boolean)
    .join('\n')

/** Что бот пришлёт, когда главное действие роли делается в чате: карточку перевозки с кнопкой шага. */
export function chatStepFor(s: Shipment, role: Role, carriers: OrgBrief[]): ChatStep | null {
  const head = `${s.erpRef} · ${route(s)}`
  const cargo = `${s.cargo.places} мест, ${fmtKg(s.cargo.grossKg)}`
  const base = { shipmentId: s.id, handoff: { kind: 'card' } as const }
  if (role === 'shipper' && s.state === 'draft')
    return {
      ...base,
      text: `${head}\nКому отдать перевозку? Перешлите сюда контакт диспетчера перевозчика или выберите из тех, с кем уже работали.`,
      buttons: [
        ...carriers.map((c, i) => ({ label: c.name, command: { type: 'shipper.offerCarrier' as const, carrierId: c.id }, primary: i === 0 })),
        { label: 'Отменить отгрузку', command: { type: 'shipper.cancel' as const } },
      ],
    }
  if (role === 'shipper' && s.state === 'loaded')
    return {
      ...base,
      text: `${head}\nВодитель принял груз: ${cargo}.${s.loadingRemarks ? `\nЗамечания водителя:\n${lineSummary(s, s.loadingRemarks.lines)}${s.loadingRemarks.comment ? `\n${s.loadingRemarks.comment}` : ''}` : ''}\nПроверьте накладную и подпишите отгрузку.`,
      buttons: [{ label: 'Подписать «Госключом»', command: { type: 'shipper.signT1' }, primary: true }],
    }
  if (role === 'carrier' && s.state === 't1_signed')
    return {
      ...base,
      text: `${head}\nОтправитель подписал. Подпишите приём груза перевозчиком: ${cargo}, машина ${s.vehicle?.plate ?? '—'}.`,
      buttons: [{ label: 'Подписать подписью организации (модель)', command: { type: 'carrier.signT2' }, primary: true }],
    }
  if (role === 'carrier' && s.state === 't3_signed')
    return {
      ...base,
      text: `${head}\nПолучатель подписал приёмку. Подпишите сдачу груза — накладная закроется.`,
      buttons: [{ label: 'Подписать и закрыть (модель)', command: { type: 'carrier.signT4' }, primary: true }],
    }
  if (role === 'driver' && s.state === 'loading')
    return {
      ...base,
      text: `${head}\nСверьте груз: ${cargo}.\nНажатие кнопки — ваша простая подпись: груз принят.`,
      buttons: [{ label: 'Всё верно, груз принял', command: { type: 'driver.confirmLoading', remarks: null }, primary: true }],
    }
  if (role === 'driver' && s.state === 'unloading')
    return { ...base, text: `${head}\nСдайте груз получателю: ${cargo}.\nНажатие кнопки — ваша простая подпись о сдаче.`, buttons: [{ label: 'Груз сдал', command: { type: 'driver.confirmDelivered' }, primary: true }] }
  if (role === 'consignee' && s.state === 'received')
    return {
      ...base,
      text: `${head}\nПриёмка отмечена. Подпишите её бесплатной подписью «Госключа»: бот пришлёт документ, «Госключ» вернёт подпись.`,
      buttons: [{ label: 'Подписать «Госключом»', command: { type: 'consignee.signT3' }, primary: true }],
    }
  return null
}

export function remarksChatStep(s: Shipment, remarks: { lines: LineCheck[]; comment: string | null }): ChatStep {
  return {
    shipmentId: s.id,
    handoff: { kind: 'remarks', remarks },
    text: `${s.erpRef} · замечания при погрузке\n${lineSummary(s, remarks.lines) || 'по позициям расхождений нет'}${remarks.comment ? `\n${remarks.comment}` : ''}\nНажатие кнопки — ваша простая подпись: груз принят с этими замечаниями.`,
    buttons: [{ label: 'Подписать с замечаниями', command: { type: 'driver.confirmLoading', remarks }, primary: true }],
  }
}

export function acceptanceChatStep(s: Shipment, acceptance: { result: AcceptanceResult; lines: LineCheck[]; comment: string | null }): ChatStep {
  const r = { full: 'принято без расхождений', partial: 'принято с расхождениями', refused: 'отказ от груза' }[acceptance.result]
  const diff = lineSummary(s, acceptance.lines)
  return {
    shipmentId: s.id,
    handoff: { kind: 'acceptance', acceptance },
    text: `${s.erpRef} · приёмка: ${r}${diff ? `\n${diff}` : ''}${acceptance.comment ? `\n${acceptance.comment}` : ''}\nПодтвердите приёмку — дальше бот попросит подпись «Госключом».`,
    buttons: [{ label: 'Подтвердить приёмку', command: { type: 'consignee.recordAcceptance', acceptance }, primary: true }],
  }
}
