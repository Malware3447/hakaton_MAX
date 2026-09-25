// gifenc без своих типов: только то, чем пользуемся для QR-кода (core/qr-gif.ts).
declare module 'gifenc' {
  interface GifEncoder {
    writeFrame(index: Uint8Array, width: number, height: number, opts: { palette?: number[][]; delay?: number; repeat?: number }): void
    finish(): void
    bytes(): Uint8Array
  }
  type Factory = () => GifEncoder
  // CommonJS-сборка из Node — объект модуля, ESM-сборка (vite, esbuild) — сама функция
  const gifenc: Factory | { GIFEncoder: Factory }
  export default gifenc
}
