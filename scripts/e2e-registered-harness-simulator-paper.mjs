#!/usr/bin/env node
/**
 * Bounded integration evidence for the registered `omp` harness.
 *
 * The default mode uses a deterministic local RPC fixture. The opt-in
 * PAPER_E2E_HARNESS_MODE=real-omp mode uses the locally authenticated OMP CLI
 * and a fixed provider/model for three bounded trials in each simulator scene.
 * Both modes use a fresh AW_HOME and local simulator/application services.
 */
import { spawn, spawnSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { chmodSync, closeSync, copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { resolveRunMode } from '../shared/config/home.mjs'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const AW_PORT = 3997
const SIM_PORT = 4020
const MQTT_PORT = 18840
const OFFLINE_TSDB_PORT = 45321
const OFFLINE_OBJECTSTORE_PORT = 45322
const OFFLINE_APP_MQTT_QUEUE_PORT = 45323
const FORBIDDEN_PORT = 4010
const APP_BASE = `http://127.0.0.1:${AW_PORT}`
const SIM_BASE = `http://127.0.0.1:${SIM_PORT}`
const FIXTURE = resolve(REPO, 'scripts', 'fixtures', 'omp-paper-harness.mjs')
const SIM_SOURCE = resolve(REPO, 'plc-node-simulator')
const VERSION = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')).version
const TAG = `rhe${Date.now().toString(36)}`
mkdirSync(join(REPO, '.omc'), { recursive: true })
const ROOT = mkdtempSync(join(REPO, '.omc', 'registered-harness-paper-'))
const HOME = join(ROOT, 'aw-home')
const EVIDENCE_PATH = join(ROOT, 'evidence.json')
const SIM_ROOT = join(ROOT, 'simulator')
const SIM_LOG = join(ROOT, 'simulator.log')
const APP_LOG = join(ROOT, 'agentworkshop.log')
const EMPTY_DOTENV = join(HOME, 'empty.env')
const ISOLATED_PROMPTS_DIR = join(HOME, 'prompts')
const NUXT_CLI = join(REPO, 'node_modules', 'nuxt', 'bin', 'nuxt.mjs')
const RAG_BRIDGE_DISABLED_BASE_URL = 'http://paper-harness-outbound-disabled.invalid'
const SIM_LOG_FD = openSync(SIM_LOG, 'a')
const APP_LOG_FD = openSync(APP_LOG, 'a')
const HARNESS_MODE = process.env.PAPER_E2E_HARNESS_MODE ?? 'fixture'
const REAL_OMP_PROVIDER = 'zhipu-coding-plan'
const REAL_OMP_MODEL = 'glm-5.3-flash'
const REAL_OMP_TRIALS_PER_SCENE = 3
const REAL_OMP_APPROVAL_TIMEOUT_MS = 180_000
const REAL_OMP_TASK_COMPLETION_TIMEOUT_MS = 180_000
const REAL_OMP_PROMPT_TIMEOUT_MS = 360_000

const evidence = {
  schemaVersion: 1,
  experiment: {
    id: TAG,
    projectVersion: VERSION,
    ...(HARNESS_MODE === 'real-omp'
      ? {
          campaign: 'R20',
          harnessMode: 'real-omp',
          provider: REAL_OMP_PROVIDER,
          model: REAL_OMP_MODEL,
          trialsPerScene: REAL_OMP_TRIALS_PER_SCENE,
          runOutcomes: [],
        }
      : {
          fixture: 'deterministic local OMP-RPC transport; no LLM or autonomous harness decision',
        }),
    startedAt: new Date().toISOString(),
    postTrialSnapshotDelaySeconds: 20,
    scenes: [],
  },
  isolation: {
    result: 'pending',
    awHome: 'fresh isolated AW_HOME',
    appBase: APP_BASE,
    simulatorBase: SIM_BASE,
    simulatorMqttLoopbackPort: MQTT_PORT,
    appMqttQueueOfflineProbePort: OFFLINE_APP_MQTT_QUEUE_PORT,
    explicitLoopbackOnly: HARNESS_MODE !== 'real-omp',
    externalLlmDisabled: HARNESS_MODE !== 'real-omp',
    ...(HARNESS_MODE === 'real-omp' ? { externalLlmAllowedOnlyForRegisteredOmpProcess: true } : {}),
    forbiddenServicePortExcluded: true,
    checks: [],
  },
  checks: [],
  status: 'running',
}

let appProcess
let simProcess
let wrapperPath
let currentStage = 'preflight'
let currentScene
let authToken
let syntheticAdminId
let isolatedPluginNames = []
let expectedPluginNames = []
const allowedEnabledPluginNames = ['rag-bridge']
let projectPluginTreeAtPrepare
let projectPromptTreeAtPrepare
let promptTreeAtPrepare
const generatedSessionPassword = randomBytes(32).toString('hex')
const children = new Set()
const allocatedDevicePorts = []
const CHILD_OS_ENV_KEYS = process.platform === 'win32'
  ? ['PATH', 'PATHEXT', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'HOMEDRIVE', 'HOMEPATH', 'ProgramData']
  : ['PATH', 'HOME', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL']
const CHILD_EXTRA_ENV_KEYS = new Set(['SIM_PORT', 'MQTT_BROKER_PORT'])
const RELEASE_CHECK_SUFFIXES = ['-process-stopped', '-port-released']

function check(id, pass, detail = {}) {
  evidence.checks.push({ id, status: pass ? 'pass' : 'fail', detail })
  if (!pass) throw new Error(`check failed: ${id}`)
}

function noteIsolation(id, pass, detail = {}) {
  evidence.isolation.checks.push({ id, status: pass ? 'pass' : 'fail', detail })
  if (!pass) throw new Error(`isolation preflight failed: ${id}`)
}

function safeText(value, limit = 500) {
  let text = String(value ?? '')
  if (authToken) text = text.split(authToken).join('[REDACTED]')
  text = text.replace(/\but-[a-f\d]{32}\b/gi, '[REDACTED_TOKEN]')
  text = text.replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer [REDACTED]')
  text = text.replace(/\b(?:api[_-]?key|access[_-]?token|client[_-]?secret|password|secret)\s*[:=]\s*["']?[^\s,"'}]+/gi, '[REDACTED_CREDENTIAL]')
  text = text.replace(/\bsk-[A-Za-z0-9_-]{16,}\b/g, '[REDACTED_CREDENTIAL]')
  return text.slice(0, limit)
}

function compactError(error) {
  const message = error instanceof Error ? error.message : String(error)
  return { name: error instanceof Error ? error.name : 'Error', message: safeText(message) }
}

function assertLoopbackUrl(url, expectedPort) {
  const parsed = new URL(url)
  if (parsed.protocol !== 'http:' || parsed.hostname !== '127.0.0.1' || Number(parsed.port) !== expectedPort || Number(parsed.port) === FORBIDDEN_PORT) {
    throw new Error('network boundary rejected a non-approved loopback URL')
  }
}

function fixtureTracePath(sceneId) {
  if (!['cast-film', 'annealing'].includes(sceneId)) throw new Error('fixture trace scene is not approved')
  const root = resolve(ROOT)
  const tracePath = resolve(root, `fixture-${sceneId}.json`)
  const relativePath = relative(root, tracePath)
  if (isAbsolute(relativePath) || relativePath === '..' || relativePath.startsWith(`..${sep}`)) {
    throw new Error('fixture trace path escaped the experiment root')
  }
  return tracePath
}

async function assertFreeLoopback(port, label) {
  if (!Number.isInteger(port) || port < 1024 || port > 65535 || port === FORBIDDEN_PORT) {
    throw new Error(`port allocation rejected for ${label}`)
  }
  const server = createServer()
  await new Promise((resolvePromise, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', resolvePromise)
  })
  await new Promise(resolvePromise => server.close(resolvePromise))
}

async function preflight() {
  if (!['fixture', 'real-omp'].includes(HARNESS_MODE)) throw new Error('PAPER_E2E_HARNESS_MODE must be fixture or real-omp')
  if (typeof VERSION !== 'string' || VERSION.length === 0) throw new Error('package manifest does not define a version')
  if ((HARNESS_MODE === 'fixture' && !existsSync(FIXTURE)) || !existsSync(join(SIM_SOURCE, 'src', 'server', 'index.ts')) || !existsSync(join(SIM_SOURCE, 'node_modules')) || !existsSync(NUXT_CLI)) {
    throw new Error('required local harness input or simulator runtime is missing')
  }
  if (existsSync(HOME)) throw new Error('fresh AW_HOME path unexpectedly exists')
  const mode = resolveRunMode({ cwd: REPO, packageRoot: REPO, env: { AW_HOME: HOME, AW_MODE: 'home' } })
  if (mode.mode !== 'home' || resolve(mode.home) !== resolve(HOME) || resolve(mode.dataDir) !== resolve(join(HOME, 'data'))) {
    throw new Error('AW_HOME did not resolve to a new isolated home-mode data directory')
  }
  noteIsolation('fresh-home-mode-resolution', true, { mode: mode.mode, dataDir: mode.dataDir })
  for (const [label, port] of [['app', AW_PORT], ['simulator-http', SIM_PORT], ['simulator-mqtt', MQTT_PORT], ['offline-app-mqtt-queue-probe', OFFLINE_APP_MQTT_QUEUE_PORT], ['offline-timescale-probe', OFFLINE_TSDB_PORT], ['offline-objectstore-probe', OFFLINE_OBJECTSTORE_PORT]]) {
    await assertFreeLoopback(port, label)
    noteIsolation(`${label}-free-loopback-port`, true, { port, host: '127.0.0.1' })
  }
  if (AW_PORT === FORBIDDEN_PORT || SIM_PORT === FORBIDDEN_PORT || MQTT_PORT === FORBIDDEN_PORT) {
    throw new Error('forbidden service port appeared in explicit service configuration')
  }
  noteIsolation('project-version-and-local-inputs', true, {
    version: VERSION,
    simulatorSourcePresent: true,
    fixturePresent: HARNESS_MODE === 'fixture' ? true : null,
    nuxtCliPresent: true,
    noUserOrBusinessArchiveInput: true,
  })
  noteIsolation('strict-child-environment-allowlist', true, HARNESS_MODE === 'fixture'
    ? { osKeys: CHILD_OS_ENV_KEYS, fixtureOnlyHarness: true, noStorageServiceEnvironment: true }
    : { osKeys: CHILD_OS_ENV_KEYS, harnessMode: HARNESS_MODE, credentialValuesExposedToRunnerOrEvidence: false, noStorageServiceEnvironment: true })
}

function cleanChildEnv(extra = {}) {
  const env = {}
  for (const key of CHILD_OS_ENV_KEYS) {
    if (process.env[key] !== undefined) env[key] = process.env[key]
  }
  env.AW_HOME = HOME
  env.AW_MODE = 'home'
  env.AW_PROMPTS_DIR = ISOLATED_PROMPTS_DIR
  env.NUXT_SESSION_PASSWORD = generatedSessionPassword
  env.NO_PROXY = '127.0.0.1,localhost'
  env.no_proxy = '127.0.0.1,localhost'
  if (HARNESS_MODE === 'fixture') {
    env.AW_PAPER_FIXTURE_NODE = process.execPath
    env.AW_PAPER_FIXTURE_SCRIPT = FIXTURE
  }
  for (const [key, value] of Object.entries(extra)) {
    if (!CHILD_EXTRA_ENV_KEYS.has(key)) throw new Error(`child environment rejected unsupported override ${key}`)
    env[key] = String(value)
  }
  return env
}

function gitText(cwd, args) {
  const result = spawnSync('git', args, {
    cwd,
    windowsHide: true,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: cleanChildEnv(),
  })
  if (result.error || result.status !== 0) {
    throw new Error(`could not capture source identity: ${safeText(result.stderr || result.error?.message || result.status)}`)
  }
  return String(result.stdout ?? '').trim()
}

function hashGitFiles(cwd, roots) {
  const names = gitText(cwd, ['ls-files', '-co', '--exclude-standard', '--', ...roots])
    .split(/\r?\n/).filter(Boolean).sort()
  if (names.length === 0) throw new Error(`source identity has no files under ${roots.join(', ')}`)
  return hashFileList(cwd, names)
}

function hashFileList(cwd, names) {
  const hash = createHash('sha256')
  for (const name of names) {
    hash.update(name.replaceAll('\\', '/') + '\0')
    hash.update(readFileSync(join(cwd, name)))
    hash.update('\0')
  }
  return { sha256: hash.digest('hex'), fileCount: names.length }
}

function hashDirectoryTree(root) {
  if (!existsSync(root)) return hashFileList(root, [])
  const names = []
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name)
      const name = relative(root, absolute).replaceAll('\\', '/')
      if (entry.isSymbolicLink()) throw new Error(`source identity rejected symlink in plugin tree: ${name}`)
      if (entry.isDirectory()) visit(absolute)
      else if (entry.isFile()) names.push(name)
    }
  }
  visit(root)
  names.sort()
  return hashFileList(root, names)
}

function pluginNamesUnder(root) {
  if (!existsSync(root)) return []
  return readdirSync(root, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && existsSync(join(root, entry.name, 'index.mjs')))
    .map(entry => entry.name)
    .sort()
}

function captureSourceIdentity() {
  const appRoots = ['app', 'server', 'shared', 'mcp', 'cli', 'sdk', 'i18n', 'public', 'tsconfig.json', 'package.json', 'pnpm-lock.yaml', 'nuxt.config.ts', 'config.yml']
  const simulatorRoots = ['src', 'package.json', 'package-lock.json']
  const simulatorSourceFiles = gitText(SIM_SOURCE, ['ls-files', '-co', '--exclude-standard', '--', ...simulatorRoots])
    .split(/\r?\n/).filter(Boolean).sort()
  const executedSimulatorFiles = simulatorSourceFiles.filter(name => existsSync(join(SIM_ROOT, name)))
  if (!executedSimulatorFiles.includes('src/server/index.ts') || !executedSimulatorFiles.includes('package.json')) {
    throw new Error('executed simulator copy is missing required source files for provenance')
  }
  const projectPluginTree = hashDirectoryTree(join(REPO, '.AgentWorkShop', 'plugins'))
  if (projectPluginTree.sha256 !== projectPluginTreeAtPrepare?.sha256) {
    throw new Error('project plugin source changed after isolation was prepared')
  }
  const promptTree = hashDirectoryTree(ISOLATED_PROMPTS_DIR)
  if (promptTree.sha256 !== promptTreeAtPrepare?.sha256) {
    throw new Error('isolated prompt assets changed after isolation was prepared')
  }
  const ompVersion = HARNESS_MODE === 'real-omp'
    ? spawnSync('omp', ['--version'], { cwd: HOME, windowsHide: true, encoding: 'utf8', timeout: 5_000, env: cleanChildEnv() })
    : null
  if (ompVersion && (ompVersion.error || ompVersion.status !== 0)) {
    throw new Error('could not record the OMP CLI version for real-harness provenance')
  }
  return {
    recordedAt: new Date().toISOString(),
    nodeVersion: process.version,
    platform: process.platform,
    architecture: process.arch,
    app: {
      version: VERSION,
      gitHead: gitText(REPO, ['rev-parse', 'HEAD']),
      sourceTree: hashGitFiles(REPO, appRoots),
      workingTreeStatus: gitText(REPO, ['status', '--porcelain', '--', ...appRoots]),
      packageManifestSha256: createHash('sha256').update(readFileSync(join(REPO, 'package.json'))).digest('hex'),
      lockfileSha256: createHash('sha256').update(readFileSync(join(REPO, 'pnpm-lock.yaml'))).digest('hex'),
      projectPluginTree,
      projectPluginNames: pluginNamesUnder(join(REPO, '.AgentWorkShop', 'plugins')),
    },
    pluginIsolation: {
      disabledNames: isolatedPluginNames,
      enabledAllowlist: allowedEnabledPluginNames,
      setupExpectedForOtherPlugins: false,
      disabledStatePath: 'AW_HOME/plugins-state.json',
      projectPluginNames: pluginNamesUnder(join(REPO, '.AgentWorkShop', 'plugins')),
      projectPluginTree,
    },
    promptIsolation: {
      sourceDirectory: 'repository/.AgentWorkShop/prompts',
      isolatedDirectory: 'AW_HOME/prompts',
      sourceTree: projectPromptTreeAtPrepare,
      runtimeTree: promptTree,
    },
    experimentScriptSha256: createHash('sha256').update(readFileSync(fileURLToPath(import.meta.url))).digest('hex'),
    registeredHarness: {
      mode: HARNESS_MODE,
      provider: HARNESS_MODE === 'real-omp' ? REAL_OMP_PROVIDER : null,
      model: HARNESS_MODE === 'real-omp' ? REAL_OMP_MODEL : null,
      ompCliVersion: ompVersion ? safeText(ompVersion.stdout.trim(), 120) : null,
      fixtureSha256: HARNESS_MODE === 'fixture' ? createHash('sha256').update(readFileSync(FIXTURE)).digest('hex') : null,
      launcherSha256: wrapperPath ? createHash('sha256').update(readFileSync(wrapperPath)).digest('hex') : null,
    },
    simulator: {
      gitlinkHead: gitText(REPO, ['rev-parse', 'HEAD:plc-node-simulator']),
      gitHead: gitText(SIM_SOURCE, ['rev-parse', 'HEAD']),
      sourceTree: hashGitFiles(SIM_SOURCE, simulatorRoots),
      workingTreeStatus: gitText(SIM_SOURCE, ['status', '--porcelain', '--', ...simulatorRoots]),
      executedTree: hashFileList(SIM_ROOT, executedSimulatorFiles),
      lockfileSha256: createHash('sha256').update(readFileSync(join(SIM_SOURCE, 'package-lock.json'))).digest('hex'),
      copyPatch: 'bind copied simulator HTTP and MQTT listeners to 127.0.0.1 and remap only their ports; source script hash records the transformation',
    },
  }
}

function prepareIsolatedHome() {
  mkdirSync(join(HOME, 'data'), { recursive: true })
  copyFileSync(join(REPO, 'config.yml'), join(HOME, 'config.yml'))
  const overrides = {
    'daq.startInfrastructure': 'never',
    'daq.mqtt.host': '127.0.0.1',
    'daq.mqtt.port': OFFLINE_APP_MQTT_QUEUE_PORT,
    'daq.timescale.host': '127.0.0.1',
    'daq.timescale.port': OFFLINE_TSDB_PORT,
    'daq.objectstore.host': '127.0.0.1',
    'daq.objectstore.port': OFFLINE_OBJECTSTORE_PORT,
    'plugins.rag-bridge.base_url': RAG_BRIDGE_DISABLED_BASE_URL,
  }
  const runtimeSettingsPath = join(HOME, 'runtime-settings.json')
  writeFileSync(runtimeSettingsPath, `${JSON.stringify({ version: 1, updatedAt: new Date().toISOString(), overrides }, null, 2)}\n`, 'utf8')
  const savedOverrides = JSON.parse(readFileSync(runtimeSettingsPath, 'utf8')).overrides
  if (savedOverrides?.['plugins.rag-bridge.base_url'] !== overrides['plugins.rag-bridge.base_url']) {
    throw new Error('isolated runtime settings did not preserve the rag-bridge outbound-disable host guard setting')
  }
  const ragBridgeKvDir = join(HOME, 'data', 'plugins', 'rag-bridge')
  mkdirSync(ragBridgeKvDir, { recursive: true })
  const ragBridgeKvPath = join(ragBridgeKvDir, 'kv.json')
  writeFileSync(ragBridgeKvPath, `${JSON.stringify({ 'kb.base_url': RAG_BRIDGE_DISABLED_BASE_URL }, null, 2)}\n`, 'utf8')
  const savedRagBridgeKv = JSON.parse(readFileSync(ragBridgeKvPath, 'utf8'))
  if (savedRagBridgeKv?.['kb.base_url'] !== RAG_BRIDGE_DISABLED_BASE_URL) {
    throw new Error('isolated rag-bridge KV fallback did not preserve the outbound-disable host guard setting')
  }
  const projectPromptsRoot = join(REPO, '.AgentWorkShop', 'prompts')
  if (!existsSync(projectPromptsRoot)) throw new Error('project prompt source directory is missing')
  cpSync(projectPromptsRoot, ISOLATED_PROMPTS_DIR, { recursive: true })
  projectPromptTreeAtPrepare = hashDirectoryTree(projectPromptsRoot)
  promptTreeAtPrepare = hashDirectoryTree(ISOLATED_PROMPTS_DIR)
  if (projectPromptTreeAtPrepare.sha256 !== promptTreeAtPrepare.sha256) {
    throw new Error('isolated prompt copy differs from the repository prompt source')
  }
  writeFileSync(EMPTY_DOTENV, '', 'utf8')
  const builtinPlugins = pluginNamesUnder(join(REPO, 'server', 'plugins-builtin'))
  const projectPluginsRoot = join(REPO, '.AgentWorkShop', 'plugins')
  const projectPlugins = pluginNamesUnder(projectPluginsRoot)
  const userPlugins = pluginNamesUnder(join(HOME, 'plugins'))
  expectedPluginNames = [...new Set([...builtinPlugins, ...projectPlugins, ...userPlugins])].sort()
  isolatedPluginNames = expectedPluginNames.filter(name => !allowedEnabledPluginNames.includes(name))
  projectPluginTreeAtPrepare = hashDirectoryTree(projectPluginsRoot)
  const pluginStatePath = join(HOME, 'plugins-state.json')
  writeFileSync(pluginStatePath, `${JSON.stringify({ version: 1, updatedAt: new Date().toISOString(), disabled: isolatedPluginNames }, null, 2)}\n`, 'utf8')
  const savedPluginState = JSON.parse(readFileSync(pluginStatePath, 'utf8'))
  if (JSON.stringify([...savedPluginState.disabled].sort()) !== JSON.stringify(isolatedPluginNames)) {
    throw new Error('isolated plugin state did not disable every discovered plugin')
  }
  noteIsolation('isolated-runtime-config', true, {
    configRoot: 'fresh isolated AW_HOME',
    startInfrastructure: overrides['daq.startInfrastructure'],
    simulatorMqttBroker: `127.0.0.1:${MQTT_PORT}`,
    appMqttQueueProbe: `127.0.0.1:${OFFLINE_APP_MQTT_QUEUE_PORT}`,
    offlineTimescaleProbe: `127.0.0.1:${OFFLINE_TSDB_PORT}`,
    offlineObjectstoreProbe: `127.0.0.1:${OFFLINE_OBJECTSTORE_PORT}`,
    ragBridgeOutboundGuardSetting: 'plugins.rag-bridge.base_url',
    ragBridgeOutboundGuardConfigPresent: true,
    ragBridgeOutboundGuardKvFallbackPresent: true,
    emptyDotenv: true,
    repoDotenvBypassed: true,
  })
  noteIsolation('pre-existing-plugin-scopes-disabled', true, {
    builtinNames: builtinPlugins,
    projectNames: projectPlugins,
    userNames: userPlugins,
    disabledStatePath: 'AW_HOME/plugins-state.json',
    projectPluginTreeSha256: projectPluginTreeAtPrepare.sha256,
    enabledPluginAllowlist: allowedEnabledPluginNames,
  })
  noteIsolation('project-prompt-assets-isolated', true, {
    sourceDirectory: 'repository/.AgentWorkShop/prompts',
    isolatedDirectory: 'AW_HOME/prompts',
    sourceTreeSha256: projectPromptTreeAtPrepare.sha256,
    runtimeTreeSha256: promptTreeAtPrepare.sha256,
    awPromptsDir: 'AW_HOME/prompts',
  })
}

async function assertPluginIsolation() {
  const expectedNames = expectedPluginNames
  let plugins = []
  for (let attempt = 0; attempt < 40; attempt++) {
    const result = requireSuccess(await app('GET', '/api/workshop/plugins'), 'isolated plugin manifest')
    plugins = Array.isArray(result.plugins) ? result.plugins : []
    const actualNames = plugins.map(plugin => plugin.name).sort()
    if (JSON.stringify(actualNames) === JSON.stringify(expectedNames)) {
      const enabledNames = plugins.filter(plugin => plugin.enabled === true).map(plugin => plugin.name).sort()
      const enabledMatchesAllowlist = JSON.stringify(enabledNames) === JSON.stringify([...allowedEnabledPluginNames].sort())
      const statesMatchPolicy = plugins.every(plugin => allowedEnabledPluginNames.includes(plugin.name)
        ? plugin.enabled === true
        : plugin.enabled === false)
      check('only-outbound-disabled-rag-bridge-enabled', enabledMatchesAllowlist && statesMatchPolicy, {
        names: actualNames,
        enabledNames,
        disabledNames: plugins.filter(plugin => plugin.enabled === false).map(plugin => plugin.name).sort(),
        invalidStateNames: plugins.filter(plugin => typeof plugin.enabled !== 'boolean').map(plugin => plugin.name),
      })
      return
    }
    await delay(250)
  }
  throw new Error(`isolated plugin manifest differed from the expected built-in/user set: ${plugins.map(plugin => plugin.name).sort().join(', ')}`)
}

function spawnLogged(command, args, { cwd = REPO, env = cleanChildEnv(), logFd, label }) {
  const child = spawn(command, args, {
    cwd,
    env,
    stdio: ['ignore', logFd, logFd],
    windowsHide: true,
    detached: process.platform !== 'win32',
  })
  child.label = label
  children.add(child)
  child.once('exit', () => children.delete(child))
  child.once('error', () => children.delete(child))
  return child
}

async function waitForExit(child, timeoutMs = 8_000) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  await Promise.race([
    new Promise(resolvePromise => child.once('exit', resolvePromise)),
    delay(timeoutMs),
  ])
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
  const result = spawnSync('tasklist.exe', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], {
    windowsHide: true,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    env: cleanChildEnv(),
  })
  if (result.error || result.status !== 0) return null
  return (result.stdout ?? '').split(/\r?\n/).some((line) => {
    const columns = line.match(/^"(?:[^"]|"")*","(\d+)"(?:,|$)/)
    return columns?.[1] === String(pid)
  })
}

async function stopProcessTree(child, label) {
  if (!child?.pid) return false
  const wasAlreadyExited = child.exitCode !== null || child.signalCode !== null
  let terminationStatus = null
  try {
    if (process.platform === 'win32' && child.pid) {
      const result = spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', env: cleanChildEnv() })
      terminationStatus = result.error ? 'spawn-error' : result.status
    }
    else if (process.platform !== 'win32' && child.pid) {
      process.kill(-child.pid, 'SIGTERM')
    }
  }
  catch { /* a process may have already exited */ }
  await waitForExit(child)
  if (process.platform !== 'win32' && processGroupExists(child.pid)) {
    try {
      process.kill(-child.pid, 'SIGKILL')
      terminationStatus = 'SIGKILL'
    }
    catch { /* already gone */ }
  }
  else if (process.platform === 'win32' && windowsProcessExists(child.pid) === true) {
    const result = spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', env: cleanChildEnv() })
    terminationStatus = result.error ? 'spawn-error' : result.status
  }
  await waitForExit(child, 2_000)
  let treePresent
  if (process.platform === 'win32') treePresent = windowsProcessExists(child.pid)
  else {
    const deadline = Date.now() + 3_000
    do {
      treePresent = processGroupExists(child.pid)
      if (!treePresent) break
      await delay(100)
    } while (Date.now() < deadline)
  }
  const pass = !wasAlreadyExited && treePresent === false && (process.platform !== 'win32' || terminationStatus === 0)
  evidence.checks.push({
    id: `${label}-process-stopped`,
    status: pass ? 'pass' : 'fail',
    detail: { pid: child.pid, terminationStatus, processTreePresentAfterCleanup: treePresent, rootWasAlreadyExited: wasAlreadyExited },
  })
  return pass
}

function buildHarnessShim() {
  if (process.platform === 'win32') {
    const compiler = [
      join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'),
      join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework', 'v4.0.30319', 'csc.exe'),
    ].find(existsSync)
    if (!compiler) throw new Error('Windows C# compiler unavailable; cannot safely launch a registered fixture executable')
    const source = join(ROOT, 'omp-fixture-shim.cs')
    wrapperPath = join(ROOT, 'omp-fixture-shim.exe')
    writeFileSync(source, String.raw`using System;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Text;
using System.Threading;
class OmpFixtureShim {
  static string Quote(string value) {
    var result = new StringBuilder("\"");
    int backslashes = 0;
    foreach (char c in value) {
      if (c == '\\') { backslashes++; continue; }
      if (c == '"') {
        result.Append('\\', backslashes * 2 + 1);
        result.Append('"');
      }
      else {
        result.Append('\\', backslashes);
        result.Append(c);
      }
      backslashes = 0;
    }
    result.Append('\\', backslashes * 2);
    result.Append('"');
    return result.ToString();
  }
  static void Copy(Stream source, Stream destination) {
    byte[] buffer = new byte[4096];
    int count;
    while ((count = source.Read(buffer, 0, buffer.Length)) > 0) {
      destination.Write(buffer, 0, count);
      destination.Flush();
    }
  }
  static int Main(string[] args) {
    string node = Environment.GetEnvironmentVariable("AW_PAPER_FIXTURE_NODE");
    string script = Environment.GetEnvironmentVariable("AW_PAPER_FIXTURE_SCRIPT");
    if (String.IsNullOrWhiteSpace(node) || String.IsNullOrWhiteSpace(script)) return 125;
    var psi = new ProcessStartInfo(node);
    psi.UseShellExecute = false;
    psi.CreateNoWindow = true;
    psi.RedirectStandardInput = true;
    psi.RedirectStandardOutput = true;
    psi.RedirectStandardError = true;
    psi.Arguments = Quote(script) + " " + String.Join(" ", args.Skip(2).Select(Quote));
    using (var child = Process.Start(psi)) {
      if (child == null) return 126;
      var stdin = new Thread(() => {
        try {
          Copy(Console.OpenStandardInput(), child.StandardInput.BaseStream);
        }
        finally {
          child.StandardInput.Close();
        }
      });
      var stdout = new Thread(() => Copy(child.StandardOutput.BaseStream, Console.OpenStandardOutput()));
      var stderr = new Thread(() => Copy(child.StandardError.BaseStream, Console.OpenStandardError()));
      stdin.IsBackground = true;
      stdout.IsBackground = true;
      stderr.IsBackground = true;
      stdin.Start();
      stdout.Start();
      stderr.Start();
      child.WaitForExit();
      stdout.Join();
      stderr.Join();
      return child.ExitCode;
    }
  }
}`.replace(/\n/g, '\n'), 'utf8')
    const result = spawnSync(compiler, ['/nologo', '/target:exe', `/out:${wrapperPath}`, source], { cwd: ROOT, windowsHide: true, encoding: 'utf8', timeout: 30_000, env: cleanChildEnv() })
    if (result.error || result.status !== 0 || !existsSync(wrapperPath)) {
      throw new Error(`could not compile isolated OMP fixture shim: ${safeText(result.stderr || result.stdout || result.error?.message || result.status)}`)
    }
    return wrapperPath
  }
  if (process.platform === 'linux' || process.platform === 'darwin') {
    wrapperPath = join(ROOT, 'omp-fixture-shim')
    writeFileSync(wrapperPath, '#!/bin/sh\nshift 2\nexec "$AW_PAPER_FIXTURE_NODE" "$AW_PAPER_FIXTURE_SCRIPT" "$@"\n', 'utf8')
    chmodSync(wrapperPath, 0o755)
    return wrapperPath
  }
  throw new Error(`unsupported fixture shim platform ${process.platform}`)
}

function extractPayload(body) {
  return body && typeof body === 'object' && Object.prototype.hasOwnProperty.call(body, 'data') ? body.data : body
}

async function request(base, expectedPort, method, path, body, { token, timeoutMs = 10_000 } = {}) {
  assertLoopbackUrl(base, expectedPort)
  if (!path.startsWith('/api/')) throw new Error('API path boundary rejected')
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(timeoutMs),
  })
  const parsed = await response.json().catch(() => null)
  return { status: response.status, body: parsed, data: extractPayload(parsed) }
}

const app = (method, path, body, opts = {}) => request(APP_BASE, AW_PORT, method, path, body, { token: opts.token ?? authToken, timeoutMs: opts.timeoutMs })
const sim = (method, path, body) => request(SIM_BASE, SIM_PORT, method, path, body, { timeoutMs: 8_000 })

function requireSuccess(result, label, status = 200) {
  if (result.status !== status) {
    const payload = result.body && typeof result.body === 'object' ? result.body : {}
    throw new Error(`${label} returned HTTP ${result.status}: ${safeText(payload.message || payload.statusMessage || payload.code || 'no response detail')}`)
  }
  return result.data
}

async function bootSimulator() {
  mkdirSync(SIM_ROOT, { recursive: true })
  cpSync(join(SIM_SOURCE, 'src'), join(SIM_ROOT, 'src'), { recursive: true })
  cpSync(join(SIM_SOURCE, 'package.json'), join(SIM_ROOT, 'package.json'))
  const simulatorEntry = join(SIM_ROOT, 'src', 'server', 'index.ts')
  const originalSource = readFileSync(simulatorEntry, 'utf8')
  const listenCall = 'server.listen(PORT, () => resolve())'
  const brokerCall = 'await startBroker(Number(process.env.MQTT_BROKER_PORT ?? 18830))'
  if (originalSource.split(listenCall).length !== 2) throw new Error('simulator copied source did not contain exactly one expected listener call')
  if (originalSource.split(brokerCall).length !== 2) throw new Error('simulator copied source did not contain exactly one expected broker startup call')
  const loopbackListenCall = `server.listen(PORT, '127.0.0.1', () => {
    const boundAddress = server.address()
    if (!boundAddress || typeof boundAddress === 'string' || boundAddress.address !== '127.0.0.1' || boundAddress.port !== PORT) {
      console.error('[paper-isolation] simulator listener address verification failed')
      server.close(() => process.exit(70))
      return
    }
    console.log('[paper-isolation] listener=' + boundAddress.address + ':' + boundAddress.port)
    resolve()
  })`
  const loopbackSource = originalSource
    .replace(listenCall, loopbackListenCall)
    .replace(brokerCall, `await startBroker(Number(process.env.MQTT_BROKER_PORT ?? 18830), '127.0.0.1')`)
  writeFileSync(simulatorEntry, loopbackSource, 'utf8')
  const modules = join(SIM_SOURCE, 'node_modules')
  symlinkSync(modules, join(SIM_ROOT, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir')
  simProcess = spawnLogged(process.execPath, [join(REPO, 'node_modules', 'tsx', 'dist', 'cli.mjs'), join(SIM_ROOT, 'src', 'server', 'index.ts')], {
    cwd: SIM_ROOT,
    logFd: SIM_LOG_FD,
    label: 'simulator',
    env: cleanChildEnv({ SIM_PORT: String(SIM_PORT), MQTT_BROKER_PORT: String(MQTT_PORT) }),
  })
  for (let i = 0; i < 50; i++) {
    if (simProcess.exitCode !== null) throw new Error(`simulator exited during startup (code ${simProcess.exitCode})`)
    try {
      const result = await sim('GET', '/api/nodes')
      if (result.status === 200) {
        const data = result.data
        const expectedListener = `[paper-isolation] listener=127.0.0.1:${SIM_PORT}`
        const simulatorLog = readFileSync(SIM_LOG, 'utf8')
        const expectedBroker = `[mqtt-broker] 内置 broker 就绪 mqtt://127.0.0.1:${MQTT_PORT}`
        if (!simulatorLog.includes(expectedListener)) throw new Error('simulator did not report the verified 127.0.0.1 HTTP listener address')
        if (!simulatorLog.includes(expectedBroker) || simulatorLog.includes('内置 broker 启动失败')) {
          throw new Error('simulator did not confirm its embedded loopback MQTT broker before application startup')
        }
        noteIsolation('simulator-listener-address-verified', true, { address: '127.0.0.1', port: SIM_PORT, copiedSourceOnly: true })
        noteIsolation('simulator-mqtt-broker-loopback-ready', true, { address: '127.0.0.1', port: MQTT_PORT, brokerStartupConfirmed: true })
        noteIsolation('simulator-local-http-ready', true, { version: 'local repository source', port: SIM_PORT, host: '127.0.0.1' })
        return data
      }
    }
    catch { /* the local simulator is still starting */ }
    await delay(400)
  }
  throw new Error('isolated simulator startup timed out')
}

function normalizeLocalNetworkConfig(value, portMap, key = '') {
  if (Array.isArray(value)) return value.map(item => normalizeLocalNetworkConfig(item, portMap, key))
  if (!value || typeof value !== 'object') {
    if (typeof value !== 'string') return value
    if (/^[a-z][a-z\d+.-]*:\/\//i.test(value)) {
      const parsed = new URL(value)
      if (!['127.0.0.1', 'localhost', '::1'].includes(parsed.hostname)) throw new Error('simulator preset contains a non-loopback endpoint')
      if (parsed.port && portMap.has(Number(parsed.port))) parsed.port = String(portMap.get(Number(parsed.port)))
      parsed.hostname = '127.0.0.1'
      return parsed.toString()
    }
    if (/(?:host|hostname|ip|address)$/i.test(key)) return '127.0.0.1'
    return value
  }
  const out = {}
  for (const [childKey, childValue] of Object.entries(value)) {
    if (/^port$/i.test(childKey) && typeof childValue === 'number' && portMap.has(childValue)) {
      out[childKey] = portMap.get(childValue)
    }
    else if (/(?:host|hostname|ip|address)$/i.test(childKey) && typeof childValue === 'string') {
      out[childKey] = '127.0.0.1'
    }
    else {
      out[childKey] = normalizeLocalNetworkConfig(childValue, portMap, childKey)
    }
  }
  return out
}

async function simulatorScene(scene) {
  const presetResponse = await sim('GET', `/api/presets/${encodeURIComponent(scene.preset)}`)
  const blueprint = requireSuccess(presetResponse, `${scene.id} simulator preset`)
  if (!blueprint?.plantModel || !Array.isArray(blueprint.nodes)) throw new Error(`${scene.id} simulator preset shape is invalid`)

  const portMapByDeviceId = new Map()
  const toCreate = []
  let nextPort = 44_000 + evidence.experiment.scenes.length * 100
  for (const raw of blueprint.nodes) {
    const node = structuredClone(raw)
    if ((node.protocol && /serial|rtu/i.test(String(node.protocol))) || /serialPort|comPort|devicePath/i.test(JSON.stringify(node.config ?? {}))) continue
    node.config ||= {}
    const oldPort = Number(node.config.port)
    const portMap = new Map()
    if (Number.isInteger(oldPort) && oldPort > 0) {
      while (allocatedDevicePorts.includes(nextPort) || nextPort === FORBIDDEN_PORT) nextPort += 1
      await assertFreeLoopback(nextPort, `${scene.id}-simulator-device`)
      portMap.set(oldPort, nextPort)
      allocatedDevicePorts.push(nextPort)
      noteIsolation(`${scene.id}-device-port-free-loopback`, true, { port: nextPort, host: '127.0.0.1', protocol: node.protocol ?? 'unspecified' })
      node.config.port = nextPort
      nextPort += 1
    }
    node.config = normalizeLocalNetworkConfig(node.config, portMap)
    if (node.protocol === 'mqtt' || /mqtt/i.test(String(node.protocol))) node.config.brokerUrl = `mqtt://127.0.0.1:${MQTT_PORT}`
    portMapByDeviceId.set(node.id, portMap)
    toCreate.push(node)
  }
  if (toCreate.length === 0) throw new Error(`${scene.id} simulator preset has no loopback-safe device nodes`)

  for (const node of toCreate) {
    const created = await sim('POST', '/api/nodes', node)
    requireSuccess(created, `${scene.id} simulator device ${safeText(node.id, 80)}`)
  }
  const plant = { ...blueprint.plantModel, id: `${TAG}-${scene.id}`, seed: 42, timeScale: 1, truthExport: false }
  const loaded = await sim('PUT', '/api/plant/config', { plantModel: plant, warm: true, upsert: true })
  requireSuccess(loaded, `${scene.id} simulator plant model`)

  const exports = []
  for (const node of toCreate) {
    const result = await sim('GET', `/api/nodes/${encodeURIComponent(node.id)}/export`)
    const data = requireSuccess(result, `${scene.id} simulator export ${safeText(node.id, 80)}`)
    for (const item of data?.items ?? []) exports.push({ ...item, deviceId: node.id })
  }
  for (const item of exports) {
    item.driverConfig = normalizeLocalNetworkConfig(item.driverConfig ?? {}, portMapByDeviceId.get(item.deviceId) ?? new Map())
    for (const [key, value] of Object.entries(item.driverConfig)) {
      if (/^(?:host|hostname|ip|address)$/i.test(key) && !['127.0.0.1', 'localhost', '::1'].includes(String(value))) {
        throw new Error(`${scene.id} exported driver config escaped loopback boundary`)
      }
    }
  }
  const mv = exports.find(item => item.deviceId === scene.sourceDevice && item.signal === scene.mvSignal)
  const cv = exports.find(item => item.signal === scene.cvSignal)
  if (!mv || !cv) throw new Error(`${scene.id} simulator export lacks required MV/CV signals`)
  if (!['opcua', 'modbus-tcp'].includes(String(mv.driver))) throw new Error(`${scene.id} MV driver is outside the approved simulator protocol set`)
  const evidenceSignal = signal => Object.fromEntries(Object.entries(signal).filter(([key]) => key !== 'curl'))
  return {
    mv: evidenceSignal(mv),
    cv: evidenceSignal(cv),
    plant: { id: plant.id, kind: plant.kind ?? 'simulator', seed: 42, timeScale: 1 },
    deviceCount: toCreate.length,
  }
}

async function registerAdmin() {
  const response = await app('POST', '/api/users/register', {
    name: `Paper Test ${TAG}`,
    email: `${TAG}@example.invalid`,
    password: `Paper-${Date.now()}-safe9`,
  }, { token: undefined })
  const data = requireSuccess(response, 'isolated synthetic administrator registration')
  if (!data?.token || data?.user?.role !== 'admin') throw new Error('fresh-home registration did not return its first administrator token')
  authToken = String(data.token)
  syntheticAdminId = String(data.user.id)
  return { id: syntheticAdminId, role: 'admin' }
}

async function verifyRagBridgeOutboundDisabled() {
  const ragBridgeHealth = requireSuccess(await app('GET', '/api/plugins/rag-bridge/health'), 'rag-bridge outbound guard health check')
  const deadline = Date.now() + 3_000
  let startupLogConfirmed = false
  while (Date.now() < deadline) {
    startupLogConfirmed = /\[rag-bridge\].*出站调用已禁用:/.test(readFileSync(APP_LOG, 'utf8'))
    if (startupLogConfirmed) break
    await delay(100)
  }
  noteIsolation('rag-bridge-outbound-disabled', ragBridgeHealth?.outbound === false && startupLogConfirmed, {
    setting: 'plugins.rag-bridge.base_url',
    pluginHealthOutbound: ragBridgeHealth?.outbound ?? null,
    startupLogConfirmed,
  })
}

function realOmpSystemPrompt(scene, recipe, control, decisionStimulus) {
  const choices = decisionStimulus.allowedValues.join(', ')
  return [
    'You are operating AgentWorkShop for one bounded task in a local process simulator.',
    `Process scene: ${scene.processDescription}.`,
    `Before task submission, the registered drivers measured the control at ${decisionStimulus.controlValue} ${control.unit} and the process variable at ${decisionStimulus.processValue} ${decisionStimulus.processUnit}.`,
    `The task target band is ${decisionStimulus.targetMin} to ${decisionStimulus.targetMax} ${decisionStimulus.processUnit}.`,
    `For this single trial, the only prevalidated candidate values are ${choices} ${control.unit}; the current control value is ${decisionStimulus.controlValue} ${control.unit}, and each candidate respects the configured engineering range and step bound.`,
    'Choose one candidate from that set using the measured target error and make one conservative, bounded recipe trial if a change is warranted. The candidate choice is yours; do not claim that it will improve or settle the process.',
    `Use exactly one host-tool call named recipe_trial, with recipe_id "${recipe.id}", one params entry for node_id "${control.id}", and your selected candidate value. Put only a concise selection rationale in hypothesis.`,
    'Do not call any other tool. Do not retry. Do not create, update, apply, or roll back a recipe. If you cannot justify a permitted candidate, stop without a tool call.',
    'After the tool result, give a brief factual report and make no further tool calls.',
  ].join('\n')
}

async function setupScene(scene, simDetails) {
  currentScene = scene.id
  currentStage = `${scene.id}:application-setup`
  const sceneEvidence = {
    id: scene.id,
    simulatorPreset: scene.preset,
    simulator: simDetails,
    status: 'running',
    approvals: [],
    runs: [],
  }
  evidence.experiment.scenes.push(sceneEvidence)

  const line = requireSuccess(await app('POST', '/api/workshop/dcw/lines', {
    name: `${TAG}-${scene.id}`,
    description: 'Synthetic isolated paper integration run',
    simulated: true,
    simSceneId: scene.preset,
    controlMode: 'manual',
  }), `${scene.id} line creation`).line
  const product = requireSuccess(await app('POST', '/api/workshop/dcw/products', {
    name: `${TAG}-${scene.id}-product`, lineId: line.id,
  }), `${scene.id} product creation`).product
  const template = requireSuccess(await app('POST', '/api/workshop/dcw/templates', {
    name: `${TAG}-${scene.id}-control-template`,
    unit: simDetails.mv.unit,
    min: simDetails.mv.min,
    max: simDetails.mv.max,
    decimals: simDetails.mv.decimals ?? 0,
  }), `${scene.id} control template creation`).template
  const control = requireSuccess(await app('POST', '/api/workshop/dcw', {
    templateRef: template.key,
    name: `${TAG}-${scene.id}-control`,
    driver: simDetails.mv.driver,
    driverConfig: simDetails.mv.driverConfig,
    lineId: line.id,
    min: simDetails.mv.min,
    max: simDetails.mv.max,
    unit: simDetails.mv.unit,
    decimals: simDetails.mv.decimals ?? 0,
    stepLimit: 30,
    writeLockSeconds: 0,
    holdIntervalMs: 0,
    readIntervalMs: 500,
    semantics: `Bounded simulated ${scene.mvSignal} setpoint for integration evidence`,
  }), `${scene.id} control node creation`).node
  const daq = requireSuccess(await app('POST', '/api/workshop/daq', {
    templateRef: 'daq-temp-tc',
    name: `${TAG}-${scene.id}-daq-cv`,
    driver: simDetails.cv.driver,
    driverConfig: simDetails.cv.driverConfig,
    lineId: line.id,
    min: simDetails.cv.min,
    max: simDetails.cv.max,
    unit: simDetails.cv.unit,
    intervalMs: 1000,
    publishIntervalMs: 0,
    semantics: `Bounded simulated ${scene.cvSignal} controlled variable for run-tagged sampling`,
  }), `${scene.id} DAQ node creation`).node
  const recipe = requireSuccess(await app('POST', '/api/workshop/dcw/recipes', {
    name: `${TAG}-${scene.id}-recipe`,
    productId: product.id,
    params: [{ nodeId: control.id, templateRef: template.key, value: scene.baseline, min: simDetails.mv.min, max: simDetails.mv.max, stepLimit: 30 }],
    daqWindows: [{ nodeId: daq.id, min: simDetails.cv.min, max: simDetails.cv.max }],
  }), `${scene.id} recipe creation`).recipe

  const start = requireSuccess(await app('POST', `/api/workshop/dcw/lines/${encodeURIComponent(line.id)}/start`, { recipeId: recipe.id }), `${scene.id} line start`)
  const runId = String(start.run?.id ?? '')
  if (!runId) throw new Error(`${scene.id} line start returned no run identifier`)
  sceneEvidence.activeRun = { id: runId, status: start.run?.status ?? null, startedAt: start.run?.startedAt ?? null, recipeId: start.run?.recipeId ?? recipe.id }

  let decisionStimulus
  if (HARNESS_MODE === 'real-omp') {
    let controlRead
    let controlReadAttempts = 0
    do {
      controlRead = await app('POST', `/api/workshop/dcw/${encodeURIComponent(control.id)}/read`)
      controlReadAttempts += 1
      if (controlRead.status === 409 && controlReadAttempts < 3) await delay(500)
    } while (controlRead.status === 409 && controlReadAttempts < 3)
    const controlReadData = requireSuccess(controlRead, `${scene.id} pre-task control read`)
    const controlData = controlReadData?.outcome ?? controlReadData?.read ?? controlReadData
    const controlValue = Number(controlData?.value ?? controlData?.data?.value)
    let processProbeResponse
    let processProbeAttempts = 0
    do {
      processProbeResponse = await app('POST', `/api/workshop/daq/${encodeURIComponent(daq.id)}/test`)
      processProbeAttempts += 1
      if (processProbeResponse.status === 409 && processProbeAttempts < 3) await delay(500)
    } while (processProbeResponse.status === 409 && processProbeAttempts < 3)
    const processProbe = requireSuccess(processProbeResponse, `${scene.id} pre-task process probe`).test
    const processValue = Number(processProbe?.sampleValue)
    if (!Number.isFinite(controlValue) || processProbe?.ok !== true || !Number.isFinite(processValue)) {
      throw new Error(`${scene.id} pre-task protocol reads did not provide finite control and process values`)
    }
    decisionStimulus = {
      controlValue,
      processValue,
      processUnit: simDetails.cv.unit,
      targetMin: scene.targetMin,
      targetMax: scene.targetMax,
      allowedValues: [...scene.candidates],
      probeDriver: simDetails.cv.driver,
      probeLatencyMs: Number.isFinite(Number(processProbe.latencyMs)) ? Number(processProbe.latencyMs) : null,
      controlReadAttempts,
      processProbeAttempts,
      measuredAt: new Date().toISOString(),
    }
    sceneEvidence.decisionStimulus = decisionStimulus
    sceneEvidence.simulator.candidateChoices = [...scene.candidates]
  }

  const channel = requireSuccess(await app('POST', '/api/workshop/channels', {
    name: `${TAG}-${scene.id}-harness-channel`,
    description: HARNESS_MODE === 'real-omp' ? 'Bounded real OMP simulator integration trial channel' : 'One-turn deterministic OMP transport fixture channel',
  }), `${scene.id} channel creation`)
  const agentConfig = HARNESS_MODE === 'real-omp'
    ? {
        command: 'omp',
        cwd: HOME,
        args: ['--no-extensions', '--no-skills', '--no-rules', '--no-lsp', '--no-pty', '--no-tools'],
        provider: REAL_OMP_PROVIDER,
        model: REAL_OMP_MODEL,
        rpcMode: 'rpc',
        promptTimeoutMs: REAL_OMP_PROMPT_TIMEOUT_MS,
        systemPromptPrefix: realOmpSystemPrompt(scene, recipe, control, decisionStimulus),
      }
    : {
        command: wrapperPath,
        args: [
          '--scene', scene.id,
          '--recipe-id', recipe.id,
          '--node-id', control.id,
          '--value', String(scene.candidate),
          '--trace-root', ROOT,
          '--trace-path', fixtureTracePath(scene.id),
        ],
        rpcMode: 'rpc',
      }
  const agent = requireSuccess(await app('POST', `/api/workshop/channels/${encodeURIComponent(channel.channelId)}/agents`, {
    name: `${TAG}-${scene.id}-${HARNESS_MODE === 'real-omp' ? 'omp-real' : 'omp-fixture'}`,
    harness: 'omp',
    role: 'lead',
    config: agentConfig,
  }), `${scene.id} registered OMP lead creation`)

  const recipeBinding = requireSuccess(await app('POST', '/api/workshop/agent-tools/bindings', {
    agentId: agent.id, nodeId: recipe.id, kind: 'recipe',
  }), `${scene.id} recipe binding`).binding
  const daqBinding = requireSuccess(await app('POST', '/api/workshop/agent-tools/bindings', {
    agentId: agent.id, nodeId: daq.id, kind: 'daq', mode: 'auto',
  }), `${scene.id} DAQ binding`).binding
  check(`${scene.id}-registered-omp`, agent.harness === 'omp' && Boolean(agent.id), { harness: agent.harness, agentId: agent.id })
  check(`${scene.id}-manual-recipe-binding`, recipeBinding.kind === 'recipe' && recipeBinding.mode === 'manual', { kind: recipeBinding.kind, mode: recipeBinding.mode })
  check(`${scene.id}-daq-observation-binding`, daqBinding.kind === 'daq', { kind: daqBinding.kind })

  sceneEvidence.entities = { lineId: line.id, productId: product.id, recipeId: recipe.id, controlNodeId: control.id, daqNodeId: daq.id, channelId: channel.channelId, agentId: agent.id }
  sceneEvidence.bindings = { recipe: { kind: recipeBinding.kind, mode: recipeBinding.mode }, daq: { kind: daqBinding.kind, mode: daqBinding.mode } }
  sceneEvidence.routePolicy = { tool: 'recipe_trial', emergency: false, cadenceBypass: false, recipeBindingMode: recipeBinding.mode }
  sceneEvidence.status = 'setup-complete'
  return { line, product, template, control, daq, recipe, channel, agent, runId, evidence: sceneEvidence }
}

async function submitFixtureTask(context) {
  currentStage = `${context.evidence.id}:submit-lead-task`
  const sent = requireSuccess(await app('POST', `/api/workshop/channels/${encodeURIComponent(context.channel.channelId)}/tasks`, {
    title: `Isolated ${context.evidence.id} recipe_trial verification`,
    description: `Execute the preconfigured isolated ${context.evidence.id} recipe_trial candidate once and return the tool outcome.`,
    fromLabel: 'Synthetic isolated test driver',
  }), `${context.evidence.id} lead task submission`)
  context.evidence.taskId = sent.id ?? sent.task?.id ?? null
}

async function submitRealOmpTask(context) {
  currentStage = `${context.evidence.id}:submit-real-omp-task`
  const sent = requireSuccess(await app('POST', `/api/workshop/channels/${encodeURIComponent(context.channel.channelId)}/tasks`, {
    title: `R20 ${context.evidence.id} recipe_trial with explicit task closure`,
    description: [
      'Use the measured process context in your registered system prompt to choose one candidate from its prevalidated set.',
      `Call recipe_trial exactly once with recipe_id ${context.recipe.id} and one params entry for node_id ${context.control.id} using your selected value.`,
      'After receiving the recipe_trial result, call complete_task exactly once on the active root task shown in the supervision context. Include the selected value and returned command-verification outcome in a concise summary and deliverable.',
      'Do not make any other tool calls. Do not retry, save, update, apply, or roll back a recipe. If no candidate is justified, abstain and explicitly close the task with that limitation.',
    ].join(' '),
    fromLabel: 'Synthetic isolated R20 test driver',
  }), `${context.evidence.id} real OMP lead task submission`)
  context.evidence.taskId = sent.id ?? sent.task?.id ?? null
  if (!context.evidence.taskId) throw new Error(`${context.evidence.id} real OMP task submission returned no task identifier`)
}

function taskToolEvents(task) {
  const events = []
  for (const message of task?.history ?? []) {
    for (const part of message?.parts ?? []) {
      const text = typeof part?.text === 'string' ? part.text : ''
      const match = text.match(/^🔧\s+([a-z][a-z\d_]*)/i)
      if (!match) continue
      events.push({
        toolName: match[1],
        phase: /(?:✅\s*完成|❌\s*失败)/.test(text) ? 'result' : 'call',
        isError: /❌\s*失败/.test(text),
        messageId: message.messageId ?? null,
        text,
      })
    }
  }
  return events
}

async function readRealOmpTask(context) {
  const result = await app('GET', `/api/workshop/tasks/${encodeURIComponent(context.evidence.taskId)}?channelId=${encodeURIComponent(context.channel.channelId)}`)
  if (result.status !== 200) throw new Error(`${context.evidence.id} task detail returned HTTP ${result.status}`)
  return result.data
}

async function waitForRealOmpTaskCompletion(context) {
  const deadline = Date.now() + REAL_OMP_TASK_COMPLETION_TIMEOUT_MS
  let latest
  while (Date.now() < deadline) {
    latest = await readRealOmpTask(context)
    if (latest.state === 'COMPLETED') return latest
    if (['FAILED', 'CANCELED'].includes(latest.state)) {
      throw new Error(`${context.evidence.id} task reached ${latest.state} before completing the approved operation`)
    }
    await delay(500)
  }
  throw new Error(`${context.evidence.id} task did not reach COMPLETED within the bounded post-approval window (state=${latest?.state ?? 'unknown'})`)
}

function assertSingleRealOmpCall(context, task) {
  const events = taskToolEvents(task)
  const calls = events.filter(event => event.phase === 'call')
  const recipeCalls = calls.filter(event => event.toolName === 'recipe_trial')
  const recipeResults = events.filter(event => event.toolName === 'recipe_trial' && event.phase === 'result')
  const completionCalls = calls.filter(event => event.toolName === 'complete_task')
  // The active lead turn is journaled through both the task-event mapper and
  // the supervisor listener. A single host invocation can therefore appear
  // twice in history; identical start text identifies that mirror. Route
  // ledgers below remain authoritative for the number of executed trials.
  const uniqueRecipeCalls = [...new Set(recipeCalls.map(event => event.text))]
  if (events.some(event => !['recipe_trial', 'complete_task'].includes(event.toolName))
    || recipeCalls.length < 1 || recipeCalls.length > 2 || uniqueRecipeCalls.length !== 1
    || recipeResults.length < 1 || recipeResults.length > 2 || recipeResults.some(event => event.isError)
    || completionCalls.length !== 1) {
    throw new Error(`${context.evidence.id} OMP task history must show one recipe_trial invocation (allowing its mirrored journal entry), a successful result, and one explicit task-completion call`)
  }
  return { events, calls: [recipeCalls[0]], results: [recipeResults[0]], completionCalls }
}

async function approveRealOmpTrial(context) {
  currentStage = `${context.evidence.id}:await-real-omp-hitl-approval`
  const deadline = Date.now() + REAL_OMP_APPROVAL_TIMEOUT_MS
  let pending
  let latestTask
  while (Date.now() < deadline) {
    latestTask = await readRealOmpTask(context)
    if (['FAILED', 'CANCELED', 'COMPLETED'].includes(latestTask.state)) {
      throw new Error(`${context.evidence.id} task reached ${latestTask.state} before synthetic approval`)
    }
    const result = await app('GET', `/api/workshop/agent-tools/approvals?agentId=${encodeURIComponent(context.agent.id)}&scope=pending`)
    if (result.status === 200) {
      const matches = (result.data?.approvals ?? []).filter(item => item.agentId === context.agent.id && item.nodeId === `recipe:${context.recipe.id}` && item.status === 'pending')
      if (matches.length > 1) throw new Error(`${context.evidence.id} has multiple pending real OMP trial approvals`)
      if (matches.length === 1) {
        const payload = matches[0].payload
        const params = Array.isArray(payload?.params) ? payload.params : []
        const proposedValue = Number(params[0]?.to)
        const decisionStimulus = context.evidence.decisionStimulus
        const allowedValues = decisionStimulus?.allowedValues ?? []
        const isExpectedTrial = payload?.kind === 'recipe-gate'
          && payload?.op === 'trial'
          && payload?.recipeId === context.recipe.id
          && payload?.emergency !== true
          && payload?.emergency !== 'true'
          && params.length === 1
          && params[0]?.nodeId === context.control.id
          && Number.isFinite(proposedValue)
          && allowedValues.includes(proposedValue)
          && proposedValue >= Number(context.evidence.simulator.mv.min)
          && proposedValue <= Number(context.evidence.simulator.mv.max)
          && Math.abs(proposedValue - Number(decisionStimulus.controlValue)) <= 30
        if (!isExpectedTrial) throw new Error(`${context.evidence.id} refused a pending approval outside the registered recipe_trial candidate set`)
        context.evidence.simulator.candidate = proposedValue
        context.evidence.modelDecision = {
          source: 'registered OMP host-tool proposal, checked against current protocol reads and prevalidated set',
          controlValue: decisionStimulus.controlValue,
          processValue: decisionStimulus.processValue,
          targetBand: [decisionStimulus.targetMin, decisionStimulus.targetMax],
          allowedValues,
          selectedValue: proposedValue,
          selectionRationale: safeText(payload?.hypothesis ?? payload?.rationale ?? '', 400),
          selectedValueWithinRangeAndStep: true,
        }
        pending = matches[0]
        break
      }
    }
    await delay(500)
  }
  if (!pending) throw new Error(`${context.evidence.id} real OMP recipe_trial approval did not appear within the bounded window`)
  context.evidence.approvals.push({ id: pending.id, statusBeforeDecision: pending.status, nodeId: pending.nodeId, title: pending.title ?? null, candidateValue: context.evidence.simulator.candidate, decision: 'approve' })
  requireSuccess(await app('POST', `/api/workshop/agent-tools/approvals/${encodeURIComponent(pending.id)}/decide`, {
    approved: true,
    comment: 'Approved for the bounded R20 local simulator integration check.',
  }), `${context.evidence.id} synthetic real OMP HITL approval`)
  const history = await app('GET', `/api/workshop/agent-tools/approvals?agentId=${encodeURIComponent(context.agent.id)}&scope=history`)
  const finalApproval = (history.data?.approvals ?? []).find(item => item.id === pending.id)
  if (history.status !== 200 || finalApproval?.status !== 'approved' || finalApproval?.decidedBy !== syntheticAdminId) {
    throw new Error(`${context.evidence.id} real OMP HITL history did not confirm the synthetic administrator decision`)
  }
  context.evidence.approvals[0] = {
    ...context.evidence.approvals[0],
    statusAfterDecision: finalApproval.status,
    decisionActor: 'synthetic isolated administrator via protected approval API',
    commentRecorded: finalApproval.comment === 'Approved for the bounded R20 local simulator integration check.',
  }
}

async function captureRealOmpUsage(context) {
  const unavailable = {
    source: 'not exposed by the channel queue endpoint',
    context: null,
    requestInputTokens: null,
    requestOutputTokens: null,
    costUsd: null,
    costAvailable: false,
  }
  if (!context?.channel?.channelId || !context?.agent?.id) return unavailable
  try {
    const queueResult = await app('GET', `/api/workshop/channels/${encodeURIComponent(context.channel.channelId)}/queue`)
    if (queueResult.status !== 200) return unavailable
    const queue = extractPayload(queueResult.body)
    const agentStatus = (Array.isArray(queue) ? queue : []).find(item => item.agentId === context.agent.id)
    const raw = agentStatus?.context
    if (!raw) return unavailable
    return {
      source: 'channel queue OMP context snapshot (not request-level billing)',
      context: {
        usedTokens: Number.isFinite(Number(raw.usedTokens)) ? Number(raw.usedTokens) : null,
        contextWindow: Number.isFinite(Number(raw.contextWindow)) ? Number(raw.contextWindow) : null,
        percent: Number.isFinite(Number(raw.percent)) ? Number(raw.percent) : null,
        compacting: raw.compacting === true,
      },
      requestInputTokens: null,
      requestOutputTokens: null,
      costUsd: null,
      costAvailable: false,
    }
  }
  catch { return unavailable }
}

async function approvePendingTrial(context) {
  currentStage = `${context.evidence.id}:manual-hitl-approval`
  const deadline = Date.now() + 20_000
  let pending
  while (Date.now() < deadline) {
    const result = await app('GET', `/api/workshop/agent-tools/approvals?agentId=${encodeURIComponent(context.agent.id)}&scope=pending`)
    if (result.status === 200) {
      const matches = (result.data?.approvals ?? []).filter(item => item.agentId === context.agent.id && item.nodeId === `recipe:${context.recipe.id}` && item.status === 'pending')
      if (matches.length > 1) throw new Error(`${context.evidence.id} has multiple pending trial approvals`)
      if (matches.length === 1) {
        pending = matches[0]
        break
      }
    }
    await delay(400)
  }
  if (!pending) throw new Error(`${context.evidence.id} manual recipe_trial HITL approval did not appear within the bounded window`)
  context.evidence.approvals.push({ id: pending.id, statusBeforeDecision: pending.status, nodeId: pending.nodeId, title: pending.title ?? null, decision: 'approve' })
  const decided = await app('POST', `/api/workshop/agent-tools/approvals/${encodeURIComponent(pending.id)}/decide`, {
    approved: true,
    comment: 'Approved for the isolated deterministic simulator integration check.',
  })
  requireSuccess(decided, `${context.evidence.id} explicit HITL approval`)
  const history = await app('GET', `/api/workshop/agent-tools/approvals?agentId=${encodeURIComponent(context.agent.id)}&scope=history`)
  const finalApproval = (history.data?.approvals ?? []).find(item => item.id === pending.id)
  if (history.status !== 200 || finalApproval?.status !== 'approved' || finalApproval?.decidedBy !== syntheticAdminId) {
    throw new Error(`${context.evidence.id} HITL approval history failed to confirm the explicit administrator decision`)
  }
  context.evidence.approvals[0] = {
    ...context.evidence.approvals[0],
    statusAfterDecision: finalApproval.status,
    decisionActor: 'synthetic isolated administrator via protected approval API',
    commentRecorded: finalApproval.comment === 'Approved for the isolated deterministic simulator integration check.',
  }
}

async function collectSceneEvidence(context) {
  currentStage = `${context.evidence.id}:collect-result-and-observations`
  let trace
  let toolName
  let toolText
  let toolIsError
  let realTask
  let realToolEvents
  if (HARNESS_MODE === 'real-omp') {
    // The supervisor journals compact host-tool start/result events on the
    // active root task. Approval and operation ledgers remain authoritative
    // for the proposal and its execution.
    realTask = await waitForRealOmpTaskCompletion(context)
    if (realTask.assigneeId !== context.agent.id) throw new Error(`${context.evidence.id} real OMP task was not executed by its registered lead agent`)
    realToolEvents = assertSingleRealOmpCall(context, realTask)
    const channelMessages = requireSuccess(await app('GET', `/api/workshop/channels/${encodeURIComponent(context.channel.channelId)}/messages?limit=500`), `${context.evidence.id} channel task evidence`)
    const taskMessages = (Array.isArray(channelMessages) ? channelMessages : []).filter(message => message.taskId === context.evidence.taskId)
    const usage = await captureRealOmpUsage(context)
    context.evidence.modelExecution = {
      provider: REAL_OMP_PROVIDER,
      model: REAL_OMP_MODEL,
      taskId: context.evidence.taskId,
      taskState: realTask.state,
      taskArtifactCount: Array.isArray(realTask.artifacts) ? realTask.artifacts.length : 0,
      evidenceSource: 'registered OMP task history, approval payload, task state, and route-specific recipe/ACK records',
      hostToolCallEvents: realToolEvents.calls.length + realToolEvents.completionCalls.length,
      hostToolResultEvents: realToolEvents.results.length,
      taskCompletionToolCallEvents: realToolEvents.completionCalls.length,
      taskToolEvents: realToolEvents.events.map(event => ({ toolName: event.toolName, phase: event.phase, isError: event.isError })),
      hostToolEventHistoryAvailable: realToolEvents.events.length > 0,
      approvedProposalValue: context.evidence.modelDecision?.selectedValue ?? null,
      approvedProposalCount: context.evidence.approvals.length,
      channelEvidence: {
        source: 'GET /api/workshop/channels/:id/messages',
        taskMessageCount: taskMessages.length,
        agentMessageCount: taskMessages.filter(message => message.fromAgentId === context.agent.id).length,
        roles: [...new Set(taskMessages.map(message => safeText(message.role, 40)))],
      },
      usage,
    }
  }
  else {
    const tracePath = fixtureTracePath(context.evidence.id)
    const deadline = Date.now() + 20_000
    while (Date.now() < deadline) {
      if (existsSync(tracePath)) {
        try {
          trace = JSON.parse(readFileSync(tracePath, 'utf8'))
        }
        catch { /* fixture is rewriting a small JSON trace */ }
      }
      if (trace?.hostToolResults?.length) break
      await delay(300)
    }
    if (!trace) throw new Error(`${context.evidence.id} deterministic fixture did not create its trace`)
    if (trace.hostToolCalls?.length !== 1 || trace.hostToolCalls[0]?.toolName !== 'recipe_trial' || trace.hostToolResults?.length !== 1) {
      throw new Error(`${context.evidence.id} fixture trace did not show exactly one recipe_trial host_tool_call/result`)
    }
    const toolResult = trace.hostToolResults[0].result
    toolText = String(toolResult?.content?.[0]?.text ?? '')
    toolName = trace.hostToolCalls[0].toolName
    toolIsError = Boolean(toolResult?.isError)
    if (toolIsError || !/全部设备证实|下发并全部设备证实/.test(toolText)) {
      throw new Error(`${context.evidence.id} recipe_trial did not return a fully verified device ACK`)
    }
  }

  const readback = await app('POST', `/api/workshop/dcw/${encodeURIComponent(context.control.id)}/read`)
  requireSuccess(readback, `${context.evidence.id} DCW readback`)

  const runData = await app('GET', `/api/workshop/dcw/runs/${encodeURIComponent(context.runId)}/data`)
  requireSuccess(runData, `${context.evidence.id} active run data`)
  const logs = await app('GET', `/api/workshop/ops-logs?scope=line&lineId=${encodeURIComponent(context.line.id)}&recipeId=${encodeURIComponent(context.recipe.id)}&limit=100`)
  requireSuccess(logs, `${context.evidence.id} recipe operation log`)
  const recipeRows = (logs.data?.logs ?? [])
    .filter(row => String(row.action).startsWith('recipe.'))
    .map((row) => {
      let detail = row.detail
      if (!detail || typeof detail !== 'object' || Array.isArray(detail)) {
        try {
          const parsed = JSON.parse(String(row.detailJson ?? '{}'))
          detail = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
        }
        catch { detail = {} }
      }
      return { ...row, detail }
    })
  const trialRows = recipeRows.filter(row => row.action === 'recipe.trial')
  const trialAckRows = recipeRows.filter(row => row.action === 'recipe.dispatch.ack' && row.detail?.trial === true)
  const trialRow = trialRows[0]
  const ackRow = trialAckRows[0]
  const trialRunId = String(ackRow?.detail?.runId ?? '')
  if (trialRows.length !== 1 || trialAckRows.length !== 1 || !trialRunId || String(trialRow?.detail?.runId ?? '') !== trialRunId) {
    throw new Error(`${context.evidence.id} recipe log did not contain exactly one matching recipe.trial and trial ACK pair`)
  }
  if (HARNESS_MODE === 'real-omp' && context.evidence.approvals.length !== 1) {
    throw new Error(`${context.evidence.id} expected exactly one approved real OMP proposal`)
  }
  const trialRunData = await app('GET', `/api/workshop/dcw/runs/${encodeURIComponent(trialRunId)}/data`)
  requireSuccess(trialRunData, `${context.evidence.id} trial run data`)
  const ack = ackRow.detail?.ackSummary ?? null
  if (!ack || ack.total !== 1 || ack.verified !== 1 || ack.failed !== 0 || ack.unverified !== 0) {
    throw new Error(`${context.evidence.id} logged trial ACK is not one-of-one verified`)
  }
  const returnedTrialRun = trialRunData.data?.run
  const trialResults = returnedTrialRun?.results
  if (returnedTrialRun?.id !== trialRunId || !Array.isArray(trialResults) || trialResults.length !== 1 || trialResults[0]?.verify?.verdict !== 'verified' || trialResults[0]?.ok !== true) {
    throw new Error(`${context.evidence.id} trial run data lacks an independently verified write result`)
  }

  const snapshotDelayStartedAt = new Date().toISOString()
  await delay(20_000)
  const probeStartedAt = new Date().toISOString()
  const probeResponse = await app('POST', `/api/workshop/daq/${encodeURIComponent(context.daq.id)}/test`)
  const probe = requireSuccess(probeResponse, `${context.evidence.id} DAQ driver probe`).test
  const sampleValue = Number(probe?.sampleValue)
  if (probe?.ok !== true || !Number.isFinite(sampleValue)) {
    throw new Error(`${context.evidence.id} DAQ driver probe did not return a finite simulator value`)
  }
  const probeCompletedAt = new Date().toISOString()
  const ingestAt = probeCompletedAt
  const ingest = requireSuccess(await app('POST', `/api/workshop/daq/${encodeURIComponent(context.daq.id)}/ingest`, {
    at: ingestAt,
    value: sampleValue,
    state: 'ok',
  }), `${context.evidence.id} DAQ snapshot ingest`)
  if (ingest?.accepted !== true || ingest.nodeId !== context.daq.id || ingest.lineId !== context.line.id) {
    throw new Error(`${context.evidence.id} DAQ snapshot ingest was not accepted for the expected node and line`)
  }

  const persistedAt = String(ingest.at ?? ingestAt)
  const persistedAtMs = Date.parse(persistedAt)
  if (!Number.isFinite(persistedAtMs)) throw new Error(`${context.evidence.id} DAQ snapshot ingest returned an invalid sample timestamp`)
  const fromMs = persistedAtMs
  const toMs = persistedAtMs + 1
  // Let the in-process queue and SQLite batch flush settle before a fixed-window query;
  // retries outlast the short query-cache TTL if the first lookup is still empty.
  await delay(800)
  const queryDeadline = Date.now() + 12_000
  let taggedQuery
  let taggedSeries
  let snapshotBucketAt
  while (Date.now() < queryDeadline) {
    const candidate = await app('GET', `/api/workshop/daq/query?line_id=${encodeURIComponent(context.line.id)}&node_ids=${encodeURIComponent(context.daq.id)}&run_id=${encodeURIComponent(context.runId)}&from=${fromMs}&to=${toMs}&bucket_ms=1000`)
    if (candidate.status === 200) {
      taggedQuery = candidate
      taggedSeries = candidate.data?.series?.find(series => series.nodeId === context.daq.id)
      const bucketMs = Number(candidate.data?.window?.bucketMs) || 1_000
      snapshotBucketAt = Math.floor(persistedAtMs / bucketMs) * bucketMs
      const matchingPoint = taggedSeries?.points?.find(point => Number(point.at) === snapshotBucketAt && Math.abs(Number(point.v) - sampleValue) <= 0.01)
      if (matchingPoint && candidate.data?.activeRun?.runId === context.runId) break
    }
    await delay(300)
  }
  if (!taggedQuery || !taggedSeries?.points?.length || taggedQuery.data?.activeRun?.runId !== context.runId) {
    throw new Error(`${context.evidence.id} platform DAQ query returned no snapshot tagged to the active run`)
  }
  const matchingProbePoint = taggedSeries.points.find(point => Number(point.at) === snapshotBucketAt && Math.abs(Number(point.v) - sampleValue) <= 0.01)
  if (!matchingProbePoint) {
    throw new Error(`${context.evidence.id} run-tagged DAQ data did not contain the driver-probe snapshot value`)
  }

  if (HARNESS_MODE === 'real-omp') {
    const finalTask = await readRealOmpTask(context)
    context.evidence.hostToolExecution = {
      provenance: 'registered OMP model proposal → protected synthetic approval → one recipe.trial and one verified DCW receipt',
      hostToolEventHistoryAvailable: realToolEvents.events.length > 0,
      taskStateAfterObservation: finalTask.state,
      taskCompleted: finalTask.state === 'COMPLETED',
      approvedProposalCount: context.evidence.approvals.length,
      recipeTrialCount: trialRows.length,
      recipeTrialAckCount: trialAckRows.length,
      toolName: 'recipe_trial',
      resultReceived: ack?.verified === 1 && ack?.failed === 0,
    }
    context.evidence.modelExecution.taskStateAfterObservation = finalTask.state
    context.evidence.modelExecution.taskCompleted = finalTask.state === 'COMPLETED'
  }
  else {
    context.evidence.fixtureTrace = {
      fixture: trace.fixture,
      decisionSource: trace.decisionSource,
      hostToolCallCount: trace.hostToolCalls.length,
      toolName,
      resultReceived: trace.hostToolResults.length === 1,
      toolResultText: safeText(toolText, 1200),
      toolIsError,
    }
  }
  context.evidence.trial = {
    runId: trialRunId,
    toolName,
    approvalId: context.evidence.approvals[0].id,
    ackSummary: ack,
    resultCount: trialResults.length,
    resultRows: trialResults,
  }
  context.evidence.readback = {
    expectedCandidate: context.evidence.simulator.candidate,
    response: readback.data?.outcome ?? readback.data?.read ?? readback.data,
    resultMatchesCandidate: (() => {
      const details = readback.data?.outcome ?? readback.data?.read ?? readback.data ?? {}
      const observed = Number(details.value ?? details.data?.value ?? details.result?.value)
      return Number.isFinite(observed) && Math.abs(observed - context.evidence.simulator.candidate) <= 0.01
    })(),
  }
  context.evidence.daq = {
    nodeId: context.daq.id,
    method: 'single driver-probe/ingest snapshot',
    storageBackend: 'isolated AW_HOME SQLite time-series fallback',
    postTrialDelaySeconds: 20,
    snapshotDelayStartedAt,
    sampleCount: taggedSeries.points.length,
    runTags: [context.runId],
    expectedActiveRunId: context.runId,
    probe: {
      driver: context.daq.driver,
      startedAt: probeStartedAt,
      completedAt: probeCompletedAt,
      sampleValue,
      latencyMs: Number.isFinite(Number(probe.latencyMs)) ? Number(probe.latencyMs) : null,
    },
    ingest: {
      accepted: ingest.accepted,
      at: persistedAt,
      value: sampleValue,
      state: 'ok',
    },
    taggedQuery: {
      requestedRunId: context.runId,
      returnedRunId: taggedQuery.data?.activeRun?.runId ?? null,
      seriesPointCount: taggedSeries.points.length,
      probeValueMatched: true,
      snapshotBucketAt: new Date(snapshotBucketAt).toISOString(),
      matchingProbePoint,
      series: taggedSeries.points.slice(-5),
    },
    activeRunDataKeys: Object.keys(runData.data ?? {}),
  }
  context.evidence.recipeLog = {
    query: 'ops-logs filtered by lineId and recipeId (recipe_log-equivalent audit view)',
    rowCount: recipeRows.length,
    trialAction: trialRow.action,
    trialSummary: safeText(trialRow.summary, 600),
    ackAction: ackRow.action,
    ackSummary: safeText(ackRow.summary, 600),
    trialRunDataKeys: Object.keys(trialRunData.data ?? {}),
  }
  context.evidence.status = 'verified'
}

async function runScene(scene) {
  const simDetails = await simulatorScene(scene)
  const context = await setupScene(scene, { ...simDetails, candidate: scene.candidate })
  context.evidence.simulator.candidate = scene.candidate
  context.evidence.simulator.baseline = scene.baseline
  await submitFixtureTask(context)
  await approvePendingTrial(context)
  await collectSceneEvidence(context)
  const stopped = await app('POST', `/api/workshop/dcw/lines/${encodeURIComponent(context.line.id)}/stop`)
  requireSuccess(stopped, `${scene.id} line stop`)
  context.evidence.activeRun.endedAt = stopped.data?.run?.endedAt ?? null
  check(`${scene.id}-host-dispatch-one-call`, context.evidence.fixtureTrace.hostToolCallCount === 1, { tool: context.evidence.fixtureTrace.toolName })
  check(`${scene.id}-ack-verified`, context.evidence.trial.ackSummary.verified === 1 && context.evidence.trial.ackSummary.failed === 0, context.evidence.trial.ackSummary)
  check(`${scene.id}-readback-matches`, context.evidence.readback.resultMatchesCandidate, context.evidence.readback)
  check(`${scene.id}-run-tagged-daq-probe-ingest-snapshot`, context.evidence.daq.taggedQuery.seriesPointCount >= 1 && context.evidence.daq.taggedQuery.probeValueMatched, {
    method: context.evidence.daq.method,
    value: context.evidence.daq.probe.sampleValue,
    runId: context.evidence.daq.expectedActiveRunId,
    matchingPoint: context.evidence.daq.taggedQuery.matchingProbePoint,
  })
  check(`${scene.id}-recipe-log`, context.evidence.recipeLog.rowCount >= 2, { trialAction: context.evidence.recipeLog.trialAction, ackAction: context.evidence.recipeLog.ackAction })
}

async function recoverFailedRealOmpTrial(context, outcome) {
  const recovery = []
  if (context?.evidence?.taskId) {
    try {
      const task = await readRealOmpTask(context)
      if (!['COMPLETED', 'FAILED', 'CANCELED'].includes(task.state)) {
        const canceled = await app('POST', `/api/workshop/tasks/${encodeURIComponent(context.evidence.taskId)}/cancel`)
        recovery.push({ action: 'cancel-nonterminal-task', status: canceled.status === 200 ? 'completed' : `http-${canceled.status}` })
      }
      else recovery.push({ action: 'cancel-nonterminal-task', status: 'not-needed', taskState: task.state })
    }
    catch (error) { recovery.push({ action: 'cancel-nonterminal-task', status: 'failed', error: compactError(error) }) }
  }
  if (context?.channel?.channelId && context?.agent?.id) {
    try {
      const stopped = await app('POST', `/api/workshop/channels/${encodeURIComponent(context.channel.channelId)}/agents/${encodeURIComponent(context.agent.id)}/stop`)
      recovery.push({ action: 'stop-agent-runtime', status: stopped.status === 200 ? 'completed' : `http-${stopped.status}` })
    }
    catch (error) { recovery.push({ action: 'stop-agent-runtime', status: 'failed', error: compactError(error) }) }
    try {
      const pendingResult = await app('GET', `/api/workshop/agent-tools/approvals?agentId=${encodeURIComponent(context.agent.id)}&scope=pending`)
      const pending = pendingResult.status === 200
        ? (pendingResult.data?.approvals ?? []).filter(item => item.agentId === context.agent.id && item.status === 'pending')
        : []
      for (const approval of pending) {
        const denied = await app('POST', `/api/workshop/agent-tools/approvals/${encodeURIComponent(approval.id)}/decide`, {
          approved: false,
          comment: 'Denied during bounded R20 failure cleanup.',
        })
        recovery.push({ action: 'deny-pending-agent-approval', approvalId: approval.id, status: denied.status === 200 ? 'completed' : `http-${denied.status}` })
      }
      if (pendingResult.status !== 200) recovery.push({ action: 'deny-pending-agent-approval', status: `list-http-${pendingResult.status}` })
      else if (pending.length === 0) recovery.push({ action: 'deny-pending-agent-approval', status: 'not-needed' })
    }
    catch (error) { recovery.push({ action: 'deny-pending-agent-approval', status: 'failed', error: compactError(error) }) }
  }
  if (context?.line?.id) {
    try {
      const stopped = await app('POST', `/api/workshop/dcw/lines/${encodeURIComponent(context.line.id)}/stop`)
      recovery.push({ action: 'stop-line', status: stopped.status === 200 ? 'completed' : `http-${stopped.status}` })
    }
    catch (error) { recovery.push({ action: 'stop-line', status: 'failed', error: compactError(error) }) }
  }
  outcome.recovery = recovery
}

async function runRealOmpScene(baseScene) {
  currentScene = baseScene.id
  let simDetails
  try {
    currentStage = `${baseScene.id}:simulator-setup-once`
    simDetails = await simulatorScene(baseScene)
    if (!Array.isArray(baseScene.candidates) || baseScene.candidates.length !== REAL_OMP_TRIALS_PER_SCENE
      || baseScene.candidates.some(candidate => !Number.isFinite(candidate)
        || candidate < Number(simDetails.mv.min)
        || candidate > Number(simDetails.mv.max)
        || Math.abs(candidate - baseScene.baseline) > 30)) {
      throw new Error(`${baseScene.id} real OMP candidates violate the configured count, process range, or 30-unit recipe step limit`)
    }
  }
  catch (error) {
    for (let repetition = 1; repetition <= REAL_OMP_TRIALS_PER_SCENE; repetition++) {
      const outcome = {
        id: `${baseScene.id}-r${repetition}`,
        scene: baseScene.id,
        repetition,
        provider: REAL_OMP_PROVIDER,
        model: REAL_OMP_MODEL,
        candidate: baseScene.candidates[repetition - 1],
        usage: { source: 'not available because simulator setup failed', context: null, requestInputTokens: null, requestOutputTokens: null, costUsd: null, costAvailable: false },
        costUsd: null,
        status: 'failed',
        failure: compactError(error),
      }
      evidence.experiment.runOutcomes.push(outcome)
    }
    return
  }

  for (let repetition = 1; repetition <= REAL_OMP_TRIALS_PER_SCENE; repetition++) {
    const scene = { ...baseScene, id: `${baseScene.id}-r${repetition}` }
    const outcome = {
      id: scene.id,
      scene: baseScene.id,
      repetition,
      provider: REAL_OMP_PROVIDER,
      model: REAL_OMP_MODEL,
      candidate: null,
      candidateChoices: [...baseScene.candidates],
      usage: { source: 'not yet available', context: null, requestInputTokens: null, requestOutputTokens: null, costUsd: null, costAvailable: false },
      costUsd: null,
      status: 'running',
      startedAt: new Date().toISOString(),
    }
    evidence.experiment.runOutcomes.push(outcome)
    let context
    try {
      currentScene = scene.id
      const runSimDetails = { ...simDetails, candidateChoices: [...baseScene.candidates] }
      context = await setupScene(scene, runSimDetails)
      context.evidence.simulator.baseline = scene.baseline
      outcome.entities = context.evidence.entities
      outcome.runId = context.runId
      await submitRealOmpTask(context)
      outcome.taskId = context.evidence.taskId
      await approveRealOmpTrial(context)
      outcome.candidate = context.evidence.simulator.candidate
      outcome.modelDecision = context.evidence.modelDecision
      await collectSceneEvidence(context)
      const stopped = await app('POST', `/api/workshop/dcw/lines/${encodeURIComponent(context.line.id)}/stop`)
      requireSuccess(stopped, `${scene.id} line stop`)
      context.evidence.activeRun.endedAt = stopped.data?.run?.endedAt ?? null
      const finalTask = await readRealOmpTask(context)
      context.evidence.hostToolExecution.taskStateAfterObservation = finalTask.state
      context.evidence.hostToolExecution.taskCompleted = finalTask.state === 'COMPLETED'
      context.evidence.modelExecution.taskStateAfterObservation = finalTask.state
      context.evidence.modelExecution.taskCompleted = finalTask.state === 'COMPLETED'
      check(`${scene.id}-real-omp-approved-model-proposal`, context.evidence.modelExecution.approvedProposalCount === 1 && context.evidence.modelExecution.approvedProposalValue === context.evidence.simulator.candidate, {
        provider: REAL_OMP_PROVIDER,
        model: REAL_OMP_MODEL,
        selectedValue: context.evidence.modelExecution.approvedProposalValue,
        toolEventHistoryAvailable: context.evidence.modelExecution.hostToolEventHistoryAvailable,
      })
      check(`${scene.id}-real-omp-one-recipe-trial-ledger`, context.evidence.hostToolExecution.recipeTrialCount === 1 && context.evidence.hostToolExecution.recipeTrialAckCount === 1, {
        recipeTrialCount: context.evidence.hostToolExecution.recipeTrialCount,
        recipeTrialAckCount: context.evidence.hostToolExecution.recipeTrialAckCount,
      })
      check(`${scene.id}-ack-verified`, context.evidence.trial.ackSummary.verified === 1 && context.evidence.trial.ackSummary.failed === 0, context.evidence.trial.ackSummary)
      check(`${scene.id}-readback-matches`, context.evidence.readback.resultMatchesCandidate, context.evidence.readback)
      check(`${scene.id}-run-tagged-daq-probe-ingest-snapshot`, context.evidence.daq.taggedQuery.seriesPointCount >= 1 && context.evidence.daq.taggedQuery.probeValueMatched, {
        method: context.evidence.daq.method,
        value: context.evidence.daq.probe.sampleValue,
        runId: context.evidence.daq.expectedActiveRunId,
        matchingPoint: context.evidence.daq.taggedQuery.matchingProbePoint,
      })
      check(`${scene.id}-recipe-log`, context.evidence.recipeLog.rowCount >= 2, { trialAction: context.evidence.recipeLog.trialAction, ackAction: context.evidence.recipeLog.ackAction })
      check(`${scene.id}-real-omp-task-completed`, context.evidence.hostToolExecution.taskCompleted, {
        taskState: context.evidence.hostToolExecution.taskStateAfterObservation,
      })
      context.evidence.status = 'verified'
      outcome.status = context.evidence.hostToolExecution.taskCompleted ? 'verified' : 'verified-operation-task-incomplete'
      outcome.finishedAt = new Date().toISOString()
      outcome.trialRunId = context.evidence.trial.runId
      outcome.taskState = context.evidence.hostToolExecution.taskStateAfterObservation
      outcome.usage = context.evidence.modelExecution.usage
      outcome.costUsd = null
      outcome.evidenceSceneId = context.evidence.id
    }
    catch (error) {
      context && (context.evidence.status = 'failed')
      if (context) context.evidence.failure = compactError(error)
      outcome.status = 'failed'
      outcome.failure = compactError(error)
      outcome.finishedAt = new Date().toISOString()
      if (context) {
        outcome.usage = await captureRealOmpUsage(context)
        await recoverFailedRealOmpTrial(context, outcome)
      }
    }
  }
}

async function startApplication() {
  currentStage = 'application-startup'
  await assertFreeLoopback(OFFLINE_APP_MQTT_QUEUE_PORT, 'offline-app-mqtt-queue-probe-before-startup')
  noteIsolation('offline-app-mqtt-queue-port-free-immediately-before-startup', true, {
    port: OFFLINE_APP_MQTT_QUEUE_PORT,
    host: '127.0.0.1',
  })
  appProcess = spawnLogged(process.execPath, [NUXT_CLI, 'dev', '--host', '127.0.0.1', '--port', String(AW_PORT), '--dotenv', EMPTY_DOTENV], {
    cwd: REPO,
    env: cleanChildEnv(),
    logFd: APP_LOG_FD,
    label: 'agentworkshop',
  })
  for (let i = 0; i < 90; i++) {
    if (appProcess.exitCode !== null) throw new Error(`AgentWorkShop startup exited (code ${appProcess.exitCode})`)
    try {
      const response = await app('GET', '/api/health', undefined, { token: undefined, timeoutMs: 2_000 })
      if (response.status === 200 && response.data?.status === 'ok' && response.data?.workshop === 'ready') {
        if (response.data?.version !== VERSION) throw new Error(`server reported an app version that differs from the package manifest`)
        noteIsolation('application-loopback-ready', true, { version: response.data.version, workshop: response.data.workshop, port: AW_PORT, host: '127.0.0.1' })
        return response.data
      }
    }
    catch (error) {
      if (error?.message?.startsWith('server reported unexpected version')) throw error
    }
    await delay(500)
  }
  throw new Error('isolated AgentWorkShop startup timed out or workshop manager did not become ready')
}

async function main() {
  mkdirSync(join(REPO, '.omc'), { recursive: true })
  if (typeof VERSION !== 'string' || VERSION.length === 0) throw new Error('package manifest does not define a version')
  await preflight()
  prepareIsolatedHome()
  if (HARNESS_MODE === 'fixture') {
    currentStage = 'compile-local-omp-fixture-shim'
    wrapperPath = buildHarnessShim()
    noteIsolation('registered-omp-fixture-launcher-ready', true, { platform: process.platform, wrapper: 'local process shim; fixture is deterministic' })
  }
  else {
    noteIsolation('registered-omp-real-provider-model-declared', true, {
      command: 'omp from allowlisted PATH',
      provider: REAL_OMP_PROVIDER,
      model: REAL_OMP_MODEL,
      cwd: 'fresh isolated AW_HOME',
      authSource: 'local OMP auth store; value is not inspected or added to evidence',
      discoveryDisabled: ['extensions', 'skills', 'rules'],
      credentialValuesExposedToRunnerOrEvidence: false,
    })
  }
  currentStage = 'simulator-startup'
  await bootSimulator()
  const health = await startApplication()
  evidence.experiment.server = { version: health.version, mode: health.mode, workshop: health.workshop, uptimeMsAtReady: health.uptimeMs }
  evidence.experiment.sourceIdentity = captureSourceIdentity()
  const admin = await registerAdmin()
  evidence.experiment.syntheticAdmin = admin
  await assertPluginIsolation()
  await verifyRagBridgeOutboundDisabled()
  const daqStatus = requireSuccess(await app('GET', '/api/workshop/daq', undefined, { timeoutMs: 45_000 }), 'isolated DAQ backend status')
  const settings = requireSuccess(await app('GET', '/api/system/settings'), 'effective runtime settings snapshot')
  const effectiveMqttHost = settings.effective?.['daq.mqtt.host']
  const effectiveMqttPort = Number(settings.effective?.['daq.mqtt.port'])
  const effectiveMqttPortSource = settings.sources?.['daq.mqtt.port']
  const effectiveInfrastructurePolicy = settings.effective?.['daq.startInfrastructure']
  const effectiveInfrastructurePolicySource = settings.sources?.['daq.startInfrastructure']
  const runtimeTargetMatches = effectiveMqttHost === '127.0.0.1'
    && effectiveMqttPort === OFFLINE_APP_MQTT_QUEUE_PORT
    && effectiveMqttPortSource === 'runtime'
    && effectiveInfrastructurePolicy === 'never'
    && effectiveInfrastructurePolicySource === 'runtime'
  check('runtime-settings-target-offline-loopback-queue', runtimeTargetMatches, {
    mqttHost: effectiveMqttHost ?? null,
    mqttPort: effectiveMqttPort,
    mqttPortSource: effectiveMqttPortSource ?? null,
    infrastructurePolicy: effectiveInfrastructurePolicy ?? null,
    infrastructurePolicySource: effectiveInfrastructurePolicySource ?? null,
  })
  check('isolated-inproc-queue-and-sqlite-tsdb', runtimeTargetMatches && daqStatus.meta?.queue === 'inproc' && daqStatus.meta?.tsdb === 'sqlite-emulated', {
    queue: daqStatus.meta?.queue ?? null,
    tsdb: daqStatus.meta?.tsdb ?? null,
    effectiveMqttHost,
    effectiveMqttPort,
    effectiveMqttPortSource,
  })
  noteIsolation('application-message-path-is-inproc', runtimeTargetMatches && daqStatus.meta?.queue === 'inproc', {
    queue: daqStatus.meta?.queue ?? null,
    effectiveMqttHost,
    effectiveMqttPort,
    effectiveMqttPortSource: effectiveMqttPortSource ?? null,
    simulatorMqttBrokerRemainsLoopback: `127.0.0.1:${MQTT_PORT}`,
  })
  evidence.isolation.result = 'passed'
  noteIsolation('application-env-and-dotenv-isolation', true, {
    launch: 'direct Nuxt CLI; dev-guard .env preload bypassed',
    dotenvFile: EMPTY_DOTENV,
    childEnvironmentAllowlisted: true,
    storageEndpointsRestrictedToFreeLoopbackPorts: true,
  })

  const scenes = [
    {
      id: 'cast-film', preset: 'cast-film-physics', sourceDevice: 'dev-extruder-opcua',
      mvSignal: 'ScrewSpeedSP', cvSignal: 'thick', baseline: 120, fixtureCandidate: 125,
      processDescription: 'cast-film extrusion; screw speed affects measured film thickness',
      targetMin: 48, targetMax: 52,
      candidates: [125, 130, 135],
    },
    {
      id: 'annealing', preset: 'anneal-line', sourceDevice: 'anneal-heating-mbtcp',
      mvSignal: '均热区3炉温SP', cvSignal: 'StripTemp', baseline: 730, fixtureCandidate: 735,
      processDescription: 'continuous annealing; zone-3 furnace setpoint affects measured strip temperature',
      targetMin: 700, targetMax: 760,
      candidates: [735, 740, 745],
    },
  ]
  if (HARNESS_MODE === 'real-omp') {
    check('real-omp-six-unique-trials-planned', scenes.length * REAL_OMP_TRIALS_PER_SCENE === 6 && new Set(scenes.flatMap(scene => Array.from({ length: REAL_OMP_TRIALS_PER_SCENE }, (_, index) => `${scene.id}-r${index + 1}`))).size === 6, {
      scenes: scenes.map(scene => scene.id),
      repetitionsPerScene: REAL_OMP_TRIALS_PER_SCENE,
    })
    for (const scene of scenes) await runRealOmpScene(scene)
    const failedRuns = evidence.experiment.runOutcomes.filter(outcome => outcome.status !== 'verified')
    evidence.status = failedRuns.length === 0 ? 'passed' : 'failed'
    if (failedRuns.length) {
      evidence.failure = {
        stage: 'real-omp-trial-set',
        name: 'RealOmpTrialSetError',
        message: `${failedRuns.length} of ${evidence.experiment.runOutcomes.length} bounded real OMP trials failed`,
        failedRunIds: failedRuns.map(outcome => outcome.id),
      }
      evidence.isolation.result = 'incomplete'
    }
  }
  else {
    for (const scene of scenes) await runScene({ ...scene, candidate: scene.fixtureCandidate })
    evidence.status = 'passed'
  }
}

async function cleanup() {
  currentStage = 'cleanup'
  const processResults = []
  const processByChild = new Map()
  if (appProcess) processByChild.set(appProcess, 'agentworkshop')
  if (simProcess) processByChild.set(simProcess, 'simulator')
  for (const child of children) if (!processByChild.has(child)) processByChild.set(child, child.label ?? 'child')
  for (const [child, label] of [...processByChild.entries()].reverse()) {
    try {
      const stopped = await stopProcessTree(child, label)
      processResults.push(stopped)
      if (!evidence.checks.some(item => item.id === `${label}-process-stopped`)) {
        evidence.checks.push({ id: `${label}-process-stopped`, status: 'fail', detail: { pid: child.pid ?? null, reason: 'process pid unavailable for termination verification' } })
      }
    }
    catch (error) {
      evidence.checks.push({ id: `${label}-process-stopped`, status: 'fail', detail: { pid: child.pid ?? null, error: compactError(error) } })
      processResults.push(false)
    }
  }
  const portResults = []
  for (const [label, port] of [
    ['app', AW_PORT],
    ['simulator-http', SIM_PORT],
    ['simulator-mqtt', MQTT_PORT],
    ['offline-app-mqtt-queue-probe', OFFLINE_APP_MQTT_QUEUE_PORT],
    ['offline-timescale-probe', OFFLINE_TSDB_PORT],
    ['offline-objectstore-probe', OFFLINE_OBJECTSTORE_PORT],
    ...allocatedDevicePorts.map((port, index) => [`simulator-device-${index}`, port]),
  ]) {
    try {
      await assertFreeLoopback(port, label)
      evidence.checks.push({ id: `${label}-port-released`, status: 'pass', detail: { port, host: '127.0.0.1' } })
      portResults.push(true)
    }
    catch (error) {
      evidence.checks.push({ id: `${label}-port-released`, status: 'fail', detail: { port, host: '127.0.0.1', error: compactError(error) } })
      portResults.push(false)
    }
  }
  try {
    closeSync(SIM_LOG_FD)
  }
  catch { /* already closed */ }
  try {
    closeSync(APP_LOG_FD)
  }
  catch { /* already closed */ }
  const requiredProcessLabels = evidence.status === 'passed' ? ['agentworkshop', 'simulator'] : [...processByChild.values()]
  const verifiedProcessLabels = new Set(evidence.checks.filter(item => item.id.endsWith('-process-stopped') && item.status === 'pass').map(item => item.id.replace(/-process-stopped$/, '')))
  const allRequiredProcessesVerified = requiredProcessLabels.every(label => verifiedProcessLabels.has(label))
  return processResults.every(Boolean) && portResults.every(Boolean) && allRequiredProcessesVerified
}

try {
  await main()
}
catch (error) {
  const preflightFailed = currentStage === 'preflight' || currentStage === 'compile-local-omp-fixture-shim' || currentStage === 'simulator-startup'
  evidence.status = preflightFailed ? 'blocked' : 'failed'
  evidence.failure = { stage: currentStage, scene: currentScene ?? null, ...compactError(error) }
  if (evidence.isolation.result === 'pending') evidence.isolation.result = preflightFailed ? 'failed' : 'incomplete'
}
finally {
  const cleanupPassed = await cleanup()
  if (!cleanupPassed) {
    evidence.status = 'failed'
    evidence.isolation.result = 'failed'
    evidence.failure ??= { stage: 'cleanup', name: 'CleanupVerificationError', message: 'process stop or loopback port release verification failed' }
    evidence.failure.cleanupVerificationFailed = true
  }
  if (evidence.status === 'passed') {
    const failedChecks = [...evidence.checks, ...evidence.isolation.checks].filter(item => item.status !== 'pass')
    const cleanupChecks = evidence.checks.filter(item => RELEASE_CHECK_SUFFIXES.some(suffix => item.id.endsWith(suffix)))
    if (failedChecks.length || !cleanupChecks.length || cleanupChecks.some(item => item.status !== 'pass')) {
      evidence.status = 'failed'
      evidence.isolation.result = 'failed'
      evidence.failure ??= { stage: 'final-verification', name: 'FinalVerificationError', message: 'not all experiment and cleanup checks passed' }
    }
  }
  evidence.cleanup = { status: cleanupPassed ? 'passed' : 'failed', requiredProcessAndPortChecks: true }
  evidence.experiment.finishedAt = new Date().toISOString()
  evidence.experiment.evidencePath = 'evidence.json'
  evidence.experiment.runtimeLogPaths = { app: 'agentworkshop.log', simulator: 'simulator.log' }
  writeFileSync(EVIDENCE_PATH, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8')
  console.log(`REGISTERED_HARNESS_E2E=${evidence.status}`)
  console.log(`EVIDENCE=${EVIDENCE_PATH}`)
  console.log(`STAGE=${evidence.failure?.stage ?? 'complete'}`)
}

if (evidence.status !== 'passed') process.exitCode = evidence.status === 'blocked' ? 2 : 1
