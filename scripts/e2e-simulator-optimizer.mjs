#!/usr/bin/env node
/* eslint-disable @stylistic/max-statements-per-line */
/**
 * Physical PLC smoke and optional collected-data training against an isolated AW home.
 * The simulator runs from a fresh source copy; existing :4010 and business records are untouched.
 * No truth/optimum endpoint is consumed. Not a benefit benchmark or an autonomous experiment runner.
 *
 * AW_PHYSICAL_CONTEXT=<JSON with base/token/home> node scripts/e2e-simulator-optimizer.mjs
 * Defaults to six 100 s, 1 Hz runs when DAQ infrastructure is healthy (2/2/2 split).
 * Exit: 0 all attempted checks passed, 1 failure, 2 blocked downstream coverage.
 */
import { spawn } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const contextFile = process.env.AW_PHYSICAL_CONTEXT || join(REPO, '.omc', 'optimizer-full-live-20261023', 'live-context.json')
const context = JSON.parse(readFileSync(contextFile, 'utf8'))
const BASE = String(context.base || '')
const token = String(context.token || '')
const allowed = new Set(['127.0.0.1', 'localhost', '[::1]'])
if (!allowed.has(new URL(BASE).hostname) || !token) throw new Error('Only an authenticated loopback test instance is allowed')
if (!/aw-optimizer-live-e2e|optimizer-physical/i.test(String(context.home || ''))) throw new Error('Expected an explicitly isolated optimizer test home')
const SIM_PORT = Number(process.env.AW_PHYSICAL_SIM_PORT || 4020)
const MQTT_PORT = Number(process.env.AW_PHYSICAL_MQTT_PORT || 18840)
const SIM = `http://127.0.0.1:${SIM_PORT}`
const TAG = `phy${Date.now().toString(36)}`
const ROOT = mkdtempSync(join(REPO, '.omc', 'optimizer-physical-'))
const EVID = join(REPO, 'docs', 'audit', 'evidence', '2026-10-23-optimizer-physical', TAG)
mkdirSync(EVID, { recursive: true })
const checks = []
const scenes = []
let simulator
const sleep = ms => new Promise(r => setTimeout(r, ms))
const record = (id, name, status, detail = '') => {
  checks.push({ id, name, status, detail })
  console.log(`${status.toUpperCase()} [${id}] ${name} ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`)
}
const check = (id, name, pass, detail = '') => record(id, name, pass ? 'pass' : 'fail', detail)
async function api(base, method, path, body, auth = false) {
  if (!allowed.has(new URL(base).hostname) || !path.startsWith('/api/')) throw new Error('Loopback API boundary')
  if (/\/plant\/(truth|optimum)/.test(path)) throw new Error('Truth is unavailable to this harness')
  const response = await fetch(base + path, {
    method, headers: { 'content-type': 'application/json', ...(auth ? { authorization: `Bearer ${token}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(120_000),
  })
  return { status: response.status, ...await response.json().catch(() => ({})) }
}
const aw = (method, path, body) => api(BASE, method, path, body, true)
const sim = (method, path, body) => api(SIM, method, path, body)
const error = result => ({ status: result.status, code: result?.data?.error?.code || result.code, message: result.message || result.statusMessage })
const need = (response, key, label) => {
  const value = response?.data?.[key]
  if (response.status !== 200 || !value) throw new Error(`${label}: ${JSON.stringify(error(response))}`)
  return value
}
async function assertFree(port) {
  const server = createServer()
  await new Promise((resolvePromise, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolvePromise) })
  await new Promise(resolvePromise => server.close(resolvePromise))
}
async function bootSimulator() {
  if (process.env.AW_PHYSICAL_SIM_ROOT) {
    if (!resolve(process.env.AW_PHYSICAL_SIM_ROOT).startsWith(join(REPO, '.omc', 'optimizer-physical-'))) throw new Error('Unexpected simulator runtime root')
    if ((await sim('GET', '/api/nodes')).status !== 200) throw new Error('Prestarted isolated simulator is unavailable')
    return
  }
  await assertFree(SIM_PORT)
  await assertFree(MQTT_PORT)
  const dest = join(ROOT, 'simulator')
  mkdirSync(dest)
  cpSync(join(REPO, 'plc-node-simulator', 'src'), join(dest, 'src'), { recursive: true })
  cpSync(join(REPO, 'plc-node-simulator', 'package.json'), join(dest, 'package.json'))
  const modules = join(REPO, 'plc-node-simulator', 'node_modules')
  if (!existsSync(modules)) throw new Error('Simulator dependencies missing; no automatic installation')
  symlinkSync(modules, join(dest, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir')
  const log = openSync(join(ROOT, 'simulator.log'), 'a')
  simulator = spawn(process.execPath, [join(REPO, 'node_modules', 'tsx', 'dist', 'cli.mjs'), join(dest, 'src', 'server', 'index.ts')], {
    cwd: dest, env: { ...process.env, SIM_PORT: String(SIM_PORT), MQTT_BROKER_PORT: String(MQTT_PORT), NO_PROXY: '127.0.0.1,localhost' },
    stdio: ['ignore', log, log], windowsHide: true,
  })
  for (let i = 0; i < 80; i++) {
    if (simulator.exitCode !== null) throw new Error(`Simulator exited ${simulator.exitCode}; ${join(ROOT, 'simulator.log')}`)
    try { if ((await sim('GET', '/api/nodes')).status === 200) return }
    catch { /* starting */ }
    await sleep(500)
  }
  throw new Error('Simulator boot timeout')
}
async function loadScene(key, label, mvName, cvName, sourceDevice) {
  const blueprint = (await sim('GET', `/api/presets/${key}`)).data
  if (!blueprint?.plantModel) throw new Error(`Missing physical blueprint ${key}`)
  for (const node of blueprint.nodes) {
    node.config ||= {}
    if (node.config.host) node.config.host = '127.0.0.1'
    if (typeof node.config.port === 'number') { node.config.port += 1000; await assertFree(node.config.port) }
    if (node.protocol === 'mqtt') node.config.brokerUrl = `mqtt://127.0.0.1:${MQTT_PORT}`
    const created = await sim('POST', '/api/nodes', node)
    if (created.status !== 200) throw new Error(`Simulator node ${node.id}: ${JSON.stringify(error(created))}`)
  }
  const plant = { ...blueprint.plantModel, id: label, seed: 42, timeScale: 1, truthExport: false }
  const loaded = await sim('PUT', '/api/plant/config', { plantModel: plant, warm: true, upsert: true })
  check(`${label}.plant`, 'Physical model loaded at real time scale', loaded.status === 200, { kind: plant.kind || 'castfilm', timeScale: 1 })
  const exported = []
  for (const node of blueprint.nodes) {
    const result = await sim('GET', `/api/nodes/${node.id}/export`)
    for (const item of result?.data?.items || []) exported.push({ ...item, deviceId: node.id })
  }
  const mv = exported.find(item => item.deviceId === sourceDevice && item.signal === mvName)
  const cv = exported.find(item => item.signal === cvName)
  if (!mv || !cv) throw new Error(`${label}: missing MV/CV exports`)
  const line = need(await aw('POST', '/api/workshop/dcw/lines', { name: `${TAG}-${label}`, simulated: true, simSceneId: key }), 'line', 'line')
  const product = need(await aw('POST', '/api/workshop/dcw/products', { name: `${TAG}-${label}`, lineId: line.id }), 'product', 'product')
  const template = need(await aw('POST', '/api/workshop/dcw/templates', { name: `${TAG}-${label}`, unit: mv.unit, min: mv.min, max: mv.max, decimals: mv.decimals || 0 }), 'template', 'template')
  const initial = label === 'film' ? 140 : 710
  const control = need(await aw('POST', '/api/workshop/dcw', { templateRef: template.key, name: `${TAG}-${label}-MV`, driver: mv.driver, driverConfig: mv.driverConfig, lineId: line.id, min: mv.min, max: mv.max, unit: mv.unit, stepLimit: 60, writeLockSeconds: 0, holdIntervalMs: 0, readIntervalMs: 500 }), 'node', 'control')
  const state = { label, key, line, product, control, initial, mv, cv, daq: [], runs: [] }
  scenes.push(state)
  // One exposed scalar for each available protocol; include both training channels.
  const selected = [mv, cv]
  for (const driver of ['modbus-tcp', 'modbus-rtu', 'opcua', 'mqtt', 'http']) {
    if (selected.some(item => item.driver === driver)) continue
    const item = exported.find(item => item.driver === driver && !item.format && !(item.driverConfig?.jsonKey))
    if (item) selected.push(item)
  }
  for (const [i, item] of selected.entries()) {
    const probe = await aw('POST', '/api/workshop/daq/test-driver', { driver: item.driver, driverConfig: item.driverConfig })
    check(`${label}.probe.${i}`, `Real ${item.driver} DAQ driver reads exposed ${item.signal}`, probe.status === 200 && probe.data?.test?.ok === true, probe.data?.test || error(probe))
    const node = need(await aw('POST', '/api/workshop/daq', { templateRef: 'daq-temp-tc', name: `${TAG}-${label}-${i}`, driver: item.driver, driverConfig: item.driverConfig, lineId: line.id, min: item.min, max: item.max, unit: item.unit, intervalMs: 500, publishIntervalMs: 0 }), 'node', 'DAQ create')
    state.daq.push({ ...node, export: item })
  }
  const written = await aw('POST', `/api/workshop/dcw/${control.id}/write`, { value: initial + 5 })
  check(`${label}.write`, 'Application DCW writes through real PLC protocol', written.status === 200 && written.data?.outcome?.ok === true, written.data?.outcome || error(written))
  const readback = await aw('POST', '/api/workshop/daq/test-driver', { driver: mv.driver, driverConfig: mv.driverConfig })
  const probeValue = Number(readback.data?.test?.value ?? readback.data?.test?.preview?.value)
  // Dedicated simulator node is the independent exposed readback when test-driver response omits value.
  const simNode = (await sim('GET', '/api/nodes')).data?.find(node => node.id === mv.deviceId)
  const signal = simNode?.signals?.find(item => item.name === mvName)
  const observed = Number(signal?.value ?? signal?.runtime?.value ?? probeValue)
  check(`${label}.readback`, 'Exposed PLC setpoint equals application write', Math.abs(observed - initial - 5) <= 0.01, { expected: initial + 5, observed })
  state.recipe = need(await aw('POST', '/api/workshop/dcw/recipes', { name: `${TAG}-${label}`, productId: product.id, params: [{ nodeId: control.id, templateRef: template.key, value: initial, min: mv.min, max: mv.max, stepLimit: 60 }], daqWindows: state.daq.map(node => ({ nodeId: node.id, min: node.export.min, max: node.export.max })) }), 'recipe', 'recipe')
  return state
}
function specOf(scene) {
  return {
    schemaVersion: 2, id: `${TAG}-${scene.label}`, version: 1, lineId: scene.line.id, productId: scene.product.id, recipeId: scene.recipe.id, recipeVersion: scene.recipe.version || 1,
    conditions: [{ id: 'physical', match: [{ field: 'recipeId', op: 'eq', value: scene.recipe.id }] }],
    variables: [
      { id: 'mv', nodeId: scene.daq[0].id, controlNodeId: scene.control.id, role: 'mv', field: 'value', unit: scene.mv.unit, scale: 1, offset: 0, delayMs: 0, min: scene.mv.min, max: scene.mv.max, maxStep: 30 },
      { id: 'cv', nodeId: scene.daq[1].id, role: 'cv', field: 'value', unit: scene.cv.unit, scale: 1, offset: 0, min: scene.cv.min, max: scene.cv.max },
    ],
    timing: { beatMs: 1000, historySteps: 8, horizonSteps: 4, fixedDt: true },
    trainer: { ref: 'linear_arx@1', config: { arOrder: 1, inputOrder: 1, ridgeLambda: 1e-4, standardize: true } },
    datasetPolicy: { split: { valRatio: 0.4, testRatio: 0.4, seed: 42 }, cleaning: { hampelK: 0, maxInterpMs: 1000 } },
    gatePolicyRef: 'process-model.gates@1', modelInterface: { id: 'linear_state_space', version: 1, inputSemantics: 'setpoint', mode: 'state_space' },
    effectiveDomain: { mv: { mv: { min: scene.mv.min, max: scene.mv.max, maxStep: 30 } }, cv: { cv: { min: scene.cv.min, max: scene.cv.max } } }, purpose: 'mpc_surrogate',
  }
}
async function startRun(scene) {
  const started = await aw('POST', `/api/workshop/dcw/lines/${scene.line.id}/start`, { recipeId: scene.recipe.id })
  check(`${scene.label}.run.${scene.runs.length}`, 'Real application line start opens a tagged collection window', started.status === 200 && Boolean(started.data?.run?.id), error(started))
  if (started.data?.run?.id) scene.runs.push(started.data.run.id)
}
async function trainAndSolve(scene) {
  const spec = specOf(scene)
  const registered = await aw('POST', '/api/workshop/process-model/specs', spec)
  check(`${scene.label}.spec`, 'Physical scene configurable ProcessModelSpec accepted', registered.status === 200, error(registered))
  await aw('POST', `/api/workshop/process-model/specs/${spec.id}/publish?version=1`)
  const built = await aw('POST', '/api/workshop/process-model/datasets', spec)
  if (built.status !== 200) { record(`${scene.label}.dataset`, 'Physical collected-data dataset/train/solve', 'blocked', error(built)); return }
  check(`${scene.label}.dataset`, 'Dataset built exclusively from actual collector data', built.data?.rowCount >= 1 && built.data?.lineageVerified === 1, built.data)
  const eligible = await aw('POST', '/api/workshop/process-model/eligibility', { specId: spec.id, specVersion: 1, datasetId: built.data.datasetId, scope: 'simulation' })
  const report = eligible.data?.report
  check(`${scene.label}.eligibility`, 'Physical intervention data eligibility evaluated', eligible.status === 200 && Boolean(report), report || error(eligible))
  const submit = await aw('POST', '/api/workshop/process-model/train', { spec, datasetId: built.data.datasetId, modelName: `${TAG}-${scene.label}` })
  let job = submit.data?.job
  for (let i = 0; job?.id && !['done', 'failed', 'cancelled', 'timeout', 'interrupted'].includes(job.status) && i < 240; i++) {
    await sleep(500)
    job = (await aw('GET', `/api/workshop/aml/jobs/${job.id}`)).data?.job
  }
  if (!job?.modelId || report?.optimizationEligible !== true) { record(`${scene.label}.train`, 'Training, model gates and optimization eligibility', 'blocked', { job, report }); return }
  check(`${scene.label}.train`, 'Physical collected-data training registers a model', job.status === 'done', { jobId: job.id, modelId: job.modelId })
  const profileId = `${TAG}-${scene.label}-profile`
  const profile = await aw('POST', '/api/workshop/optimization/profiles', { schemaVersion: 1, id: profileId, version: 1, modelRef: { modelId: job.modelId, artifactKind: 'linear_state_space@1', artifactHash: '', modelInterface: 'linear_state_space', stage: 'candidate' }, processSpecRef: `${spec.id}@1`, conditionIds: [], status: 'draft', problemTemplateRef: 'linear_mpc_quadratic@1', solverRef: 'osqp_mpc@1', solverVersion: '1', problemConfig: { linear_mpc_quadratic: { cvWeights: { cv: 1 }, duWeights: { mv: 0.1 }, terminalWeight: 2, targets: { cv: scene.label === 'film' ? 15 : 710 } } } })
  if (profile.status !== 200) { record(`${scene.label}.profile`, 'Physical model Profile creation', 'blocked', error(profile)); return }
  const published = await aw('POST', `/api/workshop/optimization/profiles/${profileId}/publish?version=1`)
  check(`${scene.label}.publish`, 'Physical model Profile publishes', published.status === 200, error(published))
  const channel = (await aw('POST', '/api/workshop/channel-templates/chtpl-aml-optimization-default/instantiate', { name: `${TAG}-${scene.label}` })).data
  const agentId = channel?.leadAgentId || channel?.agents?.find(agent => agent.role === 'lead')?.id
  const workspace = (await aw('POST', '/api/workshop/workspaces', { name: `${TAG}-${scene.label}` })).data
  await aw('POST', `/api/workshop/workspaces/${workspace.id}/channels/${channel.channelId}`)
  const binding = await aw('POST', '/api/workshop/optimization/bindings', { workspaceId: workspace.id, channelId: channel.channelId, agentInstanceId: agentId, profileId, profileVersion: 1, mode: 'recommendation' })
  check(`${scene.label}.binding`, 'Physical profile binds to actual Agent instance', binding.status === 200, error(binding))
  await startRun(scene)
  await sleep(12_000)
  const result = await aw('POST', '/api/workshop/agent-tools/invoke', { agentId, tool: 'optimizer_solve', args: {} })
  let candidate
  try { candidate = JSON.parse(result.data?.result?.text || '{}') }
  catch { /* recorded below */ }
  check(`${scene.label}.solve`, 'Agent tool produces an optimal candidate from physical history', !result.data?.result?.isError && candidate?.status === 'optimal', candidate || result.data || error(result))
  if (candidate?.status === 'optimal') {
    const raw = candidate.firstMove?.mv
    const engineered = candidate.firstMoveEngineering?.mv
    check(`${scene.label}.raw-bounds`, 'Unmodified solver first move satisfies declared physical domain', Number.isFinite(raw) && raw >= scene.mv.min - 1e-6 && raw <= scene.mv.max + 1e-6, { raw, min: scene.mv.min, max: scene.mv.max })
    check(`${scene.label}.units`, 'Tool exposes engineering and model values consistently for scale=1', Number.isFinite(engineered) && Math.abs(engineered - raw) <= 1e-9, { model: raw, engineering: engineered })
  }
  record(`${scene.label}.dispatch`, 'Production dispatch and benefit benchmark', 'not-run', 'Recommendation only; no automatic dispatch and no claim of 15% benefit/20 paired runs')
}
if (process.argv.includes('--simulator-only')) {
  await bootSimulator()
  writeFileSync(join(REPO, '.omc', 'optimizer-full-live-20261023', 'simulator-context.json'), JSON.stringify({ root: ROOT, base: SIM, port: SIM_PORT, mqttPort: MQTT_PORT, pid: simulator.pid }, null, 2))
  console.log(`Isolated simulator ready ${SIM}, root=${ROOT}`)
  await new Promise(() => setInterval(() => {}, 60_000))
}
try {
  await bootSimulator()
  await loadScene('cast-film-physics', 'film', 'ScrewSpeedSP', 'MeltPressure', 'dev-extruder-opcua')
  await loadScene('anneal-line', 'anneal', '均热区1炉温SP', 'FurnaceTemp', 'anneal-heating-mbtcp')
  const daq = await aw('GET', '/api/workshop/daq')
  check('infra.observed', 'DAQ infrastructure state is explicitly observed', daq.status === 200, { infra: daq.data?.infra, meta: daq.data?.meta })
  const healthy = daq.data?.infra?.degraded === false
  const seconds = Number(process.env.AW_PHYSICAL_COLLECT_SECONDS || (healthy ? 100 : 20))
  const runs = healthy && seconds >= 60 ? Number(process.env.AW_PHYSICAL_RUNS || 6) : 1
  for (let run = 0; run < runs; run++) {
    for (const scene of scenes) await startRun(scene)
    for (let elapsed = 0; elapsed < seconds; elapsed++) {
      if (healthy && elapsed >= 60 && elapsed % 60 === 0) {
        for (const scene of scenes) {
          const value = scene.initial + (elapsed % 120 === 0 ? -20 : 25)
          const changed = await aw('POST', `/api/workshop/dcw/${scene.control.id}/write`, { value })
          check(`${scene.label}.stimulus.${run}.${elapsed}`, 'Governed online parameter step through DCW', changed.status === 200 && changed.data?.outcome?.ok === true, changed.data?.outcome || error(changed))
        }
      }
      if (elapsed % 30 === 0) console.log(`COLLECT run=${run + 1}/${runs} elapsed=${elapsed}/${seconds}s healthy=${healthy}`)
      await sleep(1000)
    }
    for (const scene of scenes) await aw('POST', `/api/workshop/dcw/lines/${scene.line.id}/stop`)
  }
  for (const scene of scenes) {
    const samples = await aw('GET', `/api/workshop/daq/${scene.daq[1].id}/samples?bucketMs=1000&limit=1000`)
    const points = samples.data?.points || []
    const name = `${scene.label}.collection`
    if (!points.length && !healthy) record(name, 'Physical samples persisted by actual app DAQ', 'blocked', { reason: 'DAQ infrastructure degraded: application disables online acquisition', infra: daq.data?.infra, points: points.length })
    else check(name, 'Physical samples persisted by actual app DAQ', points.length > 5, { points: points.length, tail: points.slice(-2) })
    await trainAndSolve(scene)
  }
}
catch (err) { record('harness', 'Physical harness execution', 'fail', err instanceof Error ? err.stack : String(err)) }
finally {
  for (const scene of scenes) {
    await aw('POST', `/api/workshop/dcw/lines/${scene.line.id}/stop`).catch(() => {})
    for (const node of scene.daq) await aw('PATCH', `/api/workshop/daq/${node.id}`, { enabled: false }).catch(() => {})
    await aw('PATCH', `/api/workshop/dcw/${scene.control.id}`, { enabled: false }).catch(() => {})
  }
  simulator?.kill()
  const counts = Object.fromEntries(['pass', 'fail', 'blocked', 'not-run'].map(status => [status, checks.filter(item => item.status === status).length]))
  writeFileSync(join(EVID, 'report.json'), JSON.stringify({ at: new Date().toISOString(), base: BASE, simulator: SIM, simulatorRoot: process.env.AW_PHYSICAL_SIM_ROOT || ROOT, applicationHome: context.home, counts, scope: { businessInstanceTouched: false, originalSimulatorTouched: false, realHardwareTouched: false, truthConsumed: false, benefitBenchmark: false, realAgentLlm: false }, scenes: scenes.map(scene => ({ scene: scene.label, lineId: scene.line.id, recipeId: scene.recipe?.id, runs: scene.runs })), checks }, null, 2))
  console.log(JSON.stringify({ counts, report: join(EVID, 'report.json') }))
  process.exitCode = counts.fail ? 1 : counts.blocked ? 2 : 0
}
