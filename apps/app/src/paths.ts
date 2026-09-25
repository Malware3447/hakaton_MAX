import { fileURLToPath } from 'node:url'

// Пути к файлам рядом с кодом. В образе их задают переменные окружения из Dockerfile.
const here = (rel: string) => fileURLToPath(new URL(rel, import.meta.url))

export const MIGRATIONS_DIR = process.env.MIGRATIONS_DIR ?? here('../drizzle')
export const SEED_PATH = process.env.SEED_PATH ?? here('../../../seed/plant-seed.json')
// Корни УЦ «Госключа» (HAKATON-41) и кэш скачанных промежуточных сертификатов и списков отзыва
export const GOSKEY_CERTS_DIR = process.env.GOSKEY_CERTS_DIR ?? here('../../../certs/goskey')
export const GOSKEY_CACHE_DIR = process.env.GOSKEY_CACHE_DIR ?? here('../../../.cache/goskey')
