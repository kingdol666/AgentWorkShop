import assert from 'node:assert/strict'
import { test } from 'node:test'
import { formatIsoInTimeZone, formatPartsInTimeZone, installLocalIso, setConfiguredTimeZone } from '../shared/local-time.mjs'

const epoch = Date.parse('2026-01-01T00:30:00.123Z')

test('configured ISO switches between Shanghai and Los Angeles without changing epoch', () => {
  const date = new Date(epoch)
  setConfiguredTimeZone('Asia/Shanghai')
  installLocalIso()
  const shanghai = date.toISOString()
  assert.match(shanghai, /2026-01-01T08:30:00\.123\+08:00/)
  assert.equal(Date.parse(shanghai), epoch)
  assert.equal(JSON.parse(JSON.stringify(date)), shanghai)

  setConfiguredTimeZone('America/Los_Angeles')
  const losAngeles = date.toISOString()
  assert.match(losAngeles, /2025-12-31T16:30:00\.123-08:00/)
  assert.equal(Date.parse(losAngeles), epoch)
  assert.notEqual(losAngeles, shanghai)

  setConfiguredTimeZone('Asia/Shanghai')
  assert.equal(date.toISOString(), shanghai)
})

test('configured time zone exposes correct wall-clock parts and rejects invalid zones', () => {
  const date = new Date(epoch)
  assert.deepEqual(formatPartsInTimeZone(date, 'Asia/Shanghai'), {
    year: 2026, month: 1, day: 1, hour: 8, minute: 30, second: 0, millisecond: 123, offsetMinutes: 480,
  })
  assert.throws(() => setConfiguredTimeZone('Not/A-Timezone'), /Invalid IANA time zone/)
  assert.match(formatIsoInTimeZone(date, 'UTC'), /2026-01-01T00:30:00\.123\+00:00/)
})
