import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { Button, Counter, IconButton, Typography } from '@maxhub/max-ui'
import { IconBack, IconClose } from './icons.tsx'
import { STAGES, stageOf } from '../texts.ts'
import type { State } from '../model.ts'

// То, чего нет в MAX UI 0.5.0: вкладки, чипы, нижняя шторка, шкала этапов, всплывашки, шапка экрана.
// Цвета и радиусы — токены MAX UI, поэтому тёмная тема работает сама.

export function TopBar(props: { title: ReactNode; subtitle?: ReactNode; onBack?: () => void; after?: ReactNode }) {
  return (
    <header className="topbar">
      {props.onBack ? (
        <IconButton size="medium" variant="ghost" aria-label="Назад" onClick={props.onBack}>
          <IconBack />
        </IconButton>
      ) : (
        <span className="topbar-gap" />
      )}
      <div className="topbar-title">
        <Typography.Title variant="small-strong">{props.title}</Typography.Title>
        {props.subtitle && <span className="topbar-sub">{props.subtitle}</span>}
      </div>
      <div className="topbar-after">{props.after}</div>
    </header>
  )
}

export function Tabs<K extends string>(props: { items: { key: K; label: string; count?: number; attention?: boolean }[]; value: K; onChange: (k: K) => void; compact?: boolean }) {
  return (
    <div className={`tabs${props.compact ? ' tabs-compact' : ''}`} role="tablist">
      {props.items.map((it) => (
        <button key={it.key} role="tab" aria-selected={props.value === it.key} className="tab" onClick={() => props.onChange(it.key)}>
          <span>{it.label}</span>
          {it.count !== undefined && it.count > 0 && <Counter value={it.count} variant={props.value === it.key ? (it.attention ? 'attention' : 'primary') : 'mute'} />}
        </button>
      ))}
    </div>
  )
}

export function Chip(props: { active?: boolean; onClick?: () => void; children: ReactNode; tone?: 'default' | 'warn' }) {
  return (
    <button type="button" className={`chip${props.active ? ' chip-on' : ''}${props.tone === 'warn' ? ' chip-warn' : ''}`} aria-pressed={props.active} onClick={props.onClick}>
      {props.children}
    </button>
  )
}

export function Sheet(props: { open: boolean; title: ReactNode; onClose: () => void; children: ReactNode; footer?: ReactNode }) {
  useEffect(() => {
    if (!props.open) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && props.onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [props.open, props.onClose])
  if (!props.open) return null
  return (
    <div className="sheet-layer" onClick={props.onClose}>
      <div className="sheet" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-grip" />
        <div className="sheet-head">
          <Typography.Title variant="small-strong">{props.title}</Typography.Title>
          <IconButton size="small" variant="ghost" aria-label="Закрыть" onClick={props.onClose}>
            <IconClose size={20} />
          </IconButton>
        </div>
        <div className="sheet-body">{props.children}</div>
        {props.footer && <div className="sheet-foot">{props.footer}</div>}
      </div>
    </div>
  )
}

/** Шкала из четырёх этапов накладной в шапке карточки. */
export function StageBar({ state }: { state: State }) {
  const done = stageOf(state)
  const cancelled = state === 'cancelled'
  return (
    <ol className={`stages${cancelled ? ' stages-off' : ''}`} aria-label="Этапы накладной">
      {STAGES.map((s, i) => (
        <li key={s} className={i < done ? 'st-done' : i === done && !cancelled ? 'st-now' : ''}>
          <span className="st-dot" />
          <span className="st-label">{s}</span>
        </li>
      ))}
    </ol>
  )
}

export function Section(props: { title?: ReactNode; after?: ReactNode; children: ReactNode; flat?: boolean }) {
  return (
    <section className="section">
      {props.title && (
        <div className="section-head">
          <Typography.Label variant="small-strong" className="caps">
            {props.title}
          </Typography.Label>
          {props.after}
        </div>
      )}
      <div className={props.flat ? '' : 'island'}>{props.children}</div>
    </section>
  )
}

export function KV(props: { rows: [string, ReactNode | null | undefined][] }) {
  return (
    <dl className="kv">
      {props.rows
        .filter(([, v]) => v !== null && v !== undefined && v !== '')
        .map(([k, v]) => (
          <div key={k} className="kv-row">
            <dt>{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
    </dl>
  )
}

export function Note(props: { tone?: 'info' | 'warn' | 'bad' | 'good'; icon?: ReactNode; children: ReactNode }) {
  return (
    <div className={`note-box note-${props.tone ?? 'info'}`}>
      {props.icon}
      <div>{props.children}</div>
    </div>
  )
}

export function Empty(props: { title: string; text?: string; action?: ReactNode }) {
  return (
    <div className="empty">
      <Typography.Body variant="medium-strong">{props.title}</Typography.Body>
      {props.text && <Typography.Body variant="small" className="muted">{props.text}</Typography.Body>}
      {props.action}
    </div>
  )
}

export function NumberStepper(props: { value: number; onChange: (n: number) => void; min?: number; max?: number; id: string; label: string }) {
  const clamp = (n: number) => Math.max(props.min ?? 0, Math.min(props.max ?? 99999, n))
  return (
    <div className="stepper" role="group" aria-label={props.label}>
      <button type="button" aria-label="Меньше" onClick={() => props.onChange(clamp(props.value - 1))}>
        −
      </button>
      <input id={props.id} inputMode="numeric" value={props.value} onChange={(e) => props.onChange(clamp(Number(e.target.value.replace(/\D/g, '')) || 0))} />
      <button type="button" aria-label="Больше" onClick={() => props.onChange(clamp(props.value + 1))}>
        +
      </button>
    </div>
  )
}

/** Нижняя панель с главной кнопкой формы. */
export function BottomBar({ children }: { children: ReactNode }) {
  return <div className="bottombar">{children}</div>
}

export { Button }

// ---------- всплывающие сообщения ----------

interface Toast {
  id: number
  text: ReactNode
  action?: { label: string; run: () => void }
}

const ToastCtx = createContext<(t: Omit<Toast, 'id'>) => void>(() => {})
export const useToast = () => useContext(ToastCtx)

export function ToastHost({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<Toast[]>([])
  const seq = useRef(0)
  const push = useCallback((t: Omit<Toast, 'id'>) => {
    const id = ++seq.current
    setItems((xs) => [...xs.slice(-1), { ...t, id }])
    setTimeout(() => setItems((xs) => xs.filter((x) => x.id !== id)), 4200)
  }, [])
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toasts" aria-live="polite">
        {items.map((t) => (
          <div key={t.id} className="toast">
            <span>{t.text}</span>
            {t.action && (
              <button
                type="button"
                onClick={() => {
                  t.action!.run()
                  setItems((xs) => xs.filter((x) => x.id !== t.id))
                }}
              >
                {t.action.label}
              </button>
            )}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  )
}
