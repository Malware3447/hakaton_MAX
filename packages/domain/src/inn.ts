// Проверка ИНН по контрольным цифрам: 10 знаков у юрлица, 12 у ИП.

const W10 = [2, 4, 10, 3, 5, 9, 4, 6, 8]
const W11 = [7, 2, 4, 10, 3, 5, 9, 4, 6, 8]
const W12 = [3, 7, 2, 4, 10, 3, 5, 9, 4, 6, 8]

const check = (digits: number[], weights: number[]) => (weights.reduce((s, w, i) => s + w * digits[i]!, 0) % 11) % 10

/** Убрать пробелы и дефисы; вернуть 10 или 12 цифр или null. */
export function normalizeInn(input: string): string | null {
  const s = input.replace(/[\s-]/g, '')
  return /^(\d{10}|\d{12})$/.test(s) ? s : null
}

export function isValidInn(inn: string): boolean {
  const s = normalizeInn(inn)
  if (!s) return false
  const d = [...s].map(Number)
  if (d.length === 10) return check(d, W10) === d[9]
  return check(d, W11) === d[10] && check(d, W12) === d[11]
}
