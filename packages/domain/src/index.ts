// Домен перевозки: контракты, машина состояний, правила «чей ход».
// Без базы и сети. Контракты — HAKATON-21, решение переходов и тесты — HAKATON-22.

export * from './enums.ts'
export * from './commands.ts'
export * from './view.ts'
export * from './ports.ts'
export * from './machine.ts'
export * from './inn.ts'
export * from './plate.ts'

export const DOMAIN_VERSION = '0.1.0'
