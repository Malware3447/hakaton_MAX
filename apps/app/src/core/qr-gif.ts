import gifenc from 'gifenc'
import QRCode from 'qrcode'

// QR-код накладной для водителя — анимированный GIF, как «живой» QR ГИС ЭПД (модель).
// Каждый кадр — полноценный QR с тем же УИД и номером кадра, под ним полоса хода:
// снимок экрана отличается от живого кода, а файл открывается без сети.

// Node импортирует CommonJS-сборку (по умолчанию — объект модуля), vite и esbuild — ESM (сама функция)
const GIFEncoder = typeof gifenc === 'function' ? gifenc : gifenc.GIFEncoder

const SCALE = 8
const MARGIN = 4 // модулей белого поля вокруг кода
const BAR = 3 // высота полосы хода, в модулях
const FRAMES = 4
const DELAY_MS = 750
const PALETTE = [
  [255, 255, 255],
  [0, 0, 0],
]

export function qrGif(payload: Record<string, unknown>): Uint8Array {
  const gif = GIFEncoder()
  for (let f = 0; f < FRAMES; f++) {
    const qr = QRCode.create(JSON.stringify({ ...payload, f }), { errorCorrectionLevel: 'M' })
    const n = qr.modules.size
    const side = n + MARGIN * 2
    const width = side * SCALE
    const height = (side + BAR + 1) * SCALE
    const px = new Uint8Array(width * height)
    for (let y = 0; y < n; y++)
      for (let x = 0; x < n; x++) if (qr.modules.get(y, x)) fill(px, width, (x + MARGIN) * SCALE, (y + MARGIN) * SCALE, SCALE, SCALE)
    // Полоса хода под белым полем кода (поле не трогаем — иначе хуже читается): заполняется кадр за кадром
    const barW = Math.round((n * SCALE * (f + 1)) / FRAMES)
    fill(px, width, MARGIN * SCALE, side * SCALE, barW, BAR * SCALE)
    gif.writeFrame(px, width, height, { palette: PALETTE, delay: DELAY_MS, repeat: 0 })
  }
  gif.finish()
  return gif.bytes()
}

function fill(px: Uint8Array, width: number, x0: number, y0: number, w: number, h: number) {
  for (let y = y0; y < y0 + h; y++) px.fill(1, y * width + x0, y * width + x0 + w)
}
