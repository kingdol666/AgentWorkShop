#!/usr/bin/env node
import { spawn, spawnSync, execFileSync } from 'node:child_process'
import { createHash, randomBytes, randomUUID, scryptSync } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { chmodSync, closeSync, copyFileSync, existsSync, fsyncSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, realpathSync, rmSync, rmdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { networkInterfaces } from 'node:os'
import { tmpdir } from 'node:os'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const RESULTS = join(REPO, 'bench', 'results')
const SCRIPT = 'bench/PIPELINE/run-approval-ablation-pilot.mjs'
const HOOK = 'server/services/workshop/agents/industrial/bench-approval-only.ts'
const OPS = 'server/services/workshop/agents/industrial/ops-tools.ts'
const DOCKERFILE = 'bench/PIPELINE/Dockerfile.a1-pilot'
const SIMULATOR_HELPER = 'bench/PIPELINE/approval-ablation-simulator.mjs'
const SYNTHETIC_FIXTURE_HELPER = 'bench/PIPELINE/initialize-a1-synthetic-workshop.mjs'
const CONTAINER_CREDENTIAL_PATH = '/run/pilot-credential.json'
let pilotCredentials

function sha(value) { return createHash('sha256').update(value).digest('hex') }
function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(',')}}`
  return JSON.stringify(value) ?? 'null'
}
function safeId(value) { return /^[a-zA-Z0-9_-]{8,80}$/.test(String(value ?? '')) }
function iso() { return new Date().toISOString() }
function ns() { return process.hrtime.bigint().toString() }
function parseArgs(argv) {
  const out = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    const value = argv[i]
    if (!value.startsWith('--')) { out._.push(value); continue }
    const key = value.slice(2)
    if (key.startsWith('no-')) { out[key.slice(3)] = false; continue }
    if (argv[i + 1] == null || argv[i + 1].startsWith('--')) { out[key] = true; continue }
    out[key] = argv[++i]
  }
  return out
}
function need(args, key) {
  const value = args[key]
  if (value == null || value === '') throw new Error(`--${key} is required`)
  return String(value)
}
function writeJson(path, value, exclusive = false) {
  mkdirSync(dirname(path), { recursive: true })
  const bytes = `${JSON.stringify(value, null, 2)}\n`
  if (exclusive) {
    const fd = openSync(path, 'wx', 0o600)
    try { writeFileSync(fd, bytes, 'utf8'); fsyncSync(fd) }
    finally { closeSync(fd) }
  }
  else writeFileSync(path, bytes, { encoding: 'utf8', mode: 0o600 })
}
function appendJsonl(path, value) {
  mkdirSync(dirname(path), { recursive: true })
  const fd = openSync(path, 'a', 0o600)
  try { writeFileSync(fd, `${JSON.stringify(value)}\n`, 'utf8'); fsyncSync(fd) }
  finally { closeSync(fd) }
}
function readJson(path) { return JSON.parse(readFileSync(path, 'utf8')) }
function safeUrl(raw, label) {
  const url = new URL(raw)
  if (!['http:', 'https:'].includes(url.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
    || !url.port || url.username || url.password || url.search || url.hash || !['', '/'].includes(url.pathname)) {
    throw new Error(`${label} must be an explicit loopback URL with a port`)
  }
  if ((label === 'SIM_BASE' && Number(url.port) === 4010) || (label === 'AW_BASE' && Number(url.port) === 3001)) {
    throw new Error(`${label} uses a shared/default port`)
  }
  return url.origin
}
function ensureNoSymlinks(root) {
  const realRoot = realpathSync(root)
  if (realRoot !== resolve(root)) throw new Error(`path traverses a symlink: ${root}`)
  if (!lstatSync(realRoot).isDirectory()) throw new Error(`root is not a regular directory: ${root}`)
  const walk = dir => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const child = join(dir, entry.name)
      const stat = lstatSync(child)
      if (stat.isSymbolicLink()) throw new Error(`symlink is not permitted in a template snapshot: ${child}`)
      if (entry.isDirectory()) walk(child)
      else if (!entry.isFile()) throw new Error(`non-regular filesystem entry is not permitted: ${child}`)
    }
  }
  walk(realRoot)
  return realRoot
}
function copyTree(source, destination, filter = () => true, root = source) {
  mkdirSync(destination, { recursive: true })
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const from = join(source, entry.name)
    const to = join(destination, entry.name)
    const rel = relative(root, from).replaceAll('\\', '/')
    if (!filter(rel, entry)) continue
    const stat = lstatSync(from)
    if (stat.isSymbolicLink()) throw new Error(`symlink copy refused: ${from}`)
    if (entry.isDirectory()) copyTree(from, to, filter, root)
    else if (entry.isFile()) copyFileSync(from, to)
    else throw new Error(`non-regular filesystem entry is not permitted: ${from}`)
  }
}
const SECRET_PATH = /(^|\/)(?:\.env(?:\.[^/]*)?|[^/]*(?:secret|credential|private[-_.]?key|access[-_.]?token|api[-_.]?key)[^/]*|[^/]+\.(?:pem|key|p12|pfx))$/i
const SECRET_PATH_SOURCE_EXCEPTIONS = new Map([
  ['server/plugins/00-daq-credentials.ts', 'Nitro startup plugin source; exact filename match only; content scan remains enabled'],
  ['server/services/system-config/secrets.ts', 'system configuration source; exact filename match only; content scan remains enabled'],
  ['server/services/workshop/daq/infra-credentials.ts', 'DAQ infrastructure credential-handling source; exact filename match only; content scan remains enabled'],
  ['server/services/workshop/mes/mes-secrets.repo.ts', 'MES secret-repository implementation source; exact filename match only; content scan remains enabled'],
  ['server/services/workshop/net/secret-auth.ts', 'network authentication implementation source; exact filename match only; content scan remains enabled'],
])
const SECRET_CONTENT = [
  /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{24,}/i,
  /(?:api[_-]?key|access[_-]?token|client[_-]?secret)\s*[:=]\s*["']?[A-Za-z0-9_./+=-]{24,}/i,
]
function rejectSecretLikeFile(bytes, relativePath) {
  const normalized = relativePath.replaceAll('\\', '/')
  if (SECRET_PATH.test(normalized) && !SECRET_PATH_SOURCE_EXCEPTIONS.has(normalized)) throw new Error(`secret-like path refused in sanitized input: ${normalized}`)
  if (bytes.includes(0)) return
  const content = bytes.toString('utf8')
  if (SECRET_CONTENT.some(pattern => pattern.test(content))) throw new Error(`secret-like content refused in sanitized input: ${normalized}`)
}
const SYNTHETIC_JSON_FILES = [
  'data/dcw-lines.json', 'data/dcws.json', 'data/dcw-products.json', 'data/dcw-recipes.json',
  'data/dcw-params.json', 'data/agent-node-bindings.json', 'data/line-runs.json',
  'data/dcw-writes.json',
]
const EMPTY_JSON_FILES = ['data/dcw-writes.json']
const SAFE_TEMPLATE_DRIVER_KEYS = {
  'modbus-tcp': ['host', 'port', 'unitId', 'register', 'registerType', 'dataType', 'byteOrder'],
  'opcua': ['endpoint', 'nodeId'],
}
function syntheticId(runId, kind) { return `a1-${sha(`${runId}:${kind}`).slice(0, 24)}` }
function readScenarioRows(source, relativePath, sourceHashes) {
  const fullPath = join(source, relativePath)
  const stat = lstatSync(fullPath)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 8 * 1024 * 1024) throw new Error(`required scenario file is not a bounded regular file: ${relativePath}`)
  const bytes = readFileSync(fullPath)
  if (bytes.length > 8 * 1024 * 1024) throw new Error(`required scenario file grew beyond its size limit: ${relativePath}`)
  if (sourceHashes) sourceHashes[relativePath] = sha(bytes)
  let parsed
  try { parsed = JSON.parse(bytes.toString('utf8')) }
  catch { throw new Error(`required scenario file is not valid JSON: ${relativePath}`) }
  if (!Array.isArray(parsed)) throw new Error(`required scenario file must contain an array: ${relativePath}`)
  return parsed
}
function exactlyOne(rows, predicate, label) {
  const matches = rows.filter(predicate)
  if (matches.length !== 1) throw new Error(`${label} must match exactly one source row; found ${matches.length}`)
  return matches[0]
}
function finite(value, label) {
  const number = Number(value)
  if (!Number.isFinite(number)) throw new Error(`${label} must be finite`)
  return number
}
function projectTransform(value) {
  if (value == null) return undefined
  if (value.kind === 'none') return { kind: 'none' }
  if (value.kind !== 'linear') throw new Error('target node uses an unsupported data transform')
  const scale = finite(value.scale, 'node transform scale')
  const offset = finite(value.offset ?? 0, 'node transform offset')
  if (scale === 0) throw new Error('node transform scale must be non-zero')
  return { kind: 'linear', scale, offset }
}
function projectDriverConfig(driver, config) {
  const allowed = SAFE_TEMPLATE_DRIVER_KEYS[driver]
  if (!allowed || !config || typeof config !== 'object' || Array.isArray(config)) throw new Error('target node must use supported simulator Modbus TCP or OPC UA configuration')
  const keys = Object.keys(config).sort()
  if (stable(keys) !== stable([...allowed].sort())) throw new Error('target driver configuration contains missing or unapproved fields')
  const projected = Object.fromEntries(allowed.map(key => [key, config[key]]))
  if (driver === 'opcua') {
    const endpoint = new URL(String(projected.endpoint ?? ''))
    if (endpoint.protocol !== 'opc.tcp:' || !['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname) || !endpoint.port || endpoint.username || endpoint.password) {
      throw new Error('target OPC UA endpoint must be a credential-free loopback simulator endpoint')
    }
    if (typeof projected.nodeId !== 'string' || !projected.nodeId) throw new Error('target OPC UA NodeId is empty')
  }
  else {
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(String(projected.host)) || !Number.isInteger(Number(projected.port)) || Number(projected.port) < 1024) {
      throw new Error('target Modbus endpoint must be a loopback simulator endpoint')
    }
    projected.port = Number(projected.port)
    projected.unitId = Number(projected.unitId)
    projected.register = Number(projected.register)
    if (!Number.isInteger(projected.unitId) || !Number.isInteger(projected.register)
      || !['holding', 'input'].includes(projected.registerType)
      || !['int16', 'uint16', 'int32', 'uint32', 'float32'].includes(projected.dataType)
      || !['big', 'little', 'wordSwap'].includes(projected.byteOrder)) throw new Error('target Modbus driver configuration is malformed')
  }
  return projected
}
function projectScenarioFiles(source, destination, { input, sourceActorId, ids }) {
  const sourceHashes = {}
  const sourceFiles = Object.fromEntries(SYNTHETIC_JSON_FILES.filter(path => !EMPTY_JSON_FILES.includes(path)).map(path => [path, readScenarioRows(source, path, sourceHashes)]))
  const lineSource = exactlyOne(sourceFiles['data/dcw-lines.json'], row => row?.id === input.line_id, 'target line')
  if (lineSource.controlMode != null && lineSource.controlMode !== 'manual') throw new Error('target line must already use manual control mode')
  if (lineSource.simulated !== true && lineSource.simulated !== false) throw new Error('target line has no explicit simulation classification')
  if (lineSource.simSceneId != null && lineSource.simSceneId !== '' && lineSource.simSceneId !== input.scene_id) throw new Error('target line is qualified for another simulator scene')
  const nodeSource = exactlyOne(sourceFiles['data/dcws.json'], row => row?.id === input.node_id, 'target node')
  if (nodeSource.enabled !== true || nodeSource.lineId !== input.line_id) throw new Error('target node must be enabled and attached to the selected line')
  const driverConfig = projectDriverConfig(String(nodeSource.driver), nodeSource.driverConfig)
  const recipeSource = exactlyOne(sourceFiles['data/dcw-recipes.json'], row => row?.id === input.recipe_id, 'target recipe')
  if (recipeSource.lineId !== input.line_id || typeof recipeSource.productId !== 'string' || !recipeSource.productId) throw new Error('target recipe line/product relationship is malformed')
  const sourceRecipeParams = Array.isArray(recipeSource.params) ? recipeSource.params : []
  const recipeParamSource = exactlyOne(sourceRecipeParams, param => param?.nodeId === input.node_id, 'recipe target parameter')
  const paramSource = exactlyOne(sourceFiles['data/dcw-params.json'], param => param?.nodeId === input.node_id, 'target parameter map')
  const productSource = exactlyOne(sourceFiles['data/dcw-products.json'], row => row?.id === recipeSource.productId, 'recipe product')
  if (productSource.lineId !== input.line_id) throw new Error('target product is not attached to the selected line')
  const activeLineRun = exactlyOne(sourceFiles['data/line-runs.json'], row => row?.lineId === input.line_id, 'active line run')
  if (!activeLineRun.recipeId || activeLineRun.recipeId !== input.recipe_id || !activeLineRun.runId) throw new Error('target line run does not match the selected recipe')
  if (activeLineRun.endedAt != null) throw new Error('target line run is not active')
  const sourceBindings = sourceFiles['data/agent-node-bindings.json']
    .filter(row => row?.agentId === sourceActorId
      && ((row.kind === 'recipe' && row.nodeId === input.recipe_id)
        || (row.kind === 'dcw' && row.nodeId === input.node_id)))
  if (sourceBindings.length === 0) throw new Error('source actor has no recipe or target-node write grant')
  if (sourceBindings.some(row => !['recipe', 'dcw'].includes(row.kind) || !['manual', 'auto'].includes(row.mode))) throw new Error('source actor target grant has an unsupported kind or mode')
  const sourceAccess = recipeSource.access
  let access
  if (sourceAccess != null) {
    const requireAuth = sourceAccess.requireAuth === true
    const sourceAuthorized = Array.isArray(sourceAccess.authorizedAgentIds) && sourceAccess.authorizedAgentIds.includes(sourceActorId)
    if (requireAuth && !sourceAuthorized) throw new Error('source recipe denies the requested actor under its second-factor allowlist')
    access = { requireAuth, authorizedAgentIds: requireAuth ? [ids.agent_id] : [] }
  }

  const createdAt = '2000-01-01T00:00:00.000Z'
  const recipeParam = {
    nodeId: input.node_id,
    templateRef: String(recipeParamSource.templateRef ?? nodeSource.templateRef ?? ''),
    value: finite(recipeParamSource.value, 'recipe baseline value'),
    ...(recipeParamSource.min == null ? {} : { min: finite(recipeParamSource.min, 'recipe parameter minimum') }),
    ...(recipeParamSource.max == null ? {} : { max: finite(recipeParamSource.max, 'recipe parameter maximum') }),
    ...(recipeParamSource.stepLimit == null ? {} : { stepLimit: finite(recipeParamSource.stepLimit, 'recipe step limit') }),
  }
  const paramKey = String(paramSource.key ?? '')
  if (!paramKey || paramSource.nodeId !== input.node_id || paramSource.key !== paramKey) throw new Error('target parameter map key is empty or malformed')
  const paramConversion = paramSource.conversion == null ? undefined : projectConversion(paramSource.conversion)
  const productRange = productSource.paramLimits?.[paramKey]
  if (productRange != null && (typeof productRange !== 'object' || Array.isArray(productRange))) throw new Error('target product parameter limit is malformed')

  const projectedRows = {
    'data/dcw-lines.json': [{
      id: input.line_id, name: 'A1 Synthetic Line', color: '#3A6EA5', description: '', controlMode: 'manual',
      simulated: lineSource.simulated, ...(lineSource.simSceneId ? { simSceneId: lineSource.simSceneId } : {}), createdAt,
    }],
    'data/dcws.json': [{
      id: input.node_id,
      templateRef: String(nodeSource.templateRef ?? ''),
      name: 'A1 Synthetic Control Node',
      driver: String(nodeSource.driver),
      enabled: true,
      holdIntervalMs: nodeSource.holdIntervalMs == null ? null : finite(nodeSource.holdIntervalMs, 'node hold interval'),
      readIntervalMs: nodeSource.readIntervalMs == null ? null : finite(nodeSource.readIntervalMs, 'node read interval'),
      writeLockSeconds: finite(nodeSource.writeLockSeconds ?? 0, 'node write lock'),
      stepLimit: nodeSource.stepLimit == null ? null : finite(nodeSource.stepLimit, 'node step limit'),
      unit: String(nodeSource.unit ?? ''),
      decimals: finite(nodeSource.decimals, 'node decimal places'),
      min: finite(nodeSource.min, 'node minimum'),
      max: finite(nodeSource.max, 'node maximum'),
      driverConfig,
      ...(nodeSource.transform == null ? {} : { transform: projectTransform(nodeSource.transform) }),
      lineId: input.line_id,
      value: finite(nodeSource.value, 'node baseline value'),
      state: 'idle',
      createdAt,
    }],
    'data/dcw-products.json': [{
      id: recipeSource.productId,
      lineId: input.line_id,
      name: 'A1 Synthetic Product',
      description: '',
      ...(productRange == null ? {} : { paramLimits: { [paramKey]: projectRange(productRange) } }),
      createdAt,
    }],
    'data/dcw-recipes.json': [{
      id: input.recipe_id,
      productId: recipeSource.productId,
      lineId: input.line_id,
      name: 'A1 Synthetic Recipe',
      description: '',
      params: [recipeParam],
      daqWindows: [],
      version: finite(recipeSource.version ?? 1, 'recipe version'),
      paramsHistory: [],
      lastGoodRunId: null,
      ...(recipeSource.opIntervalMs == null ? {} : { opIntervalMs: finite(recipeSource.opIntervalMs, 'recipe operation interval') }),
      ...(access === undefined ? {} : { access }),
      createdAt,
      updatedAt: createdAt,
    }],
    'data/dcw-params.json': [{
      id: syntheticId(input.run_id, `parameter:${input.node_id}`),
      key: paramKey,
      name: 'A1 Synthetic Parameter',
      templateRef: String(paramSource.templateRef ?? nodeSource.templateRef ?? ''),
      unit: String(paramSource.unit ?? nodeSource.unit ?? ''),
      decimals: finite(paramSource.decimals ?? nodeSource.decimals, 'parameter decimal places'),
      min: paramSource.min == null ? null : finite(paramSource.min, 'parameter minimum'),
      max: paramSource.max == null ? null : finite(paramSource.max, 'parameter maximum'),
      stepLimit: paramSource.stepLimit == null ? null : finite(paramSource.stepLimit, 'parameter step limit'),
      nodeId: input.node_id,
      ...(paramConversion === undefined ? {} : { conversion: paramConversion }),
      createdAt,
    }],
    'data/agent-node-bindings.json': sourceBindings.map((row, index) => ({
      id: syntheticId(input.run_id, `binding:${index}:${row.kind}:${row.nodeId}`),
      agentId: ids.agent_id,
      nodeId: row.kind === 'recipe' ? input.recipe_id : input.node_id,
      kind: row.kind,
      mode: row.mode,
      createdAt,
    })),
    'data/line-runs.json': [{
      lineId: input.line_id,
      runId: ids.run_id,
      recipeId: input.recipe_id,
      recipeVersion: finite(recipeSource.version ?? 1, 'active recipe version'),
      recipeName: 'A1 Synthetic Recipe',
      productId: recipeSource.productId,
      productName: 'A1 Synthetic Product',
      startedAt: createdAt,
      taggedSamples: 0,
    }],
    'data/dcw-runs.json': [{
      id: ids.run_id,
      recipeId: input.recipe_id,
      recipeName: 'A1 Synthetic Recipe',
      productId: recipeSource.productId,
      lineId: input.line_id,
      recipeVersion: finite(recipeSource.version ?? 1, 'active recipe version'),
      startedAt: createdAt,
      endedAt: null,
      results: [],
      paramsSnapshot: [recipeParam],
    }],
    'data/dcw-writes.json': [],
  }
  for (const [path, rows] of Object.entries(projectedRows)) writeJson(join(destination, path), rows)
  const seedRequestPath = join(destination, 'data', '.a1-workshop-seed-request.json')
  writeJson(seedRequestPath, {
    db_path: join(destination, 'data', 'workshop.sqlite'),
    run_id: input.run_id,
    line_id: input.line_id,
    created_at: new Date().toISOString(),
    ids,
    agent_token: randomBytes(32).toString('base64url'),
  }, true)
  let init
  try {
    init = spawnSync(process.execPath, ['--import', 'tsx', join(REPO, SYNTHETIC_FIXTURE_HELPER), seedRequestPath], {
      cwd: REPO, encoding: 'utf8', timeout: 120_000, maxBuffer: 2 * 1024 * 1024,
      env: {
        PATH: process.env.PATH ?? '',
        HOME: tmpdir(),
        TMPDIR: tmpdir(),
        LANG: 'C.UTF-8',
        NO_PROXY: '127.0.0.1,localhost,[::1]',
        no_proxy: '127.0.0.1,localhost,[::1]',
      },
    })
  }
  finally { rmSync(seedRequestPath, { force: true }) }
  if (init.error || init.status !== 0) throw new Error(`synthetic workshop schema initialization failed: ${String(init.stderr ?? init.error ?? 'child failed').slice(0, 1000)}`)
  const workshopFixture = JSON.parse(String(init.stdout ?? '').trim())
  const sourceProjection = {
    schema_version: 1,
    method: 'source-json-explicit-target-id-field-projection',
    source_actor_id_sha256: sha(sourceActorId),
    source_database_rows_read: false,
    source_database_files_copied: false,
    selected_ids: { line_id: input.line_id, recipe_id: input.recipe_id, node_id: input.node_id, product_id: recipeSource.productId },
    synthetic_ids: { user_id: ids.user_id, channel_id: ids.channel_id, agent_id: ids.agent_id, run_id: ids.run_id },
    source_files: Object.entries(sourceHashes).map(([path, sha256]) => ({ path, sha256 })),
    included_files: Object.keys(projectedRows),
    field_allowlists: {
      line: ['id', 'controlMode', 'simulated', 'simSceneId'],
      node: ['id', 'templateRef', 'driver', 'enabled', 'holdIntervalMs', 'readIntervalMs', 'writeLockSeconds', 'stepLimit', 'unit', 'decimals', 'min', 'max', 'driverConfig', 'transform', 'lineId', 'value'],
      product: ['id', 'lineId', 'paramLimits[selected_param_key]'],
      recipe: ['id', 'productId', 'lineId', 'params[selected_node_id]', 'version', 'opIntervalMs', 'access[requireAuth,source_actor_authorization]'],
      parameter: ['id', 'key', 'templateRef', 'unit', 'decimals', 'min', 'max', 'stepLimit', 'nodeId', 'conversion'],
      binding: ['kind', 'nodeId', 'mode'],
      active_run: ['lineId', 'recipeId', 'active-only; source run identity replaced by synthetic ID'],
      synthetic_dcw_run: ['generated from the selected line/recipe projection; source dcw-runs.json is not read or hashed'],
    },
    omitted_databases: [
      { path: 'data/users.sqlite', reason: 'source file was not opened or copied; replaced by fresh app-schema database with one synthetic administrator' },
      { path: 'data/workshop.sqlite', reason: 'source file was not opened or copied; replaced by fresh app-schema/migrations database with synthetic channel and agent' },
      { path: 'data/daq-timeseries.sqlite', reason: 'outside A1 scope; source file was not opened or copied' },
    ],
    omitted_historical_records: ['all non-target line/node/product/recipe/parameter/binding rows', 'messages', 'audit records', 'prior recipe runs', 'prior write history', 'user tokens', 'credentials', 'prompts and names'],
    synthetic_workshop_database: workshopFixture,
  }
  const userFixture = createSyntheticUserDatabase(destination, ids, input.run_id)
  const credentials = userFixture.credentials
  delete userFixture.credentials
  sourceProjection.synthetic_user_database = userFixture
  return { projection: sourceProjection, credentials }
}
function projectRange(value) {
  const range = {}
  if (value.min != null) range.min = finite(value.min, 'product limit minimum')
  if (value.max != null) range.max = finite(value.max, 'product limit maximum')
  if (Object.keys(range).length === 0) throw new Error('target product limit is empty')
  return range
}
function projectConversion(value) {
  if (!['float32', 'int16-scaled', 'int32-scaled'].includes(value.mode)) throw new Error('parameter conversion mode is not allowlisted')
  const out = { mode: value.mode }
  if (value.byteOrder != null) {
    if (!['big', 'little', 'wordSwap'].includes(value.byteOrder)) throw new Error('parameter conversion byte order is invalid')
    out.byteOrder = value.byteOrder
  }
  for (const key of ['engMin', 'engMax', 'rawMin', 'rawMax']) {
    if (value[key] != null) out[key] = finite(value[key], `parameter conversion ${key}`)
  }
  return out
}
function createSyntheticUserDatabase(snapshot, ids, runId) {
  const dbPath = join(snapshot, 'data', 'users.sqlite')
  if (existsSync(dbPath)) throw new Error('synthetic users database path already exists')
  const userRepositoryPath = join(REPO, 'server', 'repositories', 'user.repository.ts')
  const source = readFileSync(userRepositoryPath, 'utf8')
  const match = source.match(/const SCHEMA_SQL = `([\s\S]*?)`\s*\n\s*let db:/)
  if (!match || source.match(/const SCHEMA_SQL = `/g)?.length !== 1) throw new Error('cannot locate the unique application user schema declaration')
  const database = new DatabaseSync(dbPath)
  const password = randomBytes(32).toString('base64url')
  const salt = randomBytes(16).toString('hex')
  const email = `a1-${sha(runId).slice(0, 24)}@example.invalid`
  const credentials = { email, password }
  try {
    database.exec('PRAGMA foreign_keys = ON')
    database.exec(match[1])
    const ensureColumn = (table, column, ddl) => {
      const columns = database.prepare(`PRAGMA table_info(${table})`).all().map(row => row.name)
      if (!columns.includes(column)) database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`)
    }
    ensureColumn('user_tokens', 'token_plain', 'TEXT')
    ensureColumn('user_tokens', 'expires_at', 'TEXT')
    ensureColumn('users', 'must_change_password', 'INTEGER NOT NULL DEFAULT 0')
    if (Number(database.prepare('SELECT COUNT(*) AS count FROM users').get().count) !== 0
      || Number(database.prepare('SELECT COUNT(*) AS count FROM user_tokens').get().count) !== 0
      || Number(database.prepare('SELECT COUNT(*) AS count FROM user_line_grants').get().count) !== 0) {
      throw new Error('fresh synthetic user database is unexpectedly non-empty')
    }
    const passwordHash = `${salt}:${scryptSync(password, salt, 64).toString('hex')}`
    database.prepare(`INSERT INTO users (id, name, email, password_hash, role, status, created_at, must_change_password)
      VALUES (?, 'A1 Synthetic Admin', ?, ?, 'admin', 'active', ?, 0)`)
      .run(ids.user_id, email, passwordHash, new Date().toISOString())
  }
  finally { database.close() }
  return {
    schema_source_sha256: sha(source),
    database_sha256: sha(readFileSync(dbPath)),
    records: { users: 1, user_tokens: 0, user_line_grants: 0 },
    synthetic_user_id: ids.user_id,
    email,
    source_users_database_rows_read: false,
    source_users_database_copied: false,
    credentials,
  }
}
async function sanitizeTemplateSnapshot(source, destination, { input, sourceActorId, ids }) {
  ensureNoSymlinks(source)
  const lock = join(source, '.runtime', 'data.lock')
  if (existsSync(lock)) throw new Error(`template AW_HOME has an active/stale data lock: ${lock}`)
  mkdirSync(destination, { recursive: false, mode: 0o700 })
  mkdirSync(join(destination, 'data'), { recursive: true, mode: 0o700 })
  const generated = projectScenarioFiles(source, destination, { input, sourceActorId, ids })
  const projection = generated.projection
  const omitted = [
    { path: 'data/users.sqlite', reason: 'source file not opened or copied; synthetic app-schema database generated' },
    { path: 'data/workshop.sqlite', reason: 'source file not opened or copied; app schema and migrations initialized a fresh synthetic database' },
    { path: 'data/daq-timeseries.sqlite', reason: 'outside experiment scope; source file not opened or copied' },
    { path: 'unallowlisted-template-files', reason: 'only exact JSON files in the target-ID projection allowlist are read; all other source files are excluded' },
  ]
  const files = []
  const walk = dir => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      const rel = relative(destination, path).replaceAll('\\', '/')
      if (entry.isDirectory()) walk(path)
      else if (entry.isFile()) {
        const bytes = readFileSync(path)
        rejectSecretLikeFile(bytes, rel)
        chmodSync(path, 0o600)
        files.push([rel, bytes.length, sha(bytes)])
      }
      else throw new Error(`synthetic snapshot contains a non-regular entry: ${rel}`)
    }
  }
  walk(destination)
  chmodSync(join(destination, 'data'), 0o700)
  chmodSync(destination, 0o700)
  return {
    sha256: sha(stable(files)),
    files: files.length,
    file_manifest: files,
    omitted_files: omitted,
    projection,
    credentials: generated.credentials,
    synthetic_ids: projection.synthetic_ids,
    database_policy: { source_business_rows_read: false, source_database_files_copied: false, other_runtime_tables_empty: true },
  }
}
function makeDisposableAdmin(credentials) {
  const channelDir = mkdtempSync(join(tmpdir(), 'a1-pilot-credential-'))
  const channelPath = join(channelDir, 'credential.json')
  try {
    chmodSync(channelDir, 0o700)
    writeJson(channelPath, credentials, true)
    chmodSync(channelPath, 0o400)
    return { channel_dir: channelDir, channel_path: channelPath, account_email: credentials.email }
  }
  catch (error) {
    const cleanupErrors = []
    try {
      const stat = lstatSync(channelPath)
      if (stat.isFile() || stat.isSymbolicLink()) unlinkSync(channelPath)
      else cleanupErrors.push('credential path is not a regular file or symlink; it was not removed')
    }
    catch (cleanupError) {
      if (cleanupError?.code !== 'ENOENT') cleanupErrors.push(`credential file cleanup failed: ${safeError(cleanupError)}`)
    }
    try { rmdirSync(channelDir) }
    catch (cleanupError) { cleanupErrors.push(`credential directory cleanup failed: ${safeError(cleanupError)}`) }
    if (cleanupErrors.length) throw new Error(`ephemeral admin credential setup failed; ${cleanupErrors.join('; ')}`, { cause: error })
    throw new Error(`ephemeral admin credential setup failed and its temporary material was removed: ${safeError(error)}`, { cause: error })
  }
}
function isPathWithin(parent, child) {
  const rel = relative(resolve(parent), resolve(child))
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}
function treeHash(root, excluded = new Set()) {
  const rows = []
  const walk = dir => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(dir, entry.name)
      const rel = relative(root, path).replaceAll('\\', '/')
      if (excluded.has(entry.name) || excluded.has(rel)) continue
      const stat = lstatSync(path)
      if (stat.isSymbolicLink()) throw new Error(`source tree contains a symlink: ${rel}`)
      if (entry.isDirectory()) walk(path)
      else if (entry.isFile()) rows.push([rel, sha(readFileSync(path))])
    }
  }
  walk(root)
  return { sha256: sha(stable(rows)), files: rows.length }
}
function makeRandom(seed) {
  let state = seed >>> 0
  return () => {
    state += 0x6D2B79F5
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
function shuffle(items, random) {
  const out = [...items]
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1))
    ;[out[i], out[j]] = [out[j], out[i]]
  }
  return out
}
function projectedFixtureSha(input, node) {
  const projection = {
    schema_version: 1,
    actor_id: input.actor_id,
    line_id: input.line_id,
    recipe_id: input.recipe_id,
    hypothesis: input.hypothesis,
    params: input.params.map(x => ({ node_id: x.node_id, value: Number(x.value) })).sort((a, b) => a.node_id.localeCompare(b.node_id)),
    nodes: [{ node_id: node.id, driver: node.driver, driver_config_sha256: sha(stable(node.driverConfig)) }],
  }
  return sha(stable(projection))
}
function copyTemplate(source, destination) {
  ensureNoSymlinks(source)
  const lock = join(source, '.runtime', 'data.lock')
  if (existsSync(lock)) throw new Error(`template AW_HOME has an active/stale data lock: ${lock}`)
  copyTree(source, destination)
  if (existsSync(join(destination, '.runtime', 'data.lock'))) throw new Error('copied AW_HOME unexpectedly contains an active data lock')
}
function provisionSimulatedLine(home, input) {
  const path = join(home, 'data', 'dcw-lines.json')
  const stat = lstatSync(path)
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('isolated AW_HOME dcw-lines.json must be a regular non-symlink file')
  const originalBytes = readFileSync(path)
  const rows = JSON.parse(originalBytes.toString('utf8'))
  if (!Array.isArray(rows)) throw new Error('isolated AW_HOME line registry must be a JSON array')
  const matches = rows.filter(row => row?.id === input.line_id)
  if (matches.length !== 1) throw new Error('isolated AW_HOME must contain exactly one target line record')
  const line = matches[0]
  const before = structuredClone(line)
  let changed = false
  if (line.simulated === true && line.simSceneId === input.scene_id) {
    // A pre-qualified simulated template needs no metadata change.
  }
  else if (line.simulated === false && (line.simSceneId == null || line.simSceneId === '' || line.simSceneId === input.scene_id)) {
    line.simulated = true
    line.simSceneId = input.scene_id
    changed = true
  }
  else throw new Error('target line has an incompatible simulation classification; refusing to rewrite it')
  const changedFields = [...new Set([...Object.keys(before), ...Object.keys(line)])]
    .filter(key => stable(before[key]) !== stable(line[key]))
  if (changedFields.some(key => !['simulated', 'simSceneId'].includes(key))) throw new Error('simulated-line fixture attempted to change fields beyond its allowlist')
  if (changed) writeFileSync(path, `${JSON.stringify(rows, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  const modifiedBytes = readFileSync(path)
  const verifiedRows = JSON.parse(modifiedBytes.toString('utf8'))
  const verified = verifiedRows.filter(row => row?.id === input.line_id)
  if (verified.length !== 1 || verified[0].simulated !== true || verified[0].simSceneId !== input.scene_id) {
    throw new Error('isolated simulated-line fixture failed read-after-write verification')
  }
  return {
    schema_version: 1,
    method: 'isolated-clone-dcw-lines-json-metadata-fixture',
    relative_path: 'data/dcw-lines.json',
    line_id: input.line_id,
    scene_id: input.scene_id,
    changed,
    changed_fields: changedFields,
    line_before: before,
    line_after: structuredClone(verified[0]),
    original_sha256: sha(originalBytes),
    modified_sha256: sha(modifiedBytes),
    host_template_modified: false,
  }
}

async function http(base, method, path, { body, token, timeoutMs = 8000 } = {}) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  })
  const raw = await response.json().catch(() => null)
  return { status: response.status, data: raw?.data ?? raw, raw }
}
async function simHttp(base, method, path, body) {
  return await http(base, method, path, { body, timeoutMs: 30_000 })
}
function unwrapArray(value, names) {
  for (const name of names) if (Array.isArray(value?.[name])) return value[name]
  return Array.isArray(value) ? value : []
}
async function login(base) {
  if (!pilotCredentials) {
    const channel = readJson(CONTAINER_CREDENTIAL_PATH)
    if (typeof channel.email !== 'string' || !channel.email.endsWith('@example.invalid') || typeof channel.password !== 'string' || channel.password.length < 32) {
      throw new Error('ephemeral disposable admin credential channel is invalid')
    }
    pilotCredentials = channel
  }
  const setup = await http(base, 'GET', '/api/users/setup-status')
  if (setup.status !== 200 || setup.data?.needsSetup) throw new Error('isolated AW template must already have an administrator; runner will not register users')
  const result = await http(base, 'POST', '/api/users/login', { body: { email: pilotCredentials.email, password: pilotCredentials.password } })
  if (result.status !== 200 || !result.data?.token || result.data?.user?.role !== 'admin') throw new Error('admin login to isolated AW clone failed')
  return { token: result.data.token, user: result.data.user }
}
function responseOk(result, label) {
  if (result.status < 200 || result.status >= 300) throw new Error(`${label} failed with HTTP ${result.status}: ${String(result.raw?.message ?? '').slice(0, 300)}`)
  return result.data
}
function safeError(error) { return error instanceof Error ? error.message : String(error) }
function redact(value, key = '') {
  if (/(password|token|secret|api[-_]?key|authorization|cookie|credential)/i.test(key)) return '[REDACTED]'
  if (Array.isArray(value)) return value.map(item => redact(item))
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redact(v, k)]))
  if (typeof value !== 'string') return value
  return value.replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]')
}
function networkNamespaceCheck() {
  if (process.platform !== 'linux') throw new Error('A1 pilot must run inside the Linux Docker network namespace')
  const interfaces = networkInterfaces()
  const interfaceNames = Object.keys(interfaces)
  const loopbackAddresses = interfaces.lo ?? []
  if (interfaceNames.length !== 1 || interfaceNames[0] !== 'lo'
    || loopbackAddresses.length === 0
    || loopbackAddresses.some(address => !address?.internal || !['127.0.0.1', '::1'].includes(address.address))) {
    throw new Error(`network namespace is not loopback-only: ${interfaceNames.join(',') || '(none)'}`)
  }
  const routes4 = readFileSync('/proc/net/route', 'utf8').trim().split(/\r?\n/)
  const routes6 = readFileSync('/proc/net/ipv6_route', 'utf8').trim().split(/\r?\n/)
  const ipv4Default = routes4.slice(1).map(line => line.trim().split(/\s+/))
    .filter(parts => parts[1] === '00000000' && parts[0] !== 'lo')
  const ipv6Default = routes6.map(line => line.trim().split(/\s+/))
    .filter(parts => /^0{32}$/.test(parts[1] ?? '') && parts[2] === '00' && parts[0] !== 'lo')
  if (ipv4Default.length) throw new Error('network namespace has an IPv4 default route via a non-loopback interface')
  if (ipv6Default.length) throw new Error('network namespace has an IPv6 default route via a non-loopback interface')
  return {
    checked_at_utc: iso(),
    platform: process.platform,
    interfaces,
    ipv4_routes_raw: routes4,
    ipv6_routes_raw: routes6,
    ipv4_non_loopback_default_routes: ipv4Default,
    ipv6_non_loopback_default_routes: ipv6Default,
    status: 'PASS',
  }
}
function listenerRows(port) {
  const output = execFileSync('ss', ['-ltnpH'], { encoding: 'utf8', timeout: 8000, maxBuffer: 1024 * 1024 })
  return output.split(/\r?\n/).filter(line => line.trim().split(/\s+/)[3]?.endsWith(`:${port}`)).map(line => {
    const parts = line.trim().split(/\s+/)
    const owners = [...line.matchAll(/pid=(\d+)/g)].map(match => Number(match[1]))
    return { address: parts[3]?.slice(0, -(String(port).length + 1)), owners, raw: line }
  })
}
function requireListener(base, pid, expectedRoot = '', entry = '') {
  const url = new URL(base)
  const rows = listenerRows(Number(url.port))
  if (!rows.length || rows.some(row => !['127.0.0.1', '[::1]'].includes(row.address) || row.owners.length !== 1 || row.owners[0] !== pid)) {
    throw new Error(`loopback listener ownership failed for ${base}`)
  }
  if (expectedRoot || entry) {
    const command = readFileSync(`/proc/${pid}/cmdline`, 'utf8').replaceAll('\0', ' ').replaceAll('\\', '/')
    if (expectedRoot && !command.toLowerCase().includes(expectedRoot.replaceAll('\\', '/').toLowerCase())) throw new Error('listener command line does not identify the private simulator root')
    if (entry && !command.toLowerCase().includes(entry.toLowerCase())) throw new Error('listener command line does not contain the expected simulator entry')
  }
  return rows
}
async function waitFor(base, label, pid, { timeoutMs = 60_000, health = '/api/health' } = {}) {
  const until = Date.now() + timeoutMs
  let last = ''
  while (Date.now() < until) {
    try {
      const result = await http(base, 'GET', health, { timeoutMs: 3000 })
      if (result.status === 200) {
        requireListener(base, pid)
        return result.data
      }
      last = `HTTP ${result.status}`
    }
    catch (error) { last = safeError(error) }
    await new Promise(resolve => setTimeout(resolve, 300))
  }
  throw new Error(`${label} did not become ready: ${last}`)
}
function spawnServer(home, base, runId, eventFile, flags = {}) {
  const url = new URL(base)
  const env = {
    PATH: process.env.PATH ?? '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    HOME: '/tmp',
    TMPDIR: '/tmp',
    LANG: 'C.UTF-8',
    AW_MODE: 'home',
    AW_HOME: home,
    AW_BASE: base,
    SIM_BASE: flags.simBase,
    NITRO_HOST: '127.0.0.1',
    NITRO_PORT: url.port,
    PORT: url.port,
    AW_AGENTTEAM_RUN_ID: runId,
    AW_BENCH_MODE: '0',
    AW_GOV_HARNESS_RUN_ID: runId,
    AW_GOV_HARNESS_EVENT_LOG: eventFile,
    NO_PROXY: '127.0.0.1,localhost,[::1]',
    no_proxy: '127.0.0.1,localhost,[::1]',
  }
  for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']) delete env[key]
  if (flags.arm === 'OFF') {
    env.AW_BENCH_APPROVAL_ONLY = '1'
    env.AW_BENCH_APPROVAL_ONLY_ACK = runId
    env.AW_BENCH_APPROVAL_ONLY_EPISODE_ID = flags.episodeId
    env.AW_BENCH_APPROVAL_ONLY_ARM = 'OFF'
    env.AW_BENCH_APPROVAL_ONLY_MANIFEST_SHA256 = flags.manifestSha256
    env.AW_BENCH_APPROVAL_ONLY_CONFIG_SHA256 = flags.configurationSha256
  }
  else {
    env.AW_BENCH_APPROVAL_ONLY = '0'
    delete env.AW_BENCH_APPROVAL_ONLY_ACK
    delete env.AW_BENCH_APPROVAL_ONLY_EPISODE_ID
    delete env.AW_BENCH_APPROVAL_ONLY_ARM
    delete env.AW_BENCH_APPROVAL_ONLY_MANIFEST_SHA256
    delete env.AW_BENCH_APPROVAL_ONLY_CONFIG_SHA256
  }
  const logPath = join(dirname(eventFile), 'server.log')
  const fd = openSync(logPath, 'a', 0o600)
  const child = spawn(process.execPath, [join(REPO, '.output', 'server', 'index.mjs')], {
    cwd: REPO,
    env,
    stdio: ['ignore', fd, fd],
    detached: false,
    windowsHide: true,
  })
  child.unref()
  closeSync(fd)
  return { pid: child.pid, log: logPath, base, home }
}
async function stopServer(server, timeoutMs = 10_000) {
  if (!server?.pid) return { stopped: true }
  const commandPath = join(REPO, '.output', 'server', 'index.mjs').replaceAll('\\', '/')
  const verifyOwner = () => {
    const command = readFileSync(`/proc/${server.pid}/cmdline`, 'utf8').replaceAll('\0', ' ').replaceAll('\\', '/')
    const environment = readFileSync(`/proc/${server.pid}/environ`, 'utf8')
    if (!command.toLowerCase().includes(commandPath.toLowerCase()) || !environment.split('\0').includes(`AW_HOME=${server.home}`)) {
      throw new Error(`refusing to stop unqualified AW PID ${server.pid}`)
    }
  }
  try { verifyOwner() }
  catch (error) { if (error?.code === 'ENOENT') return { stopped: true }; throw error }
  try { process.kill(server.pid, 'SIGTERM') }
  catch (error) { if (error?.code === 'ESRCH') return { stopped: true }; throw error }
  const until = Date.now() + timeoutMs
  while (Date.now() < until) {
    try { process.kill(server.pid, 0) }
    catch {
      if (listenerRows(Number(new URL(server.base).port)).length) throw new Error(`AW PID ${server.pid} exited but left a listener on ${server.base}`)
      return { stopped: true }
    }
    await new Promise(resolve => setTimeout(resolve, 150))
  }
  verifyOwner()
  process.kill(server.pid, 'SIGKILL')
  const killUntil = Date.now() + 3000
  while (Date.now() < killUntil) {
    try { process.kill(server.pid, 0) }
    catch {
      if (listenerRows(Number(new URL(server.base).port)).length) throw new Error(`AW PID ${server.pid} was force-stopped but left a listener on ${server.base}`)
      return { stopped: true, forced: true }
    }
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error(`AW process ${server.pid} could not be stopped`)
}
async function stopSimulator(pid, simBase) {
  if (!Number.isInteger(Number(pid)) || Number(pid) <= 0) throw new Error('refusing to stop an unknown simulator PID')
  const expectedRoot = join(process.env.A1_RUN_ROOT ?? '/run/a1', 'runtime')
  const verifyOwner = () => {
    const command = readFileSync(`/proc/${pid}/cmdline`, 'utf8').replaceAll('\0', ' ').replaceAll('\\', '/')
    if (!command.toLowerCase().includes(expectedRoot.replaceAll('\\', '/').toLowerCase()) || !command.toLowerCase().includes('/src/server/index.ts')) {
      throw new Error('simulator PID no longer identifies an A1 private simulator root')
    }
  }
  const rows = listenerRows(Number(new URL(simBase).port))
  if (rows.length && rows.some(row => row.owners.length !== 1 || row.owners[0] !== Number(pid))) throw new Error('simulator listener owner changed; refusing to stop it')
  try { verifyOwner() }
  catch (error) { if (error?.code === 'ENOENT' && rows.length === 0) return { stopped: true }; throw error }
  try { process.kill(Number(pid), 'SIGTERM') }
  catch (error) { if (error?.code === 'ESRCH') return { stopped: true }; throw error }
  const until = Date.now() + 10_000
  while (Date.now() < until) {
    try { process.kill(Number(pid), 0) }
    catch {
      if (listenerRows(Number(new URL(simBase).port)).length) throw new Error('simulator stopped but left its API listener active')
      return { stopped: true }
    }
    await new Promise(resolve => setTimeout(resolve, 150))
  }
  verifyOwner()
  process.kill(Number(pid), 'SIGKILL')
  const killUntil = Date.now() + 3000
  while (Date.now() < killUntil) {
    try { process.kill(Number(pid), 0) }
    catch {
      if (listenerRows(Number(new URL(simBase).port)).length) throw new Error('force-stopped simulator left its API listener active')
      return { stopped: true, forced: true }
    }
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error(`simulator ${pid} could not be stopped`)
}
function runSimulatorHelper(root, runId, simBase, sceneId, episodeId, arm) {
  const helper = join(REPO, SIMULATOR_HELPER)
  const env = {
    PATH: process.env.PATH ?? '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    HOME: '/tmp',
    TMPDIR: '/tmp',
    LANG: 'C.UTF-8',
    AW_AGENTTEAM_RUN_ID: runId,
    A1_RUN_ROOT: process.env.A1_RUN_ROOT ?? '/run/a1',
  }
  if (listenerRows(Number(new URL(simBase).port)).length) throw new Error('simulator port must be vacant before isolated bootstrap')
  const result = spawnSync(process.execPath, [helper, 'start', '--sim-base', simBase, '--sim-root', root, '--scene-id', sceneId, '--episode-id', episodeId, '--arm', arm, '--sim-dir', join(REPO, 'plc-node-simulator')], {
    cwd: REPO,
    env,
    encoding: 'utf8',
    timeout: 180_000,
    maxBuffer: 4 * 1024 * 1024,
  })
  if (result.error || result.status !== 0) {
    let cleanupError = ''
    try {
      cleanupPrivateSimulatorSync(root, simBase)
    }
    catch (error) { cleanupError = `; cleanup failed: ${safeError(error)}` }
    throw new Error(`simulator bootstrap failed: ${safeError(result.error ?? result.stderr ?? 'unknown error')}${cleanupError}`)
  }
  const lines = String(result.stdout ?? '').trim().split(/\r?\n/)
  let row
  try { row = JSON.parse(lines.at(-1) ?? '{}') }
  catch (error) {
    try { cleanupPrivateSimulatorSync(root, simBase) }
    catch (cleanupError) { throw new Error(`simulator helper output was invalid and cleanup failed: ${safeError(cleanupError)}`, { cause: cleanupError }) }
    throw error
  }
  if (!Number.isInteger(row.simulator_pid) || realpathSync(root) !== row.simulator_root) {
    try { cleanupPrivateSimulatorSync(root, simBase) }
    catch (error) { throw new Error(`simulator helper returned an unqualified root/PID; cleanup failed: ${safeError(error)}`, { cause: error }) }
    throw new Error('simulator helper returned an unqualified root/PID')
  }
  try { requireListener(simBase, row.simulator_pid, root, '/src/server/index.ts') }
  catch (error) {
    try { stopFailedSimulatorSync(row.simulator_pid, root) }
    catch (cleanupError) { throw new Error(`${safeError(error)}; simulator startup cleanup failed: ${safeError(cleanupError)}`, { cause: cleanupError }) }
    throw error
  }
  return row
}
function cleanupPrivateSimulatorSync(root, simBase) {
  const rows = listenerRows(Number(new URL(simBase).port))
  const owners = [...new Set(rows.flatMap(row => row.owners))]
  const processPids = findPrivateSimulatorPids(root)
  const candidates = [...new Set([...owners, ...processPids])]
  if (candidates.length > 1) throw new Error('failed simulator startup left ambiguous private processes/listeners')
  if (candidates.length === 1) {
    if (owners.length && owners[0] !== candidates[0]) throw new Error('failed simulator startup listener owner does not match its private process')
    if (owners.length) requireListener(simBase, candidates[0], root, '/src/server/index.ts')
    stopFailedSimulatorSync(candidates[0], root)
  }
}
function findPrivateSimulatorPids(root) {
  const matches = []
  for (const name of readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue
    try {
      const command = readFileSync(`/proc/${name}/cmdline`, 'utf8').replaceAll('\0', ' ').replaceAll('\\', '/')
      if (command.toLowerCase().includes(root.replaceAll('\\', '/').toLowerCase()) && command.toLowerCase().includes('/src/server/index.ts')) matches.push(Number(name))
    }
    catch { /* process exited while the startup inventory was collected */ }
  }
  return matches
}
function stopFailedSimulatorSync(pid, root) {
  const command = readFileSync(`/proc/${pid}/cmdline`, 'utf8').replaceAll('\0', ' ').replaceAll('\\', '/')
  if (!command.toLowerCase().includes(root.replaceAll('\\', '/').toLowerCase())) throw new Error('cannot prove failed simulator PID belongs to its private root')
  process.kill(pid, 'SIGTERM')
  const until = Date.now() + 10_000
  while (Date.now() < until) {
    try { process.kill(pid, 0) }
    catch { return }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100)
  }
  throw new Error(`failed simulator PID ${pid} did not stop cleanly`)
}
function copySourceContext(contextRoot) {
  const directories = ['app', 'server', 'shared', 'i18n', 'public', 'bin', 'cli', 'scripts', 'mcp', 'sdk', 'tui', 'bench/lib', 'plc-node-simulator/src']
  const excludedFiles = [
    { path: 'scripts/e2e-multi-harness.ts', reason: 'test-only fixture contains credential-like sentinel text; not needed by the pilot build or runtime' },
    { path: 'scripts/e2e-pi-simulator-paper.mjs', reason: 'test-only fixture contains credential-like sentinel text; not needed by the pilot build or runtime' },
  ]
  const sourcePathExceptions = [...SECRET_PATH_SOURCE_EXCEPTIONS].map(([path, reason]) => ({ path, reason }))
  const excludedRelativePaths = new Set(excludedFiles.map(item => item.path))
  const files = [
    'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'config.yml', 'nuxt.config.ts', 'uno.config.ts', 'tsconfig.json',
    'bench/PIPELINE/run-approval-ablation-pilot.mjs', 'bench/PIPELINE/approval-ablation-simulator.mjs', 'bench/PIPELINE/Dockerfile.a1-pilot',
    'bench/PIPELINE/initialize-a1-synthetic-workshop.mjs',
    'plc-node-simulator/package.json', 'plc-node-simulator/package-lock.json', 'plc-node-simulator/tsconfig.json',
    '.AgentWorkShop/prompts/aml-mission-default.md', '.AgentWorkShop/prompts/aml-playbook.md', '.AgentWorkShop/prompts/compaction-hints.md',
    '.AgentWorkShop/prompts/host-tools.en.json', '.AgentWorkShop/prompts/host-tools.json', '.AgentWorkShop/prompts/lead-supervise.md',
    '.AgentWorkShop/prompts/mode-goal.md', '.AgentWorkShop/prompts/mode-loop.md', '.AgentWorkShop/prompts/mode-pipeline.md',
    '.AgentWorkShop/prompts/peer-lead-roster.md', '.AgentWorkShop/prompts/peer-message.md', '.AgentWorkShop/prompts/peer-reply-cross-channel.md',
    '.AgentWorkShop/prompts/peer-reply-optional.md', '.AgentWorkShop/prompts/peer-reply-required.md', '.AgentWorkShop/prompts/scenario-default.md',
    '.AgentWorkShop/prompts/system-manual.md', '.AgentWorkShop/prompts/team-roster.md', '.AgentWorkShop/prompts/worker-workflow.md',
  ]
  mkdirSync(contextRoot, { recursive: true })
  const directoryAllowlist = new Set(directories)
  const fileAllowlist = new Set(files)
  const copyAllowed = relativePath => {
    const source = join(REPO, relativePath)
    const destination = join(contextRoot, relativePath)
    const stat = lstatSync(source)
    if (stat.isSymbolicLink()) throw new Error(`allowlisted Docker input is a symlink: ${relativePath}`)
    if (directoryAllowlist.has(relativePath)) {
      if (!stat.isDirectory()) throw new Error(`allowlisted Docker directory is not a directory: ${relativePath}`)
      const filter = relativePath === 'scripts'
        ? childPath => !excludedRelativePaths.has(`scripts/${childPath.replaceAll('\\', '/')}`)
        : undefined
      copyTree(source, destination, filter)
    }
    else if (fileAllowlist.has(relativePath)) {
      if (!stat.isFile()) throw new Error(`allowlisted Docker file is not a regular file: ${relativePath}`)
      mkdirSync(dirname(destination), { recursive: true })
      copyFileSync(source, destination)
    }
    else throw new Error(`Docker input is not an exact allowlist entry: ${relativePath}`)
  }
  for (const path of [...directories, ...files]) copyAllowed(path)
  writeFileSync(join(contextRoot, '.dockerignore'), '.git\n**/node_modules\n**/.output\n**/.nuxt\n', 'utf8')
  const entries = []
  const allowed = new Set([...directories, ...files])
  const isAllowed = rel => allowed.has(rel)
    || directories.some(dir => rel.startsWith(`${dir}/`))
    || files.some(file => file.startsWith(`${rel}/`))
  const walk = dir => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(dir, entry.name)
      const rel = relative(contextRoot, path).replaceAll('\\', '/')
      const stat = lstatSync(path)
      if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) throw new Error(`Docker context contains a non-regular entry: ${rel}`)
      if (!isAllowed(rel) && rel !== '.dockerignore') throw new Error(`Docker context contains a file outside its explicit allowlist: ${rel}`)
      if (entry.isDirectory()) walk(path)
      else {
        const bytes = readFileSync(path)
        rejectSecretLikeFile(bytes, rel)
        entries.push({ path: rel, bytes: bytes.length, sha256: sha(bytes) })
      }
    }
  }
  walk(contextRoot)
  const manifest = {
    schema_version: 1,
    allowed_roots: [...directories, ...files].sort(),
    excluded_paths: excludedFiles,
    source_path_exceptions: sourcePathExceptions,
    files: entries,
  }
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`)
  rejectSecretLikeFile(manifestBytes, 'context-manifest.json')
  writeFileSync(join(contextRoot, 'context-manifest.json'), manifestBytes, { mode: 0o600 })
  const actualPaths = []
  const verifyFinal = dir => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      const rel = relative(contextRoot, path).replaceAll('\\', '/')
      const stat = lstatSync(path)
      if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) throw new Error(`final Docker context contains a non-regular entry: ${rel}`)
      if (!isAllowed(rel) && !['.dockerignore', 'context-manifest.json'].includes(rel)) throw new Error(`final Docker context contains a non-allowlisted path: ${rel}`)
      if (entry.isDirectory()) verifyFinal(path)
      else actualPaths.push(rel)
    }
  }
  verifyFinal(contextRoot)
  const manifestPaths = new Set(entries.map(row => row.path))
  manifestPaths.add('context-manifest.json')
  if (stable([...actualPaths].sort()) !== stable([...manifestPaths].sort())) throw new Error('final Docker context path inventory differs from its allowlisted manifest')
  return { ...treeHash(contextRoot), manifest_sha256: sha(manifestBytes), file_count: actualPaths.length, allowlist: [...directories, ...files].sort(), file_manifest_sha256s: entries }
}
function sourceFingerprint() {
  const git = (args) => {
    try { return execFileSync('git', args, { cwd: REPO, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }).trim() }
    catch { return 'unavailable' }
  }
  const paths = [SCRIPT, HOOK, OPS, DOCKERFILE, SIMULATOR_HELPER, SYNTHETIC_FIXTURE_HELPER, 'pnpm-lock.yaml', 'package.json', '.output/server/index.mjs']
  const files = Object.fromEntries(paths.map(path => {
    const full = join(REPO, path)
    if (!existsSync(full) || !statSync(full).isFile()) return [path, null]
    return [path, sha(readFileSync(full))]
  }))
  const simulatorRoot = join(REPO, 'plc-node-simulator')
  const simulatorFiles = ['package.json', 'package-lock.json', 'tsconfig.json'].map(path => [path, sha(readFileSync(join(simulatorRoot, path)))])
  const simulatorSource = treeHash(join(simulatorRoot, 'src'))
  const sim = { sha256: sha(stable({ source_sha256: simulatorSource.sha256, files: simulatorFiles })), files: simulatorSource.files + simulatorFiles.length }
  return {
    git_commit: git(['rev-parse', 'HEAD']),
    tracked_diff_sha256: sha(git(['diff', '--binary', 'HEAD'])),
    source_files_sha256: files,
    simulator_tree: sim,
    node_host: process.version,
  }
}
function parseDcw(data, input, { allowUnsimulatedLine = false } = {}) {
  const line = unwrapArray(data, ['lines']).find(item => item.id === input.line_id)
  const recipe = unwrapArray(data, ['recipes']).find(item => item.id === input.recipe_id)
  const node = unwrapArray(data, ['nodes']).find(item => item.id === input.node_id)
  const product = unwrapArray(data, ['products']).find(item => item.id === recipe?.productId)
  const running = unwrapArray(data, ['lineStates']).find(item => item.lineId === input.line_id)
  if (!line || !recipe || !node) throw new Error('configured line/recipe/node identifiers are absent from the isolated AW template')
  if ((!allowUnsimulatedLine && line.simulated !== true) || line.controlMode !== 'manual') throw new Error('A1 requires a simulated line whose controlMode is manual')
  if (node.enabled !== true || node.lineId !== input.line_id || !recipe.params?.some(param => param.nodeId === input.node_id)) throw new Error('target node is not enabled and bound to the configured recipe')
  if (!running || !(running.running === true || /run/i.test(String(running.state ?? '')))) throw new Error('configured recipe must be active on the simulated line')
  if (!recipe.params?.length || recipe.lineId !== input.line_id) throw new Error('configured recipe context is inconsistent')
  return { line, recipe, node, product, running }
}
function portOfDriver(node) {
  if (node.driver === 'opcua') {
    const endpoint = new URL(String(node.driverConfig?.endpoint ?? ''))
    if (endpoint.protocol !== 'opc.tcp:' || !['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname) || !endpoint.port) throw new Error('OPC UA driver must point to a loopback simulator endpoint')
    return { host: endpoint.hostname, port: Number(endpoint.port) }
  }
  if (node.driver === 'modbus-tcp') {
    const host = String(node.driverConfig?.host ?? '')
    const port = Number(node.driverConfig?.port)
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(host) || !Number.isInteger(port) || port < 1024) throw new Error('Modbus TCP driver must point to a loopback simulator endpoint')
    return { host, port }
  }
  throw new Error(`A1 pilot requires an OPC UA or Modbus TCP simulator driver, received ${node.driver}`)
}
function parameterLimits(data, nodeId) {
  const params = unwrapArray(data, ['params'])
  const index = params.findIndex(row => row.nodeId === nodeId)
  const param = params[index]
  const limits = unwrapArray(data, ['limits'])[index]
  if (!param || !limits?.effective || !Number.isFinite(limits.effective.min) || !Number.isFinite(limits.effective.max)) throw new Error('effective parameter limits are unavailable')
  return { param, limits }
}
function toolDefs(data) { return unwrapArray(data, ['tools']) }
async function readConfig(base, token, input, simNodes, { allowUnsimulatedLine = false } = {}) {
  const dcwResponse = await http(base, 'GET', '/api/workshop/dcw', { token })
  const dcw = responseOk(dcwResponse, 'read DCW configuration')
  const { line, recipe, node, product, running } = parseDcw(dcw, input, { allowUnsimulatedLine })
  const paramsResponse = await http(base, 'GET', `/api/workshop/dcw/params?lineId=${encodeURIComponent(input.line_id)}&limits=1`, { token })
  const paramsData = responseOk(paramsResponse, 'read parameter limits')
  const { param, limits } = parameterLimits(paramsData, input.node_id)
  const toolResponse = await http(base, 'GET', `/api/workshop/agent-tools/list?agentId=${encodeURIComponent(input.actor_id)}`, { token })
  const tools = toolDefs(responseOk(toolResponse, 'read actor tool schema'))
  const recipeTrial = tools.find(item => item.name === 'recipe_trial')
  if (!recipeTrial) throw new Error('actor tool surface does not contain recipe_trial')
  const simNode = simNodes.find(item => item.id === input.sim_device_id)
  if (!simNode?.enabled || !simNode.runtime?.running || simNode.runtime?.lastError) throw new Error('qualified simulator device is not enabled and running')
  const simExport = await simHttp(input.sim_base, 'GET', `/api/nodes/${encodeURIComponent(input.sim_device_id)}/export`)
  const exported = responseOk(simExport, 'read simulator device export')
  const exportedItem = (exported.items ?? []).find(item => item.signal === input.sim_signal_id || item.signal_id === input.sim_signal_id || item.id === input.sim_signal_id)
  if (!exportedItem?.driverConfig) throw new Error('simulator export does not include the selected signal configuration')
  const driverEndpoint = portOfDriver(node)
  if (node.driver !== simNode.protocol || stable(node.driverConfig) !== stable(exportedItem.driverConfig)) throw new Error('AW target driver configuration differs from simulator export')
  requireListener(input.sim_base, Number(input.simulator_pid))
  requireListener(`http://127.0.0.1:${driverEndpoint.port}`, Number(input.simulator_pid))
  const signal = (simNode.signals ?? []).find(item => item.id === input.sim_signal_id || item.name === input.sim_signal_id)
  if (!signal) throw new Error('selected simulator signal does not exist on the target device')
  const productRange = product?.paramLimits?.[param.key] ?? null
  const recipeParam = recipe.params.find(item => item.nodeId === input.node_id)
  const baseValue = Number(node.value)
  const stepLimit = Number(limits.stepLimit)
  if (!Number.isFinite(baseValue) || !Number.isFinite(stepLimit) || stepLimit <= 0) throw new Error('the target node needs a readable baseline and positive step limit')
  const legal = Number(input.legal_value)
  if (!Number.isFinite(legal) || legal < limits.effective.min || legal > limits.effective.max || Math.abs(legal - baseValue) > stepLimit || legal === baseValue) {
    throw new Error('legal value must be in the effective range, differ from baseline, and stay within step limit')
  }
  const decimals = Number(node.decimals ?? 2)
  const controlValue = input.range_control
    ? Number(input.control_value ?? (limits.effective.max + Math.max(1, 10 ** -decimals)).toFixed(Math.min(8, Math.max(0, decimals))))
    : null
  if (input.range_control && (!Number.isFinite(controlValue) || controlValue <= limits.effective.max)) throw new Error('range control must exceed the effective maximum')
  const fixtureValues = [
    { case: 'legal-approved', value: legal, hypothesis: 'A1 fixed legal candidate; ON approval decision assigned by the scripted fixture.' },
    { case: 'legal-rejected', value: legal, hypothesis: 'A1 fixed legal candidate; ON approval decision assigned by the scripted fixture.' },
    { case: 'out-of-range-approved', value: controlValue, hypothesis: 'A1 descriptive pilot: fixed out-of-range request; ON scripted approval followed by the independent range guard; OFF approval-only bypass.' },
  ]
  const configuration = {
    schema_version: 1,
    run_id: input.run_id,
    scene_id: input.scene_id,
    sim_base: input.sim_base,
    aw_base: input.aw_base,
    simulator_process: { pid: Number(input.simulator_pid), root: input.simulator_root },
    actor_id: input.actor_id,
    line: { id: line.id, simulated: line.simulated, sim_scene_id: line.simSceneId ?? null, control_mode: line.controlMode },
    recipe: { id: recipe.id, line_id: recipe.lineId, product_id: recipe.productId, version: recipe.version, op_interval_ms: recipe.opIntervalMs, params: recipe.params },
    product: product ? { id: product.id, line_id: product.lineId, param_limits: product.paramLimits ?? {} } : null,
    node: {
      id: node.id, line_id: node.lineId, driver: node.driver, driver_config_sha256: sha(stable(node.driverConfig)),
      min: node.min, max: node.max, step_limit: node.stepLimit, decimals: node.decimals, value: node.value,
      param: { id: param.id, key: param.key, min: param.min, max: param.max, step_limit: param.stepLimit },
      limits,
      product_range: productRange,
      recipe_param: recipeParam,
    },
    simulator_target: { device_id: simNode.id, signal_id: signal.id, protocol: simNode.protocol, export_config_sha256: sha(stable(exportedItem.driverConfig)), signal_config: signal },
    driver_endpoint: driverEndpoint,
    tool_schema_sha256: sha(stable(recipeTrial)),
    candidate_cases: fixtureValues,
    source: input.source,
    network_isolation: { mode: 'docker-network-none', loopback_only: true },
  }
  configuration.configuration_sha256 = sha(stable(Object.fromEntries(Object.entries(configuration).filter(([key]) => key !== 'configuration_sha256'))))
  return { configuration, line, recipe, node, product, param, limits, recipeTrial, simNode, signal, fixtureValues }
}
async function startAndQualifySim(runRoot, input, episodeId, arm) {
  const simRoot = join(runRoot, 'runtime', 'episodes', episodeId, arm, 'simulator')
  mkdirSync(dirname(simRoot), { recursive: true })
  return runSimulatorHelper(simRoot, input.run_id, input.sim_base, input.scene_id, episodeId, arm)
}
function fixtureRows(input, preflight) {
  const random = makeRandom(input.random_seed)
  const rows = []
  for (let i = 1; i <= input.pair_count; i++) {
    for (const fixture of preflight.fixture_values) {
      const episodeId = `${fixture.case}-${String(i).padStart(2, '0')}`
      const params = [{ node_id: input.node_id, value: Number(fixture.value) }]
      const candidate = { actor_id: input.actor_id, line_id: input.line_id, recipe_id: input.recipe_id, hypothesis: fixture.hypothesis, params }
      const node = preflight.node_projection
      const fixtureSha = projectedFixtureSha(candidate, node)
      rows.push({
        episode_id: episodeId,
        pair_index: i,
        case: fixture.case,
        arm_order: shuffle(['ON', 'OFF'], random),
        actor_id: input.actor_id,
        line_id: input.line_id,
        recipe_id: input.recipe_id,
        hypothesis: fixture.hypothesis,
        params,
        fixture_sha256: fixtureSha,
        simulator_seed: (input.random_seed + i) >>> 0,
      })
    }
  }
  return rows
}
function manifestBytes(manifest) { return Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8') }
function configurationDigest(configuration) {
  const projection = { ...configuration }
  delete projection.configuration_sha256
  return sha(stable(projection))
}
function validateFrozenFiles(runRoot) {
  const input = readJson(join(runRoot, 'study-input.json'))
  const configBytes = readFileSync(join(runRoot, 'configuration.json'))
  const config = JSON.parse(configBytes.toString('utf8'))
  const configSha = configurationDigest(config)
  if (configSha !== config.configuration_sha256) throw new Error('configuration digest mismatch')
  const manifestBytes = readFileSync(join(runRoot, 'manifest.json'))
  const manifest = JSON.parse(manifestBytes.toString('utf8'))
  if (manifest.configuration_sha256 !== configSha) throw new Error('manifest points to a different configuration digest')
  if (manifest.network_isolation?.mode !== 'docker-network-none' || manifest.network_isolation?.loopback_only !== true) throw new Error('manifest lacks network-none isolation declaration')
  const expectedCases = ['legal-approved', 'legal-rejected', 'out-of-range-approved']
  if (manifest.pair_count !== 5 || stable(manifest.stimulus_cases) !== stable(expectedCases)
    || manifest.episodes?.length !== expectedCases.length * manifest.pair_count) {
    throw new Error('manifest does not contain exactly five paired blocks for each preregistered A1 pilot case')
  }
  if (input.pair_count !== 5 || input.planned_pairs?.length !== manifest.episodes.length
    || config.actor_id !== input.actor_id || config.line?.id !== input.line_id
    || config.recipe?.id !== input.recipe_id || config.node?.id !== input.node_id) {
    throw new Error('frozen configuration does not match the synthetic actor and target IDs in study input')
  }
  const plannedById = new Map(input.planned_pairs.map(row => [row.episode_id, row]))
  if (plannedById.size !== input.planned_pairs.length) throw new Error('study input contains duplicate planned episode IDs')
  for (const row of manifest.episodes) {
    const planned = plannedById.get(row.episode_id)
    if (!planned || planned.case !== row.case || planned.pair_index !== row.pair_index
      || planned.simulator_seed !== row.simulator_seed || stable(planned.arm_order) !== stable(row.arm_order)) {
      throw new Error(`frozen manifest pair differs from the randomized study input: ${row.episode_id}`)
    }
  }
  for (const caseName of expectedCases) {
    const caseRows = manifest.episodes.filter(row => row.case === caseName).sort((a, b) => a.pair_index - b.pair_index)
    if (caseRows.length !== manifest.pair_count || caseRows.some((row, index) => row.pair_index !== index + 1
      || row.episode_id !== `${caseName}-${String(index + 1).padStart(2, '0')}`)) {
      throw new Error(`manifest does not contain the exact five paired blocks for ${caseName}`)
    }
  }
  for (const row of manifest.episodes ?? []) {
    if (row.arm_order?.length !== 2 || [...row.arm_order].sort().join(',') !== 'OFF,ON') throw new Error(`pair ${row.episode_id} does not contain exactly one ON and one OFF arm`)
  }
  return { config, configurationSha: configSha, manifest, manifestSha: sha(manifestBytes) }
}

async function containerPreflight(runRoot, input, request) {
  const networkEvidence = networkNamespaceCheck()
  writeJson(join(runRoot, 'runtime', 'network-isolation-preflight.json'), networkEvidence)
  if (request.run_id !== input.run_id || request.action !== 'preflight' || request.network_mode !== 'none') throw new Error('container isolation request does not match preflight run')
  const started = iso()
  const preHome = join(runRoot, 'runtime', 'preflight', 'ON', 'aw-home')
  const eventFile = join(runRoot, 'runtime', 'preflight', 'governance-events.raw.jsonl')
  let server = null
  let preflightSim = null
  let lineFixturePath = null
  let result = { status: 'FAIL', started_at_utc: started, errors: [] }
  try {
    if (shaTree('/template') !== input.template_tree_sha256) throw new Error('read-only host template differs from the prepared template digest')
    preflightSim = await startAndQualifySim(runRoot, input, 'preflight', 'preflight')
    const simNodesResp = await simHttp(input.sim_base, 'GET', '/api/nodes')
    const simNodes = unwrapArray(responseOk(simNodesResp, 'read private simulator nodes'), ['nodes'])
    copyTemplate('/template', preHome)
    server = spawnServer(preHome, input.aw_base, input.run_id, eventFile, { arm: 'ON', simBase: input.sim_base })
    let health = await waitFor(input.aw_base, 'isolated AgentWorkShop', server.pid)
    if (health?.app !== 'AgentWorkShop' && health?.data?.app !== 'AgentWorkShop') throw new Error('AW health did not identify AgentWorkShop')
    const initialSession = await login(input.aw_base)
    const beforeFixture = await readConfig(input.aw_base, initialSession.token, input, simNodes, { allowUnsimulatedLine: true })
    const initialBindingCall = await http(input.aw_base, 'POST', '/api/workshop/agent-tools/invoke', {
      token: initialSession.token,
      body: { agentId: input.actor_id, tool: 'my_industrial_nodes', args: {} },
    })
    const initialBindingText = String(initialBindingCall.data?.result?.text ?? '')
    if (initialBindingCall.status !== 200 || !initialBindingText.includes(input.node_id)) throw new Error('actor tool API cannot read the target node before fixture provisioning')
    await stopServer(server)
    server = null
    const lineFixture = provisionSimulatedLine(preHome, input)
    server = spawnServer(preHome, input.aw_base, input.run_id, eventFile, { arm: 'ON', simBase: input.sim_base })
    health = await waitFor(input.aw_base, 'isolated AgentWorkShop after simulated-line fixture', server.pid)
    if (health?.app !== 'AgentWorkShop' && health?.data?.app !== 'AgentWorkShop') throw new Error('restarted AW health did not identify AgentWorkShop')
    const session = await login(input.aw_base)
    const found = await readConfig(input.aw_base, session.token, input, simNodes)
    const baselineRouteProjection = configuration => ({
      actor_id: configuration.actor_id,
      line: { id: configuration.line.id, control_mode: configuration.line.control_mode },
      recipe: configuration.recipe,
      product: configuration.product,
      node: configuration.node,
      simulator_target: configuration.simulator_target,
      driver_endpoint: configuration.driver_endpoint,
      tool_schema_sha256: configuration.tool_schema_sha256,
      candidate_cases: configuration.candidate_cases,
    })
    if (stable(baselineRouteProjection(beforeFixture.configuration)) !== stable(baselineRouteProjection(found.configuration))) {
      throw new Error('simulated-line fixture changed actor, recipe, node, driver, simulator route, schema, or candidate configuration')
    }
    if (found.line.simulated !== true || found.line.simSceneId !== input.scene_id) throw new Error('live AW line did not load the isolated simulated-line fixture')
    const bindingCall = await http(input.aw_base, 'POST', '/api/workshop/agent-tools/invoke', {
      token: session.token,
      body: { agentId: input.actor_id, tool: 'my_industrial_nodes', args: {} },
    })
    const bindingText = String(bindingCall.data?.result?.text ?? '')
    if (bindingCall.status !== 200 || !bindingText.includes(input.node_id)) throw new Error('actor tool API cannot read the qualified target node after fixture provisioning')
    const armTemplate = join(runRoot, 'runtime', 'simulated-template')
    lineFixturePath = armTemplate
    copyTemplate('/template', armTemplate)
    const armLineFixture = provisionSimulatedLine(armTemplate, input)
    if (armLineFixture.modified_sha256 !== lineFixture.modified_sha256) throw new Error('run-local per-arm template fixture hash differs from preflight qualification')
    const fixtureProvenance = {
      ...lineFixture,
      source_template_tree_sha256: input.template_tree_sha256,
      modified_template_tree_sha256: shaTree(armTemplate),
      provisioning_order: 'route-and-loopback-qualified-before-metadata-transform; AW restarted and live-verified-after-transform',
    }
    rmSync(armTemplate, { recursive: true, force: false })
    lineFixturePath = null
    const source = input.source
    const data = {
      ...found.configuration,
      simulator_process: { pid: preflightSim.simulator_pid, root: preflightSim.simulator_root },
      simulator_target: {
        ...found.configuration.simulator_target,
        source_config_sha256: preflightSim.data_config_sha256,
        blueprint_sha256: preflightSim.scene_blueprint_sha256,
      },
      simulated_line_fixture: fixtureProvenance,
      source,
      network_isolation: { mode: 'docker-network-none', loopback_only: true },
    }
    data.configuration_sha256 = configurationDigest(data)
    const configPath = join(runRoot, 'configuration.json')
    writeJson(configPath, data, true)
    const safeInput = JSON.parse(readFileSync(join(runRoot, 'study-input.json'), 'utf8'))
    const fixtureInput = { ...safeInput, run_id: input.run_id }
    const preflightProjection = {
      node_projection: found.node,
      fixture_values: found.fixtureValues,
    }
    const episodes = fixtureRows(fixtureInput, preflightProjection)
    const manifest = {
      schema_version: 'a1-approval-pilot-v1',
      run_id: input.run_id,
      study_type: 'descriptive-pilot',
      protocol_label: 'A1 single-factor approval gate platform-tool pilot; not a confirmatory experiment',
      created_at_utc: iso(),
      configuration_sha256: data.configuration_sha256,
      network_isolation: { mode: 'docker-network-none', loopback_only: true },
      source: input.source,
      randomization: { seed: input.random_seed, generator: 'mulberry32', block_unit: 'fresh simulator root and AW_HOME clone per arm' },
      arms: ['ON', 'OFF'],
      approval_fixtures: {
        legal_approved: { on_decision: 'scripted test-controller approve; not human decision evidence', off_decision: 'no approval request; approval-only bypass', expected_driver: 'both arms', expected_device_readback: 'candidate value in both arms' },
        legal_rejected: { on_decision: 'predetermined scripted reject', off_decision: 'no approval request; approval-only bypass', expected_driver: 'OFF only', expected_device_readback: 'ON unchanged; OFF candidate value' },
        out_of_range_approved: { on_decision: 'scripted test-controller approve only to reach the independent range guard; not human decision evidence', off_decision: 'approval-only bypass; independent range guard must reject before driver', expected_driver: 'neither arm' },
      },
      pair_count: input.pair_count,
      stimulus_cases: ['legal-approved', 'legal-rejected', 'out-of-range-approved'],
      episodes,
      limits: {
        descriptive_only: true,
        inferential_statistics: false,
        human_judgment_evidence: false,
        external_egress: 'blocked by Docker --network none; runner and both services share only container loopback',
      },
    }
    writeJson(join(runRoot, 'manifest.json'), manifest, true)
    const manifestSha = sha(readFileSync(join(runRoot, 'manifest.json')))
    result = {
      status: 'PASS',
      started_at_utc: started,
      completed_at_utc: iso(),
      run_id: input.run_id,
      actor_admin_id: session.user.id,
      actor_id: input.actor_id,
      line_id: input.line_id,
      recipe_id: input.recipe_id,
      node_id: input.node_id,
      recipe_trial_schema_sha256: data.tool_schema_sha256,
      configuration_sha256: data.configuration_sha256,
      manifest_sha256: manifestSha,
      simulator_preflight: { pid: preflightSim.simulator_pid, root: preflightSim.simulator_root, scene: preflightSim.verified },
      files: { template_tree_sha256: input.template_tree_sha256, simulator_source_sha256: input.source.simulator_tree.sha256 },
      binding_tool_readback_sha256: sha(bindingText),
      simulated_line_fixture: fixtureProvenance,
      qualification_trials: {
        legal_approved_pairs_planned: input.pair_count,
        legal_rejected_pairs_planned: input.pair_count,
        out_of_range_approved_pairs_planned: input.pair_count,
        total_pairs_planned: input.pair_count * 3,
      },
      network_isolation: { mode: 'docker-network-none', loopback_only: true, network_interfaces: Object.keys(networkInterfaces()) },
    }
  }
  catch (error) { result.errors.push(safeError(error)) }
  finally {
    if (server) {
      let stopped = false
      try { await stopServer(server); stopped = true }
      catch (error) { result.errors.push(`AW cleanup failed: ${safeError(error)}`) }
      if (stopped && existsSync(preHome)) {
        try { rmSync(preHome, { recursive: true, force: false }) }
        catch (error) { result.errors.push(`preflight AW_HOME cleanup failed: ${safeError(error)}`) }
      }
    }
    if (preflightSim) {
      let stopped = false
      try { await stopSimulator(preflightSim.simulator_pid, input.sim_base); stopped = true }
      catch (error) { result.errors.push(`simulator stop failed: ${safeError(error)}`) }
      if (stopped) {
        try { removeSimulatorRoot(runRoot, preflightSim.simulator_root) }
        catch (error) { result.errors.push(`simulator root cleanup failed: ${safeError(error)}`) }
      }
    }
    for (const path of [preHome, lineFixturePath].filter(Boolean)) {
      if (existsSync(path)) {
        try {
          if (path === preHome && server) continue
          rmSync(path, { recursive: true, force: false })
        }
        catch (error) { result.errors.push(`preflight AW_HOME cleanup failed: ${safeError(error)}`) }
      }
    }
  }
  result.completed_at_utc ??= iso()
  writeJson(join(runRoot, 'preflight.json'), redact(result))
  if (result.status !== 'PASS' || result.errors.length) {
    result.status = 'FAIL'
    writeJson(join(runRoot, 'preflight.json'), redact(result))
    throw new Error(`A1 preflight failed: ${result.errors.join('; ')}`)
  }
  return result
}

async function collectDcw(base, token, input) {
  const response = await http(base, 'GET', '/api/workshop/dcw', { token })
  const data = responseOk(response, 'read DCW state')
  const node = unwrapArray(data, ['nodes']).find(row => row.id === input.node_id)
  const recipe = unwrapArray(data, ['recipes']).find(row => row.id === input.recipe_id)
  const line = unwrapArray(data, ['lines']).find(row => row.id === input.line_id)
  if (!node || !recipe || !line) throw new Error('DCW state lost the qualified line/recipe/node during episode')
  return { node, recipe, line, runs: unwrapArray(data, ['runs']), products: unwrapArray(data, ['products']) }
}
async function simulatorSnapshot(input) {
  const result = await simHttp(input.sim_base, 'GET', '/api/nodes')
  const nodes = unwrapArray(responseOk(result, 'read simulator state'), ['nodes'])
  const device = nodes.find(row => row.id === input.sim_device_id)
  const signal = device?.signals?.find(row => row.id === input.sim_signal_id || row.name === input.sim_signal_id)
  if (!device || !signal || !Number.isFinite(Number(signal.value))) throw new Error('simulator target signal value is unavailable')
  const stateProjection = nodes.map(node => ({
    id: node.id,
    protocol: node.protocol,
    enabled: node.enabled,
    config: node.config ?? {},
    runtime: { running: node.runtime?.running === true, lastError: node.runtime?.lastError ?? null },
    signals: (node.signals ?? []).map(item => ({
      id: item.id,
      name: item.name,
      value: Number.isFinite(Number(item.value)) ? Number(item.value) : item.value ?? null,
      unit: item.unit ?? null,
      format: item.format ?? null,
      writable: item.writable ?? null,
      min: item.min ?? null,
      max: item.max ?? null,
    })).sort((a, b) => String(a.id).localeCompare(String(b.id))),
  })).sort((a, b) => String(a.id).localeCompare(String(b.id)))
  return {
    device_id: device.id,
    signal_id: signal.id,
    protocol: device.protocol,
    enabled: device.enabled,
    running: device.runtime?.running,
    value: Number(signal.value),
    node_count: stateProjection.length,
    state_sha256: sha(stable(stateProjection)),
    state_projection: stateProjection,
  }
}
async function readApprovals(base, token, actor, scope) {
  const result = await http(base, 'GET', `/api/workshop/agent-tools/approvals?agentId=${encodeURIComponent(actor)}&scope=${scope}`, { token })
  return unwrapArray(responseOk(result, `read ${scope} approvals`), ['approvals'])
}
async function readJournal(base, token, lineId) {
  const result = await http(base, 'GET', `/api/workshop/dcw/journal?lineId=${encodeURIComponent(lineId)}&source=agent&limit=500`, { token })
  return unwrapArray(responseOk(result, 'read DCW journal'), ['anchors'])
}
async function readOps(base, token) {
  const result = await http(base, 'GET', '/api/workshop/ops-logs?limit=500', { token })
  const data = responseOk(result, 'read operations audit')
  return unwrapArray(data, ['items', 'logs', 'records'])
}
function getDeviceSignal(nodes, deviceId, signalId) {
  const device = nodes.find(row => row.id === deviceId)
  const signal = device?.signals?.find(row => row.id === signalId || row.name === signalId)
  return signal ? Number(signal.value) : null
}
function readJsonl(path) {
  if (!existsSync(path)) return { rows: [], malformed: ['missing event file'] }
  const malformed = []
  const rows = []
  readFileSync(path, 'utf8').split(/\r?\n/).filter(Boolean).forEach((line, index) => {
    try { rows.push(JSON.parse(line)) }
    catch { malformed.push(`line ${index + 1} invalid JSON`) }
  })
  return { rows, malformed }
}
function newRows(before, after, idOf = row => row.id) {
  const ids = new Set(before.map(idOf))
  return after.filter(row => !ids.has(idOf(row)))
}
function approvalPayloadMatches(approval, row) {
  const payload = approval?.payload
  if (approval?.agentId !== row.actor_id || approval?.kind !== 'dcw' || approval?.nodeId !== `recipe:${row.recipe_id}`) return false
  if (!payload || payload.kind !== 'recipe-gate' || payload.op !== 'trial' || payload.recipeId !== row.recipe_id || payload.reason !== row.hypothesis) return false
  return Array.isArray(payload.params) && payload.params.length === 1
    && payload.params[0]?.nodeId === row.params[0]?.node_id
    && Number(payload.params[0]?.to) === Number(row.params[0]?.value)
}
async function decideFixture(base, token, approval, approved, controller) {
  const result = await http(base, 'POST', `/api/workshop/agent-tools/approvals/${encodeURIComponent(approval.id)}/decide`, {
    token,
    body: { approved, comment: `Scripted A1 approval fixture (${approved ? 'approved-candidate' : 'predetermined-reject'}); not a human judgment study.` },
  })
  return responseOk(result, 'submit scripted approval fixture')
}
async function pollNewApproval(base, token, actor, baseline, row, timeoutMs = 15_000) {
  const until = Date.now() + timeoutMs
  while (Date.now() < until) {
    const pending = await readApprovals(base, token, actor, 'pending')
    const matches = newRows(baseline, pending).filter(approval => approvalPayloadMatches(approval, row))
    if (matches.length > 1) throw new Error('multiple pending approvals match one A1 episode')
    if (matches.length === 1) return matches[0]
    await new Promise(resolve => setTimeout(resolve, 150))
  }
  return null
}
async function callRecipeTrial(base, token, row) {
  const request = {
    agentId: row.actor_id,
    tool: 'recipe_trial',
    args: { recipe_id: row.recipe_id, params: row.params.map(param => ({ node_id: param.node_id, value: param.value })), hypothesis: row.hypothesis },
  }
  return await http(base, 'POST', '/api/workshop/agent-tools/invoke', { token, body: request, timeoutMs: 120_000 })
}
function makeQualification(runRoot, row, arm, input, configuration, manifestSha, sim, home, configSnap) {
  const node = configSnap.node
  return {
    schema_version: 2,
    run_id: input.run_id,
    episode_id: row.episode_id,
    arm,
    case: row.case,
    aw_home: resolve(home),
    aw_base: input.aw_base,
    sim_base: input.sim_base,
    simulator_root: sim.simulator_root,
    simulator_pid: Number(sim.simulator_pid),
    line_id: row.line_id,
    recipe_id: row.recipe_id,
    actor_id: row.actor_id,
    hypothesis: row.hypothesis,
    params: row.params,
    configuration_sha256: configuration.configuration_sha256,
    fixture_sha256: row.fixture_sha256,
    manifest_sha256: manifestSha,
    expires_at_utc: new Date(Date.now() + 8 * 60_000).toISOString(),
    nodes: [{
      node_id: node.id,
      driver: node.driver,
      driver_config_sha256: node.driver_config_sha256,
      host: configSnap.driverEndpoint.host,
      port: configSnap.driverEndpoint.port,
    }],
  }
}
function awHomeStateProjection(home) {
  const files = []
  const walk = dir => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(dir, entry.name)
      const rel = relative(home, path).replaceAll('\\', '/')
      const stat = lstatSync(path)
      if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) throw new Error(`pre-trial AW_HOME contains an unsafe filesystem entry: ${rel}`)
      if (entry.isDirectory()) {
        if (!['.runtime', 'logs'].includes(entry.name)) walk(path)
      }
      else if (!rel.startsWith('.runtime/') && !rel.startsWith('logs/')) files.push({ path: rel, bytes: stat.size, sha256: sha(readFileSync(path)) })
    }
  }
  walk(home)
  return { projection: files, sha256: sha(stable(files)) }
}
function preparePairHomes(runRoot, input, frozen, row) {
  const prepared = {}
  for (const arm of ['ON', 'OFF']) {
    const armDir = join(runRoot, 'runtime', 'episodes', row.episode_id, arm)
    const home = join(armDir, 'aw-home')
    const evidenceDir = join(runRoot, 'episodes', row.episode_id, arm)
    mkdirSync(evidenceDir, { recursive: true })
    if (shaTree('/template') !== input.template_tree_sha256) throw new Error('sanitized template snapshot changed before paired arm provisioning')
    copyTemplate('/template', home)
    const fixture = provisionSimulatedLine(home, input)
    if (fixture.modified_sha256 !== frozen.config.simulated_line_fixture?.modified_sha256) throw new Error('per-arm simulated-line fixture differs from independently qualified preflight transform')
    const state = awHomeStateProjection(home)
    writeJson(join(evidenceDir, 'pretrial-state.json'), { schema_version: 1, run_id: input.run_id, episode_id: row.episode_id, arm, state_sha256: state.sha256, files: state.projection })
    prepared[arm] = { home, fixture, state }
  }
  if (prepared.ON.state.sha256 !== prepared.OFF.state.sha256) throw new Error(`matched pair AW_HOME pre-trial state mismatch for ${row.episode_id}`)
  for (const arm of ['ON', 'OFF']) {
    writeJson(join(runRoot, 'episodes', row.episode_id, arm, 'pretrial-state-pair.json'), {
      schema_version: 1,
      episode_id: row.episode_id,
      arm,
      matched_pretrial_state_sha256: prepared[arm].state.sha256,
      pair_arms_equal: true,
    })
  }
  return prepared
}
function removeSimulatorRoot(runRoot, simulatorRoot) {
  const expectedBase = resolve(runRoot, 'runtime')
  const actual = resolve(simulatorRoot)
  if (!isPathWithin(expectedBase, actual) || actual === expectedBase || !existsSync(actual) || realpathSync(actual) !== actual) {
    throw new Error('refusing to remove an unqualified simulator root')
  }
  rmSync(actual, { recursive: true, force: false })
  if (existsSync(actual)) throw new Error('simulator root cleanup did not remove its private directory')
}
async function runArm(runRoot, input, frozen, row, arm, sim, preparedHome) {
  const startedAt = iso()
  const startedNs = ns()
  const armDir = join(runRoot, 'runtime', 'episodes', row.episode_id, arm)
  const home = preparedHome.home
  const evidenceDir = join(runRoot, 'episodes', row.episode_id, arm)
  mkdirSync(evidenceDir, { recursive: true })
  const lineFixture = preparedHome.fixture
  const eventFile = join(evidenceDir, 'governance-events.raw.jsonl')
  if (arm === 'OFF') {
    const qualification = makeQualification(runRoot, row, arm, input, frozen.config, frozen.manifestSha, sim, home, frozen.preflightConfig)
    writeJson(join(home, 'approval-only-qualification.json'), qualification, true)
  }
  const server = spawnServer(home, input.aw_base, input.run_id, eventFile, {
    arm,
    simBase: input.sim_base,
    episodeId: row.episode_id,
    manifestSha256: frozen.manifestSha,
    configurationSha256: frozen.configurationSha,
  })
  const evidence = {
    schema_version: 1,
    run_id: input.run_id,
    episode_id: row.episode_id,
    pair_index: row.pair_index,
    case: row.case,
    arm,
    arm_order: row.arm_order,
    actor_id: row.actor_id,
    recipe_id: row.recipe_id,
    node_id: row.params[0].node_id,
    requested_value: row.params[0].value,
    hypothesis: row.hypothesis,
    fixture_sha256: row.fixture_sha256,
    configuration_sha256: frozen.configurationSha,
    manifest_sha256: frozen.manifestSha,
    simulated_line_fixture: lineFixture,
    process: { aw_pid: server.pid, simulator_pid: sim.simulator_pid, simulator_root: sim.simulator_root, aw_home_sha256: sha(resolve(home)) },
    matched_pretrial_aw_home: { sha256: preparedHome.state.sha256, pair_equal: true },
    timestamps: { started_at_utc: startedAt, started_monotonic_ns: startedNs },
    phases: [],
    result: 'NOT-RUN',
    errors: [],
  }
  let token = ''
  let session
  let invokePromise
  let invokeResponse = null
  let fixtureApproval = null
  try {
    const health = await waitFor(input.aw_base, 'isolated AW', server.pid)
    if (health?.app !== 'AgentWorkShop' && health?.data?.app !== 'AgentWorkShop') throw new Error('AW health did not identify AgentWorkShop')
    const loginResult = await login(input.aw_base)
    session = loginResult.user
    token = loginResult.token
    evidence.controller = { user_id: session.id, role: session.role, type: 'scripted approval fixture controller' }
    const before = await collectDcw(input.aw_base, token, input)
    if (before.line.controlMode !== 'manual' || before.line.simulated !== true) throw new Error('runtime line left manual/simulated qualification')
    if (before.line.simSceneId !== input.scene_id) throw new Error('runtime line simulation scene differs from the frozen fixture')
    if (before.recipe.id !== row.recipe_id || before.node.id !== row.params[0].node_id) throw new Error('runtime resource identity changed from preregistration')
    const driverConfigSha = sha(stable(before.node.driverConfig))
    if (before.node.driver !== frozen.config.node.driver || driverConfigSha !== frozen.config.node.driver_config_sha256
      || driverConfigSha !== frozen.config.simulator_target.export_config_sha256) {
      throw new Error('live arm target route differs from the preflight-qualified loopback simulator route')
    }
    const beforeSim = await simulatorSnapshot(input)
    const beforeRead = await http(input.aw_base, 'POST', `/api/workshop/dcw/${encodeURIComponent(input.node_id)}/read`, { token, body: {} })
    const beforeReadData = responseOk(beforeRead, 'independent device read before trial')
    const approvalsBefore = await readApprovals(input.aw_base, token, input.actor_id, 'history')
    const pendingBefore = await readApprovals(input.aw_base, token, input.actor_id, 'pending')
    const journalBefore = await readJournal(input.aw_base, token, input.line_id)
    const opsBefore = await readOps(input.aw_base, token)
    evidence.snapshots = { dcw_before: before.node, simulator_before: beforeSim, independent_read_before: beforeReadData, approvals_before_ids: approvalsBefore.map(row => row.id), pending_before_ids: pendingBefore.map(row => row.id), journal_before_ids: journalBefore.map(row => row.id), ops_before_count: opsBefore.length }
    evidence.phases.push({ stage: 'baseline-read', at_utc: iso(), monotonic_ns: ns(), duration_ms: null })
    invokePromise = callRecipeTrial(input.aw_base, token, row).then(result => { invokeResponse = result; return result })
    let approval = null
    if (arm === 'ON') {
      approval = await pollNewApproval(input.aw_base, token, input.actor_id, pendingBefore, row)
      if (!approval) {
        const early = await Promise.race([invokePromise, new Promise(resolve => setTimeout(() => resolve(null), 250))])
        evidence.approval = { status: 'NOT-OBSERVED', expected: row.case === 'legal-rejected' ? 'predetermined scripted reject' : 'scripted approve', fixture_type: 'scripted approval fixture', pending_count_delta: null }
        if (early) invokeResponse = early
        else throw new Error('ON arm did not create a matching manual approval request')
      }
      else {
        fixtureApproval = approval
        if (!approvalPayloadMatches(approval, row)) throw new Error('ON approval payload does not match the preregistered actor/recipe/node/value')
        const approved = row.case !== 'legal-rejected'
        const decisionStartedAt = iso()
        const decisionStartedNs = ns()
        const decision = await decideFixture(input.aw_base, token, approval, approved, session)
        evidence.approval = {
          id: approval.id,
          status_before: approval.status,
          decision: approved ? 'approved' : 'rejected',
          decision_source: 'scripted test-controller fixture; not human judgment',
          decided_by: session.id,
          decided_at: decision.approval?.decidedAt ?? decision.decidedAt ?? iso(),
          comment: approved ? 'approve-to-reach-range-guard' : 'predetermined-reject',
          request_payload: redact(approval.payload),
          decision_response: redact(decision),
          decision_started_at_utc: decisionStartedAt,
          decision_started_monotonic_ns: decisionStartedNs,
          decision_duration_ms: Number(process.hrtime.bigint() - BigInt(decisionStartedNs)) / 1e6,
          fixture_type: 'scripted approval fixture',
        }
      }
    }
    else evidence.approval = { status: 'BYPASSED_BY_QUALIFIED_SERVER_HOOK', expected_approval_request_count: 0, fixture_type: 'approval-only OFF' }
    const response = invokeResponse ?? await invokePromise
    evidence.tool_call = {
      http_status: response.status,
      result: redact(response.data?.result ?? response.data),
      error_message: response.status >= 400 ? String(response.raw?.message ?? '').slice(0, 1000) : '',
      elapsed_ms: Number(process.hrtime.bigint() - BigInt(startedNs)) / 1e6,
    }
    const afterApprovals = await readApprovals(input.aw_base, token, input.actor_id, 'history')
    const afterJournal = await readJournal(input.aw_base, token, input.line_id)
    const afterOps = await readOps(input.aw_base, token)
    const after = await collectDcw(input.aw_base, token, input)
    const afterRead = await http(input.aw_base, 'POST', `/api/workshop/dcw/${encodeURIComponent(input.node_id)}/read`, { token, body: {} })
    const afterReadData = responseOk(afterRead, 'independent device read after trial')
    const afterSim = await simulatorSnapshot(input)
    const gov = readJsonl(eventFile)
    const newApprovalRows = newRows(approvalsBefore, afterApprovals)
    const newAnchors = newRows(journalBefore, afterJournal)
    const newOps = newRows(opsBefore, afterOps)
    const events = gov.rows
    const driverStarts = events.filter(event => event.event_type === 'driver_call_start' && event.node_id === input.node_id && Number(event.requested_value) === Number(row.params[0].value))
    const driverEnds = events.filter(event => event.event_type === 'driver_call_end' && event.node_id === input.node_id && Number(event.requested_value) === Number(row.params[0].value))
    const anchors = newAnchors.filter(event => event.nodeId === input.node_id && event.actor === input.actor_id && Number(event.newValue) === Number(row.params[0].value))
    const rejectedOps = newOps.filter(event => event.action === 'dcw.write.rejected' && event.targetId === input.node_id && event.actor === input.actor_id)
    const bypassOps = newOps.filter(event => event.action === 'recipe.approval.bypassed' && event.targetId === input.recipe_id && event.actor === input.actor_id)
    const recipeRuns = after.runs.filter(run => run.recipeId === input.recipe_id && Date.parse(run.createdAt ?? run.startedAt ?? '') >= Date.parse(startedAt))
    const runMatch = recipeRuns.find(run => run.results?.some(item => item.nodeId === input.node_id && Number(item.value) === Number(row.params[0].value))) ?? null
    const controlMessage = String(response.data?.result?.text ?? '')
    const rangeGuardResult = row.case === 'out-of-range-approved'
      ? Boolean(runMatch?.results?.some(item => item.nodeId === input.node_id && Number(item.value) === Number(row.params[0].value) && item.ok === false && /越界|限界|范围|候选值未下发/i.test(String(item.message ?? ''))))
      : null
    const approvalsDelta = newApprovalRows.filter(item => item.agentId === input.actor_id && item.nodeId === `recipe:${input.recipe_id}`)
    evidence.approval.request_count_delta = approvalsDelta.length
    evidence.dispatch = {
      driver_call_start_count: driverStarts.length,
      driver_call_end_count: driverEnds.length,
      driver_reached: driverStarts.length > 0,
      driver_call_events: redact(driverStarts.concat(driverEnds)),
      journal_anchor_count: anchors.length,
      journal_anchors: redact(anchors),
      bypass_audit_count: bypassOps.length,
      bypass_audit: redact(bypassOps),
      range_control_guard_rejected: rangeGuardResult,
      range_control_run_result: runMatch ? redact(runMatch.results) : null,
      write_rejection_audit: redact(rejectedOps),
      run_ids: runMatch ? [runMatch.id] : [],
      tool_response_mentions_range: /越界|限界|范围|候选值未下发/i.test(controlMessage),
    }
    evidence.snapshots.dcw_after = after.node
    evidence.snapshots.simulator_after = afterSim
    evidence.snapshots.independent_read_after = afterReadData
    evidence.approval.new_history = redact(approvalsDelta)
    evidence.audit = { malformed_event_lines: gov.malformed, event_count: events.length, event_sha256: existsSync(eventFile) ? sha(readFileSync(eventFile)) : null, new_ops: redact(newOps) }
    const deviceBefore = Number(evidence.snapshots.simulator_before.value)
    const deviceAfter = Number(afterSim.value)
    const readbackValue = Number(afterReadData.read?.value)
    const valueTolerance = Math.max(0.5 * 10 ** -Number(before.node.decimals ?? 2), 0.005 * Math.abs(Number(before.node.max) - Number(before.node.min)))
    const independentReadbackOk = afterReadData.read?.ok === true && Number.isFinite(readbackValue)
    const independentReadbackMatchesDevice = independentReadbackOk && Math.abs(readbackValue - deviceAfter) <= valueTolerance
    const independentReadbackMatchesRequest = independentReadbackOk && Math.abs(readbackValue - Number(row.params[0].value)) <= valueTolerance
    evidence.endpoint_checks = {
      before_device_value: deviceBefore,
      after_device_value: deviceAfter,
      independent_readback_value: Number.isFinite(readbackValue) ? readbackValue : null,
      independent_readback_ok: independentReadbackOk,
      independent_readback_matches_device: independentReadbackMatchesDevice,
      independent_readback_matches_request: independentReadbackMatchesRequest,
      device_value_changed: deviceAfter !== deviceBefore,
      requested_value_matches_device: Math.abs(deviceAfter - Number(row.params[0].value)) <= valueTolerance,
      independent_readback: afterReadData.read ?? afterReadData,
      dcw_read_value_after: after.node.readValue,
      dcw_set_value_after: after.node.value,
    }
    const expectedDriver = row.case === 'legal-approved' || (row.case === 'legal-rejected' && arm === 'OFF')
    const independentReadbackMatchesExpectedState = expectedDriver ? independentReadbackMatchesRequest : independentReadbackMatchesDevice
    evidence.endpoint_checks.independent_readback_matches_expected_state = independentReadbackMatchesExpectedState
    const approvalCountOk = arm === 'OFF' ? approvalsDelta.length === 0 : approvalsDelta.length === 1
    const output = response.data?.result ?? response.data
    const bypassOk = arm === 'OFF' ? output?.approval_bypassed === true && bypassOps.length === 1 : output?.approval_bypassed !== true
    const driverOk = expectedDriver ? driverStarts.length === 1 : driverStarts.length === 0
    const rangeOk = row.case !== 'out-of-range-approved' || rangeGuardResult === true
    const endpointOk = expectedDriver
      ? evidence.endpoint_checks.requested_value_matches_device && independentReadbackMatchesExpectedState && deviceAfter !== deviceBefore
      : deviceAfter === deviceBefore && independentReadbackMatchesExpectedState
    evidence.invariants = {
      expected_driver_reached: expectedDriver,
      actual_driver_reached: driverStarts.length > 0,
      approval_count_ok: approvalCountOk,
      bypass_receipt_ok: bypassOk,
      driver_reach_ok: driverOk,
      range_guard_ok: rangeOk,
      device_endpoint_ok: endpointOk,
      event_file_valid: gov.malformed.length === 0,
    }
    evidence.result = Object.values(evidence.invariants).every(Boolean) ? 'PASS' : 'FAIL'
  }
  catch (error) {
    evidence.result = 'FAIL'
    evidence.errors.push(safeError(error))
    if (fixtureApproval && arm === 'ON') {
      try {
        const pending = await readApprovals(input.aw_base, token, input.actor_id, 'pending')
        const current = pending.find(item => item.id === fixtureApproval.id)
        if (current) await decideFixture(input.aw_base, token, current, false, session)
      }
      catch (decideError) { evidence.errors.push(`cleanup rejected pending fixture: ${safeError(decideError)}`) }
    }
    if (invokePromise) await Promise.race([invokePromise.catch(() => null), new Promise(resolve => setTimeout(resolve, 1000))])
  }
  finally {
    evidence.timestamps.completed_at_utc = iso()
    evidence.timestamps.completed_monotonic_ns = ns()
    evidence.timestamps.elapsed_ms = Number(process.hrtime.bigint() - BigInt(startedNs)) / 1e6
    let cleanupFailed = false
    let awStopped = false
    try { await stopServer(server); awStopped = true }
    catch (error) { evidence.errors.push(`AW stop failed: ${safeError(error)}`); cleanupFailed = true }
    if (awStopped) {
      try { rmSync(home, { recursive: true, force: false }) }
      catch (error) { evidence.errors.push(`AW_HOME cleanup failed: ${safeError(error)}`); cleanupFailed = true }
    }
    else preparedHome.cleanup_deferred = true
    if (cleanupFailed) evidence.result = 'FAIL'
    const gov = readJsonl(eventFile)
    evidence.audit = { ...(evidence.audit ?? {}), final_event_count: gov.rows.length, final_malformed: gov.malformed, final_event_sha256: existsSync(eventFile) ? sha(readFileSync(eventFile)) : null }
    writeJson(join(evidenceDir, 'episode.json'), redact(evidence))
  }
  return evidence
}
async function waitStable(path, minMs = 5000, maxMs = 30_000) {
  const started = Date.now()
  let previous = existsSync(path) ? sha(readFileSync(path)) : ''
  let unchanged = 0
  const observations = []
  while (Date.now() - started < maxMs) {
    await new Promise(resolve => setTimeout(resolve, 1000))
    const current = existsSync(path) ? sha(readFileSync(path)) : ''
    observations.push({ elapsed_ms: Date.now() - started, sha256: current })
    unchanged = current === previous ? unchanged + 1 : 0
    previous = current
    if (Date.now() - started >= minMs && unchanged >= 4) return { stable: true, elapsed_ms: Date.now() - started, observations }
  }
  return { stable: false, elapsed_ms: Date.now() - started, observations }
}
function summarize(runRoot, input, manifest) {
  const rows = []
  for (const episode of manifest.episodes) {
    for (const arm of ['ON', 'OFF']) {
      const path = join(runRoot, 'episodes', episode.episode_id, arm, 'episode.json')
      rows.push({ episode, arm, row: existsSync(path) ? readJson(path) : null })
    }
  }
  const summarizeCase = (caseName) => {
    const selected = rows.filter(x => x.episode.case === caseName)
    const perArm = Object.fromEntries(['ON', 'OFF'].map(arm => {
      const armRows = selected.filter(x => x.arm === arm)
      const completed = armRows.filter(x => x.row)
      const metric = key => ({ numerator: completed.filter(x => x.row?.invariants?.[key] === true).length, denominator: completed.length })
      return [arm, {
        planned: armRows.length,
        started: completed.length,
        passed: completed.filter(x => x.row?.result === 'PASS').length,
        driver_reached: { numerator: completed.filter(x => x.row?.dispatch?.driver_reached === true).length, denominator: completed.length },
        approval_fixture_observed: { numerator: completed.filter(x => x.row?.approval?.decision === (caseName === 'legal-rejected' ? 'rejected' : 'approved')).length, denominator: arm === 'ON' ? completed.length : null },
        non_approval_range_guard_rejected: caseName === 'out-of-range-approved' ? { numerator: completed.filter(x => x.row?.dispatch?.range_control_guard_rejected === true).length, denominator: completed.length } : null,
        readback_matches_expected_state: { numerator: completed.filter(x => x.row?.endpoint_checks?.independent_readback_matches_expected_state === true).length, denominator: completed.length },
        positive_control_write_readback: caseName === 'legal-approved'
          ? { numerator: completed.filter(x => x.row?.result === 'PASS' && x.row?.dispatch?.driver_reached === true && x.row?.endpoint_checks?.independent_readback_matches_request === true).length, denominator: completed.length }
          : null,
        device_endpoint_invariant_ok: metric('device_endpoint_ok'),
        bypass_receipt_ok: metric('bypass_receipt_ok'),
        errors: armRows.filter(x => x.row?.errors?.length).flatMap(x => x.row.errors),
      }]
    }))
    const pairs = selected.map(item => {
      const on = rows.find(x => x.episode.episode_id === item.episode.episode_id && x.arm === 'ON')?.row
      const off = rows.find(x => x.episode.episode_id === item.episode.episode_id && x.arm === 'OFF')?.row
      return { episode_id: item.episode.episode_id, on_started: Boolean(on), off_started: Boolean(off), both_started: Boolean(on && off), on_driver_reached: on?.dispatch?.driver_reached ?? null, off_driver_reached: off?.dispatch?.driver_reached ?? null, on_result: on?.result ?? 'NOT-RUN', off_result: off?.result ?? 'NOT-RUN' }
    })
    return { planned_pairs: selected.length / 2, planned_arms_per_condition: selected.length / 2, arms: perArm, pairs }
  }
  const legalApproved = summarizeCase('legal-approved')
  const legalRejected = summarizeCase('legal-rejected')
  const range = summarizeCase('out-of-range-approved')
  return { legal_approved: legalApproved, legal_rejected: legalRejected, out_of_range_approved: range, episodes: rows.map(item => ({ episode_id: item.episode.episode_id, arm: item.arm, status: item.row?.result ?? 'NOT-RUN' })) }
}
function reportMarkdown(input, frozen, summary) {
  const rows = (item, label) => {
    if (!item) return ''
    const on = item.arms.ON
    const off = item.arms.OFF
    const format = metric => metric ? `${metric.numerator}/${metric.denominator}` : 'N/A'
    const armRow = (arm, name) => `| ${label} | ${name} | ${format(arm.driver_reached)} | ${format(arm.readback_matches_expected_state)} | ${format(arm.approval_fixture_observed)} | ${format(arm.positive_control_write_readback)} | ${format(arm.non_approval_range_guard_rejected)} | ${arm.passed}/${arm.planned} |`
    return `${armRow(on, 'ON')}\n${armRow(off, 'OFF')}`
  }
  const lines = [
    '# A1 Approval-Gate Pilot Report',
    '',
    `Run: \`${input.run_id}\`  `,
    `Classification: descriptive pilot; no power calculation, hypothesis test, or efficacy claim.  `,
    `Approval decisions: ON decisions are scripted test-controller fixtures (approve/reject for the legal candidate; approve the out-of-range request only to reach the independent range guard); not human approval quality evidence or a user study.  `,
    `Invocation path: platform \`agent-tools/invoke\` API with a fixed actor and tool contract; this pilot does not evaluate an LLM or harness model.  `,
    'Protocol paths: each task uses `POST /api/workshop/agent-tools/invoke`; ON decisions use `POST /api/workshop/agent-tools/approvals/:id/decide`; device readback uses `POST /api/workshop/dcw/:id/read`.',
    `Network: Docker \`--network none\`; the run namespace must expose only loopback and no IPv4/IPv6 default route.  `,
    `Configuration SHA-256: \`${frozen.configurationSha}\`; manifest SHA-256: \`${frozen.manifestSha}\`.`,
    '',
    '## Denominators',
    '',
    '| Case | Arm | Driver reached / started | Expected readback / started | Expected ON decision / started ON | Legal write + readback / started | Range guard rejects / started | PASS / planned arms |',
    '|---|---|---:|---:|---:|---:|---:|---:|',
    rows(summary.legal_approved, 'Legal candidate; ON scripted approval'),
    rows(summary.legal_rejected, 'Legal candidate; ON predetermined rejection'),
    rows(summary.out_of_range_approved, 'Out-of-range request; ON approval then independent range guard'),
    '',
    'Each case has five planned paired blocks (five planned episodes per arm). Metric denominators use started episodes, while the PASS column uses all five planned episodes; unstarted cases remain `NOT-RUN`. “Expected readback” counts independent device readbacks matching the expected endpoint state; for legal-rejected OFF this exposes the actual write/readback count, while legal-rejected ON and range-control arms must read back the unchanged device value. Positive-control success requires one expected driver call, a changed simulator value matching the candidate, and a matching independent readback. Range-guard counts are shown per arm with explicit denominators. These descriptive counts do not estimate a general false-block rate. ON decisions are test-controller fixtures, not human judgment.',
    '',
    '## Paired Episodes',
    '',
    '| Episode | Case | ON | OFF | Both started | ON driver reached | OFF driver reached |',
    '|---|---|---|---|---|---|---|',
    ...frozen.manifest.episodes.map(episode => {
      const on = summary.episodes.find(row => row.episode_id === episode.episode_id && row.arm === 'ON')
      const off = summary.episodes.find(row => row.episode_id === episode.episode_id && row.arm === 'OFF')
      const onEvidence = readMaybe(join(input.run_root, 'episodes', episode.episode_id, 'ON', 'episode.json'))
      const offEvidence = readMaybe(join(input.run_root, 'episodes', episode.episode_id, 'OFF', 'episode.json'))
      return `| ${episode.episode_id} | ${episode.case} | ${on?.status ?? 'NOT-RUN'} | ${off?.status ?? 'NOT-RUN'} | ${Boolean(on && off)} | ${onEvidence?.dispatch?.driver_reached ?? 'N/A'} | ${offEvidence?.dispatch?.driver_reached ?? 'N/A'} |`
    }),
    '',
    '## Evidence Limits',
    '',
    '- This pilot has three separate groups: a legal candidate with scripted ON approval, a legal candidate with predetermined ON rejection, and an out-of-range request with scripted ON approval followed by the independent range guard. The OFF arm uses only the approval-gate bypass; all other guards remain active.',
    '- It does not test approval-pending timeouts, context-mutation barriers, DAQ freshness rejection, approval judgment quality, harness/model substitutability, physical PLC behavior, or general deployment readiness. Static code inspection is not experimental evidence for context-change rejection.',
    '- Docker network-none and loopback-only checks block external egress for the containerized pilot. A result applies only to the recorded simulator build, configuration, and fixture.',
    '- All raw per-arm evidence is retained under `episodes/<episode>/<arm>/`; qualification failures and unstarted episodes stay in the report.',
    '',
  ]
  return lines.flat().filter(Boolean).join('\n')
}
function readMaybe(path) { try { return readJson(path) } catch { return null } }
async function finalizeContainer(runRoot, input, frozen) {
  const stableRows = []
  for (const episode of frozen.manifest.episodes) for (const arm of ['ON', 'OFF']) {
    const eventPath = join(runRoot, 'episodes', episode.episode_id, arm, 'governance-events.raw.jsonl')
    if (existsSync(eventPath)) stableRows.push({ episode_id: episode.episode_id, arm, path: eventPath, ...await waitStable(eventPath) })
  }
  const summary = summarize(runRoot, input, frozen.manifest)
  const result = {
    schema_version: 1,
    run_id: input.run_id,
    status: summary.episodes.every(row => row.status === 'PASS') ? 'PASS' : summary.episodes.some(row => row.status === 'FAIL') ? 'FAIL' : 'INCOMPLETE',
    study_type: 'descriptive-pilot',
    finalized_at_utc: iso(),
    configuration_sha256: frozen.configurationSha,
    manifest_sha256: frozen.manifestSha,
    denominators: summary,
    event_file_stability: stableRows,
    outcomes_are_descriptive_only: true,
    human_approval_quality_claim: false,
    model_or_harness_comparison_claim: false,
  }
  writeJson(join(runRoot, 'report.json'), result)
  writeFileSync(join(runRoot, 'report.md'), reportMarkdown({ ...input, run_root: runRoot }, frozen, summary), 'utf8')
  const hashes = []
  const walk = dir => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (path === join(runRoot, 'runtime')) continue
        walk(path)
      }
      else if (entry.isFile() && path !== join(runRoot, 'SHA256SUMS')) hashes.push(`${sha(readFileSync(path))}  ${relative(runRoot, path).replaceAll('\\', '/')}`)
    }
  }
  walk(runRoot)
  writeFileSync(join(runRoot, 'SHA256SUMS'), `${hashes.join('\n')}\n`, 'utf8')
  return result
}
async function containerPilot(runRoot, input, request) {
  const networkEvidence = networkNamespaceCheck()
  writeJson(join(runRoot, 'runtime', 'network-isolation-pilot.json'), networkEvidence)
  if (request.run_id !== input.run_id || request.action !== 'pilot' || request.network_mode !== 'none') throw new Error('container isolation request does not match pilot run')
  const frozen = validateFrozenFiles(runRoot)
  const preflight = readJson(join(runRoot, 'preflight.json'))
  if (preflight.status !== 'PASS' || preflight.manifest_sha256 !== frozen.manifestSha) throw new Error('a PASS preflight for this frozen manifest is required before pilot')
  const existingEvidence = join(runRoot, 'episodes')
  if (existsSync(existingEvidence) && readdirSync(existingEvidence).length) throw new Error('pilot evidence directory is nonempty; refusing to reuse a run')
  mkdirSync(existingEvidence, { recursive: true })
  let criticalFailure = ''
  const observed = []
  for (const episode of frozen.manifest.episodes) {
    if (criticalFailure) break
    let baselineForPair = null
    let preparedHomes
    try { preparedHomes = preparePairHomes(runRoot, input, frozen, episode) }
    catch (error) {
      for (const arm of ['ON', 'OFF']) {
        const evidenceDir = join(runRoot, 'episodes', episode.episode_id, arm)
        mkdirSync(evidenceDir, { recursive: true })
        writeJson(join(evidenceDir, 'qualification-attempt.json'), redact({
          schema_version: 1, run_id: input.run_id, episode_id: episode.episode_id, case: episode.case, arm,
          status: 'FAIL', attempt: 'matched-pretrial-aw-home-qualification', error: safeError(error), observed_at_utc: iso(),
        }))
        const home = join(runRoot, 'runtime', 'episodes', episode.episode_id, arm, 'aw-home')
        if (existsSync(home)) rmSync(home, { recursive: true, force: true })
      }
      criticalFailure = `paired AW_HOME pre-trial state qualification failed in ${episode.episode_id}: ${safeError(error)}`
      continue
    }
    for (const arm of episode.arm_order) {
      if (criticalFailure) break
      const evidenceDir = join(runRoot, 'episodes', episode.episode_id, arm)
      mkdirSync(evidenceDir, { recursive: true })
      let sim
      try {
        sim = await startAndQualifySim(runRoot, input, episode.episode_id, arm)
        if (sim.data_config_sha256 !== frozen.config.simulator_target.source_config_sha256
          || sim.scene_blueprint_sha256 !== frozen.config.simulator_target.blueprint_sha256) {
          throw new Error('fresh arm simulator source configuration or scene blueprint differs from the frozen preflight')
        }
        const resetStarted = iso()
        const reset = await simHttp(input.sim_base, 'POST', '/api/plant/reset', {
          id: input.scene_id,
          seed: episode.simulator_seed,
          disturbances: { heaterDecay: 1, feedDriftPerMin: 0 },
          warm: true,
        })
        responseOk(reset, `simulator reset ${episode.episode_id}/${arm}`)
        await new Promise(resolve => setTimeout(resolve, 1200))
        const resetState = await simulatorSnapshot(input)
        if (baselineForPair && resetState.state_sha256 !== baselineForPair.state_sha256) {
          throw new Error('fresh paired simulator roots did not reproduce the same complete normalized node/signal state')
        }
        baselineForPair ??= resetState
        const armResult = await runArm(runRoot, input, { ...frozen, preflightConfig: readJson(join(runRoot, 'configuration.json')) }, episode, arm, sim, preparedHomes[arm])
        armResult.simulator_reset = {
          started_at_utc: resetStarted,
          seed: episode.simulator_seed,
          independent_root_per_arm: true,
          simulator_root: sim.simulator_root,
          simulator_pid: sim.simulator_pid,
          simulator_source_config_sha256: sim.data_config_sha256,
          scene_blueprint_sha256: sim.scene_blueprint_sha256,
          complete_normalized_state_sha256: resetState.state_sha256,
          target_after_reset: resetState,
        }
        writeJson(join(runRoot, 'episodes', episode.episode_id, arm, 'episode.json'), redact(armResult))
        observed.push({ episode_id: episode.episode_id, arm, status: armResult.result })
        if (armResult.result === 'FAIL') {
          const critical = armResult.invariants?.driver_reach_ok === false || armResult.invariants?.range_guard_ok === false
            || armResult.invariants?.device_endpoint_ok === false || armResult.errors?.some(e => /loopback|network namespace|qualification|manifest|simulator|listener/i.test(e))
          if (critical) criticalFailure = `critical invariant failure in ${episode.episode_id}/${arm}`
        }
      }
      catch (error) {
        const failure = {
          schema_version: 1,
          run_id: input.run_id,
          episode_id: episode.episode_id,
          case: episode.case,
          arm,
          arm_order: episode.arm_order,
          status: 'FAIL',
          error: safeError(error),
          simulator: sim ? { pid: sim.simulator_pid, root: sim.simulator_root, source_config_sha256: sim.data_config_sha256, scene_blueprint_sha256: sim.scene_blueprint_sha256 } : null,
          observed_at_utc: iso(),
        }
        writeJson(join(evidenceDir, 'qualification-attempt.json'), redact(failure))
        observed.push({ episode_id: episode.episode_id, arm, status: 'FAIL', qualification_attempt: true })
        criticalFailure = `simulator/AW qualification failed in ${episode.episode_id}/${arm}: ${safeError(error)}`
      }
      finally {
        if (sim) {
          let stopped = false
          try { await stopSimulator(sim.simulator_pid, input.sim_base); stopped = true }
          catch (error) { criticalFailure ||= `simulator stop failed in ${episode.episode_id}/${arm}: ${safeError(error)}` }
          if (stopped) {
            try { removeSimulatorRoot(runRoot, sim.simulator_root) }
            catch (error) { criticalFailure ||= `simulator root cleanup failed in ${episode.episode_id}/${arm}: ${safeError(error)}` }
          }
        }
        const home = preparedHomes[arm]?.home
        if (home && existsSync(home) && !preparedHomes[arm].cleanup_deferred) {
          try { rmSync(home, { recursive: true, force: false }) }
          catch (error) { criticalFailure ||= `AW_HOME cleanup failed in ${episode.episode_id}/${arm}: ${safeError(error)}` }
        }
      }
    }
    for (const arm of ['ON', 'OFF']) {
      const home = preparedHomes[arm]?.home
      if (home && existsSync(home) && !preparedHomes[arm].cleanup_deferred) {
        try { rmSync(home, { recursive: true, force: false }) }
        catch (error) { criticalFailure ||= `unrun AW_HOME cleanup failed in ${episode.episode_id}/${arm}: ${safeError(error)}` }
      }
    }
  }
  const finalized = await finalizeContainer(runRoot, input, frozen)
  if (criticalFailure) {
    finalized.status = 'FAIL'
    finalized.critical_stop_reason = criticalFailure
    finalized.completed_before_stop = observed
    writeJson(join(runRoot, 'report.json'), finalized)
  }
  return finalized
}

function findRunRoot(runId) {
  if (!safeId(runId)) throw new Error('run id must be 8–80 safe characters')
  return join(RESULTS, `${runId}-approval-ablation`)
}
async function prepareHost(args) {
  const runId = args['run-id'] ? need(args, 'run-id') : `a1-${new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14)}-${randomBytes(3).toString('hex')}`
  if (!safeId(runId)) throw new Error('run id must be 8–80 safe characters')
  const runRoot = findRunRoot(runId)
  if (existsSync(runRoot)) throw new Error(`run directory already exists: ${runRoot}`)
  const sourceTemplate = resolve(need(args, 'template-home'))
  const profile = (process.env.USERPROFILE ?? process.env.HOME ?? '').replaceAll('\\', '/')
  const userDefault = profile ? resolve(profile, '.AgentWorkShop') : ''
  const resultsRelative = relative(RESULTS, sourceTemplate).split(sep).filter(Boolean)
  const approvedResultsTemplate = isPathWithin(RESULTS, sourceTemplate)
    && resultsRelative.length >= 3
    && resultsRelative.at(-2) === 'runtime'
    && resultsRelative.at(-1) === 'aw-home'
    && resultsRelative.slice(0, -2).every(part => /^[a-zA-Z0-9._-]+$/.test(part))
  if ((isPathWithin(REPO, sourceTemplate) && !approvedResultsTemplate) || (userDefault && isPathWithin(userDefault, sourceTemplate))) {
    throw new Error('template-home must be external to the repository or an exact bench/results/**/runtime/aw-home snapshot; user default data is forbidden')
  }
  ensureNoSymlinks(sourceTemplate)
  if (existsSync(join(sourceTemplate, '.runtime', 'data.lock'))) throw new Error('stop the template AW service and clear/inspect its data lock before preparing a pilot')
  const simBase = safeUrl(args['sim-base'] ?? 'http://127.0.0.1:4011', 'SIM_BASE')
  const simPort = Number(new URL(simBase).port)
  const awPort = Number(args['aw-port'] ?? 3391)
  if (!Number.isInteger(awPort) || awPort < 1024 || awPort > 65535 || awPort === 3001 || awPort === simPort) throw new Error('choose a unique AW port from 1024–65535, distinct from shared/default and simulator ports')
  const pairCount = Number(args['pair-count'] ?? 5)
  if (pairCount !== 5) throw new Error('this preregistered descriptive pilot uses exactly five paired blocks per case')
  if (args['range-control'] === false) throw new Error('the frozen A1 pilot requires all three cases, including the independent out-of-range control')
  const seedText = args.seed == null ? randomBytes(4).readUInt32BE(0) : Number(need(args, 'seed'))
  if (!Number.isInteger(seedText) || seedText < 0 || seedText > 0xffffffff) throw new Error('seed must be an unsigned 32-bit integer')
  const sceneId = String(args['scene-id'] ?? 'injection')
  if (sceneId !== 'injection') throw new Error('this A1 pilot runner currently qualifies only the injection simulator scenario')
  const sourceActorId = need(args, 'actor-id')
  const ids = {
    user_id: syntheticId(runId, 'user'),
    channel_id: syntheticId(runId, 'channel'),
    agent_id: syntheticId(runId, 'agent'),
    run_id: syntheticId(runId, 'active-run'),
  }
  const input = {
    schema_version: 1,
    run_id: runId,
    source_template_class: approvedResultsTemplate ? 'bench/results/**/runtime/aw-home; sanitized snapshot only; excluded from Docker context' : 'external-isolated-AW_HOME',
    sim_base: simBase,
    aw_base: `http://127.0.0.1:${awPort}`,
    aw_port: awPort,
    scene_id: sceneId,
    actor_id: ids.agent_id,
    synthetic_ids: ids,
    line_id: need(args, 'line-id'),
    recipe_id: need(args, 'recipe-id'),
    node_id: need(args, 'node-id'),
    sim_device_id: need(args, 'sim-device-id'),
    sim_signal_id: need(args, 'sim-signal-id'),
    legal_value: Number(need(args, 'legal-value')),
    control_value: args['control-value'] == null ? null : Number(args['control-value']),
    range_control: true,
    pair_count: pairCount,
    random_seed: seedText,
  }
  const random = makeRandom(seedText)
  const planned = []
  for (let index = 1; index <= pairCount; index++) {
    for (const caseName of ['legal-approved', 'legal-rejected', 'out-of-range-approved']) {
      planned.push({ episode_id: `${caseName}-${String(index).padStart(2, '0')}`, pair_index: index, case: caseName, arm_order: shuffle(['ON', 'OFF'], random), simulator_seed: (seedText + index) >>> 0 })
    }
  }
  input.planned_pairs = planned
  input.source = sourceFingerprint()
  mkdirSync(runRoot, { recursive: false })
  mkdirSync(join(runRoot, 'runtime'), { recursive: true })
  const templateSnapshot = join(runRoot, 'runtime', 'template-snapshot')
  let credentialChannel
  try {
    const snapshotManifest = await sanitizeTemplateSnapshot(sourceTemplate, templateSnapshot, { input, sourceActorId, ids })
    credentialChannel = makeDisposableAdmin(snapshotManifest.credentials)
    const projection = snapshotManifest.projection
    delete snapshotManifest.credentials
    writeJson(join(runRoot, 'fixture-projection.json'), projection, true)
    input.template_tree_sha256 = shaTree(templateSnapshot)
    input.template_snapshot = {
      sha256: input.template_tree_sha256,
      sanitized_file_manifest_sha256: input.template_tree_sha256,
      files: snapshotManifest.files,
      omitted_files: snapshotManifest.omitted_files,
      source_database_rows_read: false,
      source_database_files_copied: false,
      synthetic_user_records: 1,
      synthetic_workshop_channel_agents: { channels: 1, channel_agents: 1, channel_members: 1 },
      synthetic_ids: ids,
      fixture_projection_sha256: sha(stable(projection)),
    }
  }
  catch (error) {
    writeJson(join(runRoot, 'prepare-failure.json'), { schema_version: 1, run_id: runId, phase: 'template-snapshot', status: 'FAIL', error: safeError(error), source_template_class: input.source_template_class, failed_at_utc: iso() })
    rmSync(templateSnapshot, { recursive: true, force: true })
    if (credentialChannel) rmSync(credentialChannel.channel_dir, { recursive: true, force: true })
    throw error
  }
  const contextRoot = join(runRoot, 'runtime', 'docker-context')
  let context
  try { context = copySourceContext(contextRoot) }
  catch (error) {
    let reportError
    const cleanupErrors = []
    try {
      writeJson(join(runRoot, 'prepare-failure.json'), { schema_version: 1, run_id: runId, phase: 'docker-context-allowlist', status: 'FAIL', error: safeError(error), source_template_class: input.source_template_class, failed_at_utc: iso() })
    }
    catch (failure) { reportError = failure }
    finally {
      const removeContained = (label, target, parent) => {
        try {
          if (resolve(target) === resolve(parent) || !isPathWithin(parent, target)) throw new Error(`${label} path escaped its allowed parent`)
          rmSync(resolve(target), { recursive: true, force: true })
        }
        catch (failure) { cleanupErrors.push(`${label} cleanup failed: ${safeError(failure)}`) }
      }
      removeContained('failed Docker context', contextRoot, join(runRoot, 'runtime'))
      removeContained('sanitized template snapshot', templateSnapshot, runRoot)
      if (credentialChannel) {
        const credentialDirectory = resolve(credentialChannel.channel_dir)
        if (!basename(credentialDirectory).startsWith('a1-pilot-credential-') || !isPathWithin(tmpdir(), credentialDirectory)) {
          cleanupErrors.push('temporary credential cleanup failed: directory escaped the expected disposable location')
        }
        else {
          try { rmSync(credentialDirectory, { recursive: true, force: true }) }
          catch (failure) { cleanupErrors.push(`temporary credential cleanup failed: ${safeError(failure)}`) }
        }
      }
    }
    if (reportError || cleanupErrors.length) {
      const details = [
        reportError ? `failure report write failed: ${safeError(reportError)}` : '',
        ...cleanupErrors,
      ].filter(Boolean).join('; ')
      throw new Error(`Docker context preparation failed: ${safeError(error)}; ${details}`, { cause: error })
    }
    throw error
  }
  input.container_context = context
  let image
  try {
    writeJson(join(runRoot, 'study-input.json'), input, true)
    writeJson(join(runRoot, 'runtime', 'host-setup.json'), {
      run_id: runId,
      template_snapshot: templateSnapshot,
      template_snapshot_sha256: input.template_tree_sha256,
      credential_channel: credentialChannel.channel_path,
      credential_account: credentialChannel.account_email,
      docker_context: contextRoot,
      image_tag: `aw-a1-pilot:${runId.toLowerCase()}`,
      prepared_at_utc: iso(),
    }, true)
    const dockerBuild = spawnSync('docker', ['build', '--tag', `aw-a1-pilot:${runId.toLowerCase()}`, '--file', join(contextRoot, DOCKERFILE), contextRoot], {
      cwd: REPO, encoding: 'utf8', timeout: 1_800_000, maxBuffer: 32 * 1024 * 1024,
    })
    writeFileSync(join(runRoot, 'runtime', 'docker-build.log'), `${dockerBuild.stdout ?? ''}\n${dockerBuild.stderr ?? ''}`, 'utf8')
    if (dockerBuild.error || dockerBuild.status !== 0) throw new Error(`Docker image build failed: ${safeError(dockerBuild.error ?? dockerBuild.stderr ?? 'docker build error')}`)
    image = JSON.parse(execFileSync('docker', ['image', 'inspect', `aw-a1-pilot:${runId.toLowerCase()}`, '--format', '{{json .}}'], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }))
    writeJson(join(runRoot, 'runtime', 'image.json'), { tag: `aw-a1-pilot:${runId.toLowerCase()}`, image_id: image.Id, created: image.Created, os: image.Os, architecture: image.Architecture }, true)
  }
  catch (error) {
    writeJson(join(runRoot, 'prepare-failure.json'), { schema_version: 1, run_id: runId, phase: 'docker-image-build', status: 'FAIL', error: safeError(error), source_template_class: input.source_template_class, failed_at_utc: iso() })
    rmSync(templateSnapshot, { recursive: true, force: true })
    rmSync(credentialChannel.channel_dir, { recursive: true, force: true })
    throw error
  }
  process.stdout.write(`${JSON.stringify({ run_id: runId, run_dir: runRoot, image_id: image.Id, source_context_sha256: context.sha256, planned_pairs: planned.length, classification: 'descriptive pilot; prepare only; no recipe_trial invoked' }, null, 2)}\n`)
}
function inspectSummary(inspect) {
  const mounts = (inspect.Mounts ?? []).map(row => ({ type: row.Type, source: row.Source, destination: row.Destination, rw: row.RW }))
  return {
    id: inspect.Id,
    name: inspect.Name,
    image: inspect.Image,
    created: inspect.Created,
    state: inspect.State?.Status,
    network_mode: inspect.HostConfig?.NetworkMode,
    privileged: inspect.HostConfig?.Privileged,
    read_only_rootfs: inspect.HostConfig?.ReadonlyRootfs,
    cap_drop: inspect.HostConfig?.CapDrop,
    security_opt: inspect.HostConfig?.SecurityOpt,
    mounts,
    environment_variable_names: (inspect.Config?.Env ?? []).map(row => row.split('=', 1)[0]).filter(name => !/(PASS|TOKEN|SECRET|KEY|CREDENTIAL|COOKIE)/i.test(name)),
  }
}
function verifyContainerInspect(inspect, runRoot, templateSnapshot, credentialPath, requestPath) {
  if (inspect.HostConfig?.NetworkMode !== 'none' || inspect.HostConfig?.Privileged !== false || inspect.HostConfig?.ReadonlyRootfs !== true
    || !(inspect.HostConfig?.CapDrop ?? []).includes('ALL')) throw new Error('Docker inspect does not prove network-none, rootfs read-only and all capabilities dropped')
  const mounts = inspect.Mounts ?? []
  const run = mounts.find(row => row.Destination === '/run/a1')
  const template = mounts.find(row => row.Destination === '/template')
  const credential = mounts.find(row => row.Destination === CONTAINER_CREDENTIAL_PATH)
  const request = mounts.find(row => row.Destination === '/run/container-request.json')
  if (!run?.RW || run.Source !== runRoot || template?.RW !== false || realpathSync(template?.Source ?? '') !== realpathSync(templateSnapshot)
    || credential?.RW !== false || realpathSync(credential?.Source ?? '') !== realpathSync(credentialPath)
    || request?.RW !== false || realpathSync(request?.Source ?? '') !== realpathSync(requestPath)) throw new Error('Docker bind mounts do not match the isolated run/template/request paths')
  if (mounts.some(row => String(row.Source).includes('docker.sock') || String(row.Destination).includes('docker.sock'))) throw new Error('Docker socket mount is forbidden')
  const proxyNames = (inspect.Config?.Env ?? []).map(row => row.split('=', 1)[0]).filter(name => /^(HTTP|HTTPS|ALL)_PROXY$/i.test(name))
  if (proxyNames.length) throw new Error('proxy environment variables must not enter the network-none pilot container')
  if ((inspect.Config?.Env ?? []).some(row => /^AW_ADMIN_(?:EMAIL|PASS)=/i.test(row))) throw new Error('admin credentials must never be stored in Docker environment metadata')
}
function cleanupSensitiveHost(runRoot, host) {
  const expectedSnapshot = resolve(runRoot, 'runtime', 'template-snapshot')
  if (host?.template_snapshot && resolve(host.template_snapshot) === expectedSnapshot) rmSync(expectedSnapshot, { recursive: true, force: true })
  if (host?.credential_channel && isPathWithin(tmpdir(), host.credential_channel)) {
    const channelDir = dirname(resolve(host.credential_channel))
    if (basename(host.credential_channel) === 'credential.json' && basename(channelDir).startsWith('a1-pilot-credential-')) rmSync(channelDir, { recursive: true, force: true })
  }
  for (const relativePath of ['runtime/episodes', 'runtime/simulated-template', 'runtime/preflight/ON/aw-home']) {
    const path = join(runRoot, relativePath)
    if (existsSync(path)) rmSync(path, { recursive: true, force: false })
  }
  pilotCredentials = undefined
}
function dockerAction(runRoot, action, runId) {
  const host = readJson(join(runRoot, 'runtime', 'host-setup.json'))
  if (!host.template_snapshot || shaTree(host.template_snapshot) !== host.template_snapshot_sha256) throw new Error('sanitized template snapshot changed after prepare')
  if (!existsSync(host.credential_channel) || !lstatSync(host.credential_channel).isFile() || (statSync(host.credential_channel).mode & 0o222) !== 0) {
    throw new Error('disposable credential channel must be a regular read-only file')
  }
  const requestPath = join(runRoot, 'runtime', `container-request-${action}.json`)
  writeJson(requestPath, { schema_version: 1, run_id: runId, action, network_mode: 'none', created_at_utc: iso() }, true)
  const name = `a1-${runId.slice(-20).toLowerCase()}-${action}-${randomBytes(2).toString('hex')}`
  const args = [
    'create', '--name', name, '--hostname', `a1-${runId.slice(-12).toLowerCase()}`, '--network', 'none', '--read-only', '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges:true', '--pids-limit', '512', '--tmpfs', '/tmp:rw,nosuid,nodev,size=1g',
    '--mount', `type=bind,source=${runRoot},target=/run/a1`,
    '--mount', `type=bind,source=${host.template_snapshot},target=/template,readonly`,
    '--mount', `type=bind,source=${host.credential_channel},target=${CONTAINER_CREDENTIAL_PATH},readonly`,
    '--mount', `type=bind,source=${requestPath},target=/run/container-request.json,readonly`,
    '--env', 'A1_RUN_ROOT=/run/a1', '--env', 'AW_TEMPLATE_HOME=/template', '--env', 'HOME=/tmp',
    '--env', 'NO_PROXY=127.0.0.1,localhost,[::1]', '--env', 'no_proxy=127.0.0.1,localhost,[::1]',
    host.image_tag,
    action === 'preflight' ? 'container-preflight' : 'container-pilot', '--run-id', runId,
  ]
  let containerId = ''
  let result
  let failure
  let containerRemoved = false
  const logPath = join(runRoot, 'runtime', `container-${action}.log`)
  try {
    containerId = execFileSync('docker', args, { cwd: REPO, encoding: 'utf8', timeout: 60_000 }).trim()
    const inspectBefore = JSON.parse(execFileSync('docker', ['inspect', containerId], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }))[0]
    verifyContainerInspect(inspectBefore, runRoot, host.template_snapshot, host.credential_channel, requestPath)
    writeJson(join(runRoot, 'runtime', `container-inspect-${action}-before.json`), inspectSummary(inspectBefore), true)
    const logFd = openSync(logPath, 'a', 0o600)
    let started
    try {
      started = spawnSync('docker', ['start', '-a', containerId], { cwd: REPO, encoding: 'utf8', timeout: 1_800_000, maxBuffer: 32 * 1024 * 1024 })
      const output = `${started.stdout ?? ''}\n${started.stderr ?? ''}`.replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]')
      writeFileSync(logFd, output, 'utf8')
    }
    finally { closeSync(logFd) }
    const inspectAfter = JSON.parse(execFileSync('docker', ['inspect', containerId], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }))[0]
    verifyContainerInspect(inspectAfter, runRoot, host.template_snapshot, host.credential_channel, requestPath)
    writeJson(join(runRoot, 'runtime', `container-inspect-${action}-after.json`), inspectSummary(inspectAfter), true)
    const ok = !started?.error && started?.status === 0 && inspectAfter.State?.ExitCode === 0
    result = { container_id: containerId, exit_code: inspectAfter.State?.ExitCode }
    writeJson(join(runRoot, 'runtime', `container-attestation-${action}.json`), {
      schema_version: 1,
      container_id: containerId,
      container_name: name,
      image_id: inspectAfter.Image,
      network_mode_verified_before_start: inspectBefore.HostConfig.NetworkMode === 'none',
      network_mode_verified_after_exit: inspectAfter.HostConfig.NetworkMode === 'none',
      privileged: inspectAfter.HostConfig.Privileged,
      read_only_rootfs: inspectAfter.HostConfig.ReadonlyRootfs,
      cap_drop: inspectAfter.HostConfig.CapDrop,
      mounts: inspectSummary(inspectAfter).mounts,
      exit_code: inspectAfter.State?.ExitCode,
      finished_at_utc: iso(),
    })
    if (!ok) failure = new Error(`Docker ${action} container failed; redacted inspect evidence and logs retained for ${containerId}`)
  }
  catch (error) { failure = error }
  finally {
    let cleanupError = ''
    try {
      let target = containerId
      if (!target) {
        const check = spawnSync('docker', ['inspect', name], { cwd: REPO, encoding: 'utf8', timeout: 60_000 })
        if (check.status !== 0) {
          if (/no such (?:object|container)|not found/i.test(String(check.stderr ?? ''))) {
            containerRemoved = true
          }
          else cleanupError = `cannot verify partial Docker container creation: ${safeError(check.error ?? check.stderr ?? 'inspect failed')}`
        }
        else target = name
      }
      if (target && !cleanupError) {
        execFileSync('docker', ['rm', '-f', target], { cwd: REPO, encoding: 'utf8', timeout: 60_000 })
        containerRemoved = true
      }
    }
    catch (error) { cleanupError = safeError(error) }
    if (cleanupError) {
      writeJson(join(runRoot, 'runtime', `container-cleanup-${action}.json`), { status: 'FAIL', container_id: containerId || name, error: cleanupError, attempted_at_utc: iso() })
      failure = Object.assign(new Error(`${failure ? `${safeError(failure)}; ` : ''}Docker container cleanup failed: ${cleanupError}`), { containerCleanupFailed: true })
    }
    else {
      writeJson(join(runRoot, 'runtime', `container-cleanup-${action}.json`), {
        status: 'PASS', container_id: containerId || name,
        ...(containerId ? { removed_at_utc: iso() } : { outcome: 'no-container-created', checked_at_utc: iso() }),
      })
    }
    if (containerRemoved && (action === 'pilot' || failure)) cleanupSensitiveHost(runRoot, host)
  }
  if (failure) throw failure
  return result
}
function shaTree(root) { return treeHash(root, new Set(['.runtime', 'logs'])).sha256 }
function hostPreflight(args) {
  const runId = need(args, 'run-id')
  const runRoot = findRunRoot(runId)
  const host = readJson(join(runRoot, 'runtime', 'host-setup.json'))
  try {
    const result = dockerAction(runRoot, 'preflight', runId)
    const preflight = readJson(join(runRoot, 'preflight.json'))
    if (preflight.status !== 'PASS') throw new Error(`preflight did not qualify the pilot: ${(preflight.errors ?? []).join('; ')}`)
    const frozen = validateFrozenFiles(runRoot)
    process.stdout.write(`${JSON.stringify({ run_id: runId, container_id: result.container_id, preflight: preflight.status, configuration_sha256: frozen.configurationSha, manifest_sha256: frozen.manifestSha, planned_episodes: frozen.manifest.episodes.length, experiment_executed: false, classification: 'descriptive pilot only' }, null, 2)}\n`)
  }
  catch (error) {
    if (!error?.containerCleanupFailed) cleanupSensitiveHost(runRoot, host)
    throw error
  }
}
function hostPilot(args) {
  const runId = need(args, 'run-id')
  const runRoot = findRunRoot(runId)
  const host = readJson(join(runRoot, 'runtime', 'host-setup.json'))
  try {
    if (need(args, 'confirm') !== runId) throw new Error('--confirm must exactly equal --run-id; no other value can start the pilot')
    const frozen = validateFrozenFiles(runRoot)
    const preflight = readJson(join(runRoot, 'preflight.json'))
    if (preflight.status !== 'PASS' || preflight.manifest_sha256 !== frozen.manifestSha) throw new Error('matching PASS preflight required before pilot')
    const result = dockerAction(runRoot, 'pilot', runId)
    const report = readJson(join(runRoot, 'report.json'))
    process.stdout.write(`${JSON.stringify({ run_id: runId, container_id: result.container_id, status: report.status, report: join(runRoot, 'report.md'), evidence_sha256: join(runRoot, 'SHA256SUMS'), planned_episodes: frozen.manifest.episodes.length, classification: 'descriptive pilot; no statistical efficacy claim' }, null, 2)}\n`)
  }
  catch (error) {
    if (!error?.containerCleanupFailed) cleanupSensitiveHost(runRoot, host)
    throw error
  }
}
function hostFinalize(args) {
  const runId = need(args, 'run-id')
  const runRoot = findRunRoot(runId)
  const host = readJson(join(runRoot, 'runtime', 'host-setup.json'))
  const cleanup = readMaybe(join(runRoot, 'runtime', 'container-cleanup-pilot.json'))
  try {
    const report = readJson(join(runRoot, 'report.json'))
    const sums = readFileSync(join(runRoot, 'SHA256SUMS'), 'utf8').split(/\r?\n/).filter(Boolean)
    const issues = []
    for (const line of sums) {
      const match = line.match(/^([a-f0-9]{64}) {2}(.+)$/)
      if (!match) { issues.push(`invalid checksum row: ${line}`); continue }
      const path = resolve(runRoot, match[2])
      if (!path.startsWith(`${resolve(runRoot)}${sep}`) || !existsSync(path) || sha(readFileSync(path)) !== match[1]) issues.push(`checksum mismatch: ${match[2]}`)
    }
    const attestation = readJson(join(runRoot, 'runtime', 'container-attestation-pilot.json'))
    if (!attestation.network_mode_verified_before_start || !attestation.network_mode_verified_after_exit) issues.push('Docker network-none attestation is incomplete')
    if (issues.length) throw new Error(`evidence package verification failed: ${issues.join('; ')}`)
    process.stdout.write(`${JSON.stringify({ run_id: runId, report_status: report.status, checksums_verified: sums.length, network_mode: 'none', experiment_executed: report.denominators.episodes.some(row => row.status !== 'NOT-RUN') }, null, 2)}\n`)
  }
  finally {
    if (cleanup?.status === 'PASS') cleanupSensitiveHost(runRoot, host)
  }
}

function hostCleanupInterruptedPrepare(args) {
  const runId = need(args, 'run-id')
  const runRoot = findRunRoot(runId)
  const runtimeRoot = join(runRoot, 'runtime')
  const host = readJson(join(runtimeRoot, 'host-setup.json'))
  const evidenceFiles = [
    'preflight.json', 'manifest.json', 'report.json', 'SHA256SUMS',
    'runtime/container-attestation-preflight.json', 'runtime/container-attestation-pilot.json',
    'runtime/container-cleanup-preflight.json', 'runtime/container-cleanup-pilot.json',
  ]
  const evidencePresent = evidenceFiles.filter(path => existsSync(join(runRoot, path)))
  const trialDirectories = ['runtime/preflight', 'runtime/episodes', 'runtime/simulated-template']
    .filter(path => existsSync(join(runRoot, path)))
  const containerFiles = readdirSync(runtimeRoot).filter(name => name.startsWith('container-'))
  if (evidencePresent.length || trialDirectories.length || containerFiles.length) {
    throw new Error('interrupted-prepare cleanup only applies before any preflight container or trial evidence exists')
  }
  if (!host.template_snapshot || !host.credential_channel || !host.image_tag) {
    throw new Error('host setup is missing the run-local snapshot or disposable credential path')
  }

  const snapshotPath = resolve(host.template_snapshot)
  const credentialPath = resolve(host.credential_channel)
  const cleanupItems = []
  const lstatIfPresent = target => {
    try { return lstatSync(target) }
    catch (error) {
      if (error?.code === 'ENOENT') return null
      throw error
    }
  }
  const attemptRemove = (name, target, allowed) => {
    if (!allowed) {
      cleanupItems.push({ item: name, status: 'REFUSED', error: 'path is outside its exact cleanup allowlist' })
      return
    }
    try {
      if (lstatIfPresent(target)) rmSync(target, { recursive: true, force: false })
      cleanupItems.push({ item: name, status: lstatIfPresent(target) ? 'FAIL' : 'PASS' })
    }
    catch (error) { cleanupItems.push({ item: name, status: 'FAIL', error: safeError(error) }) }
  }
  const expectedSnapshot = resolve(runRoot, 'runtime', 'template-snapshot')
  let snapshotPathSafe = snapshotPath === expectedSnapshot
    && isPathWithin(runRoot, snapshotPath)
    && snapshotPath !== resolve(runRoot)
  try {
    const snapshotStat = lstatIfPresent(snapshotPath)
    if (snapshotStat) {
      snapshotPathSafe = snapshotPathSafe && snapshotStat.isDirectory() && !snapshotStat.isSymbolicLink()
      if (snapshotPathSafe) ensureNoSymlinks(snapshotPath)
    }
  }
  catch { snapshotPathSafe = false }
  attemptRemove('template-snapshot', snapshotPath, snapshotPathSafe)

  const credentialDir = dirname(credentialPath)
  let credentialPathSafe = basename(credentialPath) === 'credential.json'
    && basename(credentialDir).startsWith('a1-pilot-credential-')
    && isPathWithin(tmpdir(), credentialPath)
    && isPathWithin(tmpdir(), credentialDir)
  try {
    const directoryStat = lstatIfPresent(credentialDir)
    const fileStat = lstatIfPresent(credentialPath)
    if (directoryStat) {
      const entries = readdirSync(credentialDir)
      credentialPathSafe = credentialPathSafe && directoryStat.isDirectory() && !directoryStat.isSymbolicLink()
        && (fileStat ? entries.length === 1 && entries[0] === 'credential.json' : entries.length === 0)
    }
    if (fileStat) credentialPathSafe = credentialPathSafe && fileStat.isFile() && !fileStat.isSymbolicLink() && Boolean(directoryStat)
  }
  catch {
    credentialPathSafe = false
  }
  attemptRemove('disposable-credential-directory', credentialDir, credentialPathSafe)

  const cleanupErrors = cleanupItems.filter(item => item.status !== 'PASS')
  const cleanup = {
    schema_version: 1,
    run_id: runId,
    status: cleanupErrors.length === 0 ? 'PASS' : 'FAIL',
    phase: 'interrupted-image-build-before-preflight',
    experiment_started: false,
    cleanup_items: cleanupItems,
    recorded_at_utc: iso(),
  }
  writeJson(join(runtimeRoot, 'interrupted-prepare-cleanup.json'), cleanup, true)
  if (cleanup.status !== 'PASS') throw new Error('interrupted-prepare cleanup did not remove all disposable sensitive inputs')
  process.stdout.write(`${JSON.stringify(cleanup, null, 2)}\n`)
}

async function main() {
  const [command, ...rest] = process.argv.slice(2)
  const args = parseArgs(rest)
  if (command === 'container-network-check') {
    const evidence = networkNamespaceCheck()
    process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`)
    return
  }
  if (command === 'help' || command === '--help' || command == null) {
    process.stdout.write('Usage:\n  prepare --template-home <stopped isolated AW_HOME> --actor-id ID --line-id ID --recipe-id ID --node-id ID --sim-device-id ID --sim-signal-id ID --legal-value N [--control-value N]\n  preflight --run-id ID\n  pilot --run-id ID --confirm ID\n  finalize --run-id ID\n  cleanup-interrupted-prepare --run-id ID (only before preflight/trials; removes the run-local snapshot and disposable credential)\n  container-network-check (diagnostic only; requires Linux --network none)\n\nThe descriptive pilot has three cases with five paired blocks each (15 pairs total) in fresh simulator roots and isolated AW_HOME clones inside Docker --network none. It uses scripted approval fixtures, not human approval evidence. Pilot requires --confirm to exactly match the run ID. Never use a physical device configuration.\n')
    return
  }
  if (command === 'prepare') return prepareHost(args)
  if (command === 'preflight') return hostPreflight(args)
  if (command === 'pilot') return hostPilot(args)
  if (command === 'finalize') return hostFinalize(args)
  if (command === 'cleanup-interrupted-prepare') return hostCleanupInterruptedPrepare(args)
  if (command === 'container-preflight' || command === 'container-pilot') {
    const runId = need(args, 'run-id')
    const runRoot = resolve(process.env.A1_RUN_ROOT ?? '/run/a1')
    const input = readJson(join(runRoot, 'study-input.json'))
    if (input.run_id !== runId || process.env.AW_TEMPLATE_HOME !== '/template') throw new Error('container run ID or template mount mismatch')
    const request = readJson('/run/container-request.json')
    if (command === 'container-preflight') await containerPreflight(runRoot, input, request)
    else {
      const frozen = validateFrozenFiles(runRoot)
      await containerPilot(runRoot, input, request)
      if (frozen.manifestSha !== validateFrozenFiles(runRoot).manifestSha) throw new Error('manifest changed during pilot execution')
    }
    return
  }
  throw new Error(`unknown command: ${command}`)
}

main().catch((error) => {
  process.stderr.write(`${safeError(error)}\n`)
  process.exitCode = 1
})
