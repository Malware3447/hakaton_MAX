import { useEffect, useState } from 'react'
import { Button, CellList, CellSimple, Input, Typography } from '@maxhub/max-ui'
import type { Ownership, Vehicle } from '../model.ts'
import { Loading, Page, useApp, useLoad } from '../shell.tsx'
import { Chip, Empty, Section, Sheet, Tabs, TopBar, useToast } from '../ui/kit.tsx'
import { IconPlus, IconUserPlus } from '../ui/icons.tsx'
import { BODY_TYPES, missingForWaybill, OWNERSHIP_TEXT } from '../texts.ts'

// Машины и водители перевозчика. Водителя добавляют пересылкой контакта в чате — так бот узнаёт человека.

export function FleetScreen() {
  const { back, data, toChat } = useApp()
  const [tab, setTab] = useState<'vehicles' | 'drivers'>('vehicles')
  const [vehicles, , reload] = useLoad(() => data.vehicles(), [])
  const [drivers] = useLoad(() => data.drivers(), [])
  const [edit, setEdit] = useState<Vehicle | 'new' | null>(null)

  return (
    <Page>
      <TopBar title="Машины и водители" onBack={back} />
      <Tabs
        items={[
          { key: 'vehicles', label: 'Машины', count: vehicles?.length },
          { key: 'drivers', label: 'Водители', count: drivers?.length },
        ]}
        value={tab}
        onChange={setTab}
      />
      {tab === 'vehicles' &&
        (!vehicles ? (
          <Loading />
        ) : (
          <Section after={<Button size="xsmall" variant="ghost" iconBefore={<IconPlus size={16} />} onClick={() => setEdit('new')}>Добавить</Button>} title="Свои машины">
            {vehicles.length === 0 ? (
              <Empty title="Машин пока нет" />
            ) : (
              <CellList mode="island">
                {vehicles.map((v) => (
                  <CellSimple
                    key={v.id}
                    title={`${v.plate} · ${v.brand}`}
                    subtitle={`${OWNERSHIP_TEXT[v.ownership]}${missingForWaybill(v) ? ' · нет данных для накладной' : v.bodyType ? ` · ${v.bodyType.toLowerCase()}` : ''}${v.busyWith ? ` · в рейсе ${v.busyWith}` : ' · свободна'}`}
                    showChevron
                    onClick={() => setEdit(v)}
                  />
                ))}
              </CellList>
            )}
          </Section>
        ))}
      {tab === 'drivers' &&
        (!drivers ? (
          <Loading />
        ) : (
          <Section title="Водители компании">
            <CellList mode="island">
              {drivers.map((d) => (
                <CellSimple key={d.id} title={d.name} subtitle={d.busyWith ? `в рейсе ${d.busyWith}` : 'свободен'} after={d.busyWith ? <span className="pill pill-on">в рейсе</span> : undefined} />
              ))}
              {data.features.addDriver ? (
                <CellSimple
                  title="Добавить водителя"
                  subtitle="переслать контакт в чате с ботом"
                  before={<IconUserPlus size={22} />}
                  onClick={() =>
                    toChat({
                      shipmentId: '',
                      text: 'Перешлите сюда контакт водителя из записной книжки MAX: скрепка → «Контакт». Если водителя ещё нет в боте, я дам ссылку-приглашение.',
                      buttons: [],
                      handoff: { kind: 'card' },
                    })
                  }
                />
              ) : (
                <CellSimple title="Как добавить водителя" subtitle="при назначении на рейс: «Новый водитель» — бот попросит переслать его контакт" before={<IconUserPlus size={22} />} />
              )}
            </CellList>
          </Section>
        ))}
      <VehicleSheet open={edit !== null} vehicle={edit === 'new' ? null : edit} onClose={() => setEdit(null)} onSaved={() => reload()} />
    </Page>
  )
}

export function VehicleSheet(props: { open: boolean; vehicle?: Vehicle | null; onClose: () => void; onSaved: (list: Vehicle[]) => void }) {
  const { data } = useApp()
  const toast = useToast()
  const [plate, setPlate] = useState('')
  const [brand, setBrand] = useState('')
  const [ownership, setOwnership] = useState<Ownership>('own')
  const [ownerName, setOwnerName] = useState('')
  const [bodyType, setBodyType] = useState<string | null>(null)
  const [capacity, setCapacity] = useState('')
  const [volume, setVolume] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (!props.open) return
    const v = props.vehicle
    setPlate(v?.plate ?? '')
    setBrand(v?.brand ?? '')
    setOwnership(v?.ownership ?? 'own')
    setOwnerName(v?.ownerName ?? '')
    setBodyType(v?.bodyType ?? null)
    setCapacity(v?.capacityT != null ? String(v.capacityT).replace('.', ',') : '')
    setVolume(v?.volumeM3 != null ? String(v.volumeM3).replace('.', ',') : '')
    setError(null)
  }, [props.open, props.vehicle])

  const num = (s: string) => {
    const n = Number(s.replace(',', '.').replace(/[^\d.]/g, ''))
    return s.trim() && Number.isFinite(n) ? n : null
  }
  const ready = plate.trim() && brand.trim() && bodyType && num(capacity) !== null && num(volume) !== null && (ownership === 'own' || ownerName.trim())

  const save = async () => {
    setBusy(true)
    setError(null)
    try {
      const list = await data.saveVehicle({
        id: props.vehicle?.id,
        plate,
        brand,
        ownership,
        ownerName: ownership === 'own' ? null : ownerName.trim() || null,
        bodyType,
        capacityT: num(capacity),
        volumeM3: num(volume),
      })
      toast({ text: props.vehicle ? 'Машина сохранена' : 'Машина добавлена' })
      props.onSaved(list)
      props.onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Sheet
      open={props.open}
      title={props.vehicle ? 'Машина' : 'Новая машина'}
      onClose={props.onClose}
      footer={
        <Button size="large" stretched loading={busy} disabled={!ready} onClick={() => void save()}>
          Сохранить
        </Button>
      }
    >
      <div className="form">
        <label htmlFor="plate" className="small">
          Госномер
        </label>
        <Input id="plate" placeholder="А245КМ116" value={plate} onChange={(e) => setPlate(e.target.value.toUpperCase())} autoCapitalize="characters" />
        <label htmlFor="brand" className="small">
          Марка и модель
        </label>
        <Input id="brand" placeholder="КАМАЗ 65115" value={brand} onChange={(e) => setBrand(e.target.value)} />
        <span className="small">Тип кузова</span>
        <div className="chips-wrap">
          {BODY_TYPES.map((b) => (
            <Chip key={b} active={bodyType === b} onClick={() => setBodyType(b)}>
              {b}
            </Chip>
          ))}
        </div>
        <label htmlFor="capacity" className="small">
          Грузоподъёмность, т
        </label>
        <Input id="capacity" inputMode="decimal" placeholder="15" value={capacity} onChange={(e) => setCapacity(e.target.value)} />
        <label htmlFor="volume" className="small">
          Объём кузова, м³
        </label>
        <Input id="volume" inputMode="decimal" placeholder="30" value={volume} onChange={(e) => setVolume(e.target.value)} />
        <span className="small">Вид владения</span>
        <div className="chips-wrap">
          {(Object.keys(OWNERSHIP_TEXT) as Ownership[]).map((o) => (
            <Chip key={o} active={ownership === o} onClick={() => setOwnership(o)}>
              {OWNERSHIP_TEXT[o]}
            </Chip>
          ))}
        </div>
        {ownership !== 'own' && (
          <>
            <label htmlFor="owner" className="small">
              Владелец машины
            </label>
            <Input id="owner" placeholder="Компания или ФИО" value={ownerName} onChange={(e) => setOwnerName(e.target.value)} />
          </>
        )}
        <Typography.Body variant="small" className="muted">
          Всё это попадает в транспортную накладную.
        </Typography.Body>
        {error && (
          <Typography.Body variant="small" className="warn-text">
            {error}
          </Typography.Body>
        )}
      </div>
    </Sheet>
  )
}
