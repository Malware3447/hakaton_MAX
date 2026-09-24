import { z } from 'zod'

const EnvSchema = z
  .object({
    MAX_MODE: z.enum(['webhook', 'polling', 'off']).default('off'),
    MAX_BOT_TOKEN: z.string().optional(),
    MAX_WEBHOOK_SECRET: z.string().optional(),
    PUBLIC_URL: z.url().optional(),
    DATABASE_URL: z.string().optional(),
    PORT: z.coerce.number().int().positive().default(3000),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  })
  .superRefine((env, ctx) => {
    if (env.MAX_MODE !== 'off' && !env.MAX_BOT_TOKEN) {
      ctx.addIssue({ code: 'custom', path: ['MAX_BOT_TOKEN'], message: `нужен при MAX_MODE=${env.MAX_MODE}` })
    }
    if (env.MAX_MODE === 'webhook' && !env.MAX_WEBHOOK_SECRET) {
      ctx.addIssue({ code: 'custom', path: ['MAX_WEBHOOK_SECRET'], message: 'нужен при MAX_MODE=webhook' })
    }
  })

export type Env = z.infer<typeof EnvSchema>

// Пустые строки из .env считаем незаданными, чтобы .env.example работал как есть
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const cleaned = Object.fromEntries(Object.entries(source).filter(([, v]) => v !== ''))
  return EnvSchema.parse(cleaned)
}
