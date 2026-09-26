import { StrictMode, useEffect, useMemo, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { MaxUI, type PlatformType } from '@maxhub/max-ui'
import '@maxhub/max-ui/styles.css'
import './styles.css'
import './demo.css'
import { MockData } from './mock/store.ts'
import { Shell } from './shell.tsx'

// Макет для показа и обсуждения: настоящие экраны мини-приложения на моковых данных.
// Всё, что в MAX делает чат с ботом, здесь показывается окном «чат с ботом».

function useTheme(): 'light' | 'dark' {
  const read = (): 'light' | 'dark' => {
    const forced = document.documentElement.dataset.theme
    if (forced === 'light' || forced === 'dark') return forced
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
  }
  const [theme, setTheme] = useState(read)
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const update = () => setTheme(read())
    mq.addEventListener('change', update)
    const mo = new MutationObserver(update)
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    return () => (mq.removeEventListener('change', update), mo.disconnect())
  }, [])
  return theme
}

const STEPS = [
  ['Отправитель', 'Откройте ОТГ-2026-1040 во вкладке «Ждут меня» и назначьте перевозчика ГрузЛайн-Казань'],
  ['Перевозчик', 'Смените роль (нажмите на «Отправитель» вверху), примите заявку и назначьте свободную машину Р318ТК116 и водителя «Проверяющий (вы)»'],
  ['Водитель', 'Примите рейс, отметьте погрузку. Попробуйте «Есть замечания» — форма по позициям'],
  ['Отправитель', 'Подпишите отгрузку в чате. Перевозчик подписывает приём груза, через пару секунд оператор (модель) выдаёт номер и QR'],
  ['Водитель', 'Откройте QR-код, отметьте выгрузку и сдачу груза'],
  ['Получатель', 'Примите груз: уменьшите количество у позиции, выберите причину, добавьте фото. Подпишите приёмку'],
  ['Перевозчик', 'Подпишите сдачу груза — накладная закрыта, лента показывает всю цепочку'],
] as const

function Demo() {
  const theme = useTheme()
  const data = useMemo(() => new MockData(), [])
  const [platform, setPlatform] = useState<PlatformType>('android')
  const [panelOpen, setPanelOpen] = useState(false)
  const [epoch, setEpoch] = useState(0)

  return (
    <div className="demo">
      <aside className={`panel${panelOpen ? ' panel-open' : ''}`}>
        <button type="button" className="panel-toggle" aria-expanded={panelOpen} onClick={() => setPanelOpen(!panelOpen)}>
          <span>Демо-пульт и сценарий</span>
          <span aria-hidden="true">{panelOpen ? '▴' : '▾'}</span>
        </button>
        <div className="panel-body">
          <p className="eyebrow">Мини-приложение в MAX · макет</p>
          <h1>Накладная в кармане</h1>
          <p className="lead">
            Настоящие экраны на MAX UI и моковых данных завода. Вы — один человек с четырьмя ролями: отправитель Волжского завода, перевозчик ГрузЛайн-Казань, его водитель и получатель ООО «Волга».
          </p>

          <h2>Пройдите одну перевозку</h2>
          <ol className="steps">
            {STEPS.map(([role, text], i) => (
              <li key={i}>
                <b>{role}.</b> {text}
              </li>
            ))}
          </ol>

          <h2>Пульт</h2>
          <div className="controls">
            <button type="button" onClick={() => data.newErpShipment()}>
              Новая отгрузка из учётной системы
            </button>
            <button
              type="button"
              onClick={() => {
                data.reset()
                setEpoch((e) => e + 1)
              }}
            >
              Сбросить демо
            </button>
          </div>
          <div className="seg" role="radiogroup" aria-label="Платформа">
            {(['android', 'ios'] as const).map((p) => (
              <button key={p} type="button" role="radio" aria-checked={platform === p} onClick={() => setPlatform(p)}>
                {p === 'ios' ? 'iOS' : 'Android'}
              </button>
            ))}
          </div>

          <h2>Как читать макет</h2>
          <ul className="legend">
            <li>
              <b>Окно «чат с ботом»</b> — то, что в MAX придёт сообщением в чат после закрытия приложения. Подписи и отметки с доказательством делаются там.
            </li>
            <li>
              <b>Всплывашки сверху</b> — живое обновление: шаги других участников и оператора видны без перезагрузки.
            </li>
            <li>
              <b>Модель</b>: оператор ЭПД, ГИС ЭПД, номер и QR, справочник организаций, подпись организации. Всё остальное — как будет в продукте.
            </li>
          </ul>
        </div>
      </aside>

      <main className="stage">
        <div className="phone">
          <div className="phone-screen">
            <MaxUI key={epoch} colorScheme={theme} platform={platform}>
              <Shell data={data} />
            </MaxUI>
          </div>
        </div>
      </main>
    </div>
  )
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Demo />
  </StrictMode>,
)
