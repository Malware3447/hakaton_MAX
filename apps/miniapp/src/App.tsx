import { useEffect, useState } from 'react'
import { Button, CellList, CellSimple, Counter, Spinner, Typography } from '@maxhub/max-ui'
import { api, ApiError, startSession, type Me, type Role } from './api.ts'
import { closeApp, webApp } from './bridge.ts'

// Каркас мини-приложения (HAKATON-42, шаг 1): вход по initData и текущая роль, общая с ботом.
// Списки и карточка перевозки — следующий шаг, план в docs/mini-prilozhenie.md.

type Screen =
  | { kind: 'loading' }
  | { kind: 'outside' }
  | { kind: 'unregistered' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; me: Me; startParam: string | null }

/** startapp: r_<роль> — открыть главную этой роли, s_<id> — открыть перевозку. */
function roleFromStart(startParam: string | null, me: Me): Role | null {
  const m = startParam?.match(/^r_(shipper|carrier|driver|consignee)$/)
  const role = m?.[1] as Role | undefined
  return role && role !== me.activeRole && me.roles.some((r) => r.role === role) ? role : null
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
      const me = role ? await api.setRole(role) : s.me
      if (alive) setScreen({ kind: 'ready', me, startParam: s.startParam })
    })().catch((e: unknown) => {
      if (alive) setScreen({ kind: 'error', message: e instanceof ApiError && e.status === 401 ? 'Не удалось подтвердить вход. Откройте приложение из чата заново.' : 'Сервер не ответил. Попробуйте ещё раз.' })
    })
    return () => {
      alive = false
    }
  }, [])

  switch (screen.kind) {
    case 'loading':
      return (
        <div className="center">
          <Spinner size={32} />
        </div>
      )
    case 'outside':
      return (
        <Message title="Откройте из MAX" text="Мини-приложение работает внутри MAX: откройте его кнопкой в чате с ботом «Накладная в кармане»." />
      )
    case 'unregistered':
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
      return <Home me={screen.me} onMe={(me) => setScreen({ ...screen, me })} />
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

function Home({ me, onMe }: { me: Me; onMe: (me: Me) => void }) {
  const [switching, setSwitching] = useState(false)
  const [busy, setBusy] = useState<Role | null>(null)
  const current = me.roles.find((r) => r.role === me.activeRole) ?? me.roles[0]

  if (!current) {
    return <Message title="Ролей пока нет" text="Заведите роль в чате с ботом: отправитель, перевозчик, водитель или получатель." />
  }

  const choose = async (role: Role) => {
    if (role === current.role) return setSwitching(false)
    setBusy(role)
    try {
      onMe(await api.setRole(role))
      setSwitching(false)
    } finally {
      setBusy(null)
    }
  }
  const othersWaiting = me.roles.filter((r) => r.role !== current.role).reduce((n, r) => n + r.waiting, 0)

  return (
    <div className="page">
      <CellList mode="island">
        <CellSimple
          title={current.title}
          subtitle={current.orgName ?? 'компания не указана'}
          after={othersWaiting > 0 && !switching ? <Counter value={othersWaiting} variant="attention" /> : undefined}
          showChevron
          onClick={() => setSwitching(!switching)}
        />
      </CellList>

      {switching && (
        <CellList mode="island" header={<Typography.Label variant="small">Сменить роль</Typography.Label>}>
          {me.roles.map((r) => (
            <CellSimple
              key={r.role}
              title={r.title}
              subtitle={r.orgName ?? undefined}
              after={busy === r.role ? <Spinner size={20} /> : r.waiting > 0 ? <Counter value={r.waiting} variant={r.role === current.role ? 'primary' : 'attention'} /> : r.role === current.role ? '✓' : undefined}
              onClick={() => void choose(r.role)}
            />
          ))}
        </CellList>
      )}

      <CellList mode="island">
        <CellSimple
          title="Ждут вас"
          subtitle={current.waiting > 0 ? 'перевозки, где сейчас ваш ход' : 'сейчас ничего не ждёт'}
          after={<Counter value={current.waiting} variant={current.waiting > 0 ? 'primary' : 'mute'} />}
        />
      </CellList>

      <Typography.Body variant="small" className="muted note">
        Здравствуйте, {me.person.name}. Списки перевозок, карточка и документы появятся здесь на следующем шаге.
      </Typography.Body>
    </div>
  )
}
