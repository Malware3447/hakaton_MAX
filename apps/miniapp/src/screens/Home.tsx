import { useEffect, useState } from 'react'
import { Button, CellList, CellSimple, Counter, IconButton, Input, Typography } from '@maxhub/max-ui'
import type { DateFilter, ListQuery, OrgBrief, Role, Shipment, StatusFilter } from '../model.ts'
import { Loading, useApp, useLoad } from '../shell.tsx'
import { Chip, Empty, Sheet, Tabs } from '../ui/kit.tsx'
import { IconBell, IconBuilding, IconCheck, IconFilter, IconSearch, IconTruck } from '../ui/icons.tsx'
import { fmtAgo, fmtDay, hasDiscrepancy, plural, route, STATE_SHORT, STATUS_FILTER_TEXT, TODO } from '../texts.ts'

// Главная роли: вкладки «Ждут меня / В работе / Закрытые», поиск, фильтры отправителя.

const TAB_LABEL: Record<Role, Record<ListQuery['tab'], string>> = {
  shipper: { waiting: 'Ждут меня', active: 'В работе', done: 'Закрытые' },
  carrier: { waiting: 'Ждут меня', active: 'Рейсы', done: 'Закрытые' },
  driver: { waiting: 'Мой ход', active: 'Рейсы', done: 'Прошлые' },
  consignee: { waiting: 'Приёмка', active: 'Ко мне едут', done: 'Принятые' },
}

const EMPTY: Record<ListQuery['tab'], string> = {
  waiting: 'Сейчас ничего не ждёт вашего действия',
  active: 'Здесь будут перевозки в работе',
  done: 'Закрытых перевозок пока нет',
}

const DATE_TEXT: Record<DateFilter, string> = { all: 'Все даты', today: 'Сегодня', tomorrow: 'Завтра', week: 'Эта неделя' }

const FILTER_KEY = 'nk-miniapp-filters'
const emptyFilters = { states: [] as StatusFilter[], date: 'all' as DateFilter, carrierIds: [] as string[] }

function loadFilters() {
  try {
    return { ...emptyFilters, ...JSON.parse(localStorage.getItem(FILTER_KEY) ?? '{}') }
  } catch {
    return emptyFilters
  }
}

export function Home() {
  const { data, me, role, go, refreshMe } = useApp()
  const [tab, setTab] = useState<ListQuery['tab']>('waiting')
  const [q, setQ] = useState('')
  const [filters, setFilters] = useState<typeof emptyFilters>(loadFilters)
  const [filterOpen, setFilterOpen] = useState(false)
  const [roleOpen, setRoleOpen] = useState(false)
  const useFilters = role === 'shipper'

  useEffect(() => {
    try {
      localStorage.setItem(FILTER_KEY, JSON.stringify(filters))
    } catch {
      /* без хранилища фильтр просто не запомнится */
    }
  }, [filters])

  const query: ListQuery = { tab, q, ...(useFilters ? filters : emptyFilters) }
  const [list] = useLoad(() => data.list(query), [tab, q, JSON.stringify(query), role])
  const [notices] = useLoad(() => data.notices(), [])
  const [carriers] = useLoad(() => data.carriers(), [])
  const unread = notices?.filter((n) => !n.read).length ?? 0
  const current = me.roles.find((r) => r.role === role)!
  const othersWaiting = me.roles.filter((r) => r.role !== role).reduce((n, r) => n + r.waiting, 0)
  const nFilters = filters.states.length + (filters.date !== 'all' ? 1 : 0) + filters.carrierIds.length

  const switchRole = async (r: Role) => {
    setRoleOpen(false)
    if (r === role) return
    await data.setRole(r)
    await refreshMe()
    setTab('waiting')
  }

  return (
    <>
      <header className="home-head">
        <button type="button" className="role-btn" onClick={() => setRoleOpen(true)} aria-haspopup="dialog">
          <span className="role-title">
            {current.title}
            {othersWaiting > 0 && <Counter value={othersWaiting} variant="attention" />}
            <span className="role-caret" aria-hidden="true">▾</span>
          </span>
          <span className="role-org">{current.orgName}</span>
        </button>
        <div className="home-icons">
          {role === 'carrier' && (
            <IconButton size="medium" variant="ghost" aria-label="Машины и водители" onClick={() => go({ name: 'fleet' })}>
              <IconTruck />
            </IconButton>
          )}
          {role !== 'driver' && (
            <IconButton size="medium" variant="ghost" aria-label="Компания" onClick={() => go({ name: 'company' })}>
              <IconBuilding />
            </IconButton>
          )}
          <span className="with-badge">
            <IconButton size="medium" variant="ghost" aria-label="События" onClick={() => go({ name: 'events' })}>
              <IconBell />
            </IconButton>
            {unread > 0 && <Counter value={unread} variant="attention" className="badge" />}
          </span>
        </div>
      </header>

      <div className="home-sticky">
        <Tabs
          items={(['waiting', 'active', 'done'] as const).map((k) => ({ key: k, label: TAB_LABEL[role][k], count: list?.counts[k], attention: k === 'waiting' }))}
          value={tab}
          onChange={setTab}
        />
        <div className="search-row">
          <Input
            id="search"
            mode="default"
            size="medium"
            placeholder={role === 'shipper' ? 'Номер, получатель, перевозчик' : 'Номер или адрес'}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            iconBefore={<IconSearch size={18} />}
            withClearButton
          />
          {useFilters && (
            <span className="with-badge">
              <IconButton size="medium" variant={nFilters ? 'primary' : 'secondary'} aria-label="Фильтры" onClick={() => setFilterOpen(true)}>
                <IconFilter />
              </IconButton>
              {nFilters > 0 && <Counter value={nFilters} variant="primary-contrast" className="badge" />}
            </span>
          )}
        </div>
        {useFilters && nFilters > 0 && (
          <div className="chips-row">
            {filters.states.map((s) => (
              <Chip key={s} active onClick={() => setFilters({ ...filters, states: filters.states.filter((x) => x !== s) })}>
                {STATUS_FILTER_TEXT[s]} ×
              </Chip>
            ))}
            {filters.date !== 'all' && (
              <Chip active onClick={() => setFilters({ ...filters, date: 'all' })}>
                {DATE_TEXT[filters.date]} ×
              </Chip>
            )}
            {filters.carrierIds.map((id) => (
              <Chip key={id} active onClick={() => setFilters({ ...filters, carrierIds: filters.carrierIds.filter((x) => x !== id) })}>
                {id === 'none' ? 'Без перевозчика' : (carriers?.find((c) => c.id === id)?.name ?? id)} ×
              </Chip>
            ))}
          </div>
        )}
      </div>

      <div className="list">
        {!list ? (
          <Loading />
        ) : list.items.length === 0 ? (
          <Empty
            title={q || nFilters ? 'Ничего не нашлось' : EMPTY[tab]}
            text={q || nFilters ? 'Измените поиск или сбросьте фильтры' : undefined}
            action={
              q || nFilters ? (
                <Button size="small" variant="secondary" onClick={() => (setQ(''), setFilters(emptyFilters))}>
                  Сбросить
                </Button>
              ) : undefined
            }
          />
        ) : (
          list.items.map((s) => <Row key={s.id} s={s} role={role} tab={tab} onOpen={() => go({ name: 'shipment', id: s.id })} />)
        )}
      </div>

      <Sheet open={roleOpen} title="От чьего лица работаете" onClose={() => setRoleOpen(false)}>
        <CellList mode="island">
          {me.roles.map((r) => (
            <CellSimple
              key={r.role}
              title={r.title}
              subtitle={r.orgName ?? undefined}
              before={<span className="radio-dot" data-on={r.role === role} />}
              after={r.waiting > 0 ? <Counter value={r.waiting} variant={r.role === role ? 'primary' : 'attention'} /> : undefined}
              onClick={() => void switchRole(r.role)}
            />
          ))}
        </CellList>
        <Typography.Body variant="small" className="muted pad">
          Роль меняется и в чате с ботом: меню бота откроется от той же роли. Сообщения о вашем ходе приходят по всем ролям.
        </Typography.Body>
      </Sheet>

      <FilterSheet open={filterOpen} onClose={() => setFilterOpen(false)} value={filters} onChange={setFilters} carriers={carriers ?? []} />
    </>
  )
}

function Row({ s, role, tab, onOpen }: { s: Shipment; role: Role; tab: ListQuery['tab']; onOpen: () => void }) {
  const mine = s.turn === role && s.canAct
  const warn = hasDiscrepancy(s)
  const who = role === 'consignee' ? s.shipper.name : s.consignee.name
  return (
    <button type="button" className={`row${mine ? ' row-mine' : ''}`} onClick={onOpen}>
      <span className="row-top">
        <span className="row-ref">{s.erpRef}</span>
        <span className="row-when">{tab === 'waiting' ? `ждёт ${fmtAgo(s.turnSince)}` : fmtDay(s.plannedLoadingAt)}</span>
      </span>
      <span className="row-mid">
        {route(s)} · {who}
      </span>
      <span className="row-bottom">
        {mine && TODO[s.state] ? (
          <span className="todo">{TODO[s.state]} ›</span>
        ) : (
          <span className={`pill pill-${s.state === 'closed' ? 'done' : s.state === 'cancelled' ? 'off' : 'on'}`}>{STATE_SHORT[s.state]}</span>
        )}
        {s.carrier && role === 'shipper' && <span className="muted small">{s.carrier.name}</span>}
        {warn && <span className="pill pill-warn">расхождения</span>}
      </span>
    </button>
  )
}

function FilterSheet(props: { open: boolean; onClose: () => void; value: typeof emptyFilters; onChange: (v: typeof emptyFilters) => void; carriers: OrgBrief[] }) {
  const [v, setV] = useState(props.value)
  useEffect(() => setV(props.value), [props.open, props.value])
  const toggle = <T,>(xs: T[], x: T) => (xs.includes(x) ? xs.filter((y) => y !== x) : [...xs, x])
  const n = v.states.length + (v.date !== 'all' ? 1 : 0) + v.carrierIds.length
  return (
    <Sheet
      open={props.open}
      title="Фильтры"
      onClose={props.onClose}
      footer={
        <div className="foot-row">
          <Button size="large" variant="secondary" onClick={() => setV(emptyFilters)} disabled={!n}>
            Сбросить
          </Button>
          <Button size="large" stretched onClick={() => (props.onChange(v), props.onClose())}>
            Показать
          </Button>
        </div>
      }
    >
      <div className="filter-group">
        <Typography.Label variant="small-strong" className="caps">
          Статус
        </Typography.Label>
        <div className="chips-wrap">
          {(Object.keys(STATUS_FILTER_TEXT) as StatusFilter[]).map((k) => (
            <Chip key={k} active={v.states.includes(k)} tone={k === 'discrepancy' ? 'warn' : 'default'} onClick={() => setV({ ...v, states: toggle(v.states, k) })}>
              {v.states.includes(k) && <IconCheck size={14} />} {STATUS_FILTER_TEXT[k]}
            </Chip>
          ))}
        </div>
      </div>
      <div className="filter-group">
        <Typography.Label variant="small-strong" className="caps">
          Дата отгрузки
        </Typography.Label>
        <div className="chips-wrap">
          {(Object.keys(DATE_TEXT) as DateFilter[]).map((k) => (
            <Chip key={k} active={v.date === k} onClick={() => setV({ ...v, date: k })}>
              {DATE_TEXT[k]}
            </Chip>
          ))}
        </div>
      </div>
      <div className="filter-group">
        <Typography.Label variant="small-strong" className="caps">
          Перевозчик
        </Typography.Label>
        <div className="chips-wrap">
          {[{ id: 'none', name: 'Не назначен' }, ...props.carriers].map((c) => (
            <Chip key={c.id} active={v.carrierIds.includes(c.id)} onClick={() => setV({ ...v, carrierIds: toggle(v.carrierIds, c.id) })}>
              {v.carrierIds.includes(c.id) && <IconCheck size={14} />} {c.name}
            </Chip>
          ))}
        </div>
      </div>
      <Typography.Body variant="small" className="muted">
        Фильтр запоминается на этом устройстве. {n ? `Выбрано: ${n} ${plural(n, 'условие', 'условия', 'условий')}.` : ''}
      </Typography.Body>
    </Sheet>
  )
}
