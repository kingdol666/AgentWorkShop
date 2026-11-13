import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(fileURLToPath(new URL('..', import.meta.url)))
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8')

test('password reset and change revoke browser sessions', () => {
  const service = read('server/services/user.service.ts')
  assert.match(service, /revokeAllBrowserSessions\(id\)/, 'admin reset must revoke browser sessions')
  assert.match(service, /revokeAllBrowserSessions\(userId\)/, 'self password change must revoke browser sessions')
})

test('terminal websocket validates browser Origin before accepting cookie auth', () => {
  const terminal = read('server/api/system/monitor/terminal/ws.ts')
  assert.match(terminal, /origin/i)
  assert.match(terminal, /forbidden|origin/i)
})

test('MQTT subscription setup failure marks transport quality bad', () => {
  const push = read('server/services/workshop/daq/daq-controller/push.ts')
  assert.match(push, /live\.quality\s*=\s*['"]bad['"]/, 'failed setup must not leave quality good')
})

test('ticket provider failure schedules reconnect rather than remaining closed', () => {
  const connection = read('app/stores/workshop/connection.ts')
  assert.match(connection, /ticket.*null|!ticket/)
  assert.match(connection, /setTimeout[\s\S]*connect\(\)/, 'ticket failures need the same backoff path as socket failures')
})
