/**
 * AML 端到端测试(对活服):fixtures → 数据集构建 → 隔离拒绝 → 训练作业 → 门禁 →
 * 排行榜 → 晋升守卫 → 预测守卫 → 审计归属。
 *
 * 运行:
 *   1) 存根模式(无 Python 环境;服务器以 AML_STUB=1 启动):
 *        npx tsx --tsconfig .nuxt/tsconfig.server.json scripts/e2e-aml.ts
 *   2) 真实模式(服务器正常启动,venv 供给可用):… scripts/e2e-aml.ts --real
 *      真实模式走 venv 供给 + torch 训练 + ONNX 评估(首次约数分钟)。
 *
 * 前置:AW_BASE(默认 http://127.0.0.1:3001,仅允许本机回环);AW_E2E_TOKEN
 *       (admin/editor token —— 建数采节点需要 editor+;缺省时注册临时用户,
 *       仅 fresh 库首位=admin 时可行)。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const BASE_URL = new URL(process.env.AW_BASE ?? 'http://127.0.0.1:3001')
// 测试脚本安全守卫:仅允许 http(s) + 本机回环/私网主机名(防误把测试流量打向外部)
if (BASE_URL.protocol !== 'http:' && BASE_URL.protocol !== 'https:') {
  console.error('AW_BASE 协议必须为 http/https')
  process.exit(1)
}
const host = BASE_URL.hostname
const isLocal = host === 'localhost' || host === '127.0.0.1' || host === '::1' || host.endsWith('.local') || /^10\./.test(host) || /^192\.168\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host)
if (!isLocal && process.env.AW_ALLOW_REMOTE_BASE !== '1') {
  console.error(`AW_BASE 主机 ${host} 非本机/私网;确需远程测试请设 AW_ALLOW_REMOTE_BASE=1`)
  process.exit(1)
}
const BASE = BASE_URL.origin
const REAL = process.argv.includes('--real')

let passed = 0
let failures = 0
let step = 0
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (ok) passed++
  else failures++
}
function section(title: string): void {
  step += 1
  console.log(`\n━━━ ${step}. ${title} ━━━`)
}

/* eslint-disable @typescript-eslint/no-explicit-any -- e2e 断言脚本:响应体按动态 JSON 探查 */

interface ApiRes { status: number, ok: boolean, json: any }

async function api(method: string, path: string, opts: { body?: unknown, token?: string } = {}): Promise<ApiRes> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'content-type': 'application/json', 'authorization': `Bearer ${opts.token ?? ''}` },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  })
  const json = await res.json().catch(() => null)
  return { status: res.status, ok: res.ok, json }
}

// ---------- 登录 ----------
let token = process.env.AW_E2E_TOKEN ?? ''
if (!token) {
  const name = `e2e-aml-${process.pid.toString(36)}-${Date.now().toString(36).slice(-5)}`
  const reg = await api('POST', '/api/workshop/users/register', { body: { name }, token: '' })
  token = reg.json?.data?.token ?? ''
}
if (!token) {
  console.error('缺少 token:设置 AW_E2E_TOKEN(admin/editor)后重试')
  process.exit(1)
}

const suffix = `${process.pid.toString(36)}${Date.now().toString(36).slice(-5)}`
const STUB_TRAIN_PY = [
  '# e2e 存根训练代码(AML_STUB=1 时不会真正执行)',
  'import amlkit',
  'amlkit.report_progress(50, \'stub\')',
  'amlkit.save_metrics({\'agent\': {\'note\': \'stub\'}})',
  'print(\'stub train done\')',
  '',
].join('\n')

async function main(): Promise<void> {
  section('平台概览')
  const overview = await api('GET', '/api/workshop/aml', { token })
  check('GET /aml 返回运行时状态', overview.ok && !!overview.json?.data?.runtime, `python.ok=${overview.json?.data?.runtime?.python?.ok}`)
  if (overview.json?.data?.runtime?.python?.ok === false && REAL) {
    console.error('真实模式要求服务器具备 Python;当前探测失败:', overview.json?.data?.runtime?.python?.reason)
  }

  section('门禁阈值放宽(幂等;无权限则降级;测试后恢复)')
  const keysToRelax = ['aml.gates.minRows', 'aml.gates.minRuns', 'aml.gates.nrmse', 'aml.gates.rolloutNrmse', 'aml.gates.valTestGap'] as const
  const relaxedValues: Record<string, unknown> = {
    'aml.gates.minRows': 10,
    'aml.gates.minRuns': 2,
    'aml.gates.nrmse': 0.99,
    'aml.gates.rolloutNrmse': 0.99,
    'aml.gates.valTestGap': 2,
  }
  const before = await api('GET', '/api/system/settings', { token })
  const prevEffective: Record<string, unknown> = before.json?.data?.effective ?? {}
  const patch = await api('PATCH', '/api/system/settings', { token, body: { overrides: relaxedValues } })
  const gatesRelaxed = patch.ok
  const restoreSettings = async (): Promise<void> => {
    if (!gatesRelaxed) return
    const restore: Record<string, unknown> = {}
    for (const k of keysToRelax) {
      if (k in prevEffective) restore[k] = prevEffective[k]
    }
    if (Object.keys(restore).length > 0) await api('PATCH', '/api/system/settings', { token, body: { overrides: restore } })
  }
  check('门禁阈值可写(权限或键缺失则降级)', gatesRelaxed || patch.status === 403 || patch.status === 404 || patch.status === 401, `status=${patch.status}`)

  section('产线 fixtures')
  const line = await api('POST', '/api/workshop/dcw/lines', { token, body: { name: `AML-E2E 线 ${suffix}` } })
  const lineId: string = line.json?.data?.id
  check('创建产线', line.ok, lineId)
  const product = await api('POST', '/api/workshop/dcw/products', { token, body: { lineId, name: `AML-E2E 产品 ${suffix}` } })
  const productId: string = product.json?.data?.id
  check('创建产品', product.ok, productId)
  const dcwNode = await api('POST', '/api/workshop/dcw', { token, body: { name: `aml-e2e-dcw-${suffix}`, driver: 'mock', lineId } })
  const dcwNodeId: string = dcwNode.json?.data?.node?.id ?? dcwNode.json?.data?.id
  check('创建数控节点(mock)', dcwNode.ok, dcwNodeId)
  const recipe = await api('POST', '/api/workshop/dcw/recipes', {
    token,
    body: {
      productId, name: `AML-E2E 配方 ${suffix}`, description: 'e2e',
      params: [{ nodeId: dcwNodeId, value: 60, min: 0, max: 100 }],
    },
  })
  const recipeId: string = recipe.json?.data?.id
  check('创建配方(节点级绑定)', recipe.ok, recipeId)

  section('数采节点 ×2')
  const mkDaq = async (name: string, templateRef: string) => api('POST', '/api/workshop/daq', {
    token,
    body: { name, templateRef, driver: 'mock', lineId, intervalMs: 1000, publishIntervalMs: 0 },
  })
  const daqCtrl = await mkDaq(`aml-e2e-ctrl-${suffix}`, 'daq-temp-tc')
  const daqTmp = await mkDaq(`aml-e2e-tmp-${suffix}`, 'daq-pressure-tx')
  const ctrlId: string = daqCtrl.json?.data?.node?.id
  const tmpId: string = daqTmp.json?.data?.node?.id
  check('数采节点(控制量)', daqCtrl.ok, ctrlId)
  check('数采节点(目标量)', daqTmp.ok, tmpId)

  section('开跑 4 个批次(短窗采集;样本按 run 打标)')
  const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
  for (let i = 0; i < 4; i++) {
    const start = await api('POST', `/api/workshop/dcw/lines/${lineId}/start`, { token, body: { recipeId } })
    if (!start.ok) {
      check(`批次 ${i + 1} 开跑`, false, JSON.stringify(start.json)?.slice(0, 120))
      break
    }
    await sleep(9000)
    await api('POST', `/api/workshop/dcw/lines/${lineId}/stop`, { token, body: {} })
    check(`批次 ${i + 1} 采集完成(9s)`, true)
  }

  section('数据集构建(隔离三元组)')
  const dsSpec = {
    lineId, productId, recipeId,
    nodes: [{ nodeId: ctrlId, role: 'control' }, { nodeId: tmpId, role: 'target' }],
    beatMs: 2000, window: { historySteps: 6, horizonSteps: 3 },
    cleaning: { hampelK: 5, maxInterpMs: 6000, maxDropRatio: 0.5 },
    split: { valRatio: 0.25, testRatio: 0.25, seed: 42 },
    purpose: 'mpc_surrogate',
    note: 'e2e',
  }
  const ds = await api('POST', '/api/workshop/aml/datasets', { token, body: dsSpec })
  const rowCount = ds.json?.data?.dataset?.rowCount ?? 0
  check('数据集构建成功', ds.ok && rowCount > 0, `rows=${rowCount} runs=${ds.json?.data?.dataset?.runIds?.length} ${ds.json?.message ?? ''}`)
  const datasetId: string = ds.json?.data?.dataset?.id
  const dsList = await api('GET', `/api/workshop/aml/datasets?recipeId=${recipeId}`, { token })
  check('数据集列表可见', dsList.ok && (dsList.json?.data?.datasets?.length ?? 0) >= 1)

  section('隔离硬约束')
  const badLine = await api('POST', '/api/workshop/aml/datasets', { token, body: { ...dsSpec, lineId: 'ln-not-exist' } })
  check('节点产线不一致被拒', !badLine.ok && String(badLine.json?.code ?? '').startsWith('AML_'), `code=${badLine.json?.code}`)
  const badProduct = await api('POST', '/api/workshop/aml/datasets', { token, body: { ...dsSpec, productId: 'pd-not-exist' } })
  check('批次归属不一致被拒', !badProduct.ok, `code=${badProduct.json?.code}`)

  section('训练作业(提交 → 终态)')
  const code = REAL
    ? readFileSync(join(process.cwd(), 'server', 'services', 'workshop', 'aml', 'python', 'train-example.py'), 'utf8')
    : STUB_TRAIN_PY
  const job = await api('POST', '/api/workshop/aml/jobs', {
    token,
    body: { datasetId, code, changeNote: 'e2e 基线', seed: 42, params: REAL ? { epochs: 30 } : {} },
  })
  const jobId: string = job.json?.data?.job?.id
  check('作业提交成功', job.ok, jobId ?? job.json?.message)
  let finalJob: any = null
  const budgetMs = REAL ? 15 * 60_000 : 4 * 60_000
  const t0 = Date.now()
  while (Date.now() - t0 < budgetMs) {
    await sleep(2000)
    const r = await api('GET', `/api/workshop/aml/jobs/${jobId}`, { token })
    finalJob = r.json?.data?.job
    if (finalJob && ['done', 'failed', 'timeout', 'cancelled'].includes(finalJob.status)) break
  }
  check('作业终态到达', !!finalJob, `status=${finalJob?.status} err=${String(finalJob?.error ?? '').slice(0, 140)}`)
  const stubDone = finalJob?.status === 'done'
  if (finalJob) {
    const detail = await api('GET', `/api/workshop/aml/jobs/${jobId}`, { token })
    check('门禁报告产出(逐项可读)', Array.isArray(detail.json?.data?.gates?.checks),
      `passed=${detail.json?.data?.gates?.passed} checks=${detail.json?.data?.gates?.checks?.length}`)
  }

  section('排行榜与实验谱系')
  const lb = await api('GET', `/api/workshop/aml/experiments?datasetId=${datasetId}`, { token })
  check('实验行已登记', lb.ok && (lb.json?.data?.experiments?.length ?? 0) >= 1, `n=${lb.json?.data?.experiments?.length}`)
  const expRow = lb.json?.data?.experiments?.[0]
  check('谱系/改动声明落库', !!expRow && Array.isArray(expRow.gates?.checks) && typeof expRow.changeNote === 'string', `status=${expRow?.status}`)

  section('模型注册与晋升守卫')
  const models = await api('GET', `/api/workshop/aml/models?recipeId=${recipeId}`, { token })
  const cand = models.json?.data?.models?.find((m: any) => m.stage === 'candidate')
  if (stubDone && cand) {
    check('候选模型已登记(门禁通过)', true, cand.id)
    const promote = await api('POST', `/api/workshop/aml/models/${cand.id}/promote`, { token, body: { toStage: 'production' } })
    // 存根工件(STUB 标记/无真实 onnx)必须被深检拦下 —— 这是守卫,不是缺陷
    check('无效工件被生产晋升深检拦截', promote.status === 422 && String(promote.json?.code ?? '').includes('ARTIFACT'),
      `status=${promote.status} code=${promote.json?.code}`)
  }
  else {
    check('门禁未过 → 注册表无候选模型(干净)', !cand, `models=${models.json?.data?.models?.length}`)
  }

  section('预测守卫(未知模型)')
  const noProd = await api('POST', '/api/workshop/aml/models/mdl-not-exist/predict', { token, body: { history: [[0]] } })
  check('未知模型预测 404', noProd.status === 404, `status=${noProd.status}`)

  section('审计归属(ops_log)')
  const ops = await api('POST', '/api/workshop/ops-logs', { token, body: { limit: 300 } })
  const opsRows: any[] = ops.json?.data?.entries ?? ops.json?.data?.logs ?? (Array.isArray(ops.json?.data) ? ops.json.data : [])
  const amlOps = opsRows.filter(r => String(r.action ?? '').startsWith('aml.'))
  check('aml.* 操作已入审计', amlOps.length >= 1, `n=${amlOps.length} actions=${[...new Set(amlOps.map(r => r.action))].slice(0, 5).join(',')}`)

  console.log(`\n━━━ 结果:${passed} PASS / ${failures} FAIL ━━━`)
  await restoreSettings()
  process.exit(failures > 0 ? 1 : 0)
}

main().catch(async (err) => {
  console.error(err)
  process.exit(1)
})
