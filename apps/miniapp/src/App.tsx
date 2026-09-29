import { useEffect, useMemo, useState } from 'react'
import { Button, Spinner, Typography } from '@maxhub/max-ui'
import { ApiData, ApiError, setRole, startSession, type MeView } from './api.ts'
import { closeApp, webApp } from './bridge.ts'
import type { Me, Role } from './model.ts'
import { Shell, type Route } from './shell.tsx'
import { BOT_LINK, BOT_NAME } from './texts.ts'

// Мини-приложение в MAX (HAKATON-42): вход по initData, дальше — те же экраны, что в макете,
// на данных сервера. startapp: r_<роль> — открыть главную этой роли, s_<id> — открыть перевозку.

type Screen =
  | { kind: 'loading' }
  | { kind: 'outside' }
  | { kind: 'unregistered' }
  | { kind: 'no_roles' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; me: Me; initial?: Route }

function roleFromStart(startParam: string | null, me: MeView): Role | null {
  const m = startParam?.match(/^r_(shipper|carrier|driver|consignee)$/)
  const role = m?.[1] as Role | undefined
  return role && role !== me.activeRole && me.roles.some((r) => r.role === role) ? role : null
}

function routeFromStart(startParam: string | null): Route | undefined {
  const m = startParam?.match(/^s_([0-9a-f-]{36})$/i)
  return m ? { name: 'shipment', id: m[1]! } : undefined
}

export function App() {
  const [screen, setScreen] = useState<Screen>({ kind: 'loading' })

  useEffect(() => {
    webApp?.ready?.()
    if (!webApp) return setScreen({ kind: 'outside' })
    let alive = true
    ;(async () => {
      const s = await startSession()
      if (!s.registered) return alive && setScreen({ kind: 'unregistered' })
      const role = roleFromStart(s.startParam, s.me)
      const me = role ? await setRole(role) : s.me
      if (!me.activeRole) return alive && setScreen({ kind: 'no_roles' })
      if (alive) setScreen({ kind: 'ready', me: { ...me, activeRole: me.activeRole }, initial: routeFromStart(s.startParam) })
    })().catch((e: unknown) => {
      if (!alive) return
      const message =
        e instanceof ApiError && e.status === 401
          ? 'Не удалось подтвердить вход. Откройте приложение из чата заново.'
          : e instanceof Error
            ? e.message
            : 'Сервер не ответил. Попробуйте ещё раз.'
      setScreen({ kind: 'error', message })
    })
    return () => {
      alive = false
    }
  }, [])

  const data = useMemo(() => (screen.kind === 'ready' ? new ApiData(screen.me) : null), [screen])

  switch (screen.kind) {
    case 'loading':
      return (
        <div className="center">
          <Spinner size={32} />
        </div>
      )
    case 'outside':
      // Вне MAX моста нет: обычная ссылка на чат с ботом, её откроет и браузер
      return (
        <Message title="Откройте из MAX" text={`Мини-приложение работает внутри MAX: откройте его кнопкой в чате с ботом «${BOT_NAME.replace(/ /g, '\u00a0')}».`}>
          <Button asChild size="large" stretched>
            <a href={BOT_LINK}>Открыть чат с ботом</a>
          </Button>
        </Message>
      )
    case 'unregistered':
    case 'no_roles':
      return (
        <Message title="Сначала подключитесь в чате" text="Роли и компания заводятся в чате с ботом. Нажмите /start, выберите роль — и возвращайтесь сюда.">
          <Button size="large" stretched onClick={closeApp}>
            Вернуться в чат
          </Button>
        </Message>
      )
    case 'error':
      return (
        <Message title="Что-то пошло не так" text={screen.message}>
          <Button size="large" stretched onClick={() => location.reload()}>
            Обновить
          </Button>
        </Message>
      )
    case 'ready':
      return <Shell data={data!} initial={screen.initial} />
  }
}

function Message(props: { title: string; text: string; children?: React.ReactNode }) {
  return (
    <div className="center column">
      <Typography.Title variant="medium-strong">{props.title}</Typography.Title>
      <Typography.Body variant="medium" className="muted">
        {props.text}
      </Typography.Body>
      {props.children}
    </div>
  )
}
