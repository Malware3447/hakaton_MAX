import { useEffect, useState } from 'react'
import QRCode from 'qrcode'
import { Typography } from '@maxhub/max-ui'
import { webApp } from '../bridge.ts'
import { Loading, Page, useApp, useLoad } from '../shell.tsx'
import { TopBar } from '../ui/kit.tsx'
import { fmtKg } from '../texts.ts'

// QR-код накладной для инспектора: белый фон на весь экран, яркость на максимум (в MAX — requestScreenMaxBrightness).

export function QrScreen({ id }: { id: string }) {
  const { back, data } = useApp()
  const [s] = useLoad(() => data.shipment(id), [id])
  const [src, setSrc] = useState<string | null>(null)
  useEffect(() => {
    if (!s?.uid) return
    void QRCode.toDataURL(`https://epd.example/${s.uid}`, { margin: 1, width: 640, errorCorrectionLevel: 'M' }).then(setSrc)
    webApp?.requestScreenMaxBrightness?.()
    return () => webApp?.restoreScreenBrightness?.()
  }, [s?.uid])
  if (!s) return <Page><TopBar title="QR-код" onBack={back} /><Loading /></Page>
  return (
    <div className="qr-screen">
      <TopBar title="QR-код накладной" subtitle={s.erpRef} onBack={back} />
      <div className="qr-box">
        {src ? <img src={src} alt={`QR-код накладной ${s.uid}`} /> : <Loading />}
        <Typography.Title variant="medium-strong" className="qr-uid">
          {s.uid}
        </Typography.Title>
        <span className="qr-meta">
          {s.vehicle?.plate} · {s.cargo.places} мест · {fmtKg(s.cargo.grossKg)}
        </span>
        <span className="qr-model">Номер и QR выдаёт оператор ЭПД — в демо это модель</span>
      </div>
    </div>
  )
}
