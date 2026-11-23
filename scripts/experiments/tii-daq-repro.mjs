#!/usr/bin/env node
/** Windows-only, disposable cast-film simulator / registered local Gemma OMP RPC trace.
 * Usage: node scripts/experiments/tii-daq-repro.mjs [--trial]
 * --trial enables one exact-card fixture approval, only after Agent DAQ is proven.
 * Requires trusted existing .output, installed dependencies, and idle local LM Studio
 * already running the specified Gemma model; does not install, load, or reconfigure it.
 */
import { spawn, spawnSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { setTimeout as sleep } from 'node:timers/promises'

const script = fileURLToPath(import.meta.url)
const repo = resolve(dirname(script), '../..')
const { Pool } = createRequire(join(repo, 'package.json'))('pg')
const timescaleImage = 'timescale/timescaledb:latest-pg16'
const mqttImage = 'eclipse-mosquitto:2'
const pgPassword = randomBytes(24).toString('hex')
const dockerHost = 'npipe:////./pipe/dockerDesktopLinuxEngine'
let containerId, tsPort, mqttContainerId, mqttQueuePort
const docker = (args, opts = {}) => cmd('docker.exe', ['--host', dockerHost, ...args], opts)
const simSource = join(repo, 'plc-node-simulator')
const appEntry = join(repo, '.output/server/index.mjs')
const manifest = path => JSON.parse(readFileSync(path, 'utf8'))
const requireSim = createRequire(join(simSource, 'package.json'))
const host = '127.0.0.1'
const model = 'google/gemma-4-12b-qat'
const provider = 'local'
const preset = 'cast-film-physics'
const baseline = 120
const candidate = 125
const stepLimit = 5
const options = process.argv.slice(2)
if (options.length > 1 || options.some(s => s !== '--trial')) throw new Error('Usage: tii-daq-repro.mjs [--trial]')
const trial = options.includes('--trial')
const tag = `tii-daq-${randomBytes(8).toString('hex')}`
const outDir = join(repo, 'paper/tii/TII-SUBMISSION-PACKAGE-DAQ-REPRO/reproduce/live')
mkdirSync(outDir, { recursive: true })
const output = join(outDir, `${tag}.json`)
const root = mkdtempSync(join(tmpdir(), 'aw-tii-'))
const home = join(root, 'aw-home')
const userHome = join(root, 'user-home')
const simRoot = join(root, 'simulator')
const workspace = join(home, 'omp-workspace')
const sessions = join(workspace, 'sessions')
const ompTrace = join(root, 'omp-events.jsonl')
const govTrace = join(root, 'gov-events.jsonl')
const nonce = randomBytes(24).toString('hex')
const osEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => /^(PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC)$/i.test(k)))
const env = { ...osEnv, HOME: userHome, USERPROFILE: userHome, APPDATA: join(userHome, 'Roaming'), LOCALAPPDATA: join(userHome, 'Local'), TEMP: root, TMP: root, NO_PROXY: `${host},localhost`, DO_NOT_TRACK: '1' }
let stage = 'preflight'
let ports, appProc, simProc, token, adminId, db, lineId, agentId, channelId, taskId, runId, recipeId, nodeId, controlId
let lineStarted = false
const reservations = []
const children = new Set()
const cancel = new AbortController()
const evidence = {
  schemaVersion: 1, experimentId: tag, startedAt: new Date().toISOString(), status: 'running',
  scope: { simulatedOnly: true, scenario: preset, trialRequested: trial, oneAgentTask: true, noCloudOrModelServiceReconfiguration: true, fixtureApprovalNotHumanSubject: true },
  isolation: {}, versions: {},
}

const utc = () => new Date().toISOString()
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const fileHash = path => sha(readFileSync(path))
const check = (condition, code) => { if (!condition) throw new Error(code) }
const isId = value => typeof value === 'string' && /^[a-zA-Z0-9_.:-]{1,150}$/.test(value)
function save() {
  const tmp = `${output}.tmp`
  writeFileSync(tmp, `${JSON.stringify(evidence, null, 2)}\n`)
  renameSync(tmp, output)
}
function update(next) {
  stage = next
  evidence.stage = stage
  save()
  console.log(`[${tag}] ${stage}`)
}
function cmd(exe, args, opts = {}) {
  const result = spawnSync(exe, args, { cwd: root, env, windowsHide: true, timeout: 7000, encoding: 'utf8', ...opts })
  check(result.status === 0, `local-command-failed:${exe.split(/[\\/]/).at(-1)}`)
  return result.stdout.trim()
}
function executable(name) {
  return cmd('where.exe', [name]).split(/\r?\n/).find(p => p.toLowerCase().endsWith(`\\${name}.exe`))
}
function child(label, entry, args, cwd, overrides) {
  const childProcess = spawn(process.execPath, [entry, ...args], { cwd, env: { ...env, ...overrides }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  const state = { label, child: childProcess, log: '', exited: false }
  const collect = b => { state.log = (state.log + b.toString()).slice(-60_000) }
  childProcess.stdout.on('data', collect)
  childProcess.stderr.on('data', collect)
  childProcess.on('exit', () => { state.exited = true })
  childProcess.on('error', () => { state.exited = true })
  children.add(state)
  return state
}
async function reserve() {
  const socket = createServer()
  await new Promise((ok, fail) => socket.once('error', fail).listen({ port: 0, host, exclusive: true }, ok))
  const record = { socket, port: socket.address().port }
  reservations.push(record)
  return record
}
async function release(r) {
  if (r.socket.listening) await new Promise(ok => r.socket.close(ok))
}
function listeners(port) {
  return cmd('netstat.exe', ['-ano', '-p', 'tcp']).split(/\r?\n/).map(s => s.trim().split(/\s+/))
    .filter(r => r[0] === 'TCP' && r[1]?.endsWith(`:${port}`) && /^(?:0\.0\.0\.0|\[::\]):0$/.test(r[2]) && r.length === 5)
    .map(r => ({ address: r[1].slice(0, -(String(port).length + 1)), pid: Number(r[4]) }))
}
function assertListener(port, owner) {
  const rows = listeners(port)
  check(rows.length === 1 && rows[0].address === host && rows[0].pid === owner, 'unexpected-actual-listener')
  return { address: host, port, disposableProcessOwnershipVerified: true, checkedAt: utc() }
}
async function poll(code, ms, fn) {
  const deadline = Date.now() + ms
  do {
    check(!cancel.signal.aborted, 'interrupted')
    const value = await fn()
    if (value) return value
    await sleep(400)
  } while (Date.now() < deadline)
  throw new Error(code)
}
async function request(port, method, path, body, auth, ms = 7000) {
  check(path.startsWith('/api/') && !path.includes('\\'), 'unsafe-api-path')
  const response = await fetch(`http://${host}:${port}${path}`, {
    method, redirect: 'error', signal: AbortSignal.timeout(ms),
    headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(auth ? { authorization: `Bearer ${auth}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const envelope = await response.json().catch(() => null)
  const code = envelope?.code ?? envelope?.data?.code
  if (!response.ok || !envelope || (code != null && code !== 0)) {
    throw new Error(`${method} ${path.split('?')[0]}:HTTP-${response.status}${typeof code === 'string' && /^[A-Z_0-9]{2,60}$/.test(code) ? `:${code}` : ''}`)
  }
  return envelope.data ?? envelope
}
const app = (m, p, b, ms) => request(ports.app.port, m, p, b, token, ms)
const sim = (m, p, b, ms) => request(ports.sim.port, m, p, b, undefined, ms)
const ready = (label, proc, probe) => poll(`${label}-startup-timeout`, 24_000, async () => {
  if (proc.exited) throw new Error(`${label}-exited-during-startup`)
  return probe().catch(() => null)
})
function treeHash(dir, accept) {
  const files = readdirSync(dir, { recursive: true, withFileTypes: true }).filter(f => f.isFile()).map(f => join(f.parentPath, f.name))
    .map(p => relative(dir, p).replaceAll('\\', '/')).filter(accept).sort()
  const hash = createHash('sha256')
  for (const p of files) hash.update(`${p}\0${fileHash(join(dir, p))}\n`)
  return { sha256: hash.digest('hex'), fileCount: files.length }
}
function patchCopy(path, from, to) {
  const file = join(simRoot, path)
  const text = readFileSync(file, 'utf8').replaceAll('\r\n', '\n')
  check(text.split(from).length === 2, 'disposable-simulator-copy-shape-changed')
  writeFileSync(file, text.replace(from, to))
}
function jsonLines(path) {
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8').split(/\r?\n/).flatMap(s => {
    try { return s ? [JSON.parse(s)] : [] }
    catch { return [] } // a live writer may be finishing its last line
  })
}
function pair(events, tool, startType, endType, idField) {
  const rows = events.filter(r => r.tool === tool && r.actor_agent_id === agentId && r.channel_id === channelId && r.task_id === taskId && r.run_id === tag)
  const starts = rows.filter(r => r.event_type === startType)
  const ends = rows.filter(r => r.event_type === endType)
  check(starts.length <= 1 && ends.length <= 1, `unexpected-repeated-${tool}`)
  if (!starts.length) return null
  check(isId(starts[0][idField]) && (!ends.length || ends[0][idField] === starts[0][idField]), `unjoined-${tool}-events`)
  return { start: starts[0], end: ends[0] }
}
const adapter = tool => pair(jsonLines(ompTrace), tool, 'tool_execution_start', 'tool_execution_end', 'tool_call_id')
const dispatch = tool => pair(jsonLines(govTrace), tool, 'tool_invocation_start', 'tool_invocation_end', 'invocation_id')
function verifyCallsAllowed(...tools) {
  const calls = jsonLines(govTrace).filter(r => r.event_type === 'tool_invocation_start')
  check(calls.every(r => r.run_id === tag && r.harness === 'omp' && r.actor_agent_id === agentId && r.channel_id === channelId && r.task_id === taskId && tools.includes(r.tool)), 'unexpected-host-tool-call')
}
function modelMessages(callId) {
  const sessionFiles = existsSync(sessions) ? readdirSync(sessions, { recursive: true, withFileTypes: true }) : []
  return sessionFiles.filter(f => f.isFile() && f.name.endsWith('.jsonl')).flatMap(f => {
    const rows = jsonLines(join(f.parentPath, f.name))
    const matching = rows.filter(r => r.type === 'message' && r.message?.role === 'assistant' && r.message.content?.some(c => c.type === 'toolCall' && c.id === callId))
    return matching.map(r => ({ provider: r.message.provider, model: r.message.model, at: r.timestamp, toolsInMessage: r.message.content.filter(c => c.type === 'toolCall').length }))
  })
}
async function setup() {
  check(process.platform === 'win32' && Number(process.versions.node.split('.')[0]) >= 24, 'requires-Windows-Node-24')
  mkdirSync(home)
  mkdirSync(userHome)
  mkdirSync(workspace)
  mkdirSync(sessions)
  const omp = executable('omp')
  const lms = executable('lms')
  check(omp && lms && existsSync(appEntry), 'trusted-app-or-OMP-or-LM-Studio-unavailable')
  const ver = cmd(omp, ['--version'])
  check(/^omp\/\d[\w.-]*$/.test(ver), 'unrecognized-OMP-version')
  // LMS CLI must use its existing installation state; this is read-only status, never load or config.
  const lmsState = cmd(lms, ['ps', '--json'], { env: { ...osEnv, USERPROFILE: process.env.USERPROFILE, LOCALAPPDATA: process.env.LOCALAPPDATA, APPDATA: process.env.APPDATA, TEMP: process.env.TEMP } })
  const models = JSON.parse(lmsState)
  const m = models[0]
  check(models.length === 1 && m?.identifier === model && m.contextLength === 65536 && m.parallel === 1 && m.queued === 0 && m.status === 'idle', 'local-Gemma-not-single-loaded-idle-at-64k')
  const lmModels = await fetch(`http://${host}:1234/v1/models`, { redirect: 'error', signal: AbortSignal.timeout(4000) }).then(r => r.ok ? r.json() : null)
  check(lmModels?.data?.some(row => row.id === model), 'loopback-Gemma-model-API-unavailable')
  const gitHead = cmd('git', ['-C', repo, 'rev-parse', 'HEAD'])
  const simGitHead = cmd('git', ['-C', simSource, 'rev-parse', 'HEAD'])
  check([gitHead, simGitHead].every(x => /^[a-f0-9]{40,64}$/.test(x)), 'unexpected-git-identity')
  evidence.versions = {
    node: process.version, platform: process.platform, arch: process.arch, omp: ver,
    model: { provider, id: model, quantization: m.quantization?.name === 'Q4_0' ? 'Q4_0' : null, contextLength: m.contextLength, parallel: m.parallel },
    app: { package: manifest(join(repo, 'package.json')).version, sourceGitHead: gitHead,
      executedBundle: treeHash(join(repo, '.output/server'), p => !p.startsWith('node_modules/') && p.endsWith('.mjs')),
      entryMtimeUtc: statSync(appEntry).mtime.toISOString(), sourceToBundleEquivalenceVerified: false },
    simulator: { package: manifest(join(simSource, 'package.json')).version, sourceGitHead: simGitHead, nodeOpcua: requireSim('node-opcua/package.json').version },
    scriptSha256: fileHash(script),
  }
  const expectedProfile = join(userHome, '.omp', 'profiles', tag, 'agent')
  check(!existsSync(expectedProfile), 'OMP-profile-already-exists')
  const cfgPath = resolve(cmd(omp, ['--profile', tag, 'config', 'path']))
  check(cfgPath.toLowerCase() === expectedProfile.toLowerCase() && readdirSync(cfgPath).every(name => name === 'agent.db'), 'OMP-not-fresh-or-not-isolated')
  // Only the disposable profile is provisioned. No shared OMP config or credentials are copied.
  writeFileSync(join(cfgPath, 'models.yml'), `providers:\n  local:\n    baseUrl: http://${host}:1234/v1\n    apiKey: lm-studio\n    api: openai-completions\n    auth: apiKey\n    models:\n      - id: ${model}\n        name: Gemma 4 12B QAT\n        reasoning: false\n        input: [text]\n        contextWindow: 65536\n        maxTokens: 8192\n        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }\n`)
  writeFileSync(join(cfgPath, 'config.yml'), `modelRoles:\n  default: ${provider}/${model}\nsetupVersion: 2\ndev:\n  autoqaConsent: denied\n`)
  evidence.isolation.omp = { freshProfileInDisposableHome: true, providerOnly: provider, noCopiedAuthOrMcp: true, builtInToolsAndDiscoveryDisabled: true }
  ports = Object.fromEntries(await Promise.all(['sim', 'mqtt', 'opcua', 'modbus', 'app', 'objectsOffline'].map(async k => [k, await reserve()])))
  update('disposable-timescale-startup')
  const imageId = docker(['image', 'inspect', '--format', '{{.Id}}', timescaleImage])
  check(/^sha256:[a-f0-9]{64}$/.test(imageId), 'cached-Timescale-image-unavailable')
  const launched = docker(['run', '--rm', '-d', '--pull=never', '--name', tag, '--label', `aw.tii.run=${tag}`, '--env', `POSTGRES_PASSWORD=${pgPassword}`, '--env', 'POSTGRES_DB=awshop', '-p', `${host}:0:5432`, imageId], { timeout: 15_000 })
  check(/^[a-f0-9]{64}$/.test(launched), 'cannot-attest-Timescale-container-id')
  containerId = launched
  const portsJson = JSON.parse(docker(['inspect', '--format', '{{json .NetworkSettings.Ports}}', containerId]))
  const mapping = portsJson['5432/tcp']
  tsPort = Number(mapping?.[0]?.HostPort)
  check(mapping?.length === 1 && mapping[0].HostIp === host && Number.isInteger(tsPort) && tsPort >= 1024 && tsPort !== 5432, 'Timescale-not-published-loopback-only')
  db = new Pool({ host, port: tsPort, user: 'postgres', password: pgPassword, database: 'awshop', connectionTimeoutMillis: 1800, query_timeout: 3500, options: '-c default_transaction_read_only=on' })
  db.on('error', () => {})
  const versions = await poll('isolated-Timescale-not-ready', 14_000, () => db.query('SELECT current_setting(\'server_version_num\') AS postgres, extversion AS timescale FROM pg_extension WHERE extname=\'timescaledb\'').then(r => r.rows[0]).catch(() => null))
  check(/^\d+$/.test(versions.postgres) && /^\d[\w.+-]*$/.test(versions.timescale), 'unrecognized-Timescale-version')
  evidence.versions.database = { ...versions, cachedImageId: imageId }
  evidence.isolation.timescale = { publishedAddress: host, publishedPort: tsPort, noSharedMounts: true, noImagePull: true, runnerQueriesReadOnly: true }
  const mqttImageId = docker(['image', 'inspect', '--format', '{{.Id}}', mqttImage])
  check(/^sha256:[a-f0-9]{64}$/.test(mqttImageId), 'cached-Mosquitto-image-unavailable')
  // The simulator mini-broker does not deliver to the publishing socket; AW's
  // queue uses a single client to publish/subscribe, so give it a standards broker.
  const mqttLaunch = docker(['run', '--rm', '-d', '--pull=never', '--name', `${tag}-queue`, '--label', `aw.tii.run=${tag}`, '-p', `${host}:0:1883`, mqttImageId, 'sh', '-ec', 'printf \'listener 1883\nallow_anonymous true\npersistence false\n\' >/tmp/tii-mqtt.conf; exec mosquitto -c /tmp/tii-mqtt.conf'], { timeout: 15_000 })
  check(/^[a-f0-9]{64}$/.test(mqttLaunch), 'cannot-attest-Mosquitto-container-id')
  mqttContainerId = mqttLaunch
  const mqttMapping = JSON.parse(docker(['inspect', '--format', '{{json .NetworkSettings.Ports}}', mqttContainerId]))['1883/tcp']
  mqttQueuePort = Number(mqttMapping?.[0]?.HostPort)
  check(mqttMapping?.length === 1 && mqttMapping[0].HostIp === host && Number.isInteger(mqttQueuePort) && mqttQueuePort >= 1024 && mqttQueuePort !== 1883 && mqttQueuePort !== ports.mqtt.port, 'Mosquitto-not-published-loopback-only')
  evidence.versions.queueBroker = { image: mqttImage, cachedImageId: mqttImageId }
  evidence.isolation.mqttQueue = { publishedAddress: host, publishedPort: mqttQueuePort, noSharedMounts: true, noImagePull: true, separateFromSimulatedDeviceBroker: true }
  const configOverrides = { 'daq.startInfrastructure': 'never', 'daq.mqtt.host': host, 'daq.mqtt.port': mqttQueuePort, 'daq.timescale.host': host, 'daq.timescale.port': tsPort, 'daq.objectstore.host': host, 'daq.objectstore.port': ports.objectsOffline.port }
  writeFileSync(join(home, 'runtime-settings.json'), JSON.stringify({ version: 1, updatedAt: utc(), overrides: configOverrides }))
  const pluginNames = ['server/plugins-builtin', '.AgentWorkShop/plugins'].flatMap(p => readdirSync(join(repo, p), { withFileTypes: true }).filter(x => x.isDirectory()).map(x => x.name))
  writeFileSync(join(home, 'plugins-state.json'), JSON.stringify({ version: 1, updatedAt: utc(), disabled: [...new Set(pluginNames)] }))
  mkdirSync(join(home, 'data'))
  mkdirSync(join(home, 'shared/config'), { recursive: true })
  cpSync(join(repo, 'shared/config/schema.json'), join(home, 'shared/config/schema.json'))
  cpSync(join(repo, 'config.yml'), join(home, 'config.yml'))
  cpSync(join(repo, '.AgentWorkShop/prompts'), join(home, 'prompts'), { recursive: true })
  return { omp, configOverrides }
}

async function bootSimulator() {
  update('simulator-startup')
  mkdirSync(simRoot)
  cpSync(join(simSource, 'src'), join(simRoot, 'src'), { recursive: true })
  cpSync(join(simSource, 'package.json'), join(simRoot, 'package.json'))
  symlinkSync(join(simSource, 'node_modules'), join(simRoot, 'node_modules'), 'junction')
  // `hostname` alone sets the advertised URL, not the TCP bind. Pass `host` as well.
  patchCopy('src/server/protocols/opcua.ts', '    hostname,\n', '    hostname,\n    host: \'127.0.0.1\',\n')
  evidence.versions.simulator.executedCopy = treeHash(join(simRoot, 'src'), p => p.endsWith('.ts'))
  evidence.versions.simulator.copyPatch = 'OPCUAServer host=127.0.0.1; advertised hostname kept separate'
  await release(ports.sim)
  await release(ports.mqtt)
  const tsx = pathToFileURL(requireSim.resolve('tsx')).href
  simProc = child('simulator', '--import', [tsx, join(simRoot, 'src/server/index.ts')], simRoot, {
    SIM_HOST: host, SIM_PORT: String(ports.sim.port), MQTT_BROKER_PORT: String(ports.mqtt.port), AW_SIM_ATTEST_NONCE: nonce,
  })
  // The standard simulator TS source is executed with its installed tsx loader.
  const attestation = await ready('simulator', simProc, () => sim('GET', '/api/attestation', undefined, 1500))
  check(attestation.nonce === nonce && attestation.pid === simProc.child.pid && attestation.simPort === ports.sim.port, 'simulator-attestation-mismatch')
  evidence.isolation.listeners = {
    simulatorHttp: assertListener(ports.sim.port, simProc.child.pid), mqtt: assertListener(ports.mqtt.port, simProc.child.pid),
  }
  check((await sim('GET', '/api/nodes')).length === 0, 'simulator-nodes-not-fresh')
  const blueprint = await sim('GET', `/api/presets/${preset}`)
  const allow = new Map([['dev-extruder-mbtcp', 'modbus-tcp'], ['dev-extruder-opcua', 'opcua'], ['dev-gauge-mqtt', 'mqtt'], ['dev-inspect-http', 'http']])
  const selected = blueprint.nodes.filter(n => allow.get(n.id) === n.protocol)
  check(selected.length === allow.size, 'preset-shape-changed')
  await release(ports.opcua)
  await release(ports.modbus)
  for (const n of selected) {
    update(`simulator-device-${n.protocol}`)
    if (n.protocol === 'opcua') Object.assign(n.config, { host, port: ports.opcua.port })
    if (n.protocol === 'modbus-tcp') Object.assign(n.config, { host, port: ports.modbus.port })
    if (n.protocol === 'mqtt') n.config.brokerUrl = `mqtt://${host}:${ports.mqtt.port}`
    const created = await sim('POST', '/api/nodes', n, n.protocol === 'opcua' ? 23_000 : 10_000)
    check(created.id === n.id && created.runtime?.running && !created.runtime?.lastError, `simulator-device-not-running:${n.protocol}`)
  }
  // Verify actual OS sockets before launching AW or allowing any app-side control operation.
  evidence.isolation.listeners.opcUa = assertListener(ports.opcua.port, simProc.child.pid)
  evidence.isolation.listeners.modbus = assertListener(ports.modbus.port, simProc.child.pid)
  const plant = { ...blueprint.plantModel, id: tag, seed: 42, timeScale: 1, truthExport: false }
  plant.outputs = Object.fromEntries(Object.entries(plant.outputs).filter(([, b]) => allow.has(b.nodeId) && !['profile', 'defectImage'].includes(b.signalId)))
  await sim('PUT', '/api/plant/config', { plantModel: plant, warm: true, upsert: true })
  const mv = (await sim('GET', '/api/nodes/dev-extruder-opcua/export')).items.find(i => i.signal === 'ScrewSpeedSP')
  const pv = (await sim('GET', '/api/nodes/dev-gauge-mqtt/export')).items.find(i => i.signal === 'thick')
  check(mv?.driver === 'opcua' && mv.driverConfig.endpoint === `opc.tcp://${host}:${ports.opcua.port}` && /^ns=2;s=AW\.N\.Sp$/.test(mv.driverConfig.nodeId), 'unexpected-OPCUA-export')
  check(pv?.driver === 'mqtt' && pv.driverConfig.host === host && pv.driverConfig.port === ports.mqtt.port && pv.driverConfig.topic === 'aw/sim/thick', 'unexpected-MQTT-export')
  evidence.scene = { seed: plant.seed, timeScale: plant.timeScale, control: 'ScrewSpeedSP', baseline, candidate: trial ? candidate : null, stepLimit, mvDriver: 'opcua', pvSignal: 'thick', pvDriver: 'mqtt', pvUnit: pv.unit, excludedPresetTransport: 'Modbus RTU' }
  update('simulator-loopback-sockets-verified')
  return { mv, pv }
}

async function bootApp(configOverrides) {
  update('app-startup')
  for (const key of ['app', 'objectsOffline']) await release(ports[key])
  appProc = child('app', appEntry, [], home, {
    AW_HOME: home, AW_MODE: 'home', AW_DATA_DIR: join(home, 'data'), AW_PROMPTS_DIR: join(home, 'prompts'),
    HOST: host, NITRO_HOST: host, PORT: String(ports.app.port), NITRO_PORT: String(ports.app.port),
    NUXT_SESSION_PASSWORD: randomBytes(32).toString('hex'), BACKUP_DISABLED: '1', AW_ALLOW_PRIVATE_OUTBOUND: '1',
    NUXT_DAQ_START_INFRASTRUCTURE: 'never',
    NUXT_DAQ_MQTT_HOST: host, NUXT_DAQ_MQTT_PORT: String(mqttQueuePort),
    NUXT_DAQ_TIMESCALE_HOST: host, NUXT_DAQ_TIMESCALE_PORT: String(tsPort),
    AW_DAQ_TIMESCALE_PASSWORD: pgPassword,
    NUXT_DAQ_OBJECTSTORE_HOST: host, NUXT_DAQ_OBJECTSTORE_PORT: String(ports.objectsOffline.port),
    AW_AGENTTEAM_EVENT_LOG: ompTrace, AW_AGENTTEAM_RUN_ID: tag,
    AW_GOV_HARNESS_EVENT_LOG: govTrace, AW_GOV_HARNESS_RUN_ID: tag,
  })
  const health = await ready('app', appProc, async () => {
    const h = await app('GET', '/api/health', undefined, 1500)
    return h?.status === 'ok' && h.workshop === 'ready' ? h : null
  })
  evidence.isolation.listeners.app = assertListener(ports.app.port, appProc.child.pid)
  check(typeof health.version === 'string' && /^[a-zA-Z0-9.+-]{1,40}$/.test(health.version), 'unexpected-app-health-version')
  evidence.versions.app.healthVersion = health.version
  evidence.versions.app.healthAppMode = ['production', 'development', 'prod', 'dev', 'home', 'repo'].includes(health.mode) ? health.mode : 'unrecognized'
  check(existsSync(join(home, 'data', 'workshop.sqlite')), 'workshop-database-not-in-fresh-AW_HOME')
  const reg = await app('POST', '/api/users/register', { name: 'Isolated experiment operator', email: `${tag}@example.invalid`, password: `Tii-${randomBytes(18).toString('hex')}` })
  check(reg.user?.role === 'admin' && reg.token, 'fresh-first-admin-not-created')
  token = reg.token
  adminId = reg.user.id
  const settings = await app('GET', '/api/system/settings')
  for (const [k, v] of Object.entries(configOverrides)) {
    check(String(settings.effective?.[k]) === String(v), `unexpected-effective-setting:${k}`)
  }
  const { plugins } = await app('GET', '/api/workshop/plugins')
  check(Array.isArray(plugins) && plugins.every(p => p.enabled === false), 'unexpected-enabled-plugin')
  evidence.isolation.app = { freshHomeMode: true, disposableCwd: true, enabledPluginCount: 0, loopbackOnlyInfrastructureSettings: true, infrastructureAutoStart: false }
  const daq = await app('GET', '/api/workshop/daq')
  recordDaqStatus(daq)
  update('app-fresh-home-verified')
}

async function provision({ mv, pv }, omp) {
  update('provision-isolated-line-and-agent')
  const { line } = await app('POST', '/api/workshop/dcw/lines', { name: 'Isolated cast-film', simulated: true, controlMode: 'manual', simSceneId: preset })
  check(line?.simulated === true && line.controlMode === 'manual' && isId(line.id), 'not-a-manual-simulated-line')
  lineId = line.id
  const { product } = await app('POST', '/api/workshop/dcw/products', { lineId, name: 'Synthetic film' })
  const { template } = await app('POST', '/api/workshop/dcw/templates', { name: 'Simulated screw speed', unit: mv.unit, min: mv.min, max: mv.max, decimals: mv.decimals })
  const { node: control } = await app('POST', '/api/workshop/dcw', { lineId, name: 'Screw speed SP', templateRef: template.key, driver: mv.driver, driverConfig: mv.driverConfig, unit: mv.unit, min: mv.min, max: mv.max, decimals: mv.decimals, stepLimit, holdIntervalMs: 2000, readIntervalMs: 1000 })
  const { node } = await app('POST', '/api/workshop/daq', { lineId, name: 'Film thickness', templateRef: 'daq-temp-tc', driver: pv.driver, driverConfig: pv.driverConfig, unit: pv.unit, min: pv.min, max: pv.max, intervalMs: 1000, publishIntervalMs: 0, semantics: 'Simulated cast-film thickness' })
  nodeId = node.id
  controlId = control.id
  const { recipe } = await app('POST', '/api/workshop/dcw/recipes', { name: 'Simulated film baseline', productId: product.id, params: [{ nodeId: controlId, templateRef: template.key, value: baseline, min: mv.min, max: mv.max, stepLimit }] })
  recipeId = recipe.id
  check([product.id, controlId, nodeId, recipeId].every(isId), 'invalid-provisioned-ids')
  const start = await app('POST', `/api/workshop/dcw/lines/${lineId}/start`, { recipeId }, 12_000)
  lineStarted = true
  runId = start.run?.id
  check(isId(runId), 'no-active-line-run-id')
  const channel = await app('POST', '/api/workshop/channels', { name: 'Isolated paper DAQ trace', description: 'One local model task on a simulated twin' })
  channelId = channel.channelId
  check(isId(channelId), 'invalid-channel-id')
  const agent = await app('POST', `/api/workshop/channels/${channelId}/agents`, {
    name: 'Paper DAQ agent', harness: 'omp', role: 'lead', config: {
      command: omp, cwd: workspace, provider, model, rpcMode: 'rpc', promptTimeoutMs: 100_000,
      args: ['--profile', tag, '--model', `${provider}/${model}`, '--session-dir', sessions, '--no-extensions', '--no-skills', '--no-rules', '--no-lsp', '--no-pty', '--no-tools', '--no-title', '--thinking', 'off'],
    },
  })
  agentId = agent.id
  check(isId(agentId) && agent.harness === 'omp', 'unexpected-agent-registration')
  const binds = [{ kind: 'daq', nodeId, mode: 'auto' }]
  if (trial) binds.push({ kind: 'recipe', nodeId: recipeId, mode: 'manual' })
  for (const b of binds) {
    const { binding } = await app('POST', '/api/workshop/agent-tools/bindings', { agentId, ...b })
    check(binding.kind === b.kind && binding.mode === b.mode && binding.nodeId === b.nodeId, 'binding-mismatch')
  }
  evidence.entities = { lineId, productId: product.id, recipeId, controlId, daqNodeId: nodeId, channelId, agentId, activeRunId: runId }
  evidence.lineStart = { runId, startedAt: start.run.startedAt, baselineFixtureWrite: true, controlMode: 'manual' }
  evidence.bindings = binds
}

async function rowsIn(fromMs, toMs) {
  let result
  try {
    result = await db.query(`SELECT node_id AS "nodeId", (EXTRACT(EPOCH FROM ts) * 1000)::bigint AS "tsMs", value, state, quality, line_id AS "lineId", product_id AS "productId", recipe_id AS "recipeId", run_id AS "runId", ingested_at AS "ingestedAtMs" FROM daq_samples WHERE node_id=$1 AND line_id=$2 AND product_id=$3 AND recipe_id=$4 AND run_id=$5 AND ts BETWEEN $6::timestamptz AND $7::timestamptz ORDER BY ts LIMIT 20`, [nodeId, lineId, evidence.entities.productId, recipeId, runId, new Date(fromMs).toISOString(), new Date(toMs).toISOString()])
  }
  catch (error) {
    const state = typeof error.code === 'string' && /^[A-Z0-9_]{4,25}$/.test(error.code) ? error.code : 'client-error'
    throw new Error(`read-only-Timescale-row-query-failed:${state}`, { cause: error })
  }
  return result.rows.map(({ tsMs, ingestedAtMs, ...row }) => ({ ...row, tsMs: Number(tsMs), ingestedAtMs: Number(ingestedAtMs) }))
}
async function captureSamples(count, strictlyAfterMs) {
  const raw = await poll('standard-MQTT-collector-no-fresh-run-tagged-raw-samples', 16_000, async () => {
    const rows = await rowsIn(strictlyAfterMs + 1, Date.now())
    return rows.length >= count ? rows.slice(0, count) : null
  })
  check(raw.every(r => Number.isFinite(r.value) && r.value > 0 && r.state === 'ok' && r.quality === 'good' && r.ingestedAtMs >= r.tsMs), 'unexpected-collector-raw-sample')
  const fromMs = raw[0].tsMs
  const toMs = raw.at(-1).tsMs
  check(new Set(raw.map(r => Math.floor(r.tsMs / 1000))).size === count, 'multiple-raw-samples-in-DAQ-bucket')
  return { source: 'normal passive MQTT subscription collector → MQTT queue → TimescaleDB daq_samples (runner SELECT only)', fromMs, toMs, raw }
}

function recordDaqStatus(daq) {
  evidence.isolation.daq = { standardCollectorRunning: daq.controller?.running === true, mqttOnline: daq.infra?.mqttOnline === true, timescaleOnline: daq.infra?.tsdbOnline === true, degraded: daq.infra?.degraded === true, objectStoreOnline: daq.infra?.objectStoreOnline === true }
  const error = daq.infra?.lastError ?? ''
  evidence.isolation.daq.diagnostics = Object.entries({ databaseAuth: /password authentication|28P01/i, extension: /hypertable|extension/i, database: /database|postgres/i, queue: /mqtt|connack/i, startupFailure: /初始化|装配|失败/ }).filter(([, pattern]) => pattern.test(error)).map(([k]) => k)
  save()
  const s = evidence.isolation.daq
  return s.standardCollectorRunning && s.mqttOnline && s.timescaleOnline && !s.degraded
}

async function observe() {
  update('baseline-DAQ-sampling')
  const { test } = await app('POST', `/api/workshop/daq/${nodeId}/test`, undefined, 7000)
  if (test?.ok && Number.isFinite(test.sampleValue)) {
    evidence.protocolProbe = { at: utc(), source: 'independent invocation of AW MQTT driver test, not an ingest', value: test.sampleValue, unit: evidence.scene.pvUnit }
    update('MQTT-protocol-probe-observed')
  }
  if (!recordDaqStatus(await app('GET', '/api/workshop/daq'))) {
    await app('POST', '/api/workshop/daq/infra/reconnect', {}, 9500).catch(() => null)
    await poll('standard-DAQ-collector-not-ready', 8000, async () => recordDaqStatus(await app('GET', '/api/workshop/daq')))
  }
  evidence.baseline = await captureSamples(4, Math.max(Date.now() - 2000, Date.parse(evidence.lineStart.startedAt) || 0))
  update('normal-collector-run-tagged-raw-samples-proven')
  const { fromMs, toMs, raw } = evidence.baseline
  const args = { node_id: nodeId, run_id: runId, from_ms: fromMs, to_ms: toMs, bucket_ms: 1000, limit: 4 }
  const trialArgs = { recipe_id: recipeId, params: [{ node_id: controlId, value: candidate }] }
  const description = [
    'On the isolated simulator, your first action must be a real call to the registered host tool with canonical name daq_query. Use these exact arguments:', JSON.stringify(args),
    'Do not substitute a text answer for the tool call. Call it exactly once. Do not invent readings.',
    ...(trial ? ['Once it returns nonempty thickness data, make one and only one recipe_trial call using these parameters:', JSON.stringify(trialArgs), 'Add a short hypothesis grounded in the returned observations; this is a bounded simulated test, not optimization. No emergency, no retry, no other write tool. Wait for the approval decision and result.'] : ['Do not call any write or recipe tool.']),
    'Then briefly report what actually happened and finish by calling complete_task once on this current root task. Do not call unrelated tools.',
  ].join(' ')
  const submittedAtMs = Date.now()
  const task = await app('POST', `/api/workshop/channels/${channelId}/tasks`, { title: 'Read run-scoped film thickness from DAQ', description, assigneeId: agentId, mode: 'goal', modeConfig: { completionPolicy: 'no-deliverable' }, fromLabel: 'Isolated experiment fixture' })
  taskId = task.id
  check(isId(taskId), 'task-not-created')
  evidence.entities.taskId = taskId
  evidence.task = { submittedAtMs, promptSha256: sha(description), description }
  update('awaiting-real-OMP-DAQ-result')
  const { a, d } = await poll('no-joined-OMP-daq_query-result-within-65s', 65_000, async () => {
    const a = adapter('daq_query'), d = dispatch('daq_query')
    if (a?.end && d?.end) return { a, d }
    const t = await taskDetail()
    if (terminal(t.state)) throw new Error(`task-ended-before-DAQ:${t.state}`)
    return null
  })
  const selectedArgs = a.start.request
  check(Object.keys(args).every(k => String(selectedArgs?.[k]) === String(args[k]) && String(d.start.request?.[k]) === String(args[k])), 'DAQ-arguments-do-not-match-exact-window')
  const text = a.end.response
  check(!a.end.is_error && !d.end.is_error && typeof text === 'string' && text === d.end.response?.text, 'DAQ-result-not-successful-or-not-identical')
  const resultLine = text.split('\n').find(s => /^ {2}样本 /.test(s))
  const seriesLine = text.split('\n').find(s => /^ {2}最近序列: /.test(s))
  check(resultLine?.includes(`样本 ${raw.length} 点`) && text.includes(`[id=${nodeId}]`) && text.includes(`run=${runId}`) && text.includes('降采样 1000ms'), 'DAQ-result-does-not-join-node-run-and-sample-count')
  const expected = raw.map(r => `${new Date(r.tsMs).toISOString().slice(11, 19)}=avg ${Number(r.value.toFixed(2))}(n=1)`).join('; ')
  check(seriesLine === `  最近序列: ${expected}`, 'DAQ-series-does-not-match-singleton-raw-buckets')
  const modelRecords = await poll('OMP-model-call-session-provenance-missing', 6000, () => {
    const records = modelMessages(a.start.tool_call_id)
    return records.length ? records : null
  })
  check(modelRecords.length === 1 && modelRecords.every(r => r.provider === provider && r.model === model), 'OMP-call-not-proven-local-Gemma')
  check(Date.parse(a.start.at_utc) >= submittedAtMs && Date.parse(a.start.at_utc) - raw.at(-1).tsMs < 75_000, 'DAQ-not-fresh-for-this-task')
  verifyCallsAllowed('daq_query', 'complete_task', ...(trial ? ['recipe_trial'] : []))
  evidence.agentDaq = {
    taskId, channelId, agentId, runId, callId: a.start.tool_call_id, invocationId: d.start.invocation_id,
    adapterStartAt: a.start.at_utc, adapterEndAt: a.end.at_utc, dispatchStartAt: d.start.at_utc, dispatchEndAt: d.end.at_utc,
    arguments: args, successful: true, modelSessionCall: modelRecords[0], resultSha256: sha(text),
    resultExcerpt: [resultLine.trim(), seriesLine.trim()], outputResolution: '1000 ms avg buckets, exactly one raw observation per bucket; original UTC milliseconds are in baseline.raw',
    latestRawSampleAgeMsAtCall: Date.parse(a.start.at_utc) - raw.at(-1).tsMs,
  }
  evidence.status = 'agent-daq-proven'
  update('real-agent-DAQ-proven')
}

const terminal = state => ['COMPLETED', 'FAILED', 'CANCELED', 'BLOCKED', 'EXPIRED'].includes(state)
const taskDetail = () => app('GET', `/api/workshop/tasks/${taskId}?channelId=${channelId}`)
const approvals = async scope => (await app('GET', `/api/workshop/agent-tools/approvals?agentId=${agentId}&scope=${scope}`)).approvals

async function readControl() {
  const { OPCUAClient, AttributeIds, StatusCodes } = requireSim('node-opcua')
  const client = OPCUAClient.create({ endpointMustExist: false, connectionStrategy: { maxRetry: 0 }, keepSessionAlive: false })
  const endpoint = `opc.tcp://${host}:${ports.opcua.port}`
  let session
  try {
    await client.connect(endpoint)
    session = await client.createSession()
    const rd = await session.read({ nodeId: 'ns=2;s=AW.N.Sp', attributeId: AttributeIds.Value })
    check(rd.statusCode.value === StatusCodes.Good.value && Number.isFinite(rd.value.value), 'independent-OPCUA-read-failed')
    return { at: utc(), value: rd.value.value, source: 'independent OPC UA client session (not AW cached value or ACK)' }
  }
  finally {
    if (session) await session.close().catch(() => {})
    await client.disconnect().catch(() => {})
  }
}

async function governedTrial() {
  update('awaiting-exact-recipe-trial-card')
  const joined = await poll('no-exact-pending-card-within-45s', 45_000, async () => {
    const d = dispatch('recipe_trial'), a = adapter('recipe_trial')
    const pending = await approvals('pending')
    check(Array.isArray(pending) && pending.length <= 1, 'unexpected-pending-card-count')
    if (d?.end?.is_error || a?.end?.is_error) throw new Error('recipe_trial-rejected-before-approval')
    if (pending.length === 1 && d?.start && a?.start) return { card: pending[0], a, d }
    const t = await taskDetail()
    if (terminal(t.state)) throw new Error(`task-ended-before-approval:${t.state}`)
    return null
  })
  const { card, a, d } = joined
  const p = card.payload
  const args = d.start.request
  const params = p?.params
  check(isId(card.id) && card.agentId === agentId && card.nodeId === `recipe:${recipeId}` && card.status === 'pending'
    && p?.kind === 'recipe-gate' && p.op === 'trial' && p.recipeId === recipeId && p.runId === runId && p.context?.lineId === lineId
    && !p.emergency && !args.emergency && args.recipe_id === recipeId && args.params?.length === 1
    && args.params[0]?.node_id === controlId && Number(args.params[0]?.value) === candidate
    && Array.isArray(params) && params.length === 1 && params[0].nodeId === controlId && params[0].from === baseline && params[0].to === candidate
    && Date.parse(d.start.at_utc) >= Date.parse(evidence.agentDaq.dispatchEndAt), 'wrong-pending-card-or-unsafe-candidate')
  const modelRecords = await poll('OMP-trial-model-call-session-provenance-missing', 6000, () => {
    const records = modelMessages(a.start.tool_call_id)
    return records.length ? records : null
  })
  check(modelRecords.length === 1 && modelRecords[0].provider === provider && modelRecords[0].model === model, 'trial-not-proven-local-Gemma')
  verifyCallsAllowed('daq_query', 'recipe_trial')
  assertListener(ports.opcua.port, simProc.child.pid)
  const before = await readControl()
  check(before.value === baseline, 'pre-approval-independent-baseline-not-observed')
  const latest = await approvals('pending')
  check(latest?.length === 1 && latest[0].id === card.id && latest[0].status === 'pending' && JSON.stringify(latest[0].payload) === JSON.stringify(p), 'pending-card-changed-before-decision')
  evidence.trial = { taskId, runId, agentId, callId: a.start.tool_call_id, invocationId: d.start.invocation_id, requestedAt: d.start.at_utc, approvalId: card.id, pending: { recipeId, nodeId: controlId, from: baseline, to: candidate, emergency: false }, before, modelSessionCall: modelRecords[0] }
  update('exact-pending-card-verified')
  const comment = 'Approved by the isolated experiment fixture for the exact predeclared simulated candidate.'
  await app('POST', `/api/workshop/agent-tools/approvals/${card.id}/decide`, { approved: true, comment })
  const approved = (await approvals('history')).find(x => x.id === card.id)
  check(approved?.status === 'approved' && approved.decidedBy === adminId && approved.comment === comment, 'no-persisted-fixture-approval')
  evidence.trial.decision = { status: 'approved', actor: 'synthetic fixture administrator', approvalId: card.id, decidedAt: approved.decidedAt ?? null }
  update('fixture-approval-confirmed')
  const receipt = await poll('no-recipe-trial-result-within-20s', 20_000, () => {
    const a2 = adapter('recipe_trial'), d2 = dispatch('recipe_trial')
    return a2?.end && d2?.end ? { a2, d2 } : null
  })
  const text = receipt.a2.end.response
  check(!receipt.a2.end.is_error && !receipt.d2.end.is_error && typeof text === 'string' && text === receipt.d2.end.response?.text && !receipt.d2.end.response?.approval_bypassed, 'recipe-trial-result-error-or-bypass')
  const logs = (await app('GET', `/api/workshop/ops-logs?scope=line&lineId=${lineId}&recipeId=${recipeId}&limit=30`)).logs
  const detail = row => row.detail ?? JSON.parse(row.detailJson ?? '{}')
  const ts = logs.filter(x => x.action === 'recipe.trial'), acks = logs.filter(x => x.action === 'recipe.dispatch.ack' && detail(x).trial === true)
  check(ts.length === 1 && acks.length === 1, 'unexpected-trial-or-ACK-ledger-count')
  const trialRunId = detail(ts[0]).runId
  const ack = detail(acks[0]).ackSummary
  check(isId(trialRunId) && trialRunId === detail(acks[0]).runId && ack?.total === 1 && ack.verified === 1 && ack.failed === 0 && ack.unverified === 0, 'trial-ACK-not-joined-or-not-verified')
  const { run } = await app('GET', `/api/workshop/dcw/runs/${trialRunId}/data`)
  check(run.id === trialRunId && run.results?.length === 1 && run.results[0].nodeId === controlId && run.results[0].ok && run.results[0].verify?.verdict === 'verified', 'persisted-trial-run-not-verified')
  const drivers = jsonLines(govTrace).filter(x => x.event_type === 'driver_call_end' && x.invocation_id === d.start.invocation_id && x.task_id === taskId && x.node_id === controlId)
  check(drivers.length === 1 && drivers[0].requested_value === candidate && drivers[0].recipe_run_id === trialRunId && isId(drivers[0].driver_call_id), 'trial-not-joined-to-driver-call')
  const { anchors } = await app('GET', `/api/workshop/dcw/journal?lineId=${lineId}&nodeId=${controlId}&source=agent&limit=10`)
  const matching = anchors.filter(row => row.approvalId === card.id && row.nodeId === controlId && row.source === 'agent')
  check(matching.length === 1 && isId(matching[0].id), 'trial-not-joined-to-journal-anchor')
  const after = await readControl()
  check(after.value === candidate, 'independent-OPCUA-readback-differs')
  Object.assign(evidence.trial, { resultAt: receipt.d2.end.at_utc, resultSha256: sha(text), trialRunId, driverCallId: drivers[0].driver_call_id, journalId: matching[0].id, ack: { total: 1, verified: 1, failed: 0, unverified: 0 }, after })
  evidence.status = 'agent-daq-and-governed-trial-proven'
  update('trial-journal-and-independent-driver-readback-proven')
  evidence.postWrite = await captureSamples(4, Date.parse(after.at))
  check(evidence.postWrite.raw.every(r => r.tsMs > Date.parse(after.at)), 'post-write-sample-timestamp-not-after-readback')
  evidence.postWrite.join = { taskId, trialRunId, journalId: matching[0].id, activeRunId: runId }
  evidence.status = 'agent-daq-trial-and-post-write-samples-proven'
  update('post-write-DAQ-samples-proven')
}

function safeDiagnostic(proc) {
  // Report only known diagnostic categories, never arbitrary subprocess output.
  const rules = {
    missingModule: /ERR_MODULE_NOT_FOUND|MODULE_NOT_FOUND/, addressInUse: /EADDRINUSE/, unsupportedTs: /ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX|ERR_MODULE_NOT_FOUND/, socketDenied: /EACCES|EPERM/,
    instanceLocked: /instance-guard.*(?:already|占用)/, ompReadyTimeout: /omp RPC ready 超时/, ompExited: /omp 子进程在 ready 前退出/, modelUnset: /No default model selected/,
    contextError: /context (?:length|window)|context_length_exceeded/i, toolParse: /tool.{0,30}(?:validation|parsing|invalid)/i,
  }
  return Object.keys(rules).filter(k => rules[k].test(proc?.log ?? ''))
}
async function cleanup() {
  for (const r of reservations) await release(r)
  const recover = async fn => { try { return await fn() } catch { return null } }
  if (token && appProc && !appProc.exited) {
    if (taskId) {
      const current = await recover(taskDetail)
      if (current && !terminal(current.state)) await recover(() => app('POST', `/api/workshop/tasks/${taskId}/cancel`, {}, 3000))
    }
    if (channelId && agentId) await recover(() => app('POST', `/api/workshop/channels/${channelId}/agents/${agentId}/stop`, {}, 3000))
    if (lineStarted && lineId) evidence.lineStopConfirmed = Boolean(await recover(() => app('POST', `/api/workshop/dcw/lines/${lineId}/stop`, {}, 4000)))
  }
  if (db) await db.end().catch(() => {})
  const stopped = []
  for (const state of [...children].reverse()) {
    // Never look up and kill by port. Only terminate the live process we spawned.
    if (!state.exited && state.child.pid && state.child.exitCode === null && state.child.signalCode === null) {
      try { cmd('taskkill.exe', ['/PID', String(state.child.pid), '/T', '/F']) }
      catch { /* recorded below */ }
      await Promise.race([new Promise(ok => state.child.once('exit', ok)), sleep(2000)])
    }
    stopped.push({ process: state.label, exited: state.exited || state.child.exitCode !== null })
  }
  const removedContainers = {}
  for (const [name, id] of [['mqttQueue', mqttContainerId], ['timescale', containerId]]) {
    removedContainers[name] = !id
    if (!id) continue
    try {
      check(docker(['inspect', '--format', '{{index .Config.Labels "aw.tii.run"}}', id]) === tag, 'container-ownership-unverified')
      docker(['rm', '-f', '-v', id])
      removedContainers[name] = true
    }
    catch { /* fail closed; never try removal by port or a shared name */ }
  }
  const disposableContainerRemoved = Object.values(removedContainers).every(Boolean)
  const checked = ['app', 'sim', 'mqtt', 'opcua', 'modbus'].filter(k => ports?.[k])
  const portsReleased = checked.every(k => {
    try { return listeners(ports[k].port).length === 0 }
    catch { return false }
  })
  let disposableFilesRemoved = false
  if (portsReleased && stopped.every(p => p.exited)) {
    try { rmSync(root, { recursive: true, force: true, maxRetries: 4, retryDelay: 150 }); disposableFilesRemoved = true }
    catch { /* no raw scratch material copied to evidence */ }
  }
  evidence.cleanup = { stopped, portsReleased, disposableFilesRemoved, disposableContainerRemoved, removedContainers }
  if (!portsReleased || !disposableFilesRemoved || !disposableContainerRemoved || stopped.some(p => !p.exited)) process.exitCode = 1
}

const onSignal = () => cancel.abort()
process.on('SIGINT', onSignal)
process.on('SIGTERM', onSignal)
try {
  update('preflight')
  const { omp, configOverrides } = await setup()
  const signals = await bootSimulator()
  await bootApp(configOverrides)
  await provision(signals, omp)
  await observe()
  if (trial) await governedTrial()
  update('task-closure-observation')
  try {
    const t = await poll('task-closure-not-observed-within-20s', 20_000, async () => { const t = await taskDetail(); return terminal(t.state) ? t : null })
    check(t.assigneeId === agentId, 'unexpected-task-assignee')
    evidence.task.finalState = t.state
  }
  catch { evidence.task.finalState = (await taskDetail().catch(() => null))?.state ?? 'unobserved' }
  verifyCallsAllowed('daq_query', 'complete_task', ...(trial ? ['recipe_trial'] : []))
  update('evidence-collection-finished')
}
catch (error) {
  const message = error instanceof Error ? error.message : ''
  const safe = /^[a-zA-Z0-9/?:._ -]{1,250}$/.test(message) && !message.includes(':\\') ? message : 'unexpected-runtime-error'
  evidence.failure = { stage, blocker: safe, appDiagnosticCategories: safeDiagnostic(appProc), simulatorDiagnosticCategories: safeDiagnostic(simProc) }
  if (!evidence.agentDaq) evidence.status = 'blocked-before-proven-agent-daq'
  console.error(`[${tag}] ${stage}: ${safe}`)
  process.exitCode = 1
}
finally {
  await cleanup()
  evidence.finishedAt = utc()
  save()
  console.log(`[${tag}] ${evidence.status}; evidence ${relative(repo, output)}`)
}
