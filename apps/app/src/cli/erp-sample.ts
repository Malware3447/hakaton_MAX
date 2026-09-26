// Тестовые таблицы отгрузок демо-завода: npm run seed:xlsx -w @nk/app
// Пишет seed/otgruzki-zavod.xlsx (17 отгрузок, загружаются без ошибок) и seed/otgruzki-s-oshibkami.xlsx.
import { writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { buildWorkbook } from '../core/erp-import.ts'
import { readSeed } from '../db/boot.ts'
import { sampleRows, sampleRowsWithErrors } from '../db/erp-sample.ts'
import { SEED_PATH } from '../paths.ts'

const seed = await readSeed()
const dir = dirname(SEED_PATH)
const ok = sampleRows(seed)
await writeFile(join(dir, 'otgruzki-zavod.xlsx'), await buildWorkbook(ok))
await writeFile(join(dir, 'otgruzki-s-oshibkami.xlsx'), await buildWorkbook(sampleRowsWithErrors(seed)))
console.log(`записал ${join(dir, 'otgruzki-zavod.xlsx')}: ${new Set(ok.map((r) => r.ref)).size} отгрузок, ${ok.length} строк; и otgruzki-s-oshibkami.xlsx`)
