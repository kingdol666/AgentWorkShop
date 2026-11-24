#!/usr/bin/env node
/**
 * Prefab runtime acceptance. Node 24+, existing trusted build/dependencies only.
 * Run --help for the Web/Windows Desktop and optional isolated local-model modes.
 * No attach-to-instance mode, builds, installs, cloud keys, or external MCP probes.
 */
import { spawn, spawnSync } from 'node:child_process'
import { createHash, createHmac, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { setTimeout as wait } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const host = '127.0.0.1'
const hash = value => createHash('sha256').update(value).digest('hex')
const hex = size => randomBytes(size).toString('hex')
const id = value => typeof value === 'string' && /^[a-z\d_:@./-]{1,180}$/i.test(value)
const readJson = file => JSON.parse(readFileSync(file, 'utf8'))
const unpack = text => JSON.parse(text || '{}')
const requireThat = (condition, code) => { if (!condition) throw new Error(code) }
const abort = new AbortController()
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => abort.abort(new Error('interrupted')))

const { values: flags } = parseArgs({ options: {
  'help': { type: 'boolean' }, 'evidence': { type: 'string' }, 'target': { type: 'string', default: 'web' },
  'l10-only': { type: 'boolean' }, 'chrome': { type: 'string' }, 'electron': { type: 'string' },
  // Legacy args are intentionally rejected below: this harness never attaches to a caller-owned instance.
  'base': { type: 'string' }, 'home': { type: 'string' }, 'user-home': { type: 'string' },
  'local-model': { type: 'string' }, 'local-port': { type: 'string' }, 'local-pid': { type: 'string' }, 'omp': { type: 'string' },
  'local-isolated-proof': { type: 'string' }, 'local-fixture': { type: 'boolean' }, 'local-prompt-dir': { type: 'string' },
} })
if (flags.help) {
  console.log(`Usage: node scripts/experiments/prefab-acceptance.mjs --evidence <new-dir>
  [--target web|desktop|both] [--l10-only] [--chrome <existing-exe>] [--electron <existing-exe>]
  [--local-model <id> --local-port <port> --local-pid <pid> --omp <existing-absolute-exe>
   --local-isolated-proof <json-file> [--local-prompt-dir <owned-log-dir>]] [--local-fixture]
--l10-only: original L10 contract (external discovery intentionally replaced by missing-manifest rejection).
The legacy --base/--home/--user-home arguments are refused because attaching to a caller-owned
instance breaks isolation. Without local flags real inference is NOT_RUN. Supply all four local flags
plus an isolated proof file only for an existing, idle, dedicated loopback OpenAI-compatible model
server you own; the proof must state scope=isolated, loopback=true, pid, port, model and provider=local.
\`--local-fixture\` is reserved for a safe protocol-only OMP path; this round reports inference BLOCKED
until its deterministic SSE endpoint is supplied, and never claims model quality.
Only use trusted binaries and .output. The harness never builds, downloads, or attaches to an AW instance.
--local-prompt-dir is where that owned model server logs the prompts it received; with it the harness
checks that the bound Prefab's role text reached the model for the bound member only.`)
  process.exit(0)
}
const localFlags = ['local-model', 'local-port', 'local-pid', 'omp']
const wantsLocal = localFlags.some(key => flags[key] !== undefined)
const fixtureLocal = flags['local-fixture'] === true
const isolatedProofPath = flags['local-isolated-proof']
// Prompt log of the owned model server: lets the run verify what the model was really sent.
const promptDir = flags['local-prompt-dir'] === undefined ? null : resolve(flags['local-prompt-dir'])
const desktopRequested = flags.target !== 'web'
const localModel = flags['local-model']
const localPort = Number(flags['local-port'])
const localPid = Number(flags['local-pid'])
requireThat(['web', 'desktop', 'both'].includes(flags.target) && flags.evidence, 'use --help for usage')
requireThat(flags.base === undefined && flags.home === undefined && flags['user-home'] === undefined,
  'legacy --base/--home/--user-home are refused; this harness owns a disposable instance')
requireThat(!desktopRequested || process.platform === 'win32', 'desktop harness requires Windows')
requireThat(!wantsLocal || (process.platform === 'win32' && !flags['l10-only'] && localFlags.every(key => flags[key])
  && isAbsolute(isolatedProofPath ?? '') && existsSync(isolatedProofPath)),
'local model mode requires Windows, full coverage, all four local flags, and an isolated proof file')
requireThat(!fixtureLocal || (!wantsLocal && !isolatedProofPath && !flags['l10-only']),
  'local fixture mode is full-coverage only and cannot be combined with real model flags')
if (wantsLocal) {
  requireThat(/^[a-zA-Z0-9][a-zA-Z0-9_./:-]{0,127}$/.test(localModel)
    && Number.isInteger(localPort) && localPort > 1024 && localPort <= 65535
    && Number.isSafeInteger(localPid) && localPid > 0 && isAbsolute(flags.omp) && existsSync(flags.omp), 'invalid local-model parameters')
}
requireThat(promptDir === null || (wantsLocal && isAbsolute(flags['local-prompt-dir'])),
  '--local-prompt-dir requires local model mode and an absolute path')
const evidence = resolve(flags.evidence)
requireThat(!existsSync(evidence), 'evidence directory must be new; refusing to overwrite another run')
mkdirSync(evidence, { recursive: true })
const targets = flags.target === 'both' ? ['web', 'desktop'] : [flags.target]
const build = join(repo, '.output', 'server', 'index.mjs')
const report = {
  startedAt: new Date().toISOString(), platform: process.platform, node: process.version, target: flags.target,
  externalMcpDiscovery: 'NOT_RUN', localModelRequested: wantsLocal || fixtureLocal,
  localFixture: fixtureLocal ? 'PREPARED_NOT_RUN' : 'NOT_REQUESTED', runs: [],
}

function loopbackOrigin(raw) {
  const url = new URL(raw)
  requireThat(raw === url.origin && url.protocol === 'http:' && url.hostname === host && Number(url.port) > 1024, 'not an isolated loopback origin')
  return url.origin
}

async function boundSocket() {
  const listener = createServer(socket => socket.destroy())
  await new Promise((ok, fail) => listener.once('error', fail).listen(0, host, ok))
  return { port: listener.address().port, close: () => new Promise(ok => listener.close(ok)) }
}

async function poll(label, ms, get) {
  const until = Date.now() + ms
  do {
    abort.signal.throwIfAborted()
    const value = await get()
    if (value) return value
    await wait(250, undefined, { signal: abort.signal })
  } while (Date.now() < until)
  throw new Error(label)
}

function makeApi(base) {
  return async (method, path, body, token, extraHeaders) => {
    requireThat(path.startsWith('/api/') && !path.includes('\\'), 'unsafe API route')
    const res = await fetch(`${base}${path}`, {
      method, redirect: 'error', signal: AbortSignal.any([abort.signal, AbortSignal.timeout(12_000)]),
      headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}), ...extraHeaders },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const text = await res.text()
    let json = null
    try { json = JSON.parse(text) } catch { /* non-JSON error */ }
    return { status: res.status, data: json?.data, code: json?.code, message: json?.message }
  }
}

function row(dbPath, sql, key) {
  const db = new DatabaseSync(dbPath, { readOnly: true })
  try { return db.prepare(sql).get(key) } finally { db.close() }
}

function getBinding(dbPath, agentId) {
  if (!id(agentId)) return {}
  const member = row(dbPath, 'SELECT prefab_binding_json FROM channel_agents WHERE id = ?', agentId)
  return unpack(member?.prefab_binding_json)
}

function ownedEnv(root, home, userHome, [mqtt, timescale, objects]) {
  // Deliberately exclude all application overrides, proxies, provider keys and inherited shell options.
  const os = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC)$/i.test(key)))
  return {
    ...os, HOME: userHome, USERPROFILE: userHome, APPDATA: join(userHome, 'Roaming'), LOCALAPPDATA: join(userHome, 'Local'),
    XDG_CONFIG_HOME: join(userHome, '.config'), XDG_DATA_HOME: join(userHome, '.local', 'share'), XDG_CACHE_HOME: join(userHome, '.cache'),
    TMP: root, TEMP: root, TMPDIR: root, NO_PROXY: `${host},localhost`, DO_NOT_TRACK: '1',
    NODE_ENV: 'production', AW_MODE: 'home', AW_HOME: home, AW_DESKTOP_HOME: home, AW_DESKTOP_NODE_BIN: process.execPath,
    AW_UPDATE_CHECK: '0', BACKUP_DISABLED: '1', RETENTION_DISABLED: '1', AML_TWIN_WORKER_DISABLED: '1',
    NUXT_TELEMETRY_DISABLED: '1', NUXT_SESSION_PASSWORD: hex(32),
    NUXT_DAQ_START_INFRASTRUCTURE: 'never', NUXT_DAQ_MQTT_HOST: host, NUXT_DAQ_MQTT_PORT: String(mqtt.port),
    NUXT_DAQ_TIMESCALE_HOST: host, NUXT_DAQ_TIMESCALE_PORT: String(timescale.port),
    NUXT_DAQ_OBJECTSTORE_HOST: host, NUXT_DAQ_OBJECTSTORE_PORT: String(objects.port),
  }
}

async function bootWeb({ env, home, own }) {
  const socket = await boundSocket()
  const port = String(socket.port)
  await socket.close()
  const secret = hex(32)
  const child = spawn(process.execPath, [build], {
    cwd: repo, env: { ...env, HOST: host, NITRO_HOST: host, PORT: port, NITRO_PORT: port, AW_DESKTOP_INSTANCE: secret },
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  })
  let output = ''
  const capture = chunk => { output = (output + chunk.toString()).slice(-12_000) }
  child.stdout.on('data', capture)
  child.stderr.on('data', capture)
  let spawnFailed = false
  child.on('error', error => { spawnFailed = true; output = `${output}\n${error.name}: ${error.message}`.slice(-12_000) })
  const closed = new Promise(ok => child.once('close', () => ok(true)))
  own(async () => {
    if (child.pid && child.exitCode === null && !child.signalCode) child.kill()
    requireThat(await Promise.race([closed, wait(15_000, false, { ref: false })]), 'owned Web process failed to exit')
  })
  const base = loopbackOrigin(`http://${host}:${port}`)
  try {
    await poll('Web startup/proof timeout', 90_000, async () => {
      requireThat(!spawnFailed && child.exitCode === null, 'owned Web process exited before readiness')
      const challenge = hex(16)
      const health = await makeApi(base)('GET', '/api/health', undefined, undefined, { 'x-aw-desktop-challenge': challenge }).catch(() => null)
      return health?.data?.status === 'ok' && health.data.workshop === 'ready'
        && health.data.desktopProof === createHmac('sha256', secret).update(challenge).digest('hex')
    })
    return base
  } catch (error) {
    const safeOutput = output.replaceAll(secret, '[redacted]').slice(-12_000)
    writeFileSync(join(evidence, 'web-startup.log'), safeOutput || '[no process output]')
    error.message = `${error.message}; owned child output saved to web-startup.log`
    throw error
  }
}

const chromiumSafety = ['--disable-background-networking', '--disable-component-update', '--disable-sync', '--no-proxy-server',
  '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1']
// Windows reports a window covered by another one as hidden and stops its frames, so a
// tab transition never finishes. The real Electron window must keep rendering whichever
// window happens to be in front of it; this changes scheduling only, not application code.
const desktopVisibility = ['--disable-features=CalculateNativeWinOcclusion', '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding']

async function bootDesktop({ browser, home }) {
  const child = browser.process()
  requireThat(child?.pid, 'Electron was not spawned by Puppeteer')
  // Kept as evidence: the real window must keep rendering when another window covers it.
  const switches = (child.spawnargs ?? []).filter(arg => /^--(?:disable|no-|host-resolver|remote-debugging)/.test(arg))
  const statusPath = join(home, 'electron', 'desktop-status.json')
  const status = await poll('Desktop startup/status timeout', 100_000, () => {
    requireThat(child.exitCode === null, 'owned Desktop process exited before readiness')
    let value
    try { value = readJson(statusPath) } catch { return null }
    requireThat(value.pid === child.pid, 'Desktop status PID did not match owned process')
    return value.phase === 'ready' && value.service === 'online' && value.windowVisible ? value : null
  })
  const base = loopbackOrigin(status.origin)
  requireThat(new URL(base).port === String(status.port), 'Desktop status port mismatch')
  const page = await poll('Desktop app WebContentsView not found', 25_000, async () => {
    const target = browser.targets().find(item => item.url().startsWith(`${base}/`))
    return target?.asPage()
  })
  return { base, page, switches }
}

async function launchBrowser(target, { env, home, userHome, own }) {
  const { default: puppeteer } = await import('puppeteer-core')
  const desktop = target === 'desktop'
  const executablePath = desktop
    ? (flags.electron ?? join(repo, 'desktop', 'node_modules', 'electron', 'dist', 'electron.exe'))
    : flags.chrome ?? ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(existsSync)
  requireThat(executablePath && isAbsolute(executablePath) && existsSync(executablePath), `trusted ${desktop ? 'Electron' : 'Chrome'} executable required`)
  // Chrome for Windows fails to start when HOME/USERPROFILE are redirected; the
  // profile stays disposable under the run root and data isolation is AW_HOME.
  const browserEnv = { ...env }
  delete browserEnv.HOME
  delete browserEnv.USERPROFILE
  const options = {
    executablePath, headless: !desktop, timeout: 30_000, protocolTimeout: 25_000,
    waitForInitialPage: !desktop, defaultViewport: desktop ? null : { width: 1440, height: 1000 },
    ...(desktop
      ? { env, pipe: true, ignoreDefaultArgs: true, args: ['--remote-debugging-pipe', ...chromiumSafety, ...desktopVisibility,
          `--user-data-dir=${join(home, 'electron')}`, join(repo, 'desktop')] }
      : { env: browserEnv, userDataDir: join(home, 'chrome-ui'), args: [...chromiumSafety, '--no-first-run', '--no-default-browser-check'] }),
  }
  let browser
  try {
    browser = await puppeteer.launch(options)
  }
  catch (error) {
    // A dead first attempt can leave a singleton lock in the disposable profile.
    if (!desktop && /already running/i.test(String(error?.message))) {
      rmSync(join(home, 'chrome-ui'), { recursive: true, force: true, maxRetries: 5, retryDelay: 250 })
      browser = await puppeteer.launch(options)
    }
    else throw error
  }
  own(async () => {
    try { await browser.close() } catch { /* Windows may keep the disposable profile lock briefly */ }
  })
  return browser
}

async function coreCoverage(ctx, call, check) {
  const { userHome, dbPath } = ctx
  const skillName = 'acceptance-analyzer'
  const skillDir = join(userHome, '.agent', 'skills', skillName)
  mkdirSync(skillDir, { recursive: true })
  writeFileSync(join(skillDir, 'SKILL.md'), '---\nname: acceptance-analyzer\ndescription: Acceptance analyzer for safe synthetic diagnostics.\nmetadata:\n  version: "1.0"\n---\n\n# Acceptance analyzer\n\nUse only synthetic fixture values. Never perform physical operations.\n')
  const discovered = await call('GET', '/api/system/skills/discover')
  const skill = discovered.data?.discovered?.find(item => item.name === skillName)
  check('skill_discovered_from_user_agent_root', skill?.source === 'global', discovered)
  requireThat(id(skill.id), 'invalid discovered skill ID')
  const imported = await call('POST', '/api/system/skills/import', { catalogId: skill.id })
  const revisionId = imported.data?.revision?.id
  const skillEnabled = imported.data?.revision?.enabled
  const skillImportOk = id(revisionId) && (skillEnabled === false || skillEnabled === 0)
  check('skill_imported_immutable_disabled', skillImportOk, imported, { enabledType: typeof skillEnabled, enabledValue: skillEnabled })
  if (!skillImportOk) {
    resultUiNote(ctx, `Skill import disabled-by-default mismatch: type=${typeof skillEnabled} value=${String(skillEnabled).slice(0, 20)}; core Prefab checks continue without Skill capability`)
  }
  const skillPath = revisionId ? `/api/system/skills/${encodeURIComponent(revisionId)}` : ''
  const enabled = revisionId ? await call('PATCH', skillPath, { enabled: true }) : { status: 0, data: null }
  if (revisionId) check('skill_enabled', enabled.data?.enabled === true, enabled)

  const draft = {
    name: 'Acceptance Analyst', description: 'Synthetic diagnostic expert', visibility: 'private',
    prompt: { role: 'Use only fixture values.', scenario: 'No physical operation.', slots: [
      { key: 'objective', label: 'Objective', defaultValue: 'verify-readings', required: true, allowMemberOverride: true, maxLength: 200 },
    ] },
    profile: {}, capabilities: [{ kind: 'skill', id: revisionId, required: true }],
  }
  const created = await call('POST', '/api/workshop/agent-prefabs', { draft })
  check('prefab_draft_created', created.status === 200 && id(created.data?.id), created)
  const prefabPath = `/api/workshop/agent-prefabs/${created.data.id}`
  const rev1 = await call('POST', `${prefabPath}/publish`, { expectedHead: 0, expectedUpdatedAt: created.data.updatedAt })
  check('prefab_revision_published', rev1.data?.revision === 1 && /^[a-f0-9]{64}$/.test(rev1.data.contentHash), rev1)

  const channelName = 'Prefab fixture channel'
  const leadName = 'Fixture lead'
  const channel = await call('POST', '/api/workshop/channels', { name: channelName, leadAgent: { name: leadName, harness: 'mock', config: { delayMs: 0 } } })
  const { channelId, leadAgentId: leadId } = channel.data ?? {}
  check('channel_with_mock_lead', id(channelId) && id(leadId), channel)
  const channelPath = `/api/workshop/channels/${channelId}`
  const leadPath = `${channelPath}/agents/${leadId}/prefab`
  const payload = { prefabId: created.data.id, revision: 1, slotValues: { objective: 'verify-readings' } }
  const bind = await call('PATCH', leadPath, payload)
  check('member_bound_to_pinned_revision', bind.data?.prefabBinding?.revision === 1 && bind.data.prefabBinding.contentHash === rev1.data.contentHash, bind)
  const tools = await call('GET', `/api/workshop/agent-tools/list?agentId=${leadId}`)
  const names = (tools.data?.tools ?? []).map(tool => tool.name)
  check('catalog_exposes_activate_skill_only_for_assigned_skill', names.includes('activate_skill'), tools)
  check('catalog_narrows_unselected_tool', !names.includes('dcw_control') && names.includes('send_message_to_agent'), tools)
  const invoke = (tool, args) => call('POST', '/api/workshop/agent-tools/invoke', { agentId: leadId, tool, args })
  const activated = await invoke('activate_skill', { skillId: revisionId })
  check('activate_skill_returns_low_trust_body', activated.data?.result?.isError !== true && /Acceptance analyzer/.test(activated.data?.result?.text) && /low-trust/.test(activated.data?.result?.text), activated)
  const denied = await invoke('dcw_control', {}) // Unselected, no device, no payload.
  check('unselected_tool_denied_at_dispatch', denied.data?.result?.isError === true && /FORBIDDEN|不开放|不可用/.test(denied.data.result.text), denied)

  const session = await call('POST', `${channelPath}/sessions`, { title: 'Prefab fixture session' })
  const sessionId = session.data?.sessionId ?? session.data?.id
  check('session_created', id(sessionId), session)
  const saved = row(dbPath, 'SELECT member_map_json, prefab_snapshot_json, prefab_snapshot_hash FROM channel_sessions WHERE id = ?', sessionId)
  const clone = getBinding(dbPath, unpack(saved?.member_map_json)[leadId])
  check('session_clone_copies_pinned_binding', clone.revision === 1 && clone.contentHash === rev1.data.contentHash)
  check('session_snapshot_hash_matches', typeof saved?.prefab_snapshot_json === 'string' && hash(saved.prefab_snapshot_json) === saved.prefab_snapshot_hash && saved.prefab_snapshot_json.includes(rev1.data.contentHash))

  const current = await call('GET', prefabPath)
  const edited = await call('PATCH', prefabPath, { expectedUpdatedAt: current.data?.updatedAt, draft: { ...draft, description: 'Changed for revision two' } })
  check('prefab_draft_edit_persists', edited.status === 200 && edited.data?.draft?.description === 'Changed for revision two', edited)
  const rev2 = await call('POST', `${prefabPath}/publish`, { expectedHead: 1, expectedUpdatedAt: edited.data.updatedAt })
  check('revision2_published', rev2.data?.revision === 2 && rev2.data.contentHash !== rev1.data.contentHash, rev2)
  check('existing_binding_not_auto_upgraded', getBinding(dbPath, leadId).contentHash === rev1.data.contentHash)
  const revoked = await call('PATCH', skillPath, { enabled: false })
  const afterRevoke = await invoke('activate_skill', { skillId: revisionId })
  check('revoked_skill_activation_denied', revoked.data?.enabled === false && afterRevoke.data?.result?.isError === true, afterRevoke)
  const restored = await call('PATCH', skillPath, { enabled: true })
  check('skill_restored_after_revocation', restored.data?.enabled === true, restored)

  // Use the reserved .invalid TLD for data-only registration, never pass its ID to discover.
  const manifest = { label: 'Nonconnecting acceptance manifest', dataSharing: 'shared-safe' }
  const badMcp = await call('POST', '/api/system/mcp-servers', { ...manifest, id: 'accept-bad', endpoint: 'http://127.0.0.1:9/mcp' })
  check('mcp_rejects_non_https', badMcp.status === 400 && badMcp.code === 'MCP_HTTPS_REQUIRED', badMcp)
  const goodMcp = await call('POST', '/api/system/mcp-servers', { ...manifest, id: 'accept-mcp', endpoint: 'https://unreachable.invalid/mcp' })
  check('mcp_manifest_registered_without_secret', goodMcp.status === 200 && goodMcp.data?.hasCredential === false && !JSON.stringify(goodMcp.data).includes('credentialRef'), goodMcp)
  const missing = await call('POST', '/api/system/mcp-servers/accept-nonexistent/discover')
  check('mcp_discovery_unknown_manifest_rejected_before_connection', missing.status === 404 && missing.code === 'NOT_FOUND' && typeof missing.message === 'string' && missing.message.length < 400, missing)
  const removed = await call('DELETE', '/api/system/mcp-servers/accept-mcp')
  check('mcp_fixture_removed', removed.status === 200, removed)
  return {
    draft, channelPath, channelId, channelName, leadPath, leadId, leadName, prefabPath,
    prefabId: created.data.id, prefabName: draft.name, rev1: rev1.data, rev2: rev2.data, revisionId,
  }
}

async function lifecycleCoverage(ctx, call, check, core) {
  const { draft, channelPath, leadPath, leadId, prefabPath, prefabId, rev1, revisionId } = core
  const channel = await call('POST', '/api/workshop/channels', { name: 'Concurrent binding fixture', leadAgent: { name: 'Race lead', harness: 'mock' } })
  const { channelId, leadAgentId } = channel.data ?? {}
  requireThat(id(channelId) && id(leadAgentId), 'race channel or lead missing')
  const membersPath = `/api/workshop/channels/${channelId}/agents`
  const path = `${membersPath}/${leadAgentId}/prefab`
  const results = await Promise.all(['race-a', 'race-b'].map(objective => call('PATCH', path, { prefabId, revision: 1, slotValues: { objective } })))
  const winner = results.findIndex(r => r.status === 200)
  const loser = results.find(r => r.status === 409)
  check('concurrent_bind_exactly_one_winner', winner !== -1 && loser?.code === 'PREFAB_ALREADY_BOUND')
  const members = await call('GET', membersPath)
  const saved = members.data?.find(item => item.id === leadAgentId)
  const binding = getBinding(ctx.dbPath, leadAgentId)
  const version = saved?.prefabBindingVersion ?? binding.bindingVersion
  check('concurrent_winner_is_the_only_persisted_binding', binding.contentHash === rev1.contentHash
  && binding.slotValues?.objective === ['race-a', 'race-b'][winner] && typeof version === 'string', members)

  const clear = await call('PATCH', path, { clear: true, expectedBindingVersion: version })
  check('versioned_clear_removes_binding', clear.status === 200 && !getBinding(ctx.dbPath, leadAgentId).prefabId, clear)

  const fresh = await call('GET', prefabPath)
  const archived = await call('DELETE', prefabPath, { expectedUpdatedAt: fresh.data?.updatedAt })
  check('published_prefab_archived', archived.status === 200 && archived.data?.id === prefabId && archived.data.archived === true, archived)
  const blocked = await call('PATCH', path, { prefabId, revision: 1, slotValues: { objective: 'try-archive' } })
  check('archived_prefab_cannot_create_new_binding', blocked.status === 409 && blocked.code === 'PREFAB_ARCHIVED', blocked)
  const oldPin = await call('GET', `${prefabPath}/revisions/1`)
  const roster = await call('GET', `${channelPath}/agents`)
  const lead = roster.data?.find(item => item.id === leadId)
  const activation = await call('POST', '/api/workshop/agent-tools/invoke', { agentId: leadId, tool: 'activate_skill', args: { skillId: revisionId } })
  check('archived_prefab_old_pin_still_resolves', oldPin.data?.contentHash === rev1.contentHash
  && lead?.prefabBinding?.contentHash === rev1.contentHash && activation.data?.result?.isError !== true
  && /low-trust/.test(activation.data?.result?.text), activation)
  const newDraft = await call('POST', '/api/workshop/agent-prefabs', { draft: { ...draft, name: 'Disposable unpublished draft' } })
  requireThat(id(newDraft.data?.id), 'draft to delete was not created')
  const draftPath = `/api/workshop/agent-prefabs/${newDraft.data.id}`
  const deleted = await call('DELETE', draftPath, { expectedUpdatedAt: newDraft.data.updatedAt })
  const gone = await call('GET', draftPath)
  check('unpublished_draft_deleted_not_archived', deleted.status === 200 && deleted.data?.id === newDraft.data.id && deleted.data.archived === false && gone.status === 404, deleted)
  const list = await call('GET', '/api/workshop/agent-prefabs')
  check('archived_and_deleted_excluded_from_active_list', Array.isArray(list.data?.prefabs) && !list.data.prefabs.some(p => [prefabId, newDraft.data.id].includes(p.id)), list)
}

const PANEL = '#settings-panel-prefabs'
/** zh and en builds label the binding card differently; either text is accepted. */
const BINDING = Object.freeze({
  select: { channel: ['Channel'], member: ['Member', '成员'], prefab: ['Name', '名称'] },
  bind: ['绑定', 'Bind'],
  unbind: ['解绑', 'Unbind'],
  cancel: ['取消', 'Cancel'],
  defaultState: ['未绑定', 'Not bound'],
  unbindFirst: ['请先解绑当前版本', 'Unbind the current revision'],
  frozenNote: ['实例关闭前不能', 'until that instance closes'],
})
/** Hold a response wait without letting its timeout surface as an unhandled rejection. */
const settle = promise => promise.then(value => value, error => error)

/** Compact DOM facts of the binding card for a failed UI step. */
async function bindingDomFacts(page) {
  return page.evaluate((panelCss) => {
    const panel = document.querySelector(panelCss)
    if (!panel) return { panel: false }
    const box = (element) => {
      if (!element) return null
      const r = element.getBoundingClientRect()
      return [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)]
    }
    return {
      panel: true,
      selects: [...panel.querySelectorAll('.ant-select')].map(element => ({
        aria: element.getAttribute('aria-label'),
        disabled: element.classList.contains('ant-select-disabled'),
        value: (element.querySelector('.ant-select-selection-item')?.textContent || '').trim(),
        box: box(element),
      })),
      state: (panel.querySelector('.pf-binding-state')?.textContent || '').replace(/\s+/g, ' ').trim(),
      buttons: [...panel.querySelectorAll('.pf-card button')].map(button => ({ text: (button.textContent || '').trim(), disabled: button.disabled, box: box(button) })),
      dropdowns: [...document.querySelectorAll('.ant-select-dropdown')]
        .filter(dropdown => !dropdown.classList.contains('ant-select-dropdown-hidden'))
        .map(dropdown => ({ box: box(dropdown), options: [...dropdown.querySelectorAll('.ant-select-item-option-content')].map(option => (option.textContent || '').trim()) })),
      confirm: [...document.querySelectorAll('.ant-modal-confirm')].map(modal => ({ box: box(modal), buttons: [...modal.querySelectorAll('.ant-modal-confirm-btns button')].map(button => (button.textContent || '').trim()) })),
      viewport: [innerWidth, innerHeight],
      visibility: document.visibilityState,
    }
  }, PANEL)
}

/** Keep the latest client errors so a failed visible step can explain itself. */
function watchPageErrors(ctx, page) {
  ctx.pageErrors ??= []
  const record = (text) => {
    // Only while the visible stages run: the event stream naturally drops when the owned server stops.
    if (!ctx.pageErrorsClosed && ctx.pageErrors.length < 30 && text) ctx.pageErrors.push(text.slice(0, 300))
  }
  page.on('pageerror', error => record(`pageerror: ${error?.message ?? error}`))
  page.on('console', (msg) => {
    if (msg.type() === 'error' || msg.type() === 'warning') record(`console.${msg.type()}: ${msg.text()}`)
  })
  page.on('requestfailed', (request) => {
    record(`requestfailed: ${request.method()} ${new URL(request.url()).pathname.slice(0, 120)} ${request.failure()?.errorText ?? ''}`)
  })
}

/** Run one visible stage; a failure keeps its step, a screenshot and the card's DOM facts. */
async function visibleStep(ctx, name, run) {
  // A covered, minimised or tray-hidden test window stops rendering; record what it was.
  ctx.visibilityAtStart = [...(ctx.visibilityAtStart ?? []), await ctx.page.evaluate(() => document.visibilityState)]
  try {
    return await run()
  } catch (error) {
    let facts = null
    // Whether the renderer still produces frames: an occluded window stops them, which
    // is the one condition that makes a rendered page look stuck to a frame-polled wait.
    const frames = await (ctx.page?.evaluate(() => new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), 1500)
      requestAnimationFrame(() => {
        clearTimeout(timer)
        resolve(true)
      })
    })).catch(() => null) ?? null)
    try { facts = await bindingDomFacts(ctx.page) } catch { /* the page may already be gone */ }
    try { await ctx.page.screenshot({ path: join(ctx.evidenceDir, `${ctx.target}-${name}-failure.png`) }) } catch { /* best effort */ }
    try {
      writeFileSync(join(ctx.evidenceDir, `${ctx.target}-${name}-failure.txt`),
        `${ctx.uiStep ?? 'unknown'}\nurl=${ctx.page.url()}\n${String(error?.message ?? error).slice(0, 3000)}\n${facts ? JSON.stringify({ ...facts, animationFrames: frames }) : 'dom facts unavailable'}\n${JSON.stringify(ctx.pageErrors ?? [])}\n`, 'utf8')
    } catch { /* best effort */ }
    throw error
  }
}

/** Timer-polled page wait: frame-driven polling stalls whenever a window is occluded. */
const waitInPage = (page, fn, timeout, arg) => page.waitForFunction(fn, { timeout, polling: 200 }, arg)

/** Replace the content of a visible text field through real input events. */
async function typeInto(page, selector, text) {
  const focused = await page.evaluate((css) => {
    const element = document.querySelector(css)
    if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) || element.readOnly) return false
    element.focus()
    element.select()
    return document.activeElement === element
  }, selector)
  requireThat(focused, `text field not editable: ${selector}`)
  // Clear the selection with a real key, then insert the text as an IME commit would.
  await page.keyboard.press('Backspace')
  await page.keyboard.sendCharacter(text)
}

/** One input driver per page; it is shared by every visible stage. */
function uiDriver(ctx) {
  ctx.ui ??= bindingDriver(ctx, ctx.page)
  return ctx.ui
}

/** Open Settings → Agent 预制件 with a real click; hydration must finish first or the click is lost. */
async function openPrefabs(ctx, base) {
  const { page } = ctx
  const ui = uiDriver(ctx)
  ctx.uiStep = 'open-settings'
  await page.goto(`${base}/settings`, { waitUntil: 'domcontentloaded', timeout: 30_000 })
  ctx.uiStep = 'wait-settings-hydration'
  await waitInPage(page, () => document.documentElement.dataset.vpTier !== undefined, 20_000)
  for (let attempt = 0; attempt < 3; attempt++) {
    ctx.uiStep = 'click-prefabs-tab'
    await ui.click({ kind: 'element', selector: '#settings-tab-prefabs' }, 'click-prefabs-tab')
    try {
      await waitInPage(page, (panelCss) => {
        const panel = document.querySelector(panelCss)
        return Boolean(panel && !panel.hidden)
      }, 5_000, PANEL)
      return
    }
    catch { /* hydration may have dropped the first click; retry */ }
  }
  requireThat(false, 'prefabs settings panel did not become visible')
}

/**
 * Drive the binding card with real mouse input: open a select, pick an option,
 * press Bind/Unbind and confirm. Elements are addressed by their accessible
 * names in either locale and clicked only once their box has stopped moving.
 */
function bindingDriver(ctx, page) {
  const evaluate = (fn, arg) => page.evaluate(fn, arg)
  const rectOf = spec => evaluate((spec) => {
    const box = (element) => {
      if (!element) return null
      const r = element.getBoundingClientRect()
      return r.width > 0 && r.height > 0 ? { x: r.x, y: r.y, width: r.width, height: r.height } : null
    }
    const panel = document.querySelector(spec.panelCss)
    if (!panel) return null
    const exact = (element, names) => names.includes((element.textContent || '').trim())
    if (spec.kind === 'select') {
      const element = [...panel.querySelectorAll('.ant-select')].find(item => spec.names.includes(item.getAttribute('aria-label')))
      return element && !element.classList.contains('ant-select-disabled') ? box(element) : null
    }
    if (spec.kind === 'option') {
      const dropdown = [...document.querySelectorAll('.ant-select-dropdown')]
        .find(item => !item.classList.contains('ant-select-dropdown-hidden') && item.getBoundingClientRect().height > 0)
      const option = dropdown && [...dropdown.querySelectorAll('.ant-select-item-option-content')].find(item => (item.textContent || '').includes(spec.text))
      return box(option || null)
    }
    if (spec.kind === 'button') {
      const card = panel.querySelector('.pf-binding-state')?.closest('.pf-card')
      return box(card && [...card.querySelectorAll('button')].find(button => !button.disabled && exact(button, spec.names)))
    }
    if (spec.kind === 'confirm') {
      const modal = [...document.querySelectorAll('.ant-modal-confirm')].find(item => item.getBoundingClientRect().width > 0)
      return box(modal && [...modal.querySelectorAll('.ant-modal-confirm-btns button')].find(button => !button.disabled && exact(button, spec.names)))
    }
    if (spec.kind === 'theme') {
      return box(document.querySelector('button.icon-btn .i-tabler-sun-high')?.closest('button'))
    }
    if (spec.kind === 'element') return box(document.querySelector(spec.selector))
    return null
  }, { panelCss: PANEL, ...spec })

  const click = async (spec, step) => {
    ctx.uiStep = step
    let previous = null
    const rect = await poll(`${step}: control not ready`, 20_000, async () => {
      const current = await rectOf(spec)
      if (!current) {
        previous = null
        return null
      }
      // Two identical boxes one poll apart mean the open/close animation has settled.
      if (previous && JSON.stringify(previous) === JSON.stringify(current)) return current
      previous = current
      return null
    })
    await page.mouse.click(rect.x + rect.width / 2, rect.y + rect.height / 2)
  }

  const dropdownsOpen = () => evaluate(() => [...document.querySelectorAll('.ant-select-dropdown')]
    .some(item => !item.classList.contains('ant-select-dropdown-hidden') && item.getBoundingClientRect().height > 0))

  return {
    click,
    async choose(select, option) {
      await click({ kind: 'select', names: BINDING.select[select] }, `open-${select}-select`)
      await click({ kind: 'option', text: option }, `pick-${select}-option`)
      await poll(`${select} dropdown did not close after the pick`, 10_000, async () => (await dropdownsOpen()) ? null : true)
    },
    async state() {
      await waitInPage(page, css => document.querySelector(css) !== null, 15_000, `${PANEL} .pf-binding-state`)
      return page.evaluate((css) => (document.querySelector(css)?.textContent || '').replace(/\s+/g, ' ').trim(), `${PANEL} .pf-binding-state`)
    },
    controls: () => evaluate(({ panelCss, selectNames, bind, unbind, unbindFirst, frozenNote }) => {
      const card = document.querySelector(panelCss)?.querySelector('.pf-binding-state')?.closest('.pf-card')
      const buttons = card ? [...card.querySelectorAll('button')] : []
      const notes = card ? [...card.querySelectorAll('.pf-meta')].map(note => (note.textContent || '').trim()) : []
      return {
        bind: buttons.some(button => bind.includes((button.textContent || '').trim())),
        unbind: buttons.some(button => unbind.includes((button.textContent || '').trim())),
        unbindFirst: notes.some(text => unbindFirst.some(label => text.includes(label))),
        frozen: notes.some(text => frozenNote.some(label => text.includes(label))),
        prefabSelect: Boolean(card && [...card.querySelectorAll('.ant-select')].some(select => selectNames.includes(select.getAttribute('aria-label')))),
      }
    }, { panelCss: PANEL, selectNames: BINDING.select.prefab, bind: BINDING.bind, unbind: BINDING.unbind, unbindFirst: BINDING.unbindFirst, frozenNote: BINDING.frozenNote }),
  }
}

async function visibleEdit(ctx, call, check, register, core) {
  return visibleStep(ctx, 'visible-edit', () => visibleCreateAndEdit(ctx, call, check, register, core))
}

async function visibleCreateAndEdit(ctx, call, check, register) {
  const { base, page, evidenceDir } = ctx
  // Only the owned sidecar origin (no external frontend assets/URLs).
  await page.setRequestInterception(true)
  page.on('request', request => {
    const href = request.url()
    const allowed = href.startsWith(`${base}/`) || /^(?:data:|blob:)/.test(href)
    void (allowed ? request.continue() : request.abort()).catch(() => {})
  })
  await page.goto(`${base}/`, { waitUntil: 'domcontentloaded', timeout: 30_000 })
  const loggedIn = await page.evaluate(async ({ email, password }) => {
    const res = await fetch('/api/users/login', { method: 'POST', headers: { 'content-type': 'application/json', 'x-aw-browser': '1' }, body: JSON.stringify({ email, password }) })
    return res.ok
  }, register)
  requireThat(loggedIn, 'browser login failed')
  const suffix = hex(4)
  const createdName = `Visible Create ${suffix}`
  const editedName = `Visible Edit ${suffix}`
  // Click a real button by its visible label (locale-tolerant) once the pane has finished
  // loading; the element receives a native click event, API responses are still awaited below.
  const clickButton = async (scope, labels) => {
    await waitInPage(page, ({ scope, labels }) => {
      const root = document.querySelector(scope)
      return Boolean(root && [...root.querySelectorAll('button')].some((button) => {
        const text = (button.textContent || '').trim()
        return !button.disabled && labels.some(label => text.includes(label))
      }))
    }, 20_000, { scope, labels })
    const clicked = await page.evaluate(({ scope, labels }) => {
      const root = document.querySelector(scope)
      if (!root) return false
      const target = [...root.querySelectorAll('button')].find((button) => {
        const text = (button.textContent || '').trim()
        return !button.disabled && labels.some(label => text.includes(label))
      })
      if (!target) return false
      target.click()
      return true
    }, { scope, labels })
    requireThat(clicked, `button not found: ${labels.join('|')}`)
  }
  const responseOk = (response, failure) => {
    if (!(response && typeof response.ok === 'function')) throw response instanceof Error ? response : new Error(failure)
    requireThat(response.ok(), failure)
  }
  const open = () => openPrefabs(ctx, base)
  await open()
  // Create a named draft through the visible create action, then locate the created row from the API.
  ctx.uiStep = 'click-new-prefab'
  await clickButton(PANEL, ['新建预制件', 'New prefab'])
  ctx.uiStep = 'type-draft-name'
  await waitInPage(page, () => document.querySelector('#pf-name') !== null, 15_000)
  await typeInto(page, '#pf-name', createdName)
  const saveResponse = settle(page.waitForResponse(res => res.url() === `${base}/api/workshop/agent-prefabs` && res.request().method() === 'POST', { timeout: 20_000 }))
  ctx.uiStep = 'click-create-draft'
  await clickButton(PANEL, ['创建草稿', 'Create draft'])
  responseOk(await saveResponse, 'browser draft creation failed')
  const listing = await call('GET', '/api/workshop/agent-prefabs')
  const created = listing.data?.prefabs?.find(row => row.draft?.name === createdName)
  requireThat(id(created?.id) && created.draft.name === createdName, 'visible created draft was not listed')
  const target = `/api/workshop/agent-prefabs/${created.id}`
  const rowSelector = `${PANEL} tr[data-row-key="${created.id}"]`
  await open()
  ctx.uiStep = 'wait-created-row'
  await waitInPage(page, selector => document.querySelector(selector) !== null, 20_000, rowSelector)
  // This is intentionally the listed row's Edit action, not a hidden API mutation.
  ctx.uiStep = 'click-row-edit'
  await clickButton(`${rowSelector} .pf-row-actions`, ['编辑', 'Edit'])
  ctx.uiStep = 'type-edited-name'
  await typeInto(page, '#pf-name', editedName)
  const savedResponse = settle(page.waitForResponse(res => res.url() === `${base}${target}` && res.request().method() === 'PATCH', { timeout: 20_000 }))
  ctx.uiStep = 'click-save-draft'
  await clickButton(PANEL, ['保存草稿', 'Save draft'])
  responseOk(await savedResponse, 'browser PATCH failed')
  await open()
  ctx.uiStep = 'wait-edited-row'
  await waitInPage(page, ({ selector, name }) => (document.querySelector(selector)?.textContent || '').includes(name), 20_000, { selector: rowSelector, name: editedName })
  const saved = await call('GET', target)
  check('visible_create_named_draft', created.draft?.name === createdName, saved)
  check('visible_listed_edit_updates_row_and_survives_reload', saved.data?.draft?.name === editedName, saved)
  await page.screenshot({ path: join(evidenceDir, `${ctx.target}-visible-edit.png`) })
}

/** Add an idle mock worker member to the fixture channel; returns its member id. */
async function addMockWorker(call, channelPath, name) {
  const template = await call('POST', '/api/workshop/agents', { name, harness: 'mock', config: { delayMs: 0 } })
  requireThat(id(template.data?.id), `mock template missing: ${name}`)
  const added = await call('POST', `${channelPath}/agents`, { agentId: template.data.id, role: 'worker' })
  const workerId = added.data?.id ?? added.data?.agentId
  requireThat(id(workerId), `mock member missing: ${name}`)
  return workerId
}

/**
 * Bind a member through the visible card only: Channel → member → published prefab → Bind.
 * The member is then left bound so a real runtime job runs under that binding.
 */
async function visibleBind(ctx, call, check, core) {
  const { page, base, evidenceDir } = ctx
  const ui = uiDriver(ctx)
  const workerName = 'Visible bind worker'
  const workerId = await addMockWorker(call, core.channelPath, workerName)
  const workerPath = `${base}/api/workshop/channels/${core.channelId}/agents/${workerId}/prefab`
  const isHeadRevision = text => /(?:版本|revision)\s*2\b/.test(text) && text.includes(core.rev2.contentHash.slice(0, 12))
  await openPrefabs(ctx, base)
  await ui.choose('channel', core.channelName)
  // The lead was bound to revision 1 by the API; the card must report that pin, not the head.
  await ui.choose('member', core.leadName)
  const leadState = await ui.state()
  check('visible_member_bound_by_api_shows_pinned_revision', leadState.includes(core.prefabName)
  && /(?:版本|revision)\s*1\b/.test(leadState) && leadState.includes(core.rev1.contentHash.slice(0, 12)), { status: 200 }, { text: leadState.slice(0, 160) })
  // A session instance inherits the binding at creation and stays view-only until the session closes.
  await ui.choose('member', `${core.leadName}·session·`)
  const cloneState = await poll('session instance did not report its pinned revision', 15_000, async () => {
    const text = await ui.state()
    return text.includes(core.rev1.contentHash.slice(0, 12)) ? text : null
  })
  const cloneControls = await ui.controls()
  check('visible_session_instance_member_is_view_only', cloneControls.bind === false && cloneControls.unbind === false
  && cloneControls.prefabSelect === false && cloneControls.frozen === true, { status: 200 }, { ...cloneControls, text: cloneState.slice(0, 160) })
  await ui.choose('member', `${workerName} (worker)`)
  const defaultState = await ui.state()
  check('visible_unbound_member_shows_default_state', BINDING.defaultState.some(label => defaultState.includes(label)), { status: 200 }, { text: defaultState.slice(0, 160) })
  await ui.choose('prefab', core.prefabName)
  const bindResponse = settle(page.waitForResponse(res => res.url() === workerPath && res.request().method() === 'PATCH', { timeout: 20_000 }))
  await ui.click({ kind: 'button', names: BINDING.bind }, 'click-bind')
  const bound = await bindResponse
  if (!(bound && typeof bound.ok === 'function')) throw bound instanceof Error ? bound : new Error('visible bind produced no response')
  requireThat(bound.ok(), 'visible bind request was rejected')
  const boundState = await poll('bound state line did not show the pinned head revision', 15_000, async () => {
    const text = await ui.state()
    return isHeadRevision(text) ? text : null
  })
  check('visible_bind_pins_published_head_revision', boundState.includes(core.prefabName), { status: bound.status() }, { text: boundState.slice(0, 160) })
  const boundControls = await ui.controls()
  check('visible_bound_member_offers_only_unbind', boundControls.bind === false && boundControls.prefabSelect === false
  && boundControls.unbind === true && boundControls.unbindFirst === true, { status: 200 }, boundControls)
  const roster = await call('GET', `${core.channelPath}/agents`)
  const saved = roster.data?.find(item => item.id === workerId)
  check('visible_binding_persisted_with_generation', saved?.prefabBinding?.revision === core.rev2.revision
  && saved.prefabBinding.contentHash === core.rev2.contentHash && typeof saved.prefabBindingVersion === 'string', roster)
  await page.screenshot({ path: join(evidenceDir, `${ctx.target}-visible-bound.png`) })
  return workerId
}

/** Unbind through the visible action and its confirmation; the member returns to default operation. */
async function visibleUnbind(ctx, call, check, core, workerId) {
  const { page, base, evidenceDir } = ctx
  const ui = uiDriver(ctx)
  const workerPath = `${base}/api/workshop/channels/${core.channelId}/agents/${workerId}/prefab`
  await openPrefabs(ctx, base)
  await ui.choose('channel', core.channelName)
  await ui.choose('member', 'Visible bind worker (worker)')
  const before = await ui.state()
  requireThat(before.includes(core.rev2.contentHash.slice(0, 12)), 'member was not bound before the visible unbind')

  const dialogSurface = () => page.evaluate(() => {
    const modal = [...document.querySelectorAll('.ant-modal-confirm')].find(item => item.getBoundingClientRect().width > 0)
    return modal ? getComputedStyle(modal.querySelector('.ant-modal-content')).backgroundColor : null
  })
  const settledDialog = async () => {
    let previous = null
    return poll('unbind confirmation did not open', 15_000, async () => {
      const facts = await bindingDomFacts(page)
      const open = facts.confirm.find(item => item.box && item.box[2] > 0)
      if (!open) {
        previous = null
        return null
      }
      // Capture only after the open animation has settled.
      const settled = previous && JSON.stringify(previous.box) === JSON.stringify(open.box)
      previous = open
      return settled ? open : null
    })
  }
  const setDark = async (dark) => {
    await ui.click({ kind: 'theme' }, dark ? 'switch-to-dark' : 'switch-to-light')
    await waitInPage(page, (value) => document.documentElement.classList.contains('dark') === value, 15_000, dark)
  }

  // Static dialogs render outside the page tree, so prove one still follows the app theme,
  // and that cancelling it leaves the binding untouched.
  await setDark(true)
  await ui.click({ kind: 'button', names: BINDING.unbind }, 'click-unbind-in-dark')
  await settledDialog()
  const darkSurface = await dialogSurface()
  await page.screenshot({ path: join(evidenceDir, `${ctx.target}-visible-unbind-confirm-dark.png`) })
  await ui.click({ kind: 'confirm', names: BINDING.cancel }, 'cancel-unbind-in-dark')
  await poll('confirmation did not close after cancel', 10_000, async () => (await dialogSurface()) ? null : true)
  const afterCancel = await call('GET', `${core.channelPath}/agents`)
  check('visible_unbind_cancel_keeps_binding', afterCancel.data?.find(item => item.id === workerId)?.prefabBinding?.contentHash === core.rev2.contentHash, afterCancel)
  await setDark(false)

  await ui.click({ kind: 'button', names: BINDING.unbind }, 'click-unbind')
  // Nothing may leave for the server until the user confirms in the dialog.
  const clearResponse = settle(page.waitForResponse(res => res.url() === workerPath && res.request().method() === 'PATCH', { timeout: 25_000 }))
  const dialog = await settledDialog()
  const lightSurface = await dialogSurface()
  await page.screenshot({ path: join(evidenceDir, `${ctx.target}-visible-unbind-confirm.png`) })
  // Exact labels: the confirm dialog must inherit the app's button settings (no CJK auto space).
  check('visible_unbind_asks_for_confirmation', BINDING.unbind.some(label => dialog.buttons.includes(label))
  && BINDING.cancel.some(label => dialog.buttons.includes(label)), { status: 200 }, { buttons: dialog.buttons })
  check('visible_confirm_dialog_follows_theme', Boolean(darkSurface) && Boolean(lightSurface) && darkSurface !== lightSurface, { status: 200 }, { darkSurface, lightSurface })
  await ui.click({ kind: 'confirm', names: BINDING.unbind }, 'confirm-unbind')
  const cleared = await clearResponse
  if (!(cleared && typeof cleared.ok === 'function')) throw cleared instanceof Error ? cleared : new Error('visible unbind produced no response')
  requireThat(cleared.ok(), 'visible unbind request was rejected')
  const body = unpack(cleared.request().postData())
  check('visible_unbind_sends_generation_guard', body.clear === true && typeof body.expectedBindingVersion === 'string' && body.expectedBindingVersion.length > 0, { status: cleared.status() })
  await poll('default state line did not return after the unbind', 15_000, async () => {
    const text = await ui.state()
    return BINDING.defaultState.some(label => text.includes(label)) ? text : null
  })
  const roster = await call('GET', `${core.channelPath}/agents`)
  const saved = roster.data?.find(item => item.id === workerId)
  check('visible_unbind_returns_member_to_default_run', saved?.prefabBinding == null && saved?.prefabBindingVersion == null, roster)
  const controls = await ui.controls()
  check('visible_unbound_member_offers_bind_again', controls.bind === true && controls.unbind === false && controls.unbindFirst === false, { status: cleared.status() }, controls)
  await page.screenshot({ path: join(evidenceDir, `${ctx.target}-visible-unbound.png`) })
  ctx.visibility = await page.evaluate(() => document.visibilityState)
  ctx.pageErrorsClosed = true
}

function resultUiNote(ctx, note) {
  ctx.uiNotes ??= []
  ctx.uiNotes.push(note)
}

/**
 * Drive one real AgentRuntime turn for a directly assigned worker: the submitting
 * human is the scheduler here, so the assign message wakes the member and the
 * mock harness must produce an artifact under the active (or absent) binding.
 * `contentHash` asserts the binding the turn ran under; without it the member must be unbound.
 */
async function mockRuntimeJob(ctx, call, check, core, { label, workerId, contentHash }) {
  const binding = getBinding(ctx.dbPath, workerId)
  const task = await call('POST', `${core.channelPath}/tasks`, {
    title: `Prefab ${label} runtime job [mock:simple]`,
    description: `[mock:simple] ${label} fixture; report completion without external tools.`,
    assigneeId: workerId,
  })
  const taskId = task.data?.id ?? task.data?.taskId
  requireThat(id(taskId), `mock ${label} task not created`)
  let terminal
  try {
    terminal = await poll(`mock ${label} task timeout`, 120_000, () => {
      const value = row(ctx.dbPath, 'SELECT state, artifacts_json FROM tasks WHERE id = ?', taskId)
      return /^(COMPLETED|FAILED|CANCELED)$/.test(value?.state) ? value : null
    })
  }
  catch (error) {
    const snapshot = row(ctx.dbPath, 'SELECT state, progress, retry_count, close_reason, route_reason FROM tasks WHERE id = ?', taskId)
    writeFileSync(join(ctx.evidenceDir, `mock-${label}-timeout.json`), `${JSON.stringify({ snapshot, task: task.data }, null, 2)}\n`, 'utf8')
    throw error
  }
  let artifacts = []
  try { artifacts = JSON.parse(terminal.artifacts_json || '[]') } catch { /* assertion below fails safely */ }
  const hasMockArtifact = artifacts.some(artifact => artifact.parts?.some(part => typeof part.text === 'string' && part.text.includes('mock 成果')))
  check(`mock_${label}_runtime_dispatch_completed`, terminal.state === 'COMPLETED' && hasMockArtifact
  && (contentHash ? binding.contentHash === contentHash : !binding.prefabId), terminal)
}

function assertModelListener(env) {
  const netstat = spawnSync('netstat.exe', ['-ano', '-p', 'tcp'], { env, encoding: 'utf8', timeout: 6000, windowsHide: true })
  requireThat(netstat.status === 0, 'local listener ownership check failed')
  const listeners = netstat.stdout.split(/\r?\n/).map(line => line.trim().split(/\s+/))
    .filter(parts => parts[0] === 'TCP' && parts[1]?.endsWith(`:${localPort}`) && /^(?:0\.0\.0\.0|\[::\]):0$/.test(parts[2]))
  requireThat(listeners.length === 1 && listeners[0][1] === `${host}:${localPort}` && Number(listeners[0].at(-1)) === localPid,
    'local model listener is absent, non-loopback, or not owned by the declared dedicated PID')
}

function assertIsolatedProof() {
  let proof
  try { proof = readJson(isolatedProofPath) } catch { throw new Error('isolated local-model proof is not valid JSON') }
  requireThat(proof?.scope === 'isolated' && proof.loopback === true
    && proof.provider === 'local' && proof.model === localModel
    && Number(proof.pid) === localPid && Number(proof.port) === localPort,
  'local-model proof must be isolated loopback provider=local with matching pid port model')
}

async function prepareLocal({ env, root, userHome }) {
  assertIsolatedProof()
  assertModelListener(env)
  const origin = loopbackOrigin(`http://${host}:${localPort}`)
  const response = await fetch(`${origin}/v1/models`, { redirect: 'error', signal: AbortSignal.timeout(4000) })
  const models = response.ok ? (await response.json()).data : null
  requireThat(Array.isArray(models) && models.length === 1 && models[0]?.id === localModel, 'dedicated local endpoint does not expose exactly the requested model')
  const profile = `aw-prefab-${hex(6)}`
  const configured = spawnSync(flags.omp, ['--profile', profile, 'config', 'path'], { cwd: root, env, windowsHide: true, encoding: 'utf8', timeout: 6000 })
  const cfg = join(userHome, '.omp', 'profiles', profile, 'agent')
  requireThat(configured.status === 0 && resolve(configured.stdout.trim()).toLowerCase() === cfg.toLowerCase()
    && readdirSync(cfg).every(name => name === 'agent.db'), 'OMP profile was not created in the disposable user home')
  // JSON is valid YAML; never inherit a provider list or auth store. Placeholder is not a real key.
  writeFileSync(join(cfg, 'models.yml'), JSON.stringify({ providers: { local: { baseUrl: `${origin}/v1`, apiKey: 'unused-local-placeholder', api: 'openai-completions', auth: 'apiKey', models: [
    { id: localModel, name: localModel, reasoning: false, input: ['text'], contextWindow: 8192, maxTokens: 512, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
  ] } } }), { flag: 'wx' })
  writeFileSync(join(cfg, 'config.yml'), JSON.stringify({ modelRoles: { default: `local/${localModel}` }, setupVersion: 2, dev: { autoqaConsent: 'denied' } }), { flag: 'wx' })
  return profile
}

/** Compact view of what the real model said in an OMP session (role, provider, text, tool calls). */
function readLocalSession(sessions) {
  return readdirSync(sessions, { recursive: true, withFileTypes: true })
    .filter(file => file.isFile() && file.name.endsWith('.jsonl'))
    .flatMap((file) => {
      try { return readFileSync(join(file.parentPath, file.name), 'utf8').split(/\r?\n/) } catch { return [] }
    })
    .flatMap((line) => {
      try { return [JSON.parse(line).message] } catch { return [] }
    })
    .filter(msg => msg && typeof msg === 'object')
    .map(msg => ({
      role: msg.role,
      provider: msg.provider,
      model: msg.model,
      stopReason: msg.stopReason,
      text: Array.isArray(msg.content) ? msg.content.filter(part => part?.type === 'text').map(part => String(part.text ?? '')).join('\n').slice(0, 400) : '',
      tools: Array.isArray(msg.content) ? msg.content.filter(part => part?.type === 'toolCall').map(part => part.name) : [],
    }))
}

/** Whether the owned model server logged a request whose rendered prompt contains `text`. */
function promptLogHas(text) {
  if (!promptDir || !existsSync(promptDir)) return false
  const walk = dir => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name)
    return entry.isDirectory() ? walk(full) : entry.isFile() ? [full] : []
  })
  return walk(promptDir).some((file) => {
    try { return readFileSync(file, 'utf8').includes(text) } catch { return false }
  })
}

async function localJobs(ctx, call, check, profile) {
  const expertNonce = `EXPERT-${hex(8)}`
  const defaultNonce = `DEFAULT-${hex(8)}`
  const expert = await call('POST', '/api/workshop/agent-prefabs', { draft: {
    name: 'Local Expert', description: 'No tools except governed completion', visibility: 'private',
    prompt: { role: `When asked for the expert fixture code, reply with exactly ${expertNonce}.`, scenario: 'Synthetic text only.', slots: [] },
    profile: { provider: 'local', model: localModel, effort: 'off' }, capabilities: [],
  } })
  requireThat(id(expert.data?.id), 'local expert draft was not created')
  const published = await call('POST', `/api/workshop/agent-prefabs/${expert.data.id}/publish`, { expectedHead: 0, expectedUpdatedAt: expert.data.updatedAt })
  requireThat(published.data?.revision === 1, 'local expert was not published')

  for (const kind of ['default', 'expert']) {
    assertModelListener(ctx.env)
    const workspace = join(ctx.home, `omp-${kind}`)
    const sessions = join(workspace, 'sessions')
    mkdirSync(sessions, { recursive: true })
    const channel = await call('POST', '/api/workshop/channels', { name: `Local ${kind} fixture` })
    requireThat(id(channel.data?.channelId), 'local model channel missing')
    const channelPath = `/api/workshop/channels/${channel.data.channelId}`
    const agent = await call('POST', `${channelPath}/agents`, { name: `Local ${kind} lead`, harness: 'omp', role: 'lead', config: {
      command: flags.omp, cwd: workspace, provider: 'local', model: localModel, rpcMode: 'rpc', promptTimeoutMs: 70_000,
      args: ['--profile', profile, '--model', `local/${localModel}`, '--session-dir', sessions, '--no-extensions', '--no-skills', '--no-rules', '--no-lsp', '--no-pty', '--no-tools', '--no-title', '--thinking', 'off'],
    } })
    const agentId = agent.data?.id
    requireThat(id(agentId) && agent.data.harness === 'omp', 'local OMP agent registration failed')
    const bound = kind === 'expert'
    if (bound) {
      const bind = await call('PATCH', `${channelPath}/agents/${agentId}/prefab`, { prefabId: expert.data.id, revision: 1, slotValues: {} })
      requireThat(bind.data?.prefabBinding?.contentHash === published.data.contentHash, 'local expert was not bound to published revision')
    }
    const pinned = getBinding(ctx.dbPath, agentId)
    check(`${kind}_job_correct_binding_before_dispatch`, bound ? pinned.contentHash === published.data.contentHash : !pinned.prefabId)
    const instruction = bound ? 'Reply with the expert fixture code from your role. Do not guess if absent.' : `Reply with exactly ${defaultNonce}.`
    const task = await call('POST', `${channelPath}/tasks`, { title: `Local ${kind} fixture job`, description: `${instruction} Then call complete_task for this task. Do not call other tools.`, mode: 'goal', modeConfig: { completionPolicy: 'no-deliverable' } })
    const taskId = task.data?.taskId ?? task.data?.id
    requireThat(id(taskId), 'local model task not dispatched')
    const isTerminal = value => /^(COMPLETED|FAILED|CANCELED)$/.test(value?.state ?? '') ? value.state : null
    const realTurns = () => readLocalSession(sessions)
      .filter(msg => msg.role === 'assistant' && msg.provider === 'local' && msg.model === localModel)
    // A small local model plans differently every run (one run waits for a reply that never
    // comes), so completion is recorded rather than required. What must hold is that the
    // member took the job and the model really answered under this binding.
    let firstTurns
    try {
      firstTurns = await poll(`${kind} job produced no model turn`, 90_000, () => realTurns().length || null)
    }
    catch (error) {
      // Keep what the model actually said so a silent job can be explained.
      const snapshot = row(ctx.dbPath, 'SELECT state, progress, retry_count, close_reason, route_reason FROM tasks WHERE id = ?', taskId)
      writeFileSync(join(ctx.evidenceDir, `local-${ctx.target}-${kind}-timeout.json`), `${JSON.stringify({ snapshot, task: task.data, messages: readLocalSession(sessions) }, null, 2)}\n`, 'utf8')
      throw error
    }
    const completed = await poll(`${kind} job terminal`, 45_000, () => isTerminal(row(ctx.dbPath, 'SELECT state FROM tasks WHERE id = ?', taskId))).catch(() => null)
    const taskState = completed ?? row(ctx.dbPath, 'SELECT state FROM tasks WHERE id = ?', taskId)?.state ?? null
    if (!completed) await call('POST', `/api/workshop/tasks/${taskId}/cancel`) // stop a wandering turn before cleanup
    const messages = readLocalSession(sessions).filter(msg => msg.role === 'assistant')
    const nonceInReply = messages.some(msg => msg.text.includes(bound ? expertNonce : defaultNonce))
    writeFileSync(join(ctx.evidenceDir, `local-${ctx.target}-${kind}-session.json`), `${JSON.stringify({ taskState, completed, firstTurns, nonceInReply, messages }, null, 2)}\n`, 'utf8')
    check(`${kind}_job_ran_real_turns_with_local_model`, firstTurns > 0 && messages.length > 0, {}, { taskState, completed, turns: messages.length, toolCalls: messages.flatMap(msg => msg.tools), nonceInReply })
    if (promptDir) {
      // The Prefab exists from the start of this stage; its role text may reach the model
      // only for the member that is bound to it.
      const reached = promptLogHas(expertNonce)
      check(bound ? 'expert_role_prompt_reached_model_request' : 'default_job_requests_carry_no_prefab_prompt', reached === bound, {}, { prefabRoleTextLogged: reached })
    }
  }
}

async function run(target) {
  const result = {
    target, checks: [], ui: flags['l10-only'] ? 'NOT_RUN' : 'BLOCKED', uiBinding: flags['l10-only'] ? 'NOT_RUN' : 'BLOCKED',
    localModel: fixtureLocal ? 'BLOCKED' : (wantsLocal ? 'BLOCKED' : 'NOT_RUN'),
  }
  report.runs.push(result)
  const check = (name, ok, response = {}, detail, continueOnFailure = false) => {
    const item = { name, status: ok ? 'PASS' : 'FAIL', ...(Number.isInteger(response.status) ? { http: response.status } : {}),
      ...(typeof response.code === 'string' && /^[A-Z_\d]{2,60}$/.test(response.code) ? { code: response.code } : {}), ...detail }
    result.checks.push(item)
    console.log(`${target} ${item.status} ${name}`)
    if (!ok && !continueOnFailure) requireThat(ok, name)
  }

  const root = mkdtempSync(join(tmpdir(), 'aw-prefab-'))
  const home = join(root, 'app')
  const userHome = join(root, 'user')
  const dbPath = join(home, 'data', 'workshop.sqlite')
  const cleanups = []
  const own = fn => cleanups.push(fn)
  let ctx = null
  let stage = 'startup'
  const timings = {}
  let stageStarted = Date.now()
  // Stage durations expose a slow cold start instead of hiding it behind a timeout.
  const enter = (next) => {
    timings[stage] = (timings[stage] ?? 0) + Date.now() - stageStarted
    stage = next
    stageStarted = Date.now()
  }
  result.timings = timings
  try {
    mkdirSync(home)
    mkdirSync(userHome)
    const sinks = []
    for (let i = 0; i < 3; i++) {
      const sink = await boundSocket()
      sinks.push(sink)
      own(sink.close)
    }
    const env = ownedEnv(root, home, userHome, sinks)
    ctx = { target, root, home, userHome, dbPath, env, own, evidenceDir: evidence }
    if (target === 'desktop') Object.assign(ctx, await bootDesktop({ browser: await launchBrowser(target, ctx), home }))
    else ctx.base = await bootWeb(ctx)
    if (ctx.page) watchPageErrors(ctx, ctx.page)
    const api = makeApi(ctx.base)
    const setup = await api('GET', '/api/users/setup-status')
    check('fresh_disposable_database_requires_setup', existsSync(dbPath) && setup.data?.needsSetup === true, setup)
    const credentials = { email: `prefab-${hex(6)}@example.invalid`, password: `Aa1!${hex(18)}` }
    const reg = await api('POST', '/api/users/register', { ...credentials, name: 'Prefab acceptance' })
    check('admin_register', reg.status === 200 && reg.data?.user?.role === 'admin' && Boolean(reg.data?.token), reg)
    const call = (method, path, body) => api(method, path, body, reg.data.token)
    enter('l10')
    const core = await coreCoverage(ctx, call, check)
    if (!flags['l10-only']) {
      enter('visible-edit')
      if (!ctx.page) {
        try {
          ctx.page = await (await launchBrowser(target, ctx)).newPage()
          watchPageErrors(ctx, ctx.page)
        }
        catch (error) {
          writeFileSync(join(evidence, `${target}-visible-launch.txt`), `${error?.stack ?? error}\n`.slice(0, 4000), 'utf8')
          throw error
        }
      }
      await visibleEdit(ctx, call, check, credentials, core)
      result.ui = 'PASS'
      result.uiNotes = ctx.uiNotes ?? []
      enter('visible-bind')
      const boundWorkerId = await visibleStep(ctx, 'visible-bind', () => visibleBind(ctx, call, check, core))
      result.uiBinding = 'PASS'
      enter('mock-runtime-jobs')
      // Default operation first, then the member that was just bound through the visible card.
      await mockRuntimeJob(ctx, call, check, core, { label: 'unbound', workerId: await addMockWorker(call, core.channelPath, 'Prefab unbound worker') })
      await mockRuntimeJob(ctx, call, check, core, { label: 'bound', workerId: boundWorkerId, contentHash: core.rev2.contentHash })
      enter('visible-unbind')
      await visibleStep(ctx, 'visible-unbind', () => visibleUnbind(ctx, call, check, core, boundWorkerId))
      enter('mock-runtime-jobs')
      // The same member must take work again with no binding at all.
      await mockRuntimeJob(ctx, call, check, core, { label: 'unbound_after_unbind', workerId: boundWorkerId })
      if (fixtureLocal) result.localModelNote = 'deterministic SSE fixture not run; inference blocked'
      enter('lifecycle')
      await lifecycleCoverage(ctx, call, check, core)
      if (wantsLocal) {
        enter('local-model-preflight')
        const profile = await prepareLocal(ctx)
        enter('local-model-jobs')
        await localJobs(ctx, call, check, profile)
        result.localModel = 'PASS'
      }
    }
    enter('done')
    result.status = 'PASS'
  } catch (error) {
    // Ignore arbitrary subprocess/DOM/model text in evidence. Preserve assertion details above.
    result.status = 'FAIL'
    result.failedStage = stage
    if (stage === 'visible-edit') result.ui = 'FAIL'
    if (stage === 'visible-bind' || stage === 'visible-unbind') result.uiBinding = 'FAIL'
    if (stage === 'local-model-jobs') result.localModel = 'FAIL'
    if (stage === 'local-model-preflight') result.localModel = 'BLOCKED'
    const safe = /^[a-zA-Z0-9 ._/-]{1,160}$/.test(error.message) ? error.message : error.name
    result.error = safe
    console.error(`${target}: ${stage}: ${safe}`)
  } finally {
    let cleaned = true
    for (const cleanup of cleanups.reverse()) {
      try { await cleanup() } catch { cleaned = false }
    }
    if (cleaned) {
      try { rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 250 }) } catch { cleaned = false }
    }
    result.cleanup = cleaned ? 'PASS' : 'FAIL'
    result.pageErrors = ctx?.pageErrors ?? []
    result.visibility = ctx?.visibility ?? null
    result.visibilityAtStart = ctx?.visibilityAtStart ?? []
    result.electronSwitches = ctx?.switches ?? null
    if (!cleaned) result.status = 'FAIL'
  }
}

try {
  requireThat(existsSync(build), 'existing trusted build not found')
  report.bundleEntry = { sha256: hash(readFileSync(build)), sourceEquivalenceVerified: false }
  for (const target of targets) await run(target)
  report.status = report.runs.every(run => run.status === 'PASS') ? 'PASS' : 'FAIL'
} catch (error) {
  report.status = 'FAIL'
  report.error = error.message
} finally {
  report.finishedAt = new Date().toISOString()
  const checks = report.runs.flatMap(run => run.checks)
  report.summary = { total: checks.length, pass: checks.filter(c => c.status === 'PASS').length, fail: checks.filter(c => c.status === 'FAIL').length }
  writeFileSync(join(evidence, 'result.json'), `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' })
  console.log(`RESULT ${JSON.stringify({ status: report.status, ...report.summary })}`)
  if (report.status !== 'PASS') process.exitCode = 1
}
