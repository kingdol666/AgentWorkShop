/**
 * AML HTTP acceptance against an already-running, disposable instance you own.
 * AW_BASE=http://127.0.0.1:<port> node scripts/e2e-aml.ts [--real]
 * Use an admin AW_E2E_TOKEN from the environment, or omit it for first-admin setup.
 * Default: server started with AML_STUB=1. --real: Python/venv + ONNX runtime ready.
 * Uses new mock-device fixtures (4 batches; ~10 min at default sampling/gates).
 * Does not change gate settings or start services; fixtures remain for inspection.
 */
import { randomBytes, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'

const REAL = process.argv.includes('--real')
const BEAT_MS = 1000
const HISTORY_STEPS = 3
const HORIZON_STEPS = 2
const BATCHES = 4
// The stock G4 needs 500 aligned windows. Leave room for cleaning and lost beats.
const SAMPLES_PER_NODE = 150
const RUN_BUDGET_MS = 240_000
const REQUEST_MS = 15_000
const JOB_TERMINAL = new Set(['done', 'failed', 'timeout', 'cancelled', 'interrupted'])
const JOB_ACTIVE = new Set(['queued', 'provisioning', 'training', 'evaluating'])
const STUB_TRAIN_PY = '# AML_STUB acceptance only; executing this is a configuration error.\nraise RuntimeError("AML_STUB=1 is required on the server")\n'

/* eslint-disable @typescript-eslint/no-explicit-any -- HTTP acceptance asserts the dynamic JSON contract */
interface ApiRes { status: number, ok: boolean, data: any, code: unknown }

function loopbackOrigin(raw: string | undefined): string {
  let url: URL
  try {
    url = new URL(raw ?? '')
  }
  catch {
    throw new Error('Set AW_BASE to the origin of a disposable loopback instance you own')
  }
  if (!['http:', 'https:'].includes(url.protocol) || !['127.0.0.1', '[::1]'].includes(url.hostname)
    || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('AW_BASE must be an HTTP(S) loopback origin (127.0.0.1 or [::1]), without credentials/path/query/fragment')
  }
  return url.origin
}

const statusOf = (r: ApiRes): string => `HTTP ${r.status}${typeof r.code === 'string' && /^[A-Z][A-Z_0-9]{1,47}$/.test(r.code) ? ` ${r.code}` : ''}`
const isId = (v: unknown): v is string => typeof v === 'string' && /^[\w-]+$/.test(v)
const sameIds = (actual: unknown, expected: string[]): boolean => Array.isArray(actual)
  && actual.length === expected.length && new Set(actual).size === expected.length && expected.every(id => actual.includes(id))

let passed = 0
function check(name: string, ok: unknown, detail = ''): asserts ok {
  if (!ok) throw new Error(`${name}${detail ? ` — ${detail}` : ''}`)
  passed++
  console.log(`PASS ${name}${detail ? ` — ${detail}` : ''}`)
}

async function poll<T>(budgetMs: number, intervalMs: number, attempt: (remainingMs: number) => Promise<T | undefined>): Promise<T | undefined> {
  const end = performance.now() + budgetMs
  while (performance.now() < end) {
    const result = await attempt(Math.max(1, Math.ceil(end - performance.now())))
    if (performance.now() >= end) return undefined
    if (result !== undefined) return result
    await sleep(Math.max(0, Math.min(intervalMs, end - performance.now())))
  }
  return undefined
}

async function main(): Promise<void> {
  const base = loopbackOrigin(process.env.AW_BASE)
  const tag = `aml-e2e-${randomUUID().slice(0, 12)}`
  let token = process.env.AW_E2E_TOKEN?.trim() ?? ''
  async function api(method: string, path: string, body?: unknown, timeoutMs = REQUEST_MS): Promise<ApiRes> {
    const url = new URL(path, base)
    if (url.origin !== base || !url.pathname.startsWith('/api/')) throw new Error('Invalid acceptance endpoint')
    const signal = AbortSignal.timeout(timeoutMs)
    const res = await fetch(url, {
      method, redirect: 'error', signal,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    }).catch(() => { throw new Error(`${method} ${url.pathname}: request failed (network, timeout or redirect)`) })
    const json = await res.json().catch(() => null)
    return { status: res.status, ok: res.status === 200 && json?.code === 0, data: json?.data, code: json?.code }
  }
  async function create(path: string, key: string, body: unknown): Promise<string> {
    const r = await api('POST', path, body)
    const id = r.data?.[key]?.id
    check(`create ${key} (${path})`, r.ok && isId(id), statusOf(r))
    return id
  }

  console.log(`AML HTTP acceptance: ${REAL ? 'real ONNX' : 'stub'}; fixtures=${tag}`)
  if (!token) {
    const setup = await api('GET', '/api/users/setup-status')
    check('first-admin setup available (otherwise provide an admin AW_E2E_TOKEN)', setup.ok && setup.data?.needsSetup === true, statusOf(setup))
    const reg = await api('POST', '/api/users/register', {
      name: tag, email: `${tag}@example.test`, password: `Aw1-${randomBytes(24).toString('hex')}`,
    })
    check('first admin registered', reg.ok && reg.data?.user?.role === 'admin'
    && typeof reg.data?.token === 'string' && reg.data.token.length > 0, statusOf(reg))
    token = reg.data.token
  }
  const me = await api('GET', '/api/users/me')
  const userId = me.data?.id
  check('admin authenticated', me.ok && isId(userId) && me.data?.role === 'admin', statusOf(me))
  const overview = await api('GET', '/api/workshop/aml')
  check('AML runtime available', overview.ok && typeof overview.data?.runtime?.python?.ok === 'boolean', statusOf(overview))
  if (REAL) check('Python available for real mode', overview.data.runtime.python.ok === true)

  const lineId = await create('/api/workshop/dcw/lines', 'line', { name: `${tag} line` })
  const productId = await create('/api/workshop/dcw/products', 'product', { lineId, name: `${tag} product` })
  const dcwId = await create('/api/workshop/dcw', 'node', { name: `${tag}-sp`, driver: 'mock', lineId, templateRef: 'temp-sp' })
  const recipeId = await create('/api/workshop/dcw/recipes', 'recipe', {
    productId, name: `${tag} recipe`, params: [{ nodeId: dcwId, value: 175, min: 150, max: 200 }],
  })
  const daq = (label: string, templateRef: string) => create('/api/workshop/daq', 'node', {
    name: `${tag}-${label}`, driver: 'mock', lineId, templateRef, intervalMs: BEAT_MS,
  })
  const ctrlId = await daq('control', 'daq-temp-tc')
  const targetId = await daq('target', 'daq-pressure-tx')
  const foreignLineId = await create('/api/workshop/dcw/lines', 'line', { name: `${tag} isolation line` })
  const foreignNode = await create('/api/workshop/daq', 'node', {
    name: `${tag}-isolation`, driver: 'mock', lineId: foreignLineId, templateRef: 'daq-temp-tc',
  })

  const linePath = `/api/workshop/dcw/lines/${lineId}`
  const runIds: string[] = []
  const isRun = (r: any, id: string) => r?.id === id && r.lineId === lineId && r.recipeId === recipeId && r.productId === productId
  for (let i = 1; i <= BATCHES; i++) {
    const start = await api('POST', `${linePath}/start`, { recipeId })
    const run = start.data?.run
    const runId = run?.id
    check(`batch ${i} started a new run`, start.ok && isId(runId) && !runIds.includes(runId)
    && isRun(run, runId) && run.endedAt === null && Number.isFinite(Date.parse(run.startedAt)), statusOf(start))
    const matchesActiveRun = (state: any) => state?.active === true && state.runId === runId
      && state.lineId === lineId && state.recipeId === recipeId && state.productId === productId
    try {
      check(`batch ${i} active with acknowledged mock write`, matchesActiveRun(start.data?.line)
      && run.results?.length === 1 && run.results[0]?.nodeId === dcwId && run.results[0]?.ok === true)
      let counts: unknown[] = []
      const ready = await poll(RUN_BUDGET_MS, 5000, async (remaining) => {
        const r = await api('GET', `/api/workshop/dcw/runs/${runId}/data`, undefined, Math.min(REQUEST_MS, remaining))
        if (!r.ok || !isRun(r.data?.run, runId) || r.data?.run?.endedAt !== null || !Array.isArray(r.data?.daq)) {
          throw new Error(`batch ${i}: active run data missing or mismatched (${statusOf(r)})`)
        }
        counts = [ctrlId, targetId].map(id => r.data.daq.find((node: any) => node.nodeId === id)?.cnt ?? 0)
        return counts.every(n => typeof n === 'number' && n >= SAMPLES_PER_NODE) ? true : undefined
      })
      check(`batch ${i} has persisted tagged samples for both nodes`, ready === true,
        `need ${SAMPLES_PER_NODE}/node; observed ${counts.map(n => Number.isSafeInteger(n) ? n : '?').join('/')}`)
    }
    finally {
      // Recheck identity before stopping, including when collection fails. Never stop a replacement run.
      const current = await api('GET', linePath)
      check(`batch ${i} still owns the active window before stop`, current.ok && matchesActiveRun(current.data?.state), statusOf(current))
      const stop = await api('POST', `${linePath}/stop`)
      const closed = stop.data?.run
      check(`batch ${i} stop closed the exact run`, stop.ok && isRun(closed, runId)
      && closed.startedAt === run.startedAt && Date.parse(closed.endedAt) > Date.parse(run.startedAt)
      && stop.data?.line?.lineId === lineId && stop.data.line.active === false && stop.data.line.runId === null, statusOf(stop))
    }
    runIds.push(runId)
  }

  const dsSpec = {
    lineId, productId, recipeId, runIds,
    nodes: [{ nodeId: ctrlId, role: 'control' }, { nodeId: targetId, role: 'target' }],
    beatMs: BEAT_MS, window: { historySteps: HISTORY_STEPS, horizonSteps: HORIZON_STEPS },
    cleaning: { hampelK: 0, maxInterpMs: 3000, maxDropRatio: 0.25 },
    split: { valRatio: 0.25, testRatio: 0.25, seed: 42 }, purpose: 'mpc_surrogate', note: tag,
  }
  const ds = await api('POST', '/api/workshop/aml/datasets', dsSpec, 60_000)
  const dataset = ds.data?.dataset
  const datasetId = dataset?.id
  check('dataset built from exactly the collected runs', ds.ok && isId(datasetId)
  && dataset.lineId === lineId && dataset.productId === productId && dataset.recipeId === recipeId
  && sameIds(dataset.runIds, runIds) && Number.isInteger(dataset.rowCount) && dataset.rowCount >= 500, statusOf(ds))
  const list = await api('GET', `/api/workshop/aml/datasets?recipeId=${recipeId}`)
  check('exact dataset is listed', list.ok && Array.isArray(list.data?.datasets)
  && list.data.datasets.some((d: any) => d.id === datasetId && d.recipeId === recipeId), statusOf(list))
  const badNode = await api('POST', '/api/workshop/aml/datasets', { ...dsSpec, nodes: [{ nodeId: foreignNode, role: 'control' }, dsSpec.nodes[1]] })
  check('cross-line source node rejected', badNode.status === 403 && badNode.code === 'AML_NODE_LINE_MISMATCH', statusOf(badNode))
  const badProduct = await api('POST', '/api/workshop/aml/datasets', { ...dsSpec, productId: `missing-${tag}` })
  check('wrong product for the same batches rejected', badProduct.status === 422 && badProduct.code === 'AML_RUN_MISMATCH', statusOf(badProduct))

  const code = REAL
    ? readFileSync(new URL('../server/services/workshop/aml/python/train-example.py', import.meta.url), 'utf8')
    : STUB_TRAIN_PY
  const submit = await api('POST', '/api/workshop/aml/jobs', {
    datasetId, code, changeNote: tag, seed: 42, params: REAL ? { epochs: 80 } : {},
  })
  const jobId = submit.data?.job?.id
  check('new training job submitted for the dataset', submit.ok && isId(jobId) && submit.data.job.datasetId === datasetId, statusOf(submit))
  let lastStatus = 'not observed'
  const terminal = await poll(REAL ? 15 * 60_000 : 4 * 60_000, 1500, async (remaining) => {
    const r = await api('GET', `/api/workshop/aml/jobs/${jobId}`, undefined, Math.min(REQUEST_MS, remaining))
    const job = r.data?.job
    if (!r.ok || job?.id !== jobId || job?.datasetId !== datasetId) throw new Error(`job detail missing or mismatched (${statusOf(r)})`)
    if (!JOB_TERMINAL.has(job.status) && !JOB_ACTIVE.has(job.status)) throw new Error('Unrecognized AML job status')
    lastStatus = job.status
    return JOB_TERMINAL.has(job.status) ? r.data : undefined
  })
  check('job reached a terminal state within the budget', terminal, `job=${jobId}; last=${lastStatus}`)
  const finalJob = terminal.job
  const modelId = finalJob.modelId
  check('this job completed successfully and registered a model', finalJob.status === 'done' && finalJob.progress === 100
  && Number.isFinite(Date.parse(finalJob.endedAt)) && isId(modelId) && typeof finalJob.artifactsPath === 'string'
  && finalJob.artifactsPath.length > 0, `job=${jobId}; status=${lastStatus}`)
  const gates = terminal.gates
  check('platform passed all gates, including the expected artifact type', gates?.passed === true
  && Array.isArray(gates.checks) && gates.checks.every((g: any) => g.pass === true)
  && gates.checks.some((g: any) => g.id === 'G5' && typeof g.detail === 'string'
    && g.detail.startsWith(REAL ? 'model.onnx(' : 'STUB ')))
  check('finite metrics for independent validation and test windows', [terminal.metrics?.oneStepVal, terminal.metrics?.oneStepTest, terminal.metrics?.rolloutTest]
    .every(m => Number.isInteger(m?.windows) && m.windows > 0 && Number.isFinite(m.nrmse) && m.nrmse >= 0))

  const leaderboard = await api('GET', `/api/workshop/aml/experiments?datasetId=${datasetId}`)
  const exp = leaderboard.data?.experiments?.find((row: any) => row.jobId === jobId && row.datasetId === datasetId)
  check('exact experiment records the successful lineage', leaderboard.ok && isId(exp?.id) && exp.status === 'gates_passed'
  && exp.changeNote === tag && exp.seed === 42 && exp.gates?.passed === true, statusOf(leaderboard))

  const modelPath = `/api/workshop/aml/models/${modelId}`
  const registered = await api('GET', modelPath)
  const model = registered.data?.model
  check('exact candidate links model, experiment and fixture', registered.ok && model?.id === modelId && model.stage === 'candidate'
  && model.datasetId === datasetId && model.experimentId === exp.id && model.recipeId === recipeId && model.productId === productId
  && model.artifactsPruned === 0 && model.artifactKind === 'onnx_one_step@1', statusOf(registered))
  if (REAL) check('registered ONNX artifact has a SHA-256 digest', typeof model.artifactHash === 'string' && /^[a-f0-9]{64}$/.test(model.artifactHash))

  const promote = await api('POST', `${modelPath}/promote`, { toStage: 'production' }, 60_000)
  const prods = await api('GET', `/api/workshop/aml/models?recipeId=${recipeId}&stage=production`)
  const prodRows = prods.data?.models
  const input = { history: Array.from({ length: HISTORY_STEPS }, () => [168, 0.82]), steps: HORIZON_STEPS }
  if (REAL) {
    check('ONNX passed deep validation and promotion', promote.ok && promote.data?.ok === true && promote.data.from === 'candidate', statusOf(promote))
    check('only the current model is production for the recipe', prods.ok && Array.isArray(prodRows) && prodRows.length === 1
    && prodRows[0].id === modelId && prodRows[0].stage === 'production', statusOf(prods))
    const r = await api('POST', `${modelPath}/predict`, input, 60_000)
    const p = r.data?.prediction
    check('real prediction from this production model has finite forecasts', r.ok && p?.modelId === modelId && p.stage === 'production'
    && p.beatMs === BEAT_MS && sameIds(p.targetNodes, [targetId]) && Array.isArray(p.forecast) && p.forecast.length === HORIZON_STEPS
    && p.forecast.every((row: unknown) => Array.isArray(row) && row.length === 1 && Number.isFinite(row[0])), statusOf(r))
  }
  else {
    check('stub rejected by the production artifact guard', promote.status === 422 && promote.code === 'AML_ARTIFACT_INVALID'
    && prods.ok && Array.isArray(prodRows) && prodRows.length === 0, statusOf(promote))
    const r = await api('POST', `${modelPath}/predict`, input)
    check('stub model cannot predict', r.status === 409 && r.code === 'AML_STUB_MODEL', statusOf(r))
  }
  const absent = await api('POST', `/api/workshop/aml/models/missing-${tag}/predict`, input)
  check('unknown model prediction guard', absent.status === 404 && absent.code === 'AML_MODEL_MISSING', statusOf(absent))

  const ops = await api('GET', `/api/workshop/ops-logs?scope=line&lineId=${lineId}&recipeId=${recipeId}&limit=100`)
  const logs = ops.data?.logs
  check('dataset/job audit entries belong to this caller and fixture', ops.ok && Array.isArray(logs)
  && [['aml.dataset.build', datasetId], ['aml.job.submit', jobId], ['aml.job.finish', jobId]].every(([action, id]) => logs.some((r: any) =>
    r.action === action && r.targetId === id && r.actor === userId && r.actorKind === 'user'
    && r.lineId === lineId && r.productId === productId && r.recipeId === recipeId)), statusOf(ops))
}

main().then(() => {
  console.log(`RESULT ${passed} PASS / 0 FAIL (${REAL ? 'real' : 'stub'})`)
}).catch((err: unknown) => {
  console.error('FAIL', err instanceof Error ? err.message : 'acceptance aborted')
  console.log(`RESULT ${passed} PASS / 1 FAIL (${REAL ? 'real' : 'stub'})`)
  process.exitCode = 1
})
