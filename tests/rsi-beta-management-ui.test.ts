import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(fileURLToPath(new URL('..', import.meta.url)))
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8')

test('RSI Beta client is a read-only management panel with provenance and limitations', () => {
  const client = read('.AgentWorkShop/plugins/rsi-interface-beta/client.mjs')
  assert.match(client, /slot: ['"]plugins\.page['"]/, 'panel must use the existing plugin page slot')
  assert.match(client, /\/api\/plugins\/rsi-interface-beta\/metadata/, 'panel must consume the metadata route')
  assert.match(client, /provenance/, 'panel must render provenance metadata')
  assert.match(client, /limitations/, 'panel must render limitations')
  assert.match(client, /refreshBtn\.addEventListener\(['"]click['"]/, 'the only management action must refresh metadata')
  assert.doesNotMatch(client, /\.post\(|method:\s*['"]POST['"]/, 'panel must not add write requests')
})

test('RSI Beta metadata contract is documented and keeps the legacy UI additive', () => {
  const plugin = read('.AgentWorkShop/plugins/rsi-interface-beta/index.mjs')
  const docs = read('docs/rsi-beta-management.md')
  assert.match(plugin, /metadataPath\s*=\s*['"]\/metadata['"]/, 'metadata route must be explicit')
  assert.match(plugin, /const visible = flags\.globallyEnabled && persistence\.ok && \(!persistedScope \|\| scoped\)/,
    'metadata visibility must follow server scope evaluation, with an explicit unbound state when no kv scope exists')
  assert.match(plugin, /SCOPE_UNBOUND/, 'metadata must expose the explicit unbound state instead of a permanent default-deny')
  assert.match(plugin, /readOnly: true/, 'metadata must declare read-only')
  assert.match(plugin, /actuation: false/, 'metadata must deny actuation')
  assert.match(plugin, /promotion: false/, 'metadata must deny promotion')
  assert.match(docs, /Default deny and visibility/)
  assert.match(docs, /no execute, approve, promote, control-write, or profile-activation controls/i)
})
