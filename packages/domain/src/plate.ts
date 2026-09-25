// Госномер машины: как в Т1 — заглавные кириллические буквы без пробелов (А245КМ116).
// Латиницу, похожую на кириллицу, заменяем: люди часто набирают номер латиницей.

const LATIN_TO_CYR: Record<string, string> = { A: 'А', B: 'В', E: 'Е', K: 'К', M: 'М', H: 'Н', O: 'О', P: 'Р', C: 'С', T: 'Т', Y: 'У', X: 'Х' }

/** Грузовик и легковой: буква, три цифры, две буквы, код региона из 2–3 цифр. */
const PLATE = /^[АВЕКМНОРСТУХ]\d{3}[АВЕКМНОРСТУХ]{2}\d{2,3}$/

export function normalizePlate(input: string): string | null {
  const s = input
    .toUpperCase()
    .replace(/[\s-]/g, '')
    .replace(/[ABEKMHOPCTYX]/g, (c) => LATIN_TO_CYR[c]!)
  return PLATE.test(s) ? s : null
}
