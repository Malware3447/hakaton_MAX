import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Fastify from 'fastify'
import { describe, expect, it } from 'vitest'
import type { Role } from '@nk/domain'
import type { RoleInfo } from '../bot/store.ts'
import { signInitData, verifyInitData } from './init-data.ts'
import { registerMiniAppApi, registerMiniAppStatic, type MiniAppPeople } from './routes.ts'
import { SessionSigner } from './session.ts'

const TOKEN = 'test-bot-token'
const now = new Date('2026-09-26T12:00:00Z')
const authDate = String(Math.floor(now.getTime() / 1000) - 60)
const user = JSON.stringify({ id: 67890, first_name: 'Марина', last_name: 'Соколова', username: null, language_code: 'ru' })

describe('initData мини-приложения', () => {
  it('пример из документации MAX: подпись по отсортированным декодированным парам', () => {
    const raw = signInitData({ auth_date: authDate, chat: '{"id":12345,"type":"DIALOG"}', query_id: 'q1', user, start_param: 's_abc' }, TOKEN)
    const init = verifyInitData(raw, TOKEN, now)
    expect(init).toMatchObject({ user: { id: 67890, firstName: 'Марина', lastName: 'Соколова' }, startParam: 's_abc' })
  })

  it('чужой токен, правка поля, повтор ключа и старый auth_date не проходят', () => {
    const raw = signInitData({ auth_date: authDate, user }, TOKEN)
    expect(verifyInitData(raw, 'other-token', now)).toBeNull()
    expect(verifyInitData(raw.replace('67890', '67891'), TOKEN, now)).toBeNull()
    expect(verifyInitData(`${raw}&user=${encodeURIComponent(user)}`, TOKEN, now)).toBeNull()
    expect(verifyInitData(raw, TOKEN, new Date(now.getTime() + 2 * 3600_000))).toBeNull()
    expect(verifyInitData('', TOKEN, now)).toBeNull()
  })
})

describe('сессия', () => {
  it('живёт 8 часов и не подделывается', () => {
    const s = new SessionSigner(TOKEN)
    const { token } = s.issue('p1', 1, now)
    expect(s.verify(token, now)).toMatchObject({ personId: 'p1', maxUserId: 1 })
    expect(s.verify(token, new Date(now.getTime() + 8 * 3600_000 + 1000))).toBeNull()
    expect(new SessionSigner('other').verify(token, now)).toBeNull()
    const [body, sig] = token.split('.')
    const forged = Buffer.from(JSON.stringify({ personId: 'p2', maxUserId: 1, exp: 9e9 })).toString('base64url')
    expect(s.verify(`${forged}.${sig}`, now)).toBeNull()
    expect(body).toBeTruthy()
  })
})

function fakePeople(): MiniAppPeople & { active: Role | null } {
  const org = { name: 'Волжский завод масел' } as RoleInfo['org']
  const roles: RoleInfo[] = (['shipper', 'consignee'] as const).map((role) => ({
    role, org, orgs: [], isAdmin: true, canSign: true, poaNumber: null, poaValidTo: null,
  }))
  const people = {
    active: 'shipper' as Role | null,
    async personByMaxUserId(id: number) {
      return id === 67890 ? { id: 'p1', name: 'Марина Соколова', activeRole: people.active } : null
    },
    async roles() {
      return roles
    },
    async setActiveRole(_: string, role: Role | null) {
      people.active = role
    },
  }
  return people
}

async function api() {
  const app = Fastify()
  const people = fakePeople()
  // Чтение экранов — на настоящей базе в miniapp-db.test.ts; здесь только вход и роль
  const read = {
    async me(personId: string) {
      if (personId !== 'p1') return null
      return {
        name: 'Марина Соколова',
        activeRole: people.active,
        roles: [
          { role: 'shipper' as const, title: 'Отправитель', orgName: 'Волжский завод масел', waiting: 1 },
          { role: 'consignee' as const, title: 'Получатель', orgName: 'Волжский завод масел', waiting: 0 },
        ],
      }
    },
    async scope(personId: string, role: Role) {
      return personId === 'p1' && (role === 'shipper' || role === 'consignee') ? { personId, role, orgIds: ['o1'] } : null
    },
  }
  registerMiniAppApi(app, { botToken: TOKEN, people, read })
  return { app, people }
}

const freshInit = (u = user) => signInitData({ auth_date: String(Math.floor(Date.now() / 1000)), user: u, start_param: 's_1' }, TOKEN)

describe('API мини-приложения', () => {
  it('initData → сессия → /api/me с ролями и счётчиками «ждут вас»', async () => {
    const { app } = await api()
    const bad = await app.inject({ method: 'POST', url: '/api/session', payload: { initData: freshInit().replace('hash=', 'hash=0') } })
    expect(bad.statusCode).toBe(401)

    const res = await app.inject({ method: 'POST', url: '/api/session', payload: { initData: freshInit() } })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body).toMatchObject({ registered: true, startParam: 's_1', me: { activeRole: 'shipper' } })

    expect((await app.inject({ method: 'GET', url: '/api/me' })).statusCode).toBe(401)
    const me = await app.inject({ method: 'GET', url: '/api/me', headers: { authorization: `Bearer ${body.token}` } })
    expect(me.json().roles).toEqual([
      { role: 'shipper', title: 'Отправитель', orgName: 'Волжский завод масел', waiting: 1 },
      { role: 'consignee', title: 'Получатель', orgName: 'Волжский завод масел', waiting: 0 },
    ])
  })

  it('незнакомый боту человек получает «сначала в чат», без сессии', async () => {
    const { app } = await api()
    const stranger = JSON.stringify({ id: 1, first_name: 'Кто-то' })
    const res = await app.inject({ method: 'POST', url: '/api/session', payload: { initData: freshInit(stranger) } })
    expect(res.json()).toEqual({ registered: false, startParam: 's_1' })
  })

  it('роль меняется только на свою, и это та же запись, что у бота', async () => {
    const { app, people } = await api()
    const { token } = (await app.inject({ method: 'POST', url: '/api/session', payload: { initData: freshInit() } })).json()
    const auth = { authorization: `Bearer ${token}` }
    const foreign = await app.inject({ method: 'PUT', url: '/api/me/role', headers: auth, payload: { role: 'carrier' } })
    expect(foreign.statusCode).toBe(403)
    const ok = await app.inject({ method: 'PUT', url: '/api/me/role', headers: auth, payload: { role: 'consignee' } })
    expect(ok.json().activeRole).toBe('consignee')
    expect(people.active).toBe('consignee')
  })
})

describe('раздача сборки', () => {
  it('файлы, SPA-маршруты на index.html и никаких выходов за папку', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'miniapp-'))
    await mkdir(join(dir, 'assets'))
    await writeFile(join(dir, 'index.html'), '<!doctype html><title>app</title>')
    await writeFile(join(dir, 'assets', 'a-1.js'), 'console.log(1)')
    const app = Fastify()
    registerMiniAppStatic(app, dir)

    const js = await app.inject({ method: 'GET', url: '/app/assets/a-1.js' })
    expect(js.headers['content-type']).toContain('text/javascript')
    expect(js.headers['cache-control']).toContain('immutable')
    const route = await app.inject({ method: 'GET', url: '/app/shipments/123' })
    expect(route.body).toContain('<title>app</title>')
    expect(route.headers['cache-control']).toBe('no-cache')
    expect((await app.inject({ method: 'GET', url: '/app/missing.js' })).statusCode).toBe(404)
    expect((await app.inject({ method: 'GET', url: '/app/..%2f..%2fetc%2fpasswd' })).body).not.toContain('root:')
    expect((await app.inject({ method: 'GET', url: '/app' })).statusCode).toBe(302)
  })
})
