#!/usr/bin/env node
/**
 * HTTP-only session/runtime regression on an already-running disposable instance you own.
 * AW_E2E_TOKEN=<owner token in env> node scripts/_audit/session-live.mjs --base http://127.0.0.1:<port>
 * Optional restart check: use --prepare-restart, then (after an operator restarts the same instance
 * with the same home) use --after-restart <channel-id> <boot-ms> with the same owner's token.
 * Default runs the close lifecycle immediately. Phase 1 may bootstrap a fresh admin for the
 * default run; restart mode requires an existing owner token. No state/evidence files or services.
 */
import { randomBytes, randomUUID } from 'node:crypto'
import { setTimeout as sleep } from 'node:timers/promises'

const args = process.argv.slice(2)
const fixturePattern = /^sr-e2e-[a-f0-9]{12}$/
const isId = v => typeof v === 'string' && /^[\w-]+$/.test(v)
const label = ['session-one', 'session-two']
const apiRoot = '/api/workshop'
let passed = 0

function check(name, ok, detail = '') {
  if (!ok) throw new Error(`${name}${detail ? ` — ${detail}` : ''}`)
  passed++
  console.log(`PASS ${name}${detail ? ` — ${detail}` : ''}`)
}

function readArgs() {
  const [flag, raw, mode, channelId, before] = args
  if (flag !== '--base' || !raw || (mode !== undefined && mode !== '--prepare-restart' && mode !== '--after-restart')
    || (mode === '--after-restart' ? !isId(channelId) || !/^\d{13}$/.test(before ?? '') || args.length !== 5 : args.length > 3)) {
    throw new Error('Usage: session-live.mjs --base <owned loopback origin> [--prepare-restart | --after-restart <channel-id> <boot-ms>]')
  }
  let url
  try {
    url = new URL(raw)
  }
  catch {
    throw new Error('--base must be an HTTP(S) loopback origin')
  }
  if (!['http:', 'https:'].includes(url.protocol) || !['127.0.0.1', '[::1]'].includes(url.hostname)
    || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('--base must be an HTTP(S) loopback origin (127.0.0.1 or [::1]), without credentials/path/query/fragment')
  }
  return { base: url.origin, mode, channelId, before: Number(before) }
}

const statusOf = r => `HTTP ${r.status}${typeof r.code === 'string' && /^[A-Z][A-Z_0-9]{1,47}$/.test(r.code) ? ` ${r.code}` : ''}`
const sameIds = (actual, expected) => Array.isArray(actual) && actual.length === expected.length
  && new Set(actual).size === expected.length && expected.every(id => actual.includes(id))
const exactText = (parts, text) => Array.isArray(parts) && parts.length === 1 && parts[0]?.text === text

async function poll(name, observe) {
  const end = performance.now() + 25_000
  while (performance.now() < end) {
    const remaining = Math.max(1, Math.ceil(end - performance.now()))
    const result = await observe(Math.min(remaining, 5000))
    if (result && performance.now() < end) return result
    await sleep(Math.max(0, Math.min(300, end - performance.now())))
  }
  throw new Error(`${name}: expected state was not observed within 25s`)
}

async function main() {
  const { base, mode, channelId: checkpointChannel, before } = readArgs()
  let token = process.env.AW_E2E_TOKEN?.trim() ?? ''
  async function api(method, path, { body, auth = token, timeout = 5000 } = {}) {
    const url = new URL(path, base)
    if (url.origin !== base || !url.pathname.startsWith('/api/')) throw new Error('Invalid acceptance endpoint')
    const r = await fetch(url, {
      method, redirect: 'error', signal: AbortSignal.timeout(timeout),
      headers: {
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(auth ? { authorization: `Bearer ${auth}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    }).catch(() => { throw new Error(`${method} ${url.pathname}: request failed (network, timeout or redirect)`) })
    const j = await r.json().catch(() => null)
    return { ok: r.status === 200 && j?.code === 0, status: r.status, data: j?.data, code: j?.code }
  }
  async function get(path, timeout) {
    const r = await api('GET', path, { timeout })
    if (!r.ok) throw new Error(`GET ${path}: ${statusOf(r)}`)
    return r.data
  }
  const health = await get('/api/health')
  const bootMs = Date.parse(health?.timestamp) - health?.uptimeMs
  check('workshop ready with observable boot time', health?.status === 'ok' && health.workshop === 'ready' && Number.isSafeInteger(bootMs))
  if (mode === '--after-restart') check('server boot is newer than the phase-1 checkpoint', bootMs > before + 1000)
  if (!token) {
    check('restart phases require an owner AW_E2E_TOKEN supplied via the environment', mode === undefined)
    const setup = await get('/api/users/setup-status')
    check('first-admin setup available (otherwise provide AW_E2E_TOKEN)', setup?.needsSetup === true)
    const name = `sr-${randomUUID().slice(0, 12)}`
    const r = await api('POST', '/api/users/register', { body: {
      name, email: `${name}@example.test`, password: `Aw1-${randomBytes(24).toString('hex')}`,
    } })
    check('first admin registered', r.ok && r.data?.user?.role === 'admin' && typeof r.data?.token === 'string' && r.data.token.length > 0, statusOf(r))
    token = r.data.token
  }
  const owner = await get('/api/users/me')
  check('authenticated owner', isId(owner?.id))

  let channelId = checkpointChannel
  let leadId
  let workerId
  let sessions
  const channelPath = () => `${apiRoot}/channels/${channelId}`
  const sessionPath = session => `${channelPath()}/sessions/${session.id}`
  const sessionData = async (id, title) => {
    const row = await get(`${channelPath()}/sessions/${id}`)
    if (row?.id !== id || row.channelId !== channelId || row.title !== title || row.createdBy !== owner.id
      || row.channelMode !== 'generic' || !Number.isFinite(Date.parse(row.createdAt))) {
      throw new Error('session detail does not match the owned fixture')
    }
    const map = row.memberMap
    if (!map || !sameIds(Object.keys(map), [leadId, workerId]) || !isId(map[leadId]) || !isId(map[workerId])) {
      throw new Error('persisted session member map does not contain the exact base members')
    }
    return { id, title, lead: map[leadId], worker: map[workerId], status: row.status }
  }
  const roster = async () => {
    const rows = await get(`${channelPath()}/agents`)
    if (!Array.isArray(rows)) throw new Error('invalid channel agent list')
    return rows
  }

  if (mode === '--after-restart') {
    const rows = await get(`${apiRoot}/channels`)
    const ch = Array.isArray(rows) && rows.find(r => r.id === channelId)
    check('checkpoint channel is an owned generic regression fixture', ch?.ownerUserId === owner.id
    && ch.channelMode === 'generic' && fixturePattern.test(ch.name) && isId(ch.leadAgentId))
    leadId = ch.leadAgentId
    const agents = await roster()
    const workers = agents.filter(a => a.name === 'sr-worker' && a.role === 'worker')
    check('checkpoint base mock worker found', workers.length === 1 && isId(workers[0].id) && workers[0].harness === 'mock')
    workerId = workers[0].id
    const list = await get(`${channelPath()}/sessions`)
    check('exact two sessions persisted across restart', Array.isArray(list) && list.length === 2
    && label.every(title => list.filter(s => s.title === title && s.status === 'active' && isId(s.id)).length === 1))
    sessions = await Promise.all(label.map(title => sessionData(list.find(s => s.title === title).id, title)))
  }
  else {
    const tag = `sr-e2e-${randomUUID().replaceAll('-', '').slice(0, 12)}`
    const ch = await api('POST', `${apiRoot}/channels`, { body: {
      name: tag, channelMode: 'generic', leadAgent: { name: 'sr-lead', harness: 'mock' },
    } })
    channelId = ch.data?.channelId
    leadId = ch.data?.leadAgentId
    check('new generic channel and mock lead', ch.ok && isId(channelId) && isId(leadId), statusOf(ch))
    const worker = await api('POST', `${channelPath()}/agents`, { body: { name: 'sr-worker', harness: 'mock', role: 'worker' } })
    workerId = worker.data?.id
    check('new mock worker', worker.ok && isId(workerId) && workerId !== leadId, statusOf(worker))
    sessions = []
    for (const title of label) {
      const r = await api('POST', `${channelPath()}/sessions`, { body: { title } })
      check(`create ${title}`, r.ok && isId(r.data?.sessionId) && r.data.channelMode === 'generic'
      && Array.isArray(r.data.members) && sameIds(r.data.members.map(m => m.baseAgentId), [leadId, workerId]), statusOf(r))
      const session = await sessionData(r.data.sessionId, title)
      check(`${title} clone map matches its creation receipt`, r.data.members.every(m =>
        m.cloneId === (m.baseAgentId === leadId ? session.lead : session.worker)))
      sessions.push(session)
    }
  }
  const [a, b] = sessions
  const ids = [leadId, workerId, a.lead, a.worker, b.lead, b.worker]
  check('two active sessions have four distinct clones, not the base agents', a.id !== b.id && a.status === 'active' && b.status === 'active'
  && new Set(ids).size === 6)
  const activeAgents = await roster()
  check('exact clone and base identities are enabled mock agents', ids.every(id => activeAgents.some(row =>
    row.id === id && row.channelId === channelId && row.harness === 'mock' && row.enabled === 1)))
  console.log(`FIXTURE channel=${channelId} sessions=${a.id},${b.id}`)

  async function history(session) {
    const rows = await get(`${sessionPath(session)}/history?limit=200`)
    if (!Array.isArray(rows)) throw new Error('invalid session history')
    return rows
  }
  async function timeline(timeout) {
    const rows = await get(`${channelPath()}/messages?limit=200`, timeout)
    if (!Array.isArray(rows)) throw new Error('invalid channel timeline')
    return rows
  }
  const probeText = (session, phase) => `sr-${phase}-${session.id}`
  async function verifyExchange(session, other, id, text, from, to, human = false) {
    const read = await poll(`${session.title} ${id} consumption and reply`, async (timeout) => {
      const rows = await timeline(timeout)
      const row = rows.find(m => m.id === id)
      if (row && (row.channelId !== channelId || row.toAgentId !== to || row.fromAgentId !== from
        || row.metadata?.['x-aw-session-id'] !== session.id || !exactText(row.parts, text))) {
        throw new Error('persisted request identity, session, or text mismatched')
      }
      if (row?.state === 'dead') throw new Error('request was dead-lettered')
      const replies = rows.filter(m => m.metadata?.['x-aw-in-reply-to'] === id)
      if (replies.some(m => m.channelId !== channelId || m.fromAgentId !== to || m.toAgentId !== from
        || m.role !== 'ROLE_AGENT' || m.metadata?.['x-aw-session-id'] !== session.id)) {
        throw new Error('reply has wrong sender, recipient, or session')
      }
      if (row?.state !== 'consumed' || !Number.isFinite(Date.parse(row.consumedAt)) || replies.length === 0) return
      if (replies.length !== 1 || !isId(replies[0].id) || replies[0].id === id
        || typeof replies[0].parts?.[0]?.text !== 'string' || !replies[0].parts[0].text.trim()
        || (human && replies[0].metadata?.['x-aw-relayed'] !== 'true')) throw new Error('missing or ambiguous reply evidence')
      return replies[0]
    })
    const [own, sibling] = await Promise.all([history(session), history(other)])
    check(`${session.title} consumed its exact request and persisted a correlated reply in only its history`,
      own.some(m => m.type === 'message' && m.id === id && m.text === text && m.name === (from ?? to))
      && own.some(m => m.type === 'message' && m.id === read.id && m.name === to && m.text === read.parts[0].text)
      && !sibling.some(m => m.id === id || m.id === read.id || m.text === text), `message=${id}`)
  }

  if (mode !== '--after-restart') {
    const agentTokens = new Map()
    for (const s of sessions) {
      const r = await api('POST', `${channelPath()}/agents/${s.lead}/rotate-token`)
      check(`${s.title} fresh clone credential acquired in memory`, r.ok && r.data?.agentId === s.lead && r.data.channelId === channelId
      && typeof r.data.token === 'string' && r.data.token.length > 0, statusOf(r))
      agentTokens.set(s.lead, r.data.token)
    }
    const send = (from, to, text, metadata) => api('POST', `${apiRoot}/a2a/send`, {
      auth: agentTokens.get(from), body: { toAgentId: to, parts: [{ text }], metadata },
    })
    for (const [s, other] of [[a, b], [b, a]]) {
      const text = probeText(s, 'before')
      const r = await send(s.lead, s.worker, text, { 'x-aw-require-reply': 'true' })
      const id = r.data?.messageId
      check(`${s.title} A2A request addressed to the exact worker clone`, r.ok && isId(id) && r.data.contextId === channelId
      && exactText(r.data.parts, text) && r.data.metadata?.['x-aw-session-id'] === s.id
      && r.data.metadata['x-aw-from-agent'] === s.lead && r.data.metadata['x-aw-target-agent'] === s.worker, statusOf(r))
      await verifyExchange(s, other, id, text, s.lead, s.worker)
    }
    const deniedText = `sr-isolation-${randomUUID()}`
    const denied = await send(a.lead, b.worker, deniedText)
    check('cross-session A2A denied without a timeline row', denied.status === 403 && denied.code === 'SESSION_MEMBER_SCOPE_MISMATCH'
    && !(await timeline()).some(m => exactText(m.parts, deniedText)), statusOf(denied))
    agentTokens.clear()
    const runtime = await get(`${apiRoot}/runtime`)
    check('both exact worker clones have independent runtime entries', Array.isArray(runtime?.wiredAgents)
    && runtime.wiredAgents.includes(a.worker) && runtime.wiredAgents.includes(b.worker))
    if (mode === '--prepare-restart') {
      console.log(`CHECKPOINT --after-restart ${channelId} ${bootMs}`)
      return
    }
  }
  else {
    // Before the first post-restart delivery, neither worker should have been wired eagerly.
    const runtime = await get(`${apiRoot}/runtime`)
    check('persisted workers were not eagerly wired after restart', Array.isArray(runtime?.wiredAgents)
    && !runtime.wiredAgents.includes(a.worker) && !runtime.wiredAgents.includes(b.worker))
    for (const [s, other] of [[a, b], [b, a]]) {
      const text = probeText(s, 'before')
      const requests = (await history(s)).filter(m => m.type === 'message' && m.text === text && m.name === s.lead)
      check(`${s.title} exact pre-restart request survived`, requests.length === 1 && isId(requests[0].id))
      await verifyExchange(s, other, requests[0].id, text, s.lead, s.worker)
    }
  }

  const close = await api('POST', `${sessionPath(b)}/close`, { body: { reason: 'owned runtime regression' } })
  check('closing B targets only its two clones', close.ok && sameIds(close.data?.clones, [b.lead, b.worker]), statusOf(close))
  check('B closed and A remains active', (await sessionData(b.id, b.title)).status === 'closed'
  && (await sessionData(a.id, a.title)).status === 'active')
  const agentsAfter = await roster()
  check('B clones disabled; both base agents and A clones preserved', [b.lead, b.worker].every(id => agentsAfter.some(r => r.id === id && r.enabled === 0))
  && [leadId, workerId, a.lead, a.worker].every(id => agentsAfter.some(r => r.id === id && r.enabled === 1)))
  const reject = await api('POST', `${sessionPath(b)}/messages`, { body: { text: `sr-closed-${randomUUID()}` } })
  check('send to closed session rejected', reject.status === 409 && reject.code === 'SESSION_CLOSED', statusOf(reject))
  const text = `sr-after-${randomUUID()}`
  const r = await api('POST', `${sessionPath(a)}/messages`, { body: { text } })
  check('fresh request routed to the original A lead clone', r.ok && isId(r.data?.messageId) && r.data.toAgentId === a.lead, statusOf(r))
  await verifyExchange(a, b, r.data.messageId, text, null, a.lead, true)
  const runtime = await get(`${apiRoot}/runtime`)
  check('A lead clone wired and B clones unloaded', Array.isArray(runtime?.wiredAgents) && runtime.wiredAgents.includes(a.lead)
  && !runtime.wiredAgents.includes(b.lead) && !runtime.wiredAgents.includes(b.worker))
}

main().then(() => {
  console.log(`RESULT ${passed} PASS / 0 FAIL`)
}).catch((err) => {
  console.error('FAIL', err instanceof Error ? err.message : 'acceptance aborted')
  console.log(`RESULT ${passed} PASS / 1 FAIL`)
  process.exitCode = 1
})
