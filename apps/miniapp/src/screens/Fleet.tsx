import { useEffect, useState } from 'react'
import { Button, CellList, CellSimple, Input, Typography } from '@maxhub/max-ui'
import type { Ownership, Vehicle } from '../model.ts'
import { Loading, Page, useApp, useLoad } from '../shell.tsx'
import { Chip, Empty, Section, Sheet, Tabs, TopBar, useToast } from '../ui/kit.tsx'
import { IconPlus, IconUserPlus } from '../ui/icons.tsx'
import { OWNERSHIP_TEXT } from '../texts.ts'

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
                  <CellSimple key={v.id} title={`${v.plate} · ${v.brand}`} subtitle={`${OWNERSHIP_TEXT[v.ownership]}${v.busyWith ? ` · в рейсе ${v.busyWith}` : ' · свободна'}`} showChevron onClick={() => setEdit(v)} />
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
              <CellSimple
                title="Добавить водителя"
                subtitle="переслать контакт в чате с ботом"
                before={<IconUserPlus size={22} />}
                onClick={() =>
                  toChat({ shipmentId: '', text: 'Перешлите сюда контакт водителя из записной книжки MAX: скрепка → «Контакт». Если водителя ещё нет в боте, я дам ссылку-приглашение.', buttons: [] })
                }
              />
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
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (!props.open) return
    setPlate(props.vehicle?.plate ?? '')
    setBrand(props.vehicle?.brand ?? '')
    setOwnership(props.vehicle?.ownership ?? 'own')
    setError(null)
  }, [props.open, props.vehicle])

  const save = async () => {
    setBusy(true)
    setError(null)
    try {
      const list = await data.saveVehicle({ id: props.vehicle?.id, plate, brand, ownership })
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
        <Button size="large" stretched loading={busy} disabled={!plate.trim() || !brand.trim()} onClick={() => void save()}>
          Сохранить
        </Button>
      }
    >
      <div className="form">
        <label htmlFor="plate" className="small">
          Госномер
        </label>
        <Input id="plate" placeholder="А245КМ116" value={plate} onChange={(e) => setPlate(e.target.value.toUpperCase())} autoCapitalize="characters" hint={error ?? undefined} />
        <label htmlFor="brand" className="small">
          Марка и тип кузова
        </label>
        <Input id="brand" placeholder="КАМАЗ 65115 (бортовой)" value={brand} onChange={(e) => setBrand(e.target.value)} />
        <span className="small">Вид владения — нужен в накладной</span>
        <div className="chips-wrap">
          {(Object.keys(OWNERSHIP_TEXT) as Ownership[]).map((o) => (
            <Chip key={o} active={ownership === o} onClick={() => setOwnership(o)}>
              {OWNERSHIP_TEXT[o]}
            </Chip>
          ))}
        </div>
        {error && (
          <Typography.Body variant="small" className="warn-text">
            {error}
          </Typography.Body>
        )}
      </div>
    </Sheet>
  )
}
