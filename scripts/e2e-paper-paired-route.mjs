#!/usr/bin/env node
/**
 * Paired-entry integration evidence for the registered OMP fixture and direct
 * REST recipe_trial routes. Both routes share one configuration and admissible
 * candidate set, with a distinct predeclared candidate per route. The runner
 * uses only loopback services and a deterministic fixture, not an LLM.
 */
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, closeSync, copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs'
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
const FIXTURE = join(REPO, 'scripts', 'fixtures', 'omp-paper-harness.mjs')
const NUXT_CLI = join(REPO, 'node_modules', 'nuxt', 'bin', 'nuxt.mjs')
const OUTPUT_ROOT = join(REPO, 'docs', 'audit', 'evidence', 'paper-paired-route')
mkdirSync(OUTPUT_ROOT, { recursive: true })
const OUTPUT = mkdtempSync(join(OUTPUT_ROOT, 'run-'))
mkdirSync(join(REPO, '.omc'), { recursive: true })
const ROOT = mkdtempSync(join(REPO, '.omc', 'paper-paired-route-'))
const HOME = join(ROOT, 'aw-home')
const SIM_ROOT = join(ROOT, 'simulator')
const EMPTY_DOTENV = join(HOME, 'empty.env')
const TAG = `ppr${Date.now().toString(36)}`
const APP_LOG = join(OUTPUT, 'agentworkshop.log')
const SIM_LOG = join(OUTPUT, 'simulator.log')
const appLogFd = openSync(APP_LOG, 'a')
const simLogFd = openSync(SIM_LOG, 'a')
const CHILD_OS_ENV_KEYS = process.platform === 'win32'
  ? ['PATH', 'PATHEXT', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'HOMEDRIVE', 'HOMEPATH', 'ProgramData']
  : ['PATH', 'HOME', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL']
const children = new Set()
const allocatedDevicePorts = []
const activeLineIds = new Set()

const evidence = {
  schemaVersion: 1,
  experiment: {
    id: TAG,
    name: 'paired registered-harness and direct-REST recipe_trial entry evaluation',
    projectVersion: VERSION,
    executionMode: 'one isolated loopback-only application/simulator startup; deterministic local OMP-RPC fixture plus direct REST route on one shared per-scene configuration and candidate set; route-specific candidates; native recipe cadence honored; no LLM inference',
    claimBoundary: 'Validates two real AgentWorkShop software entry paths, shared dispatch, bounded simulated device writes, approval, platform receipts, and independent readback. Does not validate Agent decision quality, LLM reasoning, multi-Agent coordination, physical PLC behavior, or process convergence.',
    startedAt: new Date().toISOString(),
    scenes: [],
  },
  isolation: { result: 'pending', appBase: APP_BASE, simulatorBase: SIM_BASE, awHome: 'fresh isolated home mode', loopbackOnly: true, externalModelCalls: false, checks: [] },
  checks: [],
  status: 'running',
}

let appProcess
let simProcess
let wrapperPath
let authToken
let syntheticAdminId
let stage = 'preflight'
let currentScene = null

function check(id, pass, detail = {}) {
  evidence.checks.push({ id, status: pass ? 'pass' : 'fail', detail })
  if (!pass) throw new Error(`check failed: ${id}`)
}
function isolationCheck(id, pass, detail = {}) {
  evidence.isolation.checks.push({ id, status: pass ? 'pass' : 'fail', detail })
  if (!pass) throw new Error(`isolation check failed: ${id}`)
}
function safeText(value, limit = 700) {
  let text = String(value ?? '')
  if (authToken) text = text.split(authToken).join('[REDACTED]')
  return text.replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer [REDACTED]')
    .replace(/\b(?:api[_-]?key|access[_-]?token|client[_-]?secret|password|secret)\s*[:=]\s*["']?[^\s,"'}]+/gi, '[REDACTED_CREDENTIAL]')
    .slice(0, limit)
}
function payload(body) {
  return body && typeof body === 'object' && Object.hasOwn(body, 'data') ? body.data : body
}
function assertLoopback(base, port) {
  const url = new URL(base)
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || Number(url.port) !== port || port === PORTS.forbidden) throw new Error('network boundary rejected a non-approved endpoint')
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
  if (!existsSync(FIXTURE) || !existsSync(join(SIM_SOURCE, 'src', 'server', 'index.ts')) || !existsSync(join(SIM_SOURCE, 'node_modules')) || !existsSync(NUXT_CLI)) throw new Error('local fixture, simulator runtime, or Nuxt CLI is missing')
  const runMode = resolveRunMode({ cwd: REPO, packageRoot: REPO, env: { AW_HOME: HOME, AW_MODE: 'home', AW_DATA_DIR: join(HOME, 'data') } })
  if (runMode.mode !== 'home' || resolve(runMode.dataDir) !== resolve(join(HOME, 'data'))) throw new Error('fresh AW_HOME did not resolve to its isolated home-mode data directory')
  isolationCheck('fresh-aw-home-data-path', true, { mode: runMode.mode, dataDir: 'isolated AW_HOME/data' })
  for (const [name, port] of Object.entries(PORTS)) {
    if (name === 'forbidden') continue
    await freePort(port, name)
    isolationCheck(`free-loopback-${name}-port`, true, { host: '127.0.0.1', port })
  }
  isolationCheck('deterministic-fixture-only', true, { fixture: 'scripts/fixtures/omp-paper-harness.mjs', noExternalModel: true, llmInference: false })
}
function childEnv(extra = {}) {
  const env = {}
  for (const key of CHILD_OS_ENV_KEYS) if (process.env[key] !== undefined) env[key] = process.env[key]
  const pathKey = process.platform === 'win32' ? 'PATH' : 'PATH'
  const inheritedPath = env[pathKey] ?? ''
  Object.assign(env, {
    AW_HOME: HOME,
    AW_MODE: 'home',
    AW_DATA_DIR: join(HOME, 'data'),
    AW_PROMPTS_DIR: join(HOME, 'prompts'),
    NUXT_SESSION_PASSWORD: 'paired-paper-isolated-session-secret',
    NO_PROXY: '127.0.0.1,localhost',
    no_proxy: '127.0.0.1,localhost',
    AW_PAPER_FIXTURE_NODE: process.execPath,
    AW_PAPER_FIXTURE_SCRIPT: FIXTURE,
  }, extra)
  env[pathKey] = `${join(HOME, 'bin')}${process.platform === 'win32' ? ';' : ':'}${inheritedPath}`
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
  evidence.checks.push({ id: `${label}-stopped`, status: gone ? 'pass' : 'fail', detail: { pid: child.pid, processTreeStopped: gone } })
  return gone
}
function pluginNames(root) {
  if (!existsSync(root)) return []
  return readdirSync(root, { withFileTypes: true }).filter(item => item.isDirectory() && existsSync(join(root, item.name, 'index.mjs'))).map(item => item.name)
}
function configureHome() {
  mkdirSync(join(HOME, 'data'), { recursive: true })
  copyFileSync(join(REPO, 'config.yml'), join(HOME, 'config.yml'))
  writeFileSync(join(HOME, 'runtime-settings.json'), JSON.stringify({ version: 1, updatedAt: new Date().toISOString(), overrides: {
    'daq.startInfrastructure': 'never', 'daq.mqtt.host': '127.0.0.1', 'daq.mqtt.port': PORTS.appMqtt,
    'daq.timescale.host': '127.0.0.1', 'daq.timescale.port': PORTS.tsdb,
    'daq.objectstore.host': '127.0.0.1', 'daq.objectstore.port': PORTS.objectstore,
    'plugins.rag-bridge.base_url': 'http://paired-paper-outbound-disabled.invalid',
  } }, null, 2) + '\n')
  const kv = join(HOME, 'data', 'plugins', 'rag-bridge')
  mkdirSync(kv, { recursive: true })
  writeFileSync(join(kv, 'kv.json'), JSON.stringify({ 'kb.base_url': 'http://paired-paper-outbound-disabled.invalid' }, null, 2) + '\n')
  cpSync(join(REPO, '.AgentWorkShop', 'prompts'), join(HOME, 'prompts'), { recursive: true })
  writeFileSync(EMPTY_DOTENV, '')
  const names = [...new Set([...pluginNames(join(REPO, 'server', 'plugins-builtin')), ...pluginNames(join(REPO, '.AgentWorkShop', 'plugins')), ...pluginNames(join(HOME, 'plugins'))])]
  writeFileSync(join(HOME, 'plugins-state.json'), JSON.stringify({ version: 1, updatedAt: new Date().toISOString(), disabled: names.filter(name => name !== 'rag-bridge') }, null, 2) + '\n')
  isolationCheck('isolated-home-and-outbound-guard-configured', true, { infrastructure: 'never', services: 'loopback only', enabledPluginAllowlist: ['rag-bridge'], outboundHost: 'invalid non-routable hostname' })
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
  return { status: response.status, body: parsed, data: payload(parsed) }
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
  if (source.split(listenCall).length !== 2 || source.split(brokerCall).length !== 2) throw new Error('simulator source differs from the verified loopback patch points')
  const patched = source.replace(listenCall, `server.listen(PORT, '127.0.0.1', () => {\n const a = server.address()\n if (!a || typeof a === 'string' || a.address !== '127.0.0.1' || a.port !== PORT) process.exit(70)\n console.log('[paired-paper-isolation] listener=' + a.address + ':' + a.port)\n resolve()\n })`).replace(brokerCall, `await startBroker(Number(process.env.MQTT_BROKER_PORT ?? 18830), '127.0.0.1')`)
  writeFileSync(entry, patched)
  symlinkSync(join(SIM_SOURCE, 'node_modules'), join(SIM_ROOT, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir')
  simProcess = spawnLogged(process.execPath, [join(REPO, 'node_modules', 'tsx', 'dist', 'cli.mjs'), entry], { cwd: SIM_ROOT, env: childEnv({ SIM_PORT: String(PORTS.sim), MQTT_BROKER_PORT: String(PORTS.mqtt) }), logFd: simLogFd, label: 'simulator' })
  for (let i = 0; i < 60; i++) {
    try {
      const result = await sim('GET', '/api/nodes')
      if (result.status === 200) {
        const log = readFileSync(SIM_LOG, 'utf8')
        if (!log.includes(`[paired-paper-isolation] listener=127.0.0.1:${PORTS.sim}`) || !log.includes(`mqtt://127.0.0.1:${PORTS.mqtt}`)) throw new Error('simulator listener or MQTT broker was not confirmed loopback-only')
        isolationCheck('simulator-http-and-mqtt-loopback', true, { http: `127.0.0.1:${PORTS.sim}`, mqtt: `127.0.0.1:${PORTS.mqtt}` })
        return
      }
    }
    catch (error) { if (String(error.message).includes('not confirmed')) throw error }
    await delay(400)
  }
  throw new Error('local simulator startup timed out')
}
async function startApplication() {
  await freePort(PORTS.app, 'application-immediate-before-startup')
  appProcess = spawnLogged(process.execPath, [NUXT_CLI, 'dev', '--host', '127.0.0.1', '--port', String(PORTS.app), '--dotenv', EMPTY_DOTENV], { cwd: REPO, env: childEnv(), logFd: appLogFd, label: 'agentworkshop' })
  for (let i = 0; i < 100; i++) {
    if (appProcess.exitCode !== null) throw new Error(`AgentWorkShop startup process exited with code ${appProcess.exitCode}`)
    try {
      const result = await app('GET', '/api/health', undefined, { token: undefined, timeoutMs: 2000 })
      if (result.status === 200 && result.data?.status === 'ok' && result.data?.workshop === 'ready' && result.data?.version === VERSION) {
        const log = readFileSync(APP_LOG, 'utf8')
        const isolatedHomeReady = log.includes(HOME) && /\[system-config\].*运行时设置已加载/.test(log) && log.includes('模式 home')
        const noPriorAdmin = log.includes('尚无管理员账号')
        if (isolatedHomeReady && noPriorAdmin) {
          isolationCheck('application-loaded-isolated-home-and-empty-admin-state', true, { home: 'fresh isolated AW_HOME', firstAccount: 'synthetic experiment administrator' })
          isolationCheck('application-loopback-ready', true, { version: result.data.version, host: '127.0.0.1', port: PORTS.app })
          return result.data
        }
      }
    }
    catch { /* startup in progress */ }
    await delay(500)
  }
  throw new Error('AgentWorkShop did not become ready on loopback')
}
function buildHarnessShim() {
  mkdirSync(join(HOME, 'bin'), { recursive: true })
  if (process.platform === 'win32') {
    const compiler = [join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'), join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework', 'v4.0.30319', 'csc.exe')].find(existsSync)
    if (!compiler) throw new Error('Windows C# compiler unavailable for the isolated registered fixture launcher')
    const source = join(ROOT, 'omp-fixture-shim.cs')
    wrapperPath = join(HOME, 'bin', 'omp.exe')
    writeFileSync(source, String.raw`using System; using System.Diagnostics; using System.IO; using System.Linq; using System.Text; using System.Threading;
class Shim { static string Q(string s) { var b=new StringBuilder("\""); int n=0; foreach(char c in s){ if(c=='\\'){n++;continue;} if(c=='\"'){b.Append('\\',n*2+1).Append('"');} else b.Append('\\',n).Append(c); n=0;} return b.Append('\\',n*2).Append('"').ToString(); }
static void C(Stream a,Stream b){byte[] x=new byte[4096];int n;while((n=a.Read(x,0,x.Length))>0){b.Write(x,0,n);b.Flush();}}
static int Main(string[] a){string node=Environment.GetEnvironmentVariable("AW_PAPER_FIXTURE_NODE"), script=Environment.GetEnvironmentVariable("AW_PAPER_FIXTURE_SCRIPT");if(String.IsNullOrWhiteSpace(node)||String.IsNullOrWhiteSpace(script))return 125;var p=new ProcessStartInfo(node);p.UseShellExecute=false;p.CreateNoWindow=true;p.RedirectStandardInput=true;p.RedirectStandardOutput=true;p.RedirectStandardError=true;p.Arguments=Q(script)+" "+String.Join(" ",a.Skip(2).Select(Q));using(var c=Process.Start(p)){if(c==null)return 126;var i=new Thread(()=>C(Console.OpenStandardInput(),c.StandardInput.BaseStream));var o=new Thread(()=>C(c.StandardOutput.BaseStream,Console.OpenStandardOutput()));var e=new Thread(()=>C(c.StandardError.BaseStream,Console.OpenStandardError()));i.Start();o.Start();e.Start();c.WaitForExit();o.Join();e.Join();return c.ExitCode;}}}`, 'utf8')
    const result = spawnSync(compiler, ['/nologo', '/target:exe', `/out:${wrapperPath}`, source], { cwd: ROOT, windowsHide: true, encoding: 'utf8', timeout: 30000, env: childEnv() })
    if (result.error || result.status !== 0 || !existsSync(wrapperPath)) throw new Error(`failed to compile local fixture launcher: ${safeText(result.stderr || result.stdout || result.error?.message || result.status)}`)
    return wrapperPath
  }
  if (process.platform === 'linux' || process.platform === 'darwin') {
    wrapperPath = join(HOME, 'bin', 'omp')
    writeFileSync(wrapperPath, '#!/bin/sh\nshift 2\nexec "$AW_PAPER_FIXTURE_NODE" "$AW_PAPER_FIXTURE_SCRIPT" "$@"\n')
    chmodSync(wrapperPath, 0o755)
    return wrapperPath
  }
  throw new Error(`unsupported fixture launcher platform: ${process.platform}`)
}
function normalizeConfig(value, portMap, key = '') {
  if (Array.isArray(value)) return value.map(item => normalizeConfig(item, portMap, key))
  if (!value || typeof value !== 'object') {
    if (typeof value !== 'string') return value
    if (/^[a-z][a-z\d+.-]*:\/\//i.test(value)) {
      const parsed = new URL(value)
      if (!['127.0.0.1', 'localhost', '::1'].includes(parsed.hostname)) throw new Error('simulator preset contains a non-loopback URL')
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
async function loadSimulatorScene(scene, index) {
  const preset = success(await sim('GET', `/api/presets/${encodeURIComponent(scene.preset)}`), `${scene.id} preset`)
  if (!preset?.plantModel || !Array.isArray(preset.nodes)) throw new Error(`${scene.id} simulator preset is malformed`)
  let nextPort = 44400 + index * 100
  const portMaps = new Map()
  const nodes = []
  for (const raw of preset.nodes) {
    const node = structuredClone(raw)
    if ((node.protocol && /serial|rtu/i.test(String(node.protocol))) || /serialPort|comPort|devicePath/i.test(JSON.stringify(node.config ?? {}))) continue
    node.config ||= {}
    const oldPort = Number(node.config.port)
    const map = new Map()
    if (Number.isInteger(oldPort) && oldPort > 0) {
      while (allocatedDevicePorts.includes(nextPort) || nextPort === PORTS.forbidden) nextPort++
      await freePort(nextPort, `${scene.id}-device`)
      map.set(oldPort, nextPort)
      allocatedDevicePorts.push(nextPort)
      node.config.port = nextPort++
    }
    node.config = normalizeConfig(node.config, map)
    if (/mqtt/i.test(String(node.protocol))) node.config.brokerUrl = `mqtt://127.0.0.1:${PORTS.mqtt}`
    portMaps.set(node.id, map)
    nodes.push(node)
  }
  if (!nodes.length) throw new Error(`${scene.id} preset has no supported nodes`)
  for (const node of nodes) success(await sim('POST', '/api/nodes', node), `${scene.id} simulator node`)
  const plant = { ...preset.plantModel, id: `${TAG}-${scene.id}`, seed: 42, timeScale: 1, truthExport: false }
  success(await sim('PUT', '/api/plant/config', { plantModel: plant, warm: true, upsert: true }), `${scene.id} plant config`)
  const exports = []
  for (const node of nodes) {
    const data = success(await sim('GET', `/api/nodes/${encodeURIComponent(node.id)}/export`), `${scene.id} export`)
    for (const item of data?.items ?? []) exports.push({ ...item, deviceId: node.id })
  }
  for (const item of exports) item.driverConfig = normalizeConfig(item.driverConfig ?? {}, portMaps.get(item.deviceId) ?? new Map())
  const mv = exports.find(item => item.deviceId === scene.sourceDevice && item.signal === scene.mvSignal)
  const cv = exports.find(item => item.signal === scene.cvSignal)
  if (!mv || !cv || !['opcua', 'modbus-tcp'].includes(String(mv.driver))) throw new Error(`${scene.id} required MV/CV export or approved MV protocol missing`)
  return { mv, cv, plant: { id: plant.id, kind: plant.kind ?? 'simulator', seed: 42, timeScale: 1 }, deviceCount: nodes.length }
}
async function createRouteContext(scene, simulator) {
  const route = 'registered-harness'
  const candidate = scene.candidates.registeredHarness
  const suffix = `${scene.id}-paired`
  const line = success(await app('POST', '/api/workshop/dcw/lines', { name: `${TAG}-${suffix}`, description: 'Synthetic isolated paired-entry route experiment', simulated: true, simSceneId: scene.preset, controlMode: 'manual' }), `${suffix} line`).line
  const product = success(await app('POST', '/api/workshop/dcw/products', { name: `${TAG}-${suffix}-product`, lineId: line.id }), `${suffix} product`).product
  const template = success(await app('POST', '/api/workshop/dcw/templates', { name: `${TAG}-${suffix}-template`, unit: simulator.mv.unit, min: simulator.mv.min, max: simulator.mv.max, decimals: simulator.mv.decimals ?? 0 }), `${suffix} template`).template
  const control = success(await app('POST', '/api/workshop/dcw', { templateRef: template.key, name: `${TAG}-${suffix}-control`, driver: simulator.mv.driver, driverConfig: simulator.mv.driverConfig, lineId: line.id, min: simulator.mv.min, max: simulator.mv.max, unit: simulator.mv.unit, decimals: simulator.mv.decimals ?? 0, stepLimit: scene.stepLimit, writeLockSeconds: 0, holdIntervalMs: 0, readIntervalMs: 500, semantics: `Bounded simulated ${scene.mvSignal} setpoint` }), `${suffix} control`).node
  const daq = success(await app('POST', '/api/workshop/daq', { templateRef: 'daq-temp-tc', name: `${TAG}-${suffix}-daq-cv`, driver: simulator.cv.driver, driverConfig: simulator.cv.driverConfig, lineId: line.id, min: simulator.cv.min, max: simulator.cv.max, unit: simulator.cv.unit, intervalMs: 1000, publishIntervalMs: 0, semantics: `Bounded simulated ${scene.cvSignal} sample` }), `${suffix} DAQ`).node
  const recipe = success(await app('POST', '/api/workshop/dcw/recipes', { name: `${TAG}-${suffix}-recipe`, productId: product.id, params: [{ nodeId: control.id, templateRef: template.key, value: scene.baseline, min: simulator.mv.min, max: simulator.mv.max, stepLimit: scene.stepLimit }], daqWindows: [{ nodeId: daq.id, min: simulator.cv.min, max: simulator.cv.max }] }), `${suffix} recipe`).recipe
  const started = success(await app('POST', `/api/workshop/dcw/lines/${encodeURIComponent(line.id)}/start`, { recipeId: recipe.id }), `${suffix} line start`)
  const activeRunId = String(started.run?.id ?? '')
  if (!activeRunId) throw new Error(`${suffix} line start response did not contain a run ID`)
  activeLineIds.add(line.id)
  const channel = success(await app('POST', '/api/workshop/channels', { name: `${TAG}-${suffix}-channel`, description: 'Paired deterministic fixture and direct REST routes on one shared context' }), `${suffix} channel`)
  const config = { command: 'omp', cwd: HOME, args: ['--scene', scene.id, '--recipe-id', recipe.id, '--node-id', control.id, '--value', String(candidate), '--trace-root', ROOT, '--trace-path', join(ROOT, `fixture-${scene.id}.json`)], rpcMode: 'rpc' }
  const agent = success(await app('POST', `/api/workshop/channels/${encodeURIComponent(channel.channelId)}/agents`, { name: `${TAG}-${suffix}-agent`, harness: 'omp', role: 'lead', config }), `${suffix} agent`)
  const recipeBinding = success(await app('POST', '/api/workshop/agent-tools/bindings', { agentId: agent.id, nodeId: recipe.id, kind: 'recipe' }), `${suffix} recipe binding`).binding
  const daqBinding = success(await app('POST', '/api/workshop/agent-tools/bindings', { agentId: agent.id, nodeId: daq.id, kind: 'daq', mode: 'auto' }), `${suffix} DAQ binding`).binding
  if (recipeBinding.mode !== 'manual' || daqBinding.kind !== 'daq') throw new Error(`${suffix} bindings do not match manual recipe and DAQ observation policy`)
  if (!Number.isFinite(candidate) || candidate < simulator.mv.min || candidate > simulator.mv.max || Math.abs(candidate - scene.baseline) > scene.stepLimit) throw new Error(`${suffix} candidate violates device engineering limits`)
  return { scene, route, simulator, line, product, template, control, daq, recipe, channel, agent, activeRunId, candidate }
}
async function approvePending(ctx, pathComment, invocationPromise = null) {
  const deadline = Date.now() + 30000
  let approval
  while (Date.now() < deadline) {
    const result = await app('GET', `/api/workshop/agent-tools/approvals?agentId=${encodeURIComponent(ctx.agent.id)}&scope=pending`)
    if (result.status === 200) {
      const matches = (result.data?.approvals ?? []).filter(item => item.agentId === ctx.agent.id && item.nodeId === `recipe:${ctx.recipe.id}` && item.status === 'pending')
      if (matches.length > 1) throw new Error(`${ctx.route} produced multiple pending approvals`)
      if (matches.length === 1) {
        approval = matches[0]
        break
      }
    }
    if (invocationPromise?.settled) {
      try {
        const settled = await invocationPromise
        const tool = settled.data?.result
        const toolText = String(tool?.text ?? tool?.content?.[0]?.text ?? '')
        throw new Error(`${ctx.route} invocation settled before approval: HTTP ${settled.status}, toolError=${tool?.isError === true}, result=${safeText(toolText || settled.body?.message || 'empty', 500)}`)
      }
      catch (error) {
        if (String(error?.message ?? error).includes('invocation settled before approval')) throw error
        throw new Error(`${ctx.route} invocation rejected before approval: ${safeText(error?.message ?? error, 500)}`, { cause: error })
      }
    }
    await delay(350)
  }
  if (!approval) throw new Error(`${ctx.route} approval was not observed within the bound`)
  success(await app('POST', `/api/workshop/agent-tools/approvals/${encodeURIComponent(approval.id)}/decide`, { approved: true, comment: pathComment }), `${ctx.route} approval decision`)
  const history = success(await app('GET', `/api/workshop/agent-tools/approvals?agentId=${encodeURIComponent(ctx.agent.id)}&scope=history`), `${ctx.route} approval history`)
  const finalApproval = (history.approvals ?? []).find(item => item.id === approval.id)
  if (finalApproval?.status !== 'approved' || finalApproval.decidedBy !== syntheticAdminId) throw new Error(`${ctx.route} approval history does not show the isolated synthetic administrator`)
  return { id: approval.id, statusBeforeDecision: approval.status, statusAfterDecision: finalApproval.status, nodeId: approval.nodeId, actor: 'synthetic isolated administrator', commentRecorded: finalApproval.comment === pathComment }
}
async function taskRequest(ctx) {
  const sent = success(await app('POST', `/api/workshop/channels/${encodeURIComponent(ctx.channel.channelId)}/tasks`, { title: `Paired ${ctx.scene.id} deterministic recipe_trial`, description: `Execute exactly one predeclared ${ctx.scene.id} recipe_trial candidate through the registered fixture route.`, fromLabel: 'Synthetic paired-route experiment driver' }), `${ctx.scene.id} fixture task`)
  const taskId = sent.id ?? sent.task?.id
  if (!taskId) throw new Error(`${ctx.scene.id} registered fixture task response omitted its ID`)
  return String(taskId)
}
async function readDeviceValue(ctx, label) {
  const attempts = []
  const startedAt = Date.now()
  let response
  for (let attempt = 1; attempt <= 12; attempt++) {
    response = await app('POST', `/api/workshop/dcw/${encodeURIComponent(ctx.control.id)}/read`, undefined, { timeoutMs: 6000 })
    attempts.push({ attempt, status: response.status, at: new Date().toISOString() })
    if (response.status === 200) {
      const data = success(response, `${ctx.route} ${label}`)
      const read = data?.outcome ?? data?.read ?? data
      const value = Number(read?.value ?? read?.data?.value)
      if (!Number.isFinite(value)) throw new Error(`${ctx.route} ${label} returned a nonnumeric device value`)
      return { value, attempts, waitedMs: Date.now() - startedAt }
    }
    if (response.status !== 409) success(response, `${ctx.route} ${label}`)
    if (attempt < 12) await delay(250)
  }
  throw new Error(`${ctx.route} ${label} remained busy after ${attempts.length} bounded read attempts (last HTTP ${response?.status})`)
}
async function priorTrialRunIds(ctx) {
  const logs = success(await app('GET', `/api/workshop/ops-logs?scope=line&lineId=${encodeURIComponent(ctx.line.id)}&recipeId=${encodeURIComponent(ctx.recipe.id)}&limit=100`), `${ctx.route} pre-invocation ops logs`)
  const rows = (logs.logs ?? []).map((row) => {
    let detail = row.detail
    if (!detail || typeof detail !== 'object' || Array.isArray(detail)) {
      try {
        detail = JSON.parse(String(row.detailJson ?? '{}'))
      }
      catch { detail = {} }
    }
    return { ...row, detail }
  })
  return [...new Set(rows.filter(row => row.action === 'recipe.trial' || (row.action === 'recipe.dispatch.ack' && row.detail?.trial === true)).map(row => String(row.detail?.runId ?? '')).filter(Boolean))]
}
async function verifyReceiptAndReadback(ctx, approval, routeToolText, priorRunIds, routeTrace = null) {
  const readback = await readDeviceValue(ctx, 'independent device readback')
  const observed = readback.value
  check(`${ctx.scene.id}-${ctx.route}-device-readback`, Math.abs(observed - ctx.candidate) <= 0.01, { expected: ctx.candidate, observed })
  const preWrite = ctx.preWriteReadback
  const stateChanged = Number.isFinite(preWrite?.value) && Math.abs(preWrite.value - ctx.candidate) > 0.01 && Math.abs(observed - preWrite.value) > 0.01
  check(`${ctx.scene.id}-${ctx.route}-actual-state-transition`, stateChanged, { before: preWrite?.value ?? null, candidate: ctx.candidate, after: observed })
  const logs = success(await app('GET', `/api/workshop/ops-logs?scope=line&lineId=${encodeURIComponent(ctx.line.id)}&recipeId=${encodeURIComponent(ctx.recipe.id)}&limit=100`), `${ctx.route} ops logs`)
  const rows = (logs.logs ?? []).filter(row => String(row.action).startsWith('recipe.')).map((row) => {
    let detail = row.detail
    if (!detail || typeof detail !== 'object' || Array.isArray(detail)) {
      try {
        detail = JSON.parse(String(row.detailJson ?? '{}'))
      }
      catch { detail = {} }
    }
    return { ...row, detail }
  })
  const prior = new Set(priorRunIds)
  const trial = rows.filter(row => row.action === 'recipe.trial' && !prior.has(String(row.detail?.runId ?? '')))
  const acks = rows.filter(row => row.action === 'recipe.dispatch.ack' && row.detail?.trial === true && !prior.has(String(row.detail?.runId ?? '')))
  const trialRunId = String(acks[0]?.detail?.runId ?? '')
  if (trial.length !== 1 || acks.length !== 1 || !trialRunId || String(trial[0]?.detail?.runId ?? '') !== trialRunId || prior.has(trialRunId)) throw new Error(`${ctx.route} must produce exactly one new linked recipe.trial and ACK for this invocation`)
  const runData = success(await app('GET', `/api/workshop/dcw/runs/${encodeURIComponent(trialRunId)}/data`), `${ctx.route} trial run receipt`)
  const run = runData?.run
  const result = run?.results?.[0]
  const ack = acks[0].detail?.ackSummary
  if (run?.id !== trialRunId || run.results?.length !== 1 || result?.ok !== true || result?.verify?.verdict !== 'verified' || ack?.total !== 1 || ack?.verified !== 1 || ack?.unverified !== 0 || ack?.failed !== 0) throw new Error(`${ctx.route} receipt does not independently verify a single device write`)
  const toolSuccess = /全部设备证实|下发并全部设备证实/.test(String(routeToolText ?? ''))
  if (!toolSuccess) throw new Error(`${ctx.route} route result did not report all-device confirmation`)
  return {
    route: ctx.route,
    status: 'verified',
    endpoint: ctx.route === 'registered-harness' ? 'registered OMP-RPC harness → shared host-tool dispatch' : 'POST /api/workshop/agent-tools/invoke',
    entities: { lineId: ctx.line.id, recipeId: ctx.recipe.id, controlNodeId: ctx.control.id, daqNodeId: ctx.daq.id, channelId: ctx.channel.channelId, agentId: ctx.agent.id },
    activeRunId: ctx.activeRunId,
    approvalId: approval.id,
    approvedBy: 'synthetic isolated administrator',
    toolResult: { success: true, text: safeText(routeToolText, 600) },
    platformReceipt: { trialRunId, trialRows: trial.length, trialAckRows: acks.length, ackSummary: ack, verifiedResult: result },
    preWriteReadback: preWrite,
    independentReadback: { expected: ctx.candidate, observed, matches: true, retryAttempts: readback.attempts, waitedMs: readback.waitedMs },
    operationLog: { trialAction: trial[0].action, ackAction: acks[0].action, linkedRunId: trialRunId, priorTrialRunIds: priorRunIds, selectedCurrentInvocationOnly: true },
    lineStoppedAfterPair: false,
    ...(ctx.cadenceWait ? { cadenceWait: ctx.cadenceWait } : {}),
    ...(routeTrace ? { trace: routeTrace } : {}),
  }
}
async function runRegistered(ctx) {
  const scene = ctx.scene
  stage = `${scene.id}:registered-route`
  ctx.preWriteReadback = await readDeviceValue(ctx, 'pre-write device readback')
  if (Math.abs(ctx.preWriteReadback.value - ctx.candidate) <= 0.01 || Math.abs(ctx.candidate - ctx.preWriteReadback.value) > scene.stepLimit) throw new Error(`${scene.id} registered candidate is not a bounded state change from its measured pre-write value`)
  const previousRunIds = await priorTrialRunIds(ctx)
  const tracePath = join(ROOT, `fixture-${scene.id}.json`)
  const taskId = await taskRequest(ctx)
  const approval = await approvePending(ctx, 'Approved for the bounded paired registered-harness local simulator check.')
  const deadline = Date.now() + 30000
  let trace
  while (Date.now() < deadline) {
    if (existsSync(tracePath)) {
      try {
        trace = JSON.parse(readFileSync(tracePath, 'utf8'))
      }
      catch { /* fixture is writing trace */ }
    }
    if (trace?.hostToolResults?.length) break
    await delay(250)
  }
  if (!trace || trace.hostToolCalls?.length !== 1 || trace.hostToolCalls[0]?.toolName !== 'recipe_trial' || trace.hostToolResults?.length !== 1) throw new Error(`${scene.id} fixture trace did not capture exactly one recipe_trial call/result`)
  const result = trace.hostToolResults[0].result
  const text = String(result?.content?.[0]?.text ?? '')
  if (result?.isError === true || !/全部设备证实|下发并全部设备证实/.test(text)) throw new Error(`${scene.id} registered route did not return a verified all-device result`)
  const task = await app('GET', `/api/workshop/tasks/${encodeURIComponent(taskId)}?channelId=${encodeURIComponent(ctx.channel.channelId)}`)
  const taskState = task.status === 200 ? task.data?.state ?? null : null
  return verifyReceiptAndReadback(ctx, approval, text, previousRunIds, {
    fixture: trace.fixture,
    decisionSource: trace.decisionSource,
    hostToolCallCount: trace.hostToolCalls.length,
    hostToolResultCount: trace.hostToolResults.length,
    taskId,
    taskState,
    traceSha256: createHash('sha256').update(readFileSync(tracePath)).digest('hex'),
  })
}
async function runDirect(ctx) {
  const scene = ctx.scene
  stage = `${scene.id}:direct-rest-route`
  ctx.route = 'direct-rest'
  ctx.candidate = scene.candidates.directRest
  const waitStartedAt = new Date().toISOString()
  await delay(61_000)
  ctx.cadenceWait = {
    requiredSeconds: 60,
    waitedSeconds: (Date.now() - Date.parse(waitStartedAt)) / 1000,
    reason: 'honor the same-recipe minimum dispatch interval; cadence bypass is disabled',
    previousTrialRunId: ctx.previousRouteTrialRunId,
    startedAt: waitStartedAt,
    completedAt: new Date().toISOString(),
  }
  ctx.preWriteReadback = await readDeviceValue(ctx, 'pre-write device readback')
  if (Math.abs(ctx.preWriteReadback.value - ctx.candidate) <= 0.01 || Math.abs(ctx.candidate - ctx.preWriteReadback.value) > scene.stepLimit) throw new Error(`${scene.id} direct candidate is not a bounded state change from its measured pre-write value`)
  const previousRunIds = await priorTrialRunIds(ctx)
  const body = { agentId: ctx.agent.id, tool: 'recipe_trial', args: { recipe_id: ctx.recipe.id, params: [{ node_id: ctx.control.id, value: ctx.candidate }], hypothesis: `Bounded paired-entry check for ${scene.id}; apply this route's predeclared candidate from the shared admissible candidate set.` } }
  const invokePromise = app('POST', '/api/workshop/agent-tools/invoke', body, { noTimeout: true })
  invokePromise.settled = false
  const settle = () => {
    invokePromise.settled = true
  }
  const markSettled = invokePromise.then(settle, settle)
  const approvalPromise = approvePending(ctx, 'Approved for the bounded paired direct-REST local simulator check.', invokePromise)
  const approval = await approvalPromise
  let timeoutId
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(`${scene.id} direct route invocation did not settle after approval`)), 45000)
  })
  let invocation
  try {
    invocation = await Promise.race([invokePromise, timeout])
  }
  finally { clearTimeout(timeoutId) }
  await markSettled
  const result = invocation.data?.result
  const text = String(result?.text ?? result?.content?.[0]?.text ?? '')
  if (invocation.status !== 200 || result?.isError === true) throw new Error(`${scene.id} direct REST invocation returned unsuccessful HTTP/tool result (${invocation.status}, isError=${result?.isError === true}, result=${safeText(text || invocation.body?.message || 'empty', 700)})`)
  check(`${scene.id}-direct-rest-http-success`, invocation.status === 200, { status: invocation.status, endpoint: '/api/workshop/agent-tools/invoke' })
  return verifyReceiptAndReadback(ctx, approval, text, previousRunIds)
}
function stableConfig(scene, simulator) {
  const candidateSet = [scene.candidates.registeredHarness, scene.candidates.directRest]
  const candidateSetSha256 = createHash('sha256').update(JSON.stringify(candidateSet)).digest('hex')
  const controlDriverConfigSha256 = createHash('sha256').update(JSON.stringify(simulator.mv.driverConfig)).digest('hex')
  const observationDriverConfigSha256 = createHash('sha256').update(JSON.stringify(simulator.cv.driverConfig)).digest('hex')
  const normalized = {
    scene: scene.id,
    preset: scene.preset,
    process: scene.process,
    protocol: simulator.mv.driver,
    controlSignal: scene.mvSignal,
    observationSignal: scene.cvSignal,
    manipulationDevice: simulator.mv.deviceId,
    observationDevice: simulator.cv.deviceId,
    controlDriverConfigSha256,
    observationDriverConfigSha256,
    engineeringRange: [Number(simulator.mv.min), Number(simulator.mv.max)],
    stepLimit: scene.stepLimit,
    baseline: scene.baseline,
    targetBand: [scene.targetMin, scene.targetMax],
    candidateSet,
    candidateSetSha256,
  }
  return { canonical: normalized, fingerprintSha256: createHash('sha256').update(JSON.stringify(normalized)).digest('hex') }
}
async function runScene(scene, index) {
  currentScene = scene.id
  stage = `${scene.id}:shared-simulator-scene`
  const simulator = await loadSimulatorScene(scene, index)
  const config = stableConfig(scene, simulator)
  const sceneEvidence = {
    id: scene.id,
    status: 'running',
    simulator: { preset: scene.preset, plant: simulator.plant, deviceCount: simulator.deviceCount },
    sharedConfiguration: config,
    routeConfigurationFingerprints: { registeredHarness: config.fingerprintSha256, directRest: config.fingerprintSha256, equal: true },
    protocolMapping: { driver: simulator.mv.driver, control: { deviceId: simulator.mv.deviceId, signal: simulator.mv.signal, driverConfigSha256: config.canonical.controlDriverConfigSha256 }, observation: { deviceId: simulator.cv.deviceId, signal: simulator.cv.signal, driverConfigSha256: config.canonical.observationDriverConfigSha256 } },
    values: { engineeringRange: config.canonical.engineeringRange, stepLimit: scene.stepLimit, baseline: scene.baseline, targetBand: [scene.targetMin, scene.targetMax], candidateSet: config.canonical.candidateSet, candidateSetSha256: config.canonical.candidateSetSha256, routeCandidates: { registeredHarness: scene.candidates.registeredHarness, directRest: scene.candidates.directRest } },
    routes: [],
  }
  evidence.experiment.scenes.push(sceneEvidence)
  const ctx = await createRouteContext(scene, simulator)
  const registered = await runRegistered(ctx)
  ctx.previousRouteTrialRunId = registered.platformReceipt.trialRunId
  sceneEvidence.routes.push(registered)
  const direct = await runDirect(ctx)
  sceneEvidence.routes.push(direct)
  const stopped = success(await app('POST', `/api/workshop/dcw/lines/${encodeURIComponent(ctx.line.id)}/stop`), `${scene.id} stop shared line after pair`)
  if (!stopped?.run) throw new Error(`${scene.id} shared line did not report a stopped run after both route invocations`)
  activeLineIds.delete(ctx.line.id)
  registered.lineStoppedAfterPair = true
  direct.lineStoppedAfterPair = true
  const sharedEntities = ['lineId', 'recipeId', 'controlNodeId', 'daqNodeId', 'channelId', 'agentId']
    .every(key => registered.entities[key] === direct.entities[key])
    && registered.activeRunId === direct.activeRunId
  const sameConfig = sceneEvidence.routeConfigurationFingerprints.equal
    && sharedEntities
    && registered.independentReadback.expected !== direct.independentReadback.expected
    && registered.preWriteReadback.value !== registered.independentReadback.observed
    && direct.preWriteReadback.value !== direct.independentReadback.observed
    && registered.platformReceipt.ackSummary.verified === 1
    && direct.platformReceipt.ackSummary.verified === 1
  check(`${scene.id}-paired-route-shared-context-and-transitions`, sameConfig, { fingerprintSha256: config.fingerprintSha256, candidateSetSha256: config.canonical.candidateSetSha256, routeCandidates: [registered.independentReadback.expected, direct.independentReadback.expected], sharedEntities, activeRunId: registered.activeRunId })
  sceneEvidence.status = 'verified'
}
function sourceHash(paths) {
  const hash = createHash('sha256')
  for (const path of paths) {
    hash.update(path.replaceAll('\\', '/') + '\0')
    hash.update(readFileSync(join(REPO, path)))
    hash.update('\0')
  }
  return hash.digest('hex')
}
function captureSourceIdentity() {
  const git = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: REPO, windowsHide: true, encoding: 'utf8' })
  const simulatorGit = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: SIM_SOURCE, windowsHide: true, encoding: 'utf8' })
  return {
    appGitHead: git.status === 0 ? git.stdout.trim() : null,
    simulatorGitHead: simulatorGit.status === 0 ? simulatorGit.stdout.trim() : null,
    appSourceSha256: sourceHash(['server/services/workshop/runtime/manager/host-tools.ts', 'server/services/workshop/runtime/manager/index.ts', 'server/services/workshop/runtime/manager/dispatch.ts'].filter(path => existsSync(join(REPO, path)))),
    simulatorEntrySha256: createHash('sha256').update(readFileSync(join(SIM_SOURCE, 'src', 'server', 'index.ts'))).digest('hex'),
    runnerSha256: createHash('sha256').update(readFileSync(fileURLToPath(import.meta.url))).digest('hex'),
    fixtureSha256: createHash('sha256').update(readFileSync(FIXTURE)).digest('hex'),
    nodeVersion: process.version,
    platform: process.platform,
    architecture: process.arch,
  }
}
async function main() {
  await preflight()
  configureHome()
  wrapperPath = buildHarnessShim()
  isolationCheck('registered-fixture-launcher-ready', true, { platform: process.platform, launcher: 'local stdio shim', fixture: 'deterministic OMP-RPC fixture' })
  stage = 'simulator-startup'
  await bootSimulator()
  stage = 'application-startup'
  const health = await startApplication()
  evidence.experiment.server = { version: health.version, mode: health.mode, workshop: health.workshop }
  const adminResponse = success(await app('POST', '/api/users/register', { name: `Paper Pair ${TAG}`, email: `${TAG}@example.invalid`, password: `Pair-${Date.now()}-safe9` }, { token: undefined }), 'synthetic administrator registration')
  if (!adminResponse?.token || adminResponse?.user?.role !== 'admin') throw new Error('isolated home did not create its synthetic first administrator')
  authToken = String(adminResponse.token)
  syntheticAdminId = String(adminResponse.user.id)
  evidence.experiment.syntheticAdmin = { id: syntheticAdminId, role: 'admin', source: 'first registration in fresh isolated AW_HOME' }
  const plugins = success(await app('GET', '/api/workshop/plugins'), 'plugin allowlist')
  const enabled = (plugins.plugins ?? []).filter(plugin => plugin.enabled).map(plugin => plugin.name).sort()
  if (enabled.join(',') !== 'rag-bridge') throw new Error(`isolated plugin allowlist mismatch: ${enabled.join(',')}`)
  const bridge = success(await app('GET', '/api/plugins/rag-bridge/health'), 'outbound plugin guard')
  if (bridge.outbound !== false) throw new Error('external plugin outbound requests are not disabled')
  const daq = success(await app('GET', '/api/workshop/daq', undefined, { timeoutMs: 45000 }), 'isolated DAQ backends')
  if (daq.meta?.queue !== 'inproc' || daq.meta?.tsdb !== 'sqlite-emulated') throw new Error('DAQ did not use isolated in-process and SQLite fallback backends')
  isolationCheck('application-plugin-outbound-and-daq-isolation', true, { enabledPlugins: enabled, outbound: bridge.outbound, daqQueue: daq.meta.queue, timeSeries: daq.meta.tsdb })
  evidence.isolation.result = 'passed'
  evidence.experiment.sourceIdentity = captureSourceIdentity()
  const scenes = [
    { id: 'cast-film', preset: 'cast-film-physics', sourceDevice: 'dev-extruder-opcua', mvSignal: 'ScrewSpeedSP', cvSignal: 'thick', baseline: 120, candidates: { registeredHarness: 125, directRest: 130 }, targetMin: 48, targetMax: 52, stepLimit: 30, process: 'cast-film extrusion' },
    { id: 'annealing', preset: 'anneal-line', sourceDevice: 'anneal-heating-mbtcp', mvSignal: '均热区3炉温SP', cvSignal: 'StripTemp', baseline: 730, candidates: { registeredHarness: 735, directRest: 740 }, targetMin: 700, targetMax: 760, stepLimit: 30, process: 'continuous annealing' },
  ]
  for (const [index, scene] of scenes.entries()) await runScene(scene, index)
  evidence.status = 'passed'
}
async function cleanup() {
  let ok = true
  for (const lineId of activeLineIds) {
    try {
      const stopped = success(await app('POST', `/api/workshop/dcw/lines/${encodeURIComponent(lineId)}/stop`), 'cleanup stop active shared line')
      const pass = Boolean(stopped?.run)
      evidence.checks.push({ id: 'cleanup-stop-active-line', status: pass ? 'pass' : 'fail', detail: { lineId } })
      ok = ok && pass
    }
    catch (error) {
      evidence.checks.push({ id: 'cleanup-stop-active-line', status: 'fail', detail: { lineId, error: safeText(error.message) } })
      ok = false
    }
  }
  for (const child of [...children]) {
    if (child === appProcess || child === simProcess) continue
    const stopped = await stopTree(child, child.label ?? 'fixture-child').catch(() => false)
    ok = ok && stopped
  }
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
  for (const fd of [appLogFd, simLogFd]) {
    try {
      closeSync(fd)
    }
    catch { /* already closed */ }
  }
  return ok
}
try {
  await main()
}
catch (error) {
  evidence.status = 'failed'
  evidence.failure = { stage, scene: currentScene, name: error?.name ?? 'Error', message: safeText(error?.message ?? error) }
  if (evidence.isolation.result === 'pending') evidence.isolation.result = stage === 'preflight' ? 'failed' : 'incomplete'
}
finally {
  const cleanupOk = await cleanup()
  if (!cleanupOk) {
    evidence.status = 'failed'
    evidence.isolation.result = 'failed'
    evidence.failure ??= { stage: 'cleanup', message: 'process stop or port release verification failed' }
  }
  if (evidence.status === 'passed' && evidence.checks.some(item => item.status !== 'pass')) {
    evidence.status = 'failed'
    evidence.isolation.result = 'failed'
  }
  evidence.cleanup = { status: cleanupOk ? 'passed' : 'failed', allStartedProcessTreesAndLoopbackPortsChecked: true }
  evidence.experiment.finishedAt = new Date().toISOString()
  evidence.experiment.runtimeDirectory = '.omc/paper-paired-route-*'
  evidence.experiment.outputDirectory = 'docs/audit/evidence/paper-paired-route/run-*'
  writeFileSync(join(OUTPUT, 'evidence.json'), JSON.stringify(evidence, null, 2) + '\n')
  writeFileSync(join(OUTPUT, 'README.md'), [
    '# Paired route integration evidence', '',
    `- Run: ${TAG}`,
    '- Scope: two simulator scenes; one registered deterministic OMP-RPC fixture route and one direct REST route per scene.',
    '- The fixture supplies a predeclared test vector. No LLM inference, autonomous Agent decision, multi-Agent coordination, or physical PLC was involved.',
    '- Both routes reused one line, product, recipe, control/DAQ nodes, channel, agent, and active run per scene, with separate manual approvals. They used one normalized scene/signal/protocol/range/step/target configuration and candidate set, then applied distinct predeclared candidates sequentially after honoring the same-recipe 60 s dispatch interval. Evidence records the wait, pre/post reads, and invocation-local trial/ACK run IDs.',
    '- Both route results are checked against platform trial/ACK records and a separate DCW device readback.',
    '- Service logs: agentworkshop.log and simulator.log. Reproduce with `node scripts/e2e-paper-paired-route.mjs`.',
    '- Interpretation: validates software route integration and simulated bounded writes only; it is not evidence of Agent decision quality, multi-Agent capability, physical deployment, process attainment, or dynamic response.', '',
  ].join('\n'))
  console.log(`PAPER_PAIRED_ROUTE=${evidence.status}`)
  console.log(`EVIDENCE=${join(OUTPUT, 'evidence.json')}`)
  console.log(`LOGS=${OUTPUT}`)
  console.log(`STAGE=${evidence.failure?.stage ?? 'complete'}`)
}
if (evidence.status !== 'passed') process.exitCode = 1
