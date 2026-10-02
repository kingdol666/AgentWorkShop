/**
 * E2E · 系统时区真实切换验证。
 * 用法: pnpm exec tsx scripts/e2e-timezone-settings.mjs [baseUrl]
 * 默认连接 3005；脚本最后恢复 Asia/Shanghai。
 */
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'

const BASE = process.argv[2] ?? 'http://127.0.0.1:3005'
const ROOT = process.cwd()
process.env.NO_PROXY = '127.0.0.1,localhost'

async function api(method, path, body, token) {
  const r = await fetch(BASE + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  })
  return { status: r.status, json: await r.json().catch(() => null) }
}

const reg = await api('POST', '/api/workshop/users/register', { name: `tz-e2e-${Date.now()}` })
const token = reg.json?.data?.token
assert.ok(token, 'register token missing')
const users = new DatabaseSync(join(ROOT, '.AgentWorkShop', 'data', 'users.sqlite'))
users.prepare('UPDATE users SET role=\'admin\' WHERE email LIKE \'tz-e2e-%\' AND role=\'user\'').run()
users.close()

const db = new DatabaseSync(join(ROOT, '.AgentWorkShop', 'data', 'workshop.sqlite'))
const before = db.prepare('SELECT id, created_at AS createdAt FROM chat_messages ORDER BY rowid DESC LIMIT 1').get()
const written = []
try {
  for (const zone of ['Asia/Shanghai', 'America/Los_Angeles']) {
    const patch = await api('PATCH', '/api/system/settings', { override: { 'time.timeZone': zone } }, token)
    assert.equal(patch.status, 200, `timezone patch failed for ${zone}`)
    const current = await api('GET', '/api/system/timezone', undefined, token)
    assert.equal(current.json?.data?.timeZone, zone, `timezone readback mismatch for ${zone}`)

    const ops = await api('POST', '/api/workshop/ops-logs', { summary: `timezone e2e ${zone}` }, token)
    assert.equal(ops.status, 200, `ops write failed for ${zone}`)
    const row = db.prepare('SELECT at FROM audit_log WHERE summary = ? ORDER BY rowid DESC LIMIT 1').get(`timezone e2e ${zone}`)
    assert.ok(row?.at, `audit row missing for ${zone}`)
    assert.match(String(row.at), zone === 'Asia/Shanghai' ? /\+08:00$/ : /-0[78]:00$/)
    written.push({ zone, at: String(row.at) })
  }

  assert.ok(before === undefined || Date.parse(String(before.createdAt)) > 0, 'existing chat timestamp must remain parseable')
  assert.ok(written.every(item => Number.isFinite(Date.parse(item.at))), 'all timezone audit timestamps must remain parseable')
  assert.notEqual(written[0].at.slice(-6), written[1].at.slice(-6), 'timezone switches must change the recorded offset')
  console.log(JSON.stringify({ ok: true, written, timezoneApi: (await api('GET', '/api/system/timezone', undefined, token)).json?.data }, null, 2))
}
finally {
  await api('PATCH', '/api/system/settings', { override: { 'time.timeZone': 'Asia/Shanghai' } }, token)
  db.close()
}
