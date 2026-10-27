#!/usr/bin/env node
/**
 * Isolated direct-REST route evaluation for AgentWorkShop's recipe_trial flow.
 * Runs one approved, bounded candidate per simulator scene through
 * POST /api/workshop/agent-tools/invoke. A non-scheduled worker identity is
 * used only to provide the platform's agent-scoped permission context; no
 * registered harness transport or LLM decision is used.
 */
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { closeSync, copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { resolveRunMode } from '../shared/config/home.mjs'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const VERSION = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')).version
const PORTS = { app: 3997, sim: 4020, mqtt: 18840, appMqtt: 45323, tsdb: 45321, objectstore: 45322, forbidden: 4010 }
const APP_BASE = `http://127.0.0.1:${PORTS.app}`
const SIM_BASE = `http://127.0.0.1:${PORTS.sim}`
const SIM_SOURCE = join(REPO, 'plc-node-simulator')
const NUXT_CLI = join(REPO, 'node_modules', 'nuxt', 'bin', 'nuxt.mjs')
const OUTPUT_ROOT = join(REPO, 'docs', 'audit', 'evidence', '2026-10-25-current-cross-scene', 'direct-rest-trial-2026-10-25')
mkdirSync(OUTPUT_ROOT, { recursive: true })
const OUTPUT = mkdtempSync(join(OUTPUT_ROOT, 'run-'))
const TAG = `drt${Date.now().toString(36)}`
mkdirSync(join(REPO, '.omc'), { recursive: true })
const ROOT = mkdtempSync(join(REPO, '.omc', 'direct-rest-paper-'))
const HOME = join(ROOT, 'aw-home')
const SIM_ROOT = join(ROOT, 'simulator')
const EMPTY_DOTENV = join(HOME, 'empty.env')
const APP_LOG = join(OUTPUT, 'agentworkshop.log')
const SIM_LOG = join(OUTPUT, 'simulator.log')
const appLogFd = openSync(APP_LOG, 'a')
const simLogFd = openSync(SIM_LOG, 'a')
const CHILD_OS_ENV_KEYS = process.platform === 'win32'
  ? ['PATH', 'PATHEXT', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'HOMEDRIVE', 'HOMEPATH', 'ProgramData']
  : ['PATH', 'HOME', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL']
const children = new Set()
const allocatedDevicePorts = []
const evidence = {
  schemaVersion: 1,
  experiment: {
    id: TAG,
    name: 'direct-REST recipe_trial route coverage',
    projectVersion: VERSION,
    route: 'POST /api/workshop/agent-tools/invoke',
    executionMode: 'direct HTTP invocation; worker identity supplies agent scope, with no harness transport or LLM decision',
    startedAt: new Date().toISOString(),
    postTrialSnapshotDelaySeconds: 20,
    scenes: [],
  },
  isolation: { result: 'pending', appBase: APP_BASE, simulatorBase: SIM_BASE, awHome: 'fresh isolated home mode', loopbackOnly: true, checks: [] },
  checks: [],
  status: 'running',
}

let appProcess
let simProcess
let authToken
let syntheticAdminId
let stage = 'preflight'
let sceneId = null

function check(id, pass, detail = {}) {
  evidence.checks.push({ id, status: pass ? 'pass' : 'fail', detail })
  if (!pass) throw new Error(`check failed: ${id}`)
}
function isolationCheck(id, pass, detail = {}) {
  evidence.isolation.checks.push({ id, status: pass ? 'pass' : 'fail', detail })
  if (!pass) throw new Error(`isolation check failed: ${id}`)
}
function safeText(value, limit = 600) {
  let text = String(value ?? '')
  if (authToken) text = text.split(authToken).join('[REDACTED]')
  text = text.replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer [REDACTED]')
    .replace(/\b(?:api[_-]?key|access[_-]?token|client[_-]?secret|password|secret)\s*[:=]\s*["']?[^\s,"'}]+/gi, '[REDACTED_CREDENTIAL]')
  return text.slice(0, limit)
}
function parsePayload(body) {
  return body && typeof body === 'object' && Object.hasOwn(body, 'data') ? body.data : body
}
function assertLoopback(base, port) {
  const url = new URL(base)
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || Number(url.port) !== port || port === PORTS.forbidden) {
    throw new Error('network boundary rejected a non-approved endpoint')
  }
}
async function freePort(port, label) {
  if (!Number.isInteger(port) || port < 1024 || port > 65535 || port === PORTS.forbidden) throw new Error(`invalid port for ${label}`)
  const server = createServer()
  await new Promise((resolvePromise, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', resolvePromise)
  })
  await new Promise(resolvePromise => server.close(resolvePromise))
}
async function preflight() {
  if (typeof VERSION !== 'string' || VERSION.length === 0) throw new Error('package manifest does not define a version')
  if (!existsSync(join(SIM_SOURCE, 'src', 'server', 'index.ts')) || !existsSync(join(SIM_SOURCE, 'node_modules')) || !existsSync(NUXT_CLI)) {
    throw new Error('local simulator source/runtime or Nuxt CLI is missing')
  }
  if (resolveRunMode({ cwd: REPO, packageRoot: REPO, env: { AW_HOME: HOME, AW_MODE: 'home' } }).mode !== 'home') throw new Error('fresh AW_HOME did not resolve to home mode')
  for (const [name, port] of Object.entries(PORTS)) {
    if (name === 'forbidden') continue
    await freePort(port, name)
    isolationCheck(`free-loopback-${name}-port`, true, { host: '127.0.0.1', port })
  }
  if (PORTS.app === PORTS.forbidden || PORTS.sim === PORTS.forbidden || PORTS.mqtt === PORTS.forbidden) throw new Error('forbidden service port configured')
  isolationCheck('local-inputs-only', true, { version: VERSION, simulatorSource: true, simulatorRuntime: true, noExternalArchiveOrLLM: true })
}
function childEnv(extra = {}) {
  const env = {}
  for (const key of CHILD_OS_ENV_KEYS) if (process.env[key] !== undefined) env[key] = process.env[key]
  Object.assign(env, {
    AW_HOME: HOME,
    AW_MODE: 'home',
    AW_PROMPTS_DIR: join(HOME, 'prompts'),
    NUXT_SESSION_PASSWORD: 'paper-isolated-session-secret-not-for-evidence',
    NO_PROXY: '127.0.0.1,localhost',
    no_proxy: '127.0.0.1,localhost',
  })
  Object.assign(env, extra)
  return env
}
function spawnLogged(command, args, { cwd = REPO, env = childEnv(), logFd, label }) {
  const child = spawn(command, args, { cwd, env, stdio: ['ignore', logFd, logFd], windowsHide: true, detached: process.platform !== 'win32' })
  child.label = label
  children.add(child)
  child.once('exit', () => children.delete(child))
  child.once('error', () => children.delete(child))
  return child
}
async function waitExit(child, ms = 8000) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  await Promise.race([new Promise(resolvePromise => child.once('exit', resolvePromise)), delay(ms)])
}
function processGroupExists(pid) {
  try {
    process.kill(-pid, 0)
    return true
  }
  catch (error) {
    if (error?.code === 'ESRCH') return false
    if (error?.code === 'EPERM') return true
    throw error
  }
}
function windowsProcessExists(pid) {
  const result = spawnSync('tasklist.exe', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], env: childEnv() })
  if (result.error || result.status !== 0) return null
  return (result.stdout ?? '').split(/\r?\n/).some(line => line.match(/^"(?:[^"]|"")*","(\d+)"(?:,|$)/)?.[1] === String(pid))
}
async function stopTree(child, label) {
  if (!child?.pid) return false
  try {
    if (process.platform === 'win32') spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', env: childEnv() })
    else process.kill(-child.pid, 'SIGTERM')
  }
  catch { /* process may already have exited */ }
  await waitExit(child)
  if (process.platform !== 'win32' && processGroupExists(child.pid)) {
    try {
      process.kill(-child.pid, 'SIGKILL')
    }
    catch { /* process may already have exited */ }
  }
  else if (process.platform === 'win32' && windowsProcessExists(child.pid) === true) {
    spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', env: childEnv() })
  }
  await waitExit(child, 2000)
  let gone
  if (process.platform === 'win32') gone = windowsProcessExists(child.pid) === false
  else {
    const deadline = Date.now() + 3000
    do {
      gone = !processGroupExists(child.pid)
      if (gone) break
      await delay(100)
    } while (Date.now() < deadline)
  }
  evidence.checks.push({ id: `${label}-stopped`, status: gone ? 'pass' : 'fail', detail: { pid: child.pid, treeStopped: gone } })
  return gone
}
function configureHome() {
  mkdirSync(join(HOME, 'data'), { recursive: true })
  copyFileSync(join(REPO, 'config.yml'), join(HOME, 'config.yml'))
  writeFileSync(join(HOME, 'runtime-settings.json'), JSON.stringify({ version: 1, updatedAt: new Date().toISOString(), overrides: {
    'daq.startInfrastructure': 'never',
    'daq.mqtt.host': '127.0.0.1', 'daq.mqtt.port': PORTS.appMqtt,
    'daq.timescale.host': '127.0.0.1', 'daq.timescale.port': PORTS.tsdb,
    'daq.objectstore.host': '127.0.0.1', 'daq.objectstore.port': PORTS.objectstore,
    'plugins.rag-bridge.base_url': 'http://paper-direct-rest-outbound-disabled.invalid',
  } }, null, 2) + '\n')
  const kvDir = join(HOME, 'data', 'plugins', 'rag-bridge')
  mkdirSync(kvDir, { recursive: true })
  writeFileSync(join(kvDir, 'kv.json'), JSON.stringify({ 'kb.base_url': 'http://paper-direct-rest-outbound-disabled.invalid' }, null, 2) + '\n')
  cpSync(join(REPO, '.AgentWorkShop', 'prompts'), join(HOME, 'prompts'), { recursive: true })
  writeFileSync(join(HOME, 'empty.env'), '')
  const builtin = pluginNames(join(REPO, 'server', 'plugins-builtin'))
  const project = pluginNames(join(REPO, '.AgentWorkShop', 'plugins'))
  const users = pluginNames(join(HOME, 'plugins'))
  const all = [...new Set([...builtin, ...project, ...users])].sort()
  const disabled = all.filter(name => name !== 'rag-bridge')
  writeFileSync(join(HOME, 'plugins-state.json'), JSON.stringify({ version: 1, updatedAt: new Date().toISOString(), disabled }, null, 2) + '\n')
  isolationCheck('isolated-home-settings', true, { homeMode: true, infrastructure: 'never', offlineServices: 'loopback only', promptAssetsCopied: true, pluginsDisabledExcept: 'outbound-disabled rag-bridge' })
}
function pluginNames(root) {
  if (!existsSync(root)) return []
  return readdirSync(root, { withFileTypes: true }).filter(entry => entry.isDirectory() && existsSync(join(root, entry.name, 'index.mjs'))).map(entry => entry.name).sort()
}
async function request(base, port, method, path, body, { token, timeoutMs = 10000, noTimeout = false } = {}) {
  assertLoopback(base, port)
  if (!path.startsWith('/api/')) throw new Error('API path boundary rejected')
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(token ? { authorization: `Bearer ${token}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    ...(noTimeout ? {} : { signal: AbortSignal.timeout(timeoutMs) }),
  })
  const parsed = await response.json().catch(() => null)
  return { status: response.status, body: parsed, data: parsePayload(parsed) }
}
const app = (method, path, body, opts = {}) => request(APP_BASE, PORTS.app, method, path, body, { token: opts.token === undefined ? authToken : opts.token, timeoutMs: opts.timeoutMs, noTimeout: opts.noTimeout })
const sim = (method, path, body) => request(SIM_BASE, PORTS.sim, method, path, body, { timeoutMs: 8000 })
function success(result, label, expected = 200) {
  if (result.status !== expected) throw new Error(`${label} returned HTTP ${result.status}: ${safeText(result.body?.message ?? result.body?.statusMessage ?? 'no response detail')}`)
  return result.data
}
async function bootSimulator() {
  mkdirSync(SIM_ROOT, { recursive: true })
  cpSync(join(SIM_SOURCE, 'src'), join(SIM_ROOT, 'src'), { recursive: true })
  copyFileSync(join(SIM_SOURCE, 'package.json'), join(SIM_ROOT, 'package.json'))
  const entry = join(SIM_ROOT, 'src', 'server', 'index.ts')
  const source = readFileSync(entry, 'utf8')
  const listenCall = 'server.listen(PORT, () => resolve())'
  const brokerCall = 'await startBroker(Number(process.env.MQTT_BROKER_PORT ?? 18830))'
  if (source.split(listenCall).length !== 2 || source.split(brokerCall).length !== 2) throw new Error('simulator source does not match the known loopback-isolation patch points')
  const patched = source.replace(listenCall, `server.listen(PORT, '127.0.0.1', () => {\n    const a = server.address()\n    if (!a || typeof a === 'string' || a.address !== '127.0.0.1' || a.port !== PORT) process.exit(70)\n    console.log('[direct-paper-isolation] listener=' + a.address + ':' + a.port)\n    resolve()\n  })`).replace(brokerCall, `await startBroker(Number(process.env.MQTT_BROKER_PORT ?? 18830), '127.0.0.1')`)
  writeFileSync(entry, patched)
  symlinkSync(join(SIM_SOURCE, 'node_modules'), join(SIM_ROOT, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir')
  simProcess = spawnLogged(process.execPath, [join(REPO, 'node_modules', 'tsx', 'dist', 'cli.mjs'), entry], { cwd: SIM_ROOT, env: childEnv({ SIM_PORT: String(PORTS.sim), MQTT_BROKER_PORT: String(PORTS.mqtt) }), logFd: simLogFd, label: 'simulator' })
  for (let i = 0; i < 50; i++) {
    try {
      const result = await sim('GET', '/api/nodes')
      if (result.status === 200) {
        const log = readFileSync(SIM_LOG, 'utf8')
        if (!log.includes(`[direct-paper-isolation] listener=127.0.0.1:${PORTS.sim}`) || !log.includes(`mqtt://127.0.0.1:${PORTS.mqtt}`)) throw new Error('simulator listener or broker was not verified as loopback-only')
        isolationCheck('simulator-http-and-mqtt-loopback', true, { http: APP_BASE.replace(String(PORTS.app), String(PORTS.sim)), mqtt: `127.0.0.1:${PORTS.mqtt}` })
        return
      }
    }
    catch (error) { if (String(error.message).includes('not verified')) throw error }
    await delay(400)
  }
  throw new Error('simulator startup timed out')
}
async function startApplication() {
  appProcess = spawnLogged(process.execPath, [NUXT_CLI, 'dev', '--host', '127.0.0.1', '--port', String(PORTS.app), '--dotenv', EMPTY_DOTENV], { cwd: REPO, env: childEnv(), logFd: appLogFd, label: 'agentworkshop' })
  for (let i = 0; i < 90; i++) {
    try {
      const result = await app('GET', '/api/health', undefined, { token: undefined, timeoutMs: 2000 })
      if (result.status === 200 && result.data?.status === 'ok' && result.data?.workshop === 'ready' && result.data?.version === VERSION) {
        isolationCheck('application-loopback-ready', true, { version: result.data.version, host: '127.0.0.1', port: PORTS.app })
        return result.data
      }
    }
    catch { /* startup in progress */ }
    await delay(500)
  }
  throw new Error('AgentWorkShop did not become ready')
}
function normalizeConfig(value, portMap, key = '') {
  if (Array.isArray(value)) return value.map(item => normalizeConfig(item, portMap, key))
  if (!value || typeof value !== 'object') {
    if (typeof value !== 'string') return value
    if (/^[a-z][a-z\d+.-]*:\/\//i.test(value)) {
      const parsed = new URL(value)
      if (!['127.0.0.1', 'localhost', '::1'].includes(parsed.hostname)) throw new Error('preset includes a non-loopback device URL')
      if (parsed.port && portMap.has(Number(parsed.port))) parsed.port = String(portMap.get(Number(parsed.port)))
      parsed.hostname = '127.0.0.1'
      return parsed.toString()
    }
    if (/(?:host|hostname|ip|address)$/i.test(key)) return '127.0.0.1'
    return value
  }
  const out = {}
  for (const [childKey, childValue] of Object.entries(value)) {
    if (/^port$/i.test(childKey) && Number.isInteger(childValue) && portMap.has(childValue)) out[childKey] = portMap.get(childValue)
    else if (/(?:host|hostname|ip|address)$/i.test(childKey) && typeof childValue === 'string') out[childKey] = '127.0.0.1'
    else out[childKey] = normalizeConfig(childValue, portMap, childKey)
  }
  return out
}
async function loadScene(scene, index) {
  const preset = success(await sim('GET', `/api/presets/${encodeURIComponent(scene.preset)}`), `${scene.id} simulator preset`)
  if (!preset?.plantModel || !Array.isArray(preset.nodes)) throw new Error(`${scene.id} simulator preset is malformed`)
  let nextPort = 44400 + index * 100
  const portMapByDeviceId = new Map()
  const nodes = []
  for (const raw of preset.nodes) {
    const node = structuredClone(raw)
    if ((node.protocol && /serial|rtu/i.test(String(node.protocol))) || /serialPort|comPort|devicePath/i.test(JSON.stringify(node.config ?? {}))) continue
    node.config ||= {}
    const oldPort = Number(node.config.port)
    const portMap = new Map()
    if (Number.isInteger(oldPort) && oldPort > 0) {
      while (allocatedDevicePorts.includes(nextPort) || nextPort === PORTS.forbidden) nextPort++
      await freePort(nextPort, `${scene.id}-device`)
      portMap.set(oldPort, nextPort)
      allocatedDevicePorts.push(nextPort)
      node.config.port = nextPort++
    }
    node.config = normalizeConfig(node.config, portMap)
    if (/mqtt/i.test(String(node.protocol))) node.config.brokerUrl = `mqtt://127.0.0.1:${PORTS.mqtt}`
    portMapByDeviceId.set(node.id, portMap)
    nodes.push(node)
  }
  if (!nodes.length) throw new Error(`${scene.id} preset has no supported devices`)
  for (const node of nodes) success(await sim('POST', '/api/nodes', node), `${scene.id} create simulator device`)
  const plant = { ...preset.plantModel, id: `${TAG}-${scene.id}`, seed: 42, timeScale: 1, truthExport: false }
  success(await sim('PUT', '/api/plant/config', { plantModel: plant, warm: true, upsert: true }), `${scene.id} load plant`)
  const exports = []
  for (const node of nodes) {
    const data = success(await sim('GET', `/api/nodes/${encodeURIComponent(node.id)}/export`), `${scene.id} export ${node.id}`)
    for (const item of data?.items ?? []) exports.push({ ...item, deviceId: node.id })
  }
  for (const item of exports) item.driverConfig = normalizeConfig(item.driverConfig ?? {}, portMapByDeviceId.get(item.deviceId) ?? new Map())
  const mv = exports.find(item => item.deviceId === scene.sourceDevice && item.signal === scene.mvSignal)
  const cv = exports.find(item => item.signal === scene.cvSignal)
  if (!mv || !cv || !['opcua', 'modbus-tcp'].includes(String(mv.driver))) throw new Error(`${scene.id} required signals or approved MV protocol missing`)
  return { mv, cv, plant: { id: plant.id, kind: plant.kind ?? 'simulator', seed: 42, timeScale: 1 }, deviceCount: nodes.length }
}
async function setupScene(scene, simulator) {
  const line = success(await app('POST', '/api/workshop/dcw/lines', { name: `${TAG}-${scene.id}`, description: 'Synthetic isolated direct-REST simulator experiment', simulated: true, simSceneId: scene.preset, controlMode: 'manual' }), `${scene.id} line`).line
  const product = success(await app('POST', '/api/workshop/dcw/products', { name: `${TAG}-${scene.id}-product`, lineId: line.id }), `${scene.id} product`).product
  const template = success(await app('POST', '/api/workshop/dcw/templates', { name: `${TAG}-${scene.id}-control-template`, unit: simulator.mv.unit, min: simulator.mv.min, max: simulator.mv.max, decimals: simulator.mv.decimals ?? 0 }), `${scene.id} template`).template
  const control = success(await app('POST', '/api/workshop/dcw', { templateRef: template.key, name: `${TAG}-${scene.id}-control`, driver: simulator.mv.driver, driverConfig: simulator.mv.driverConfig, lineId: line.id, min: simulator.mv.min, max: simulator.mv.max, unit: simulator.mv.unit, decimals: simulator.mv.decimals ?? 0, stepLimit: 30, writeLockSeconds: 0, holdIntervalMs: 0, readIntervalMs: 500, semantics: `Bounded simulated ${scene.mvSignal} setpoint` }), `${scene.id} control node`).node
  const daq = success(await app('POST', '/api/workshop/daq', { templateRef: 'daq-temp-tc', name: `${TAG}-${scene.id}-daq-cv`, driver: simulator.cv.driver, driverConfig: simulator.cv.driverConfig, lineId: line.id, min: simulator.cv.min, max: simulator.cv.max, unit: simulator.cv.unit, intervalMs: 1000, publishIntervalMs: 0, semantics: `Bounded simulated ${scene.cvSignal} sample` }), `${scene.id} DAQ node`).node
  const recipe = success(await app('POST', '/api/workshop/dcw/recipes', { name: `${TAG}-${scene.id}-recipe`, productId: product.id, params: [{ nodeId: control.id, templateRef: template.key, value: scene.baseline, min: simulator.mv.min, max: simulator.mv.max, stepLimit: 30 }], daqWindows: [{ nodeId: daq.id, min: simulator.cv.min, max: simulator.cv.max }] }), `${scene.id} recipe`).recipe
  const start = success(await app('POST', `/api/workshop/dcw/lines/${encodeURIComponent(line.id)}/start`, { recipeId: recipe.id }), `${scene.id} start line`)
  const activeRunId = String(start.run?.id ?? '')
  if (!activeRunId) throw new Error(`${scene.id} start response did not include run ID`)
  const channel = success(await app('POST', '/api/workshop/channels', { name: `${TAG}-${scene.id}-direct-route`, description: 'Direct REST route test; no registered harness launched' }), `${scene.id} channel`)
  const agent = success(await app('POST', `/api/workshop/channels/${encodeURIComponent(channel.channelId)}/agents`, { name: `${TAG}-${scene.id}-direct-agent`, harness: 'omp', role: 'worker', config: { command: process.execPath, cwd: HOME, args: ['--version'], rpcMode: 'rpc' } }), `${scene.id} worker identity`)
  const recipeBinding = success(await app('POST', '/api/workshop/agent-tools/bindings', { agentId: agent.id, nodeId: recipe.id, kind: 'recipe' }), `${scene.id} recipe binding`).binding
  const daqBinding = success(await app('POST', '/api/workshop/agent-tools/bindings', { agentId: agent.id, nodeId: daq.id, kind: 'daq', mode: 'auto' }), `${scene.id} DAQ binding`).binding
  if (recipeBinding.mode !== 'manual' || daqBinding.kind !== 'daq') throw new Error(`${scene.id} route binding did not match manual recipe + DAQ observation policy`)
  const candidate = scene.candidate
  if (!Number.isFinite(candidate) || candidate < Number(simulator.mv.min) || candidate > Number(simulator.mv.max) || Math.abs(candidate - scene.baseline) > 30) throw new Error(`${scene.id} candidate violates exported limits or step bound`)
  return { line, product, template, control, daq, recipe, channel, agent, activeRunId, candidate, simulator }
}
async function approveDirectInvocation(ctx, invocationPromise) {
  const deadline = Date.now() + 30000
  let approval
  while (Date.now() < deadline) {
    const result = await app('GET', `/api/workshop/agent-tools/approvals?agentId=${encodeURIComponent(ctx.agent.id)}&scope=pending`)
    if (result.status === 200) {
      const matches = (result.data?.approvals ?? []).filter(item => item.agentId === ctx.agent.id && item.nodeId === `recipe:${ctx.recipe.id}` && item.status === 'pending')
      if (matches.length > 1) throw new Error(`${ctx.scene.id} invocation produced multiple pending recipe approvals`)
      if (matches.length === 1) {
        approval = matches[0]
        break
      }
    }
    if (invocationPromise.settled) throw new Error(`${ctx.scene.id} direct REST invocation settled before an approval was observed`)
    await delay(300)
  }
  if (!approval) throw new Error(`${ctx.scene.id} direct REST recipe_trial approval was not observed within 30 seconds`)
  ctx.evidence.approval = { id: approval.id, nodeId: approval.nodeId, statusBeforeDecision: approval.status, title: safeText(approval.title, 300), decision: 'approved by synthetic isolated administrator' }
  const decision = await app('POST', `/api/workshop/agent-tools/approvals/${encodeURIComponent(approval.id)}/decide`, { approved: true, comment: 'Approved for one bounded direct-REST local simulator check.' })
  success(decision, `${ctx.scene.id} approve pending recipe trial`)
  const history = success(await app('GET', `/api/workshop/agent-tools/approvals?agentId=${encodeURIComponent(ctx.agent.id)}&scope=history`), `${ctx.scene.id} approval history`)
  const finalApproval = (history.approvals ?? []).find(item => item.id === approval.id)
  if (!finalApproval || finalApproval.status !== 'approved') throw new Error(`${ctx.scene.id} approval history did not confirm approval`)
  ctx.evidence.approval.statusAfterDecision = finalApproval.status
  ctx.evidence.approval.syntheticDecisionActor = 'first administrator in fresh isolated AW_HOME'
}
async function collectEvidence(ctx, invocation) {
  const responseData = invocation.data
  const toolResult = responseData?.result
  const toolText = String(toolResult?.text ?? toolResult?.content?.[0]?.text ?? '')
  const isError = toolResult?.isError === true
  check(`${ctx.scene.id}-direct-rest-http-success`, invocation.status === 200, { status: invocation.status, endpoint: '/api/workshop/agent-tools/invoke' })
  check(`${ctx.scene.id}-tool-result-success`, Boolean(toolResult) && !isError && /全部设备证实/.test(toolText), { present: Boolean(toolResult), isError, text: safeText(toolText, 800) })
  ctx.evidence.invocation.httpStatus = invocation.status
  ctx.evidence.invocation.toolResult = { present: Boolean(toolResult), isError, text: safeText(toolText, 1000) }

  const readback = success(await app('POST', `/api/workshop/dcw/${encodeURIComponent(ctx.control.id)}/read`), `${ctx.scene.id} DCW readback`)
  const read = readback?.outcome ?? readback?.read ?? readback
  const readValue = Number(read?.value ?? read?.data?.value)
  check(`${ctx.scene.id}-candidate-readback`, Number.isFinite(readValue) && Math.abs(readValue - ctx.candidate) <= 0.01, { candidate: ctx.candidate, observed: Number.isFinite(readValue) ? readValue : null })

  const logResponse = success(await app('GET', `/api/workshop/ops-logs?scope=line&lineId=${encodeURIComponent(ctx.line.id)}&recipeId=${encodeURIComponent(ctx.recipe.id)}&limit=100`), `${ctx.scene.id} operation logs`)
  const recipeRows = (logResponse?.logs ?? []).filter(row => String(row.action).startsWith('recipe.')).map((row) => {
    let detail = row.detail
    if (!detail || typeof detail !== 'object' || Array.isArray(detail)) {
      try {
        detail = JSON.parse(String(row.detailJson ?? '{}'))
      }
      catch { detail = {} }
    }
    return { ...row, detail }
  })
  const trialRows = recipeRows.filter(row => row.action === 'recipe.trial')
  const ackRows = recipeRows.filter(row => row.action === 'recipe.dispatch.ack' && row.detail?.trial === true)
  const trialRunId = String(ackRows[0]?.detail?.runId ?? '')
  if (trialRows.length !== 1 || ackRows.length !== 1 || !trialRunId || String(trialRows[0]?.detail?.runId ?? '') !== trialRunId) throw new Error(`${ctx.scene.id} did not produce exactly one linked recipe.trial + ACK record`)
  const trialRun = success(await app('GET', `/api/workshop/dcw/runs/${encodeURIComponent(trialRunId)}/data`), `${ctx.scene.id} trial run data`)
  const run = trialRun?.run
  const resultRow = run?.results?.[0]
  const ack = ackRows[0].detail?.ackSummary
  if (run?.id !== trialRunId || run?.results?.length !== 1 || resultRow?.ok !== true || resultRow?.verify?.verdict !== 'verified' || ack?.total !== 1 || ack?.verified !== 1 || ack?.unverified !== 0 || ack?.failed !== 0) {
    throw new Error(`${ctx.scene.id} trial receipt or ACK was not independently verified`)
  }
  ctx.evidence.trial = { runId: trialRunId, linkedTrialAckRows: true, ackSummary: ack, result: resultRow }
  ctx.evidence.readback = { expected: ctx.candidate, observed: readValue, matches: true }
  ctx.evidence.recipeRecords = { trialCount: trialRows.length, trialAckCount: ackRows.length, trialRunId }

  const activeRunData = success(await app('GET', `/api/workshop/dcw/runs/${encodeURIComponent(ctx.activeRunId)}/data`), `${ctx.scene.id} active run data`)
  const waitStartedAt = new Date().toISOString()
  await delay(20000)
  const probeStartedAt = new Date().toISOString()
  const probeResponse = success(await app('POST', `/api/workshop/daq/${encodeURIComponent(ctx.daq.id)}/test`), `${ctx.scene.id} DAQ driver probe`)
  const probe = probeResponse?.test
  const sampleValue = Number(probe?.sampleValue)
  if (probe?.ok !== true || !Number.isFinite(sampleValue)) throw new Error(`${ctx.scene.id} DAQ probe returned no finite sample`)
  const ingestedAt = new Date().toISOString()
  const ingest = success(await app('POST', `/api/workshop/daq/${encodeURIComponent(ctx.daq.id)}/ingest`, { at: ingestedAt, value: sampleValue, state: 'ok' }), `${ctx.scene.id} DAQ snapshot ingest`)
  if (ingest?.accepted !== true || ingest.nodeId !== ctx.daq.id || ingest.lineId !== ctx.line.id) throw new Error(`${ctx.scene.id} DAQ snapshot was not accepted by the expected node and line`)
  await delay(800)
  const atMs = Date.parse(String(ingest.at ?? ingestedAt))
  let taggedQuery
  let point
  const queryDeadline = Date.now() + 12000
  while (Date.now() < queryDeadline) {
    const query = await app('GET', `/api/workshop/daq/query?line_id=${encodeURIComponent(ctx.line.id)}&node_ids=${encodeURIComponent(ctx.daq.id)}&run_id=${encodeURIComponent(ctx.activeRunId)}&from=${atMs}&to=${atMs + 1}&bucket_ms=1000`)
    if (query.status === 200) {
      const series = query.data?.series?.find(row => row.nodeId === ctx.daq.id)
      const bucketMs = Number(query.data?.window?.bucketMs) || 1000
      const bucketAt = Math.floor(atMs / bucketMs) * bucketMs
      point = series?.points?.find(row => Number(row.at) === bucketAt && Math.abs(Number(row.v) - sampleValue) <= 0.01)
      if (point && query.data?.activeRun?.runId === ctx.activeRunId) {
        taggedQuery = query.data
        break
      }
    }
    await delay(300)
  }
  if (!taggedQuery || !point) throw new Error(`${ctx.scene.id} DAQ readback was not linked to its active run`)
  const target = { min: ctx.scene.targetMin, max: ctx.scene.targetMax }
  ctx.evidence.observation = {
    method: 'one driver probe, accepted into the isolated time-series store, then queried by active run ID',
    postTrialDelaySeconds: 20,
    waitStartedAt,
    probeStartedAt,
    probeCompletedAt: new Date().toISOString(),
    driver: ctx.daq.driver,
    value: sampleValue,
    unit: ctx.simulator.cv.unit,
    targetBand: target,
    withinTargetBand: sampleValue >= target.min && sampleValue <= target.max,
    acceptedIngest: true,
    queryRunId: taggedQuery.activeRun?.runId,
    matchingPoint: point,
  }
  ctx.evidence.activeRunDataKeys = Object.keys(activeRunData ?? {})
  ctx.evidence.status = 'verified'
  const stopped = success(await app('POST', `/api/workshop/dcw/lines/${encodeURIComponent(ctx.line.id)}/stop`), `${ctx.scene.id} stop line`)
  ctx.evidence.activeRun.endedAt = stopped?.run?.endedAt ?? null
}
async function runScene(scene, index) {
  stage = `${scene.id}:simulator-setup`
  sceneId = scene.id
  const simulator = await loadScene(scene, index)
  stage = `${scene.id}:application-setup`
  const ctx = await setupScene(scene, simulator)
  ctx.scene = scene
  ctx.evidence = {
    id: scene.id,
    status: 'running',
    preset: scene.preset,
    process: scene.process,
    entities: { lineId: ctx.line.id, productId: ctx.product.id, recipeId: ctx.recipe.id, controlNodeId: ctx.control.id, daqNodeId: ctx.daq.id, channelId: ctx.channel.channelId, agentId: ctx.agent.id },
    bindings: { recipe: 'manual', daq: 'auto' },
    protocolMapping: { manipulationDevice: ctx.simulator.mv.deviceId, manipulationSignal: ctx.simulator.mv.signal, manipulationProtocol: ctx.simulator.mv.driver, observationDevice: ctx.simulator.cv.deviceId, observationSignal: ctx.simulator.cv.signal, observationProtocol: ctx.simulator.cv.driver, candidate: ctx.candidate, baseline: scene.baseline },
    activeRun: { id: ctx.activeRunId, recipeId: ctx.recipe.id },
    invocation: {
      endpoint: '/api/workshop/agent-tools/invoke',
      method: 'POST',
      auth: 'synthetic administrator bearer; secret omitted',
      body: { agentId: ctx.agent.id, tool: 'recipe_trial', args: { recipe_id: ctx.recipe.id, params: [{ node_id: ctx.control.id, value: ctx.candidate }], hypothesis: `Bounded single-candidate direct-route check for ${scene.id} simulator mapping.` } },
      retryCount: 0,
    },
  }
  evidence.experiment.scenes.push(ctx.evidence)
  stage = `${scene.id}:direct-rest-invocation`
  const invokePromise = app('POST', '/api/workshop/agent-tools/invoke', ctx.evidence.invocation.body, { noTimeout: true })
  invokePromise.settled = false
  const markSettled = invokePromise.then(
    () => { invokePromise.settled = true },
    () => { invokePromise.settled = true },
  )
  ctx.evidence.invocation.startedAt = new Date().toISOString()
  await approveDirectInvocation(ctx, invokePromise)
  stage = `${scene.id}:direct-rest-result-and-snapshot`
  const timeout = delay(45000).then(() => {
    throw new Error(`${scene.id} direct invocation did not return within 45 seconds after approval`)
  })
  const invocation = await Promise.race([invokePromise, timeout])
  await markSettled
  ctx.evidence.invocation.completedAt = new Date().toISOString()
  await collectEvidence(ctx, invocation)
}
async function main() {
  mkdirSync(join(REPO, '.omc'), { recursive: true })
  await preflight()
  mkdirSync(join(HOME, 'data'), { recursive: true })
  configureHome()
  stage = 'simulator-startup'
  await bootSimulator()
  stage = 'application-startup'
  const health = await startApplication()
  evidence.experiment.server = { version: health.version, mode: health.mode, workshop: health.workshop }
  const first = await app('POST', '/api/users/register', { name: `Paper Direct ${TAG}`, email: `${TAG}@example.invalid`, password: `Paper-${Date.now()}-safe9` }, { token: undefined })
  const admin = success(first, 'synthetic administrator registration')
  if (!admin?.token || admin?.user?.role !== 'admin') throw new Error('fresh isolated home did not create its first administrator')
  authToken = String(admin.token)
  syntheticAdminId = String(admin.user.id)
  evidence.experiment.syntheticAdmin = { id: syntheticAdminId, role: admin.user.role, source: 'first registration in fresh isolated AW_HOME' }
  const plugins = success(await app('GET', '/api/workshop/plugins'), 'plugin isolation manifest')
  const enabled = (plugins.plugins ?? []).filter(plugin => plugin.enabled).map(plugin => plugin.name).sort()
  if (enabled.join(',') !== 'rag-bridge') throw new Error(`isolated plugin allowlist mismatch: ${enabled.join(',')}`)
  isolationCheck('only-outbound-disabled-rag-bridge-enabled', true, { enabled, outboundGuard: 'invalid non-routable host configured' })
  const bridgeHealth = success(await app('GET', '/api/plugins/rag-bridge/health'), 'outbound plugin guard')
  if (bridgeHealth.outbound !== false) throw new Error('rag-bridge outbound calls are not disabled')
  isolationCheck('external-rag-outbound-disabled', true, { outbound: bridgeHealth.outbound })
  const daqStatus = success(await app('GET', '/api/workshop/daq', undefined, { timeoutMs: 45000 }), 'DAQ isolated backend status')
  if (daqStatus.meta?.queue !== 'inproc' || daqStatus.meta?.tsdb !== 'sqlite-emulated') throw new Error('DAQ did not use isolated in-process queue and SQLite fallback')
  check('isolated-daq-backends', true, { queue: daqStatus.meta.queue, tsdb: daqStatus.meta.tsdb })
  evidence.isolation.result = 'passed'
  evidence.experiment.sourceIdentity = {
    gitHead: spawnSync('git', ['rev-parse', 'HEAD'], { cwd: REPO, encoding: 'utf8', windowsHide: true }).stdout.trim(),
    appTreeSha256: spawnSync('git', ['diff', '--binary', 'HEAD', '--', 'server', 'shared', 'app', 'config.yml'], { cwd: REPO, encoding: 'buffer', windowsHide: true }).stdout ? createHash('sha256').update(spawnSync('git', ['diff', '--binary', 'HEAD', '--', 'server', 'shared', 'app', 'config.yml'], { cwd: REPO, encoding: 'buffer', windowsHide: true }).stdout).digest('hex') : null,
    simulatorCommit: spawnSync('git', ['rev-parse', 'HEAD'], { cwd: SIM_SOURCE, encoding: 'utf8', windowsHide: true }).stdout.trim(),
    scriptSha256: createHash('sha256').update(readFileSync(fileURLToPath(import.meta.url))).digest('hex'),
  }
  const scenes = [
    { id: 'cast-film', preset: 'cast-film-physics', sourceDevice: 'dev-extruder-opcua', mvSignal: 'ScrewSpeedSP', cvSignal: 'thick', baseline: 120, candidate: 125, targetMin: 48, targetMax: 52, process: 'cast-film extrusion' },
    { id: 'annealing', preset: 'anneal-line', sourceDevice: 'anneal-heating-mbtcp', mvSignal: '均热区3炉温SP', cvSignal: 'StripTemp', baseline: 730, candidate: 735, targetMin: 700, targetMax: 760, process: 'continuous annealing' },
  ]
  for (const [index, scene] of scenes.entries()) await runScene(scene, index)
  evidence.status = 'passed'
}
async function cleanup() {
  let ok = true
  for (const [child, label] of [[appProcess, 'agentworkshop'], [simProcess, 'simulator']].reverse()) {
    if (!child) continue
    const stopped = await stopTree(child, label).catch(() => false)
    ok = ok && stopped
  }
  for (const [label, port] of [['app', PORTS.app], ['simulator-http', PORTS.sim], ['simulator-mqtt', PORTS.mqtt], ['app-mqtt', PORTS.appMqtt], ['timeseries', PORTS.tsdb], ['objectstore', PORTS.objectstore], ...allocatedDevicePorts.map((port, i) => [`simulator-device-${i}`, port])]) {
    try {
      await freePort(port, label)
      evidence.checks.push({ id: `${label}-port-released`, status: 'pass', detail: { port } })
    }
    catch (error) {
      ok = false
      evidence.checks.push({ id: `${label}-port-released`, status: 'fail', detail: { port, error: safeText(error.message) } })
    }
  }
  try {
    closeSync(appLogFd)
  }
  catch { /* already closed */ }
  try {
    closeSync(simLogFd)
  }
  catch { /* already closed */ }
  return ok
}

try {
  await main()
}
catch (error) {
  evidence.status = 'failed'
  evidence.failure = { stage, scene: sceneId, name: error?.name ?? 'Error', message: safeText(error?.message ?? error) }
  if (evidence.isolation.result === 'pending') evidence.isolation.result = stage === 'preflight' ? 'failed' : 'incomplete'
}
finally {
  const cleanupOk = await cleanup()
  if (!cleanupOk) {
    evidence.status = 'failed'
    evidence.isolation.result = 'failed'
    evidence.failure ??= { stage: 'cleanup', message: 'process stop or port-release verification failed' }
  }
  if (evidence.status === 'passed' && evidence.checks.some(item => item.status !== 'pass')) {
    evidence.status = 'failed'
    evidence.isolation.result = 'failed'
  }
  evidence.cleanup = { status: cleanupOk ? 'passed' : 'failed', requiredProcessesAndPortsChecked: true }
  evidence.experiment.finishedAt = new Date().toISOString()
  evidence.experiment.outputDirectory = 'direct-rest-trial-2026-10-25/run-*'
  writeFileSync(join(OUTPUT, 'evidence.json'), JSON.stringify(evidence, null, 2) + '\n')
  const readme = [
    '# Direct REST simulator route evidence',
    '',
    `- Run: ${TAG}`,
    '- Scope: two local simulator scenes; one manual approval and one direct REST recipe_trial invocation per scene.',
    '- Route: POST /api/workshop/agent-tools/invoke; the worker identity only supplies platform agent scope. No registered harness transport, LLM decision, or physical PLC was used.',
    '- Data: evidence.json; service logs: agentworkshop.log and simulator.log.',
    '- Reproduce from the repository root with: node scripts/e2e-direct-rest-simulator-paper.mjs.',
    '- Interpretation: route and protocol mapping coverage only; the post-trial DAQ result is a single run-tagged snapshot, not process-attainment or dynamic-response evidence.',
    '',
  ].join('\n')
  writeFileSync(join(OUTPUT, 'README.md'), readme)
  console.log(`DIRECT_REST_E2E=${evidence.status}`)
  console.log(`EVIDENCE=${join(OUTPUT, 'evidence.json')}`)
  console.log(`STAGE=${evidence.failure?.stage ?? 'complete'}`)
}
if (evidence.status !== 'passed') process.exitCode = 1
