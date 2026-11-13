import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { consumeWsTicket, issueWsTicket, sessionCookieOptions } from '../server/services/auth/browser-session'

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..')

function source(rel: string): string {
  return readFileSync(join(ROOT, rel), 'utf8')
}

test('WS ticket is single-use and bound to its issued user', () => {
  const issued = issueWsTicket('user-a', 60_000)
  assert.equal(consumeWsTicket(issued.ticket, 'user-a')?.userId, 'user-a')
  assert.equal(consumeWsTicket(issued.ticket, 'user-a'), null)
})

test('WS ticket rejects a different user and expires', () => {
  const issued = issueWsTicket('user-a', -1)
  assert.equal(consumeWsTicket(issued.ticket, 'user-b'), null)
  assert.equal(consumeWsTicket(issued.ticket, 'user-a'), null)
})

test('browser session cookie is HttpOnly and same-site', () => {
  const options = sessionCookieOptions(true)
  assert.equal(options.httpOnly, true)
  assert.equal(options.sameSite, 'lax')
  assert.equal(options.secure, true)
})

test('browser UI does not persist the API bearer token', () => {
  const store = source('app/stores/workshop/user.ts')
  const auth = source('app/utils/auth-session.ts')
  assert.doesNotMatch(store, /localStorage\.setItem\(['"]aw\.token['"]/)
  assert.doesNotMatch(auth, /localStorage\.getItem\(['"]aw\.token['"]/)
})

test('browser WS URL does not carry a long-lived user token', () => {
  const connection = source('app/stores/workshop/connection.ts')
  assert.doesNotMatch(connection, /\?token=/)
})
