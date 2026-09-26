import { useEffect } from 'react'
import { Loading, Page, useApp, useLoad } from '../shell.tsx'
import { Empty, TopBar } from '../ui/kit.tsx'
import { fmtDay, ROLE_TITLE } from '../texts.ts'

// Раздел событий по всем ролям человека. Непрочитанное отмечено; открыли раздел — всё прочитано.

export function EventsScreen() {
  const { back, data, go } = useApp()
  const [list] = useLoad(() => data.notices(), [])
  useEffect(() => {
    const t = setTimeout(() => void data.markRead(), 1500)
    return () => clearTimeout(t)
  }, [data])
  return (
    <Page>
      <TopBar title="События" onBack={back} />
      {!list ? (
        <Loading />
      ) : list.length === 0 ? (
        <Empty title="Событий пока нет" />
      ) : (
        <ul className="notices">
          {list.map(({ event: e, read }) => (
            <li key={e.id}>
              <button type="button" className={`notice${read ? '' : ' unread'}`} onClick={() => go({ name: 'shipment', id: e.shipmentId })}>
                <span className="notice-dot" aria-label={read ? undefined : 'не прочитано'} />
                <span className="notice-body">
                  <span className="notice-top">
                    <b>{e.erpRef}</b>
                    <span className="muted small">{fmtDay(e.at)}</span>
                  </span>
                  <span>{e.text}</span>
                  <span className="muted small">
                    {e.actor}
                    {e.turnFor && ` · ход: ${ROLE_TITLE[e.turnFor].toLowerCase()}`}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </Page>
  )
}
