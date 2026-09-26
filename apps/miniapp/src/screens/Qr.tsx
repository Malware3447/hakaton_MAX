import { useEffect, useState } from 'react'
import { Typography } from '@maxhub/max-ui'
import { webApp } from '../bridge.ts'
import { Loading, Page, useApp, useLoad } from '../shell.tsx'
import { TopBar } from '../ui/kit.tsx'
import { fmtKg } from '../texts.ts'

// QR-код накладной для инспектора: белый фон на весь экран, яркость на максимум (в MAX — requestScreenMaxBrightness).
// Код выдаёт оператор ЭПД (модель) — тот же анимированный QR, что приходит водителю в чат.

export function QrScreen({ id }: { id: string }) {
  const { back, data } = useApp()
  const [s] = useLoad(() => data.shipment(id), [id])
  const [src, setSrc] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    if (!s?.uid) return
    let url: string | null = null
    data.qr(s.id).then(
      (u) => setSrc((url = u)),
      (e: unknown) => setError(e instanceof Error ? e.message : String(e)),
    )
    webApp?.requestScreenMaxBrightness?.()
    return () => {
      webApp?.restoreScreenBrightness?.()
      if (url?.startsWith('blob:')) URL.revokeObjectURL(url)
    }
  }, [data, s?.id, s?.uid])
  if (!s) return <Page><TopBar title="QR-код" onBack={back} /><Loading /></Page>
  return (
    <div className="qr-screen">
      <TopBar title="QR-код накладной" subtitle={s.erpRef} onBack={back} />
      <div className="qr-box">
        {src ? <img src={src} alt={`QR-код накладной ${s.uid}`} /> : error ? <span className="qr-meta">{error}</span> : <Loading />}
        <Typography.Title variant="medium-strong" className="qr-uid">
          {s.uid}
        </Typography.Title>
        <span className="qr-meta">
          {s.vehicle?.plate} · {s.cargo.places} мест · {fmtKg(s.cargo.grossKg)}
        </span>
        <span className="qr-model">Номер и QR-код выдаёт оператор ЭПД (модель)</span>
      </div>
    </div>
  )
}
