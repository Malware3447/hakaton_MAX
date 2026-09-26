import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { useAppearance } from '@maxhub/max-ui'
import type { ChatStep, DataSource, Me, Role, ShipEvent } from './model.ts'
import { ToastHost, useToast } from './ui/kit.tsx'
import { ChatSheet } from './chat.tsx'
import { Home } from './screens/Home.tsx'
import { ShipmentScreen } from './screens/ShipmentScreen.tsx'
import { AcceptanceForm, AssignForm, DeclineForm, RemarksForm } from './screens/Forms.tsx'
import { FleetScreen } from './screens/Fleet.tsx'
import { CompanyScreen } from './screens/Company.tsx'
import { EventsScreen } from './screens/Events.tsx'
import { QrScreen } from './screens/Qr.tsx'

// Оболочка мини-приложения: стек экранов, текущий человек и роль, живое обновление.
// Источник данных подставляется снаружи: API сервера в MAX, мок в макете.

export type Route =
  | { name: 'home' }
  | { name: 'shipment'; id: string }
  | { name: 'acceptance'; id: string }
  | { name: 'remarks'; id: string }
  | { name: 'decline'; id: string }
  | { name: 'assign'; id: string }
  | { name: 'fleet' }
  | { name: 'company' }
  | { name: 'events' }
  | { name: 'qr'; id: string }

interface Ctx {
  data: DataSource
  me: Me
  role: Role
  /** растёт при каждом изменении данных — экраны перечитывают своё */
  version: number
  refreshMe: () => Promise<void>
  go: (r: Route) => void
  back: () => void
  /** шаг, который делается в чате: в MAX приложение закрывается и бот присылает сообщение */
  toChat: (step: ChatStep) => void
}

const AppCtx = createContext<Ctx | null>(null)
export const useApp = () => useContext(AppCtx)!

export function Shell({ data, initial }: { data: DataSource; initial?: Route }) {
  const { colorScheme } = useAppearance()
  return (
    <div className="nk" data-scheme={colorScheme}>
      <ToastHost>
        <ShellInner data={data} initial={initial} />
      </ToastHost>
    </div>
  )
}

function ShellInner({ data, initial }: { data: DataSource; initial?: Route }) {
  const [me, setMe] = useState<Me | null>(null)
  const [stack, setStack] = useState<Route[]>(initial && initial.name !== 'home' ? [{ name: 'home' }, initial] : [{ name: 'home' }])
  const [version, setVersion] = useState(0)
  const [chat, setChat] = useState<ChatStep | null>(null)
  const toast = useToast()

  const refreshMe = useCallback(async () => setMe(await data.me()), [data])

  useEffect(() => {
    void refreshMe()
    return data.subscribe((e: ShipEvent | null) => {
      setVersion((v) => v + 1)
      void refreshMe()
      if (e && !e.actor.startsWith('Проверяющий')) {
        toast({
          text: (
            <>
              <b>{e.erpRef}</b> · {e.text}
            </>
          ),
          action: { label: 'Открыть', run: () => setStack((s) => [...s.filter((r) => r.name === 'home'), { name: 'shipment', id: e.shipmentId }]) },
        })
      }
    })
  }, [data, refreshMe, toast])

  const go = useCallback((r: Route) => setStack((s) => [...s, r]), [])
  const back = useCallback(() => setStack((s) => (s.length > 1 ? s.slice(0, -1) : s)), [])

  const ctx = useMemo<Ctx | null>(
    () => (me ? { data, me, role: me.activeRole, version, refreshMe, go, back, toChat: setChat } : null),
    [data, me, version, refreshMe, go, back],
  )
  if (!ctx) return <div className="screen" />

  const route = stack[stack.length - 1]!
  return (
    <AppCtx.Provider value={ctx}>
      <div className="screen" key={`${route.name}-${'id' in route ? route.id : ''}`}>
        {route.name === 'home' && <Home />}
        {route.name === 'shipment' && <ShipmentScreen id={route.id} />}
        {route.name === 'acceptance' && <AcceptanceForm id={route.id} />}
        {route.name === 'remarks' && <RemarksForm id={route.id} />}
        {route.name === 'decline' && <DeclineForm id={route.id} />}
        {route.name === 'assign' && <AssignForm id={route.id} />}
        {route.name === 'fleet' && <FleetScreen />}
        {route.name === 'company' && <CompanyScreen />}
        {route.name === 'events' && <EventsScreen />}
        {route.name === 'qr' && <QrScreen id={route.id} />}
      </div>
      <ChatSheet
        step={chat}
        onClose={() => setChat(null)}
        onDone={(shipmentId) => {
          setChat(null)
          setStack((s) => {
            const home = s.filter((r) => r.name === 'home')
            return [...home, { name: 'shipment', id: shipmentId }]
          })
        }}
      />
    </AppCtx.Provider>
  )
}

/** Перечитать данные экрана при каждом изменении. */
export function useLoad<T>(load: () => Promise<T>, deps: unknown[] = []): [T | null, Error | null, () => void] {
  const { version } = useApp()
  const [value, setValue] = useState<T | null>(null)
  const [error, setError] = useState<Error | null>(null)
  const [tick, setTick] = useState(0)
  useEffect(() => {
    let alive = true
    load().then(
      (v) => alive && (setValue(v), setError(null)),
      (e: unknown) => alive && setError(e instanceof Error ? e : new Error(String(e))),
    )
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version, tick, ...deps])
  return [value, error, () => setTick((t) => t + 1)]
}

export function Loading() {
  return <div className="loading" aria-busy="true" />
}

export function Page({ children, bottom }: { children: ReactNode; bottom?: boolean }) {
  return <div className={`page${bottom ? ' page-bottom' : ''}`}>{children}</div>
}
