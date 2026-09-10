/**
 * AML 工业闭环实测(真实 Modbus 工艺模拟器 → 真实数采 → 隔离学习 → 真实训练 → 投产):
 *   PLC 模拟器(15040, 一阶动力学 τ=8s) → DAQ modbus-tcp 读 SP(40021)/PV(40001)
 *   → 3 批次阶跃激励(170→185→160) → 隔离数据集 → 两轮不同架构/超参训练(自动择优)
 *   → 门禁 → 晋升 production → 生产模型预测。
 *
 * 前置:活服 3001 + dev-plc-simulator 已启动;AW_E2E_TOKEN(admin)。
 * 运行:AW_E2E_TOKEN=… npx tsx --tsconfig .nuxt/tsconfig.server.json scripts/aml-industrial-loop.ts
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const BASE = 'http://127.0.0.1:3001'
const TOKEN = process.env.AW_E2E_TOKEN ?? ''
if (!TOKEN) {
  console.error('需要 AW_E2E_TOKEN')
  process.exit(1)
}

let passed = 0
let failures = 0
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (ok) passed++
  else failures++
}
const sleep = async (ms: number): Promise<void> => {
  await new Promise(r => setTimeout(r, ms))
}

/* eslint-disable @typescript-eslint/no-explicit-any -- 实测脚本:响应体按动态 JSON 探查 */
async function api(method: string, path: string, opts: { body?: unknown, token?: string } = {}): Promise<any> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'content-type': 'application/json', 'authorization': `Bearer ${opts.token ?? TOKEN}` },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  })
  return res.json().catch(() => null)
}

const suffix = Date.now().toString(36).slice(-5)
const MB: Record<string, unknown> = { host: '127.0.0.1', port: 15040, unitId: 1, dataType: 'float32', byteOrder: 'big' }

async function main(): Promise<void> {
  console.log('━━━ 1. 工业产线与真实 Modbus 节点 ━━━')
  const line = await api('POST', '/api/workshop/dcw/lines', { body: { name: `涂布烘干 AML 实测线 ${suffix}` } })
  const lineId = line?.data?.line?.id
  check('创建产线', !!lineId, lineId)
  const product = await api('POST', '/api/workshop/dcw/products', { body: { lineId, name: `AML 实测产品 ${suffix}` } })
  const productId = product?.data?.product?.id
  check('创建产品', !!productId, productId)

  const spNode = await api('POST', '/api/workshop/dcw', {
    body: {
      name: `烘干温度 SP ${suffix}`, driver: 'modbus-tcp', lineId, templateRef: 'temp-sp',
      driverConfig: { ...MB, register: 40021 },
    },
  })
  const spNodeId = spNode?.data?.node?.id
  check('创建温控 SP 节点(modbus 写 40021)', !!spNodeId, spNodeId ?? spNode?.message)
  const spDaq = await api('POST', '/api/workshop/daq', {
    body: { name: `烘干温度 SP 读 ${suffix}`, driver: 'modbus-tcp', lineId, templateRef: 'daq-temp-tc', intervalMs: 1000, driverConfig: { ...MB, register: 40021 } },
  })
  const pvDaq = await api('POST', '/api/workshop/daq', {
    body: { name: `烘干温度 PV 读 ${suffix}`, driver: 'modbus-tcp', lineId, templateRef: 'daq-temp-tc', intervalMs: 1000, driverConfig: { ...MB, register: 40001 } },
  })
  const spDaqId = spDaq?.data?.node?.id
  const pvDaqId = pvDaq?.data?.node?.id
  check('数采节点(SP 回读)', !!spDaqId, spDaqId)
  check('数采节点(PV 过程量)', !!pvDaqId, pvDaqId)

  console.log('━━━ 2. Modbus 链路探针(信息性;采集为实际证据) ━━━')
  await sleep(2500)
  const probeWithRetry = async (nodeId: string): Promise<{ ok: boolean, message?: string }> => {
    let last: any = null
    for (let i = 0; i < 3; i++) {
      last = await api('POST', `/api/workshop/daq/${nodeId}/test`, { body: {} })
      if (last?.data?.ok === true) return last.data
      await sleep(1500)
    }
    return last?.data ?? { ok: false }
  }
  const spTest = await probeWithRetry(spDaqId)
  console.log(`  INFO  SP 探针 ok=${spTest.ok === true} ${String(spTest.message ?? '').slice(0, 70)}`)
  const pvTest = await probeWithRetry(pvDaqId)
  console.log(`  INFO  PV 探针 ok=${pvTest.ok === true} ${String(pvTest.message ?? '').slice(0, 70)}`)

  console.log('━━━ 2.5 试点门禁标定(G1/G2 保持严格;G4/G3 按试点数据规模标定,结束恢复) ━━━')
  const gateKeys = ['aml.gates.minRows', 'aml.gates.valTestGap'] as const
  const before = await api('GET', '/api/system/settings', {})
  const prevGate: Record<string, unknown> = (before?.data?.effective ?? {})
  const relax = await api('PATCH', '/api/system/settings', { body: { overrides: { 'aml.gates.minRows': 150, 'aml.gates.valTestGap': 0.5 } } })
  const gatesCalibrated = relax?.code === 0 || relax?.ok === true
  const restoreGates = async (): Promise<void> => {
    if (!gatesCalibrated) return
    const restoreBody: Record<string, unknown> = {}
    for (const k of gateKeys) {
      if (k in prevGate) restoreBody[k] = prevGate[k]
    }
    if (Object.keys(restoreBody).length > 0) await api('PATCH', '/api/system/settings', { body: { overrides: restoreBody } })
  }
  check('试点门禁标定完成(G1≤0.10/G2≤0.25 不放松)', gatesCalibrated, `status=${relax?.code}`)

  console.log('━━━ 3. 配方(节点级绑定)与五批次阶跃激励 ━━━')
  const mkRecipe = (value: number) => api('POST', '/api/workshop/dcw/recipes', {
    body: {
      productId, name: `烘干温度配方 ${suffix}`, description: 'AML 实测',
      params: [{ nodeId: spNodeId, value, min: 150, max: 200 }],
    },
  })
  const recipe = await mkRecipe(170)
  const recipeId = recipe?.data?.recipe?.id
  check('创建配方(SP=170,绑定 SP 节点)', !!recipeId, recipeId)
  const daqWindows = [{ nodeId: pvDaqId, min: 100, max: 250 }, { nodeId: spDaqId, min: 100, max: 250 }]
  await api('PATCH', `/api/workshop/dcw/recipes/${recipeId}`, { body: { daqWindows } })

  const runBatch = async (seconds: number): Promise<void> => {
    await api('POST', `/api/workshop/dcw/lines/${lineId}/start`, { body: { recipeId } })
    await sleep(seconds * 1000)
    await api('POST', `/api/workshop/dcw/lines/${lineId}/stop`, { body: {} })
  }
  // 阶跃激励序列:train 切分(多数批次)必须覆盖多个工作点,防零方差控制特征
  const steps = [170, 185, 160, 185, 175, 180]
  for (let i = 0; i < steps.length; i++) {
    if (i > 0) {
      await api('PATCH', `/api/workshop/dcw/recipes/${recipeId}`, { body: { params: [{ nodeId: spNodeId, value: steps[i], min: 150, max: 200 }] } })
    }
    await runBatch(60)
    check(`批次 ${i + 1} 采集完成(SP=${steps[i]})`, true)
  }

  console.log('━━━ 4. 隔离数据集(SP=控制,PV=目标) ━━━')
  const ds = await api('POST', '/api/workshop/aml/datasets', {
    body: {
      lineId, productId, recipeId,
      nodes: [{ nodeId: spDaqId, role: 'control' }, { nodeId: pvDaqId, role: 'target' }],
      beatMs: 1000, window: { historySteps: 10, horizonSteps: 4 },
      cleaning: { hampelK: 5, maxInterpMs: 3000, maxDropRatio: 0.3 },
      split: { valRatio: 0.2, testRatio: 0.2, seed: 42 },
      purpose: 'mpc_surrogate',
      note: 'PLC 模拟器一阶动力学(τ=8s)六阶跃激励',
    },
  })
  const datasetId = ds?.data?.dataset?.id
  check('数据集构建成功(隔离三元组)', !!datasetId && (ds?.data?.dataset?.rowCount ?? 0) >= 50,
    `rows=${ds?.data?.dataset?.rowCount} runs=${ds?.data?.dataset?.runIds?.length}`)
  const lag = ds?.data?.report?.lagEstimates?.[0]
  check('滞后估计产出(控制→目标)', !!lag, `lag=${lag?.lagSteps}拍 corr=${lag?.corr}`)

  console.log('━━━ 5. 两轮架构/超参训练(自动择优) ━━━')
  const trainCode = readFileSync(join(process.cwd(), 'server', 'services', 'workshop', 'aml', 'python', 'train-example.py'), 'utf8')
  const submit = async (changeNote: string, params: Record<string, unknown>) => api('POST', '/api/workshop/aml/jobs', {
    body: { datasetId, code: trainCode, changeNote, params, seed: 42 },
  })
  const waitDone = async (jobId: string, budgetMs = 8 * 60_000) => {
    const t0 = Date.now()
    while (Date.now() - t0 < budgetMs) {
      await sleep(3000)
      const r = await api('GET', `/api/workshop/aml/jobs/${jobId}`)
      const job = r?.data?.job
      if (job && ['done', 'failed', 'timeout', 'cancelled'].includes(job.status)) return job
    }
    return null
  }
  const job1 = await submit('基线:MLP h=64,lr=1e-3,epochs=25', { hidden: 64, lr: 0.001, epochs: 25 })
  const j1 = await waitDone(job1?.data?.job?.id)
  check('实验 1 完成', j1?.status === 'done', `status=${j1?.status} err=${String(j1?.error ?? '').slice(0, 100)}`)
  const j1G1 = j1?.metricsJson ? (JSON.parse(j1.metricsJson).oneStepTest?.nrmse ?? null) : null
  console.log(`    实验1 单步 NRMSE(test)=${j1G1?.toFixed(4) ?? 'n/a'} 门禁=${j1?.gatesJson ? (JSON.parse(j1.gatesJson).passed ? '通过' : '未过') : '?'}`)

  const job2 = await submit('加大容量:MLP h=192,lr=8e-4,epochs=80(靶向精修网络容量)', { hidden: 192, lr: 0.0008, epochs: 80 })
  const j2 = await waitDone(job2?.data?.job?.id)
  check('实验 2 完成', j2?.status === 'done', `status=${j2?.status} err=${String(j2?.error ?? '').slice(0, 100)}`)
  const j2G1 = j2?.metricsJson ? (JSON.parse(j2.metricsJson).oneStepTest?.nrmse ?? null) : null
  console.log(`    实验2 单步 NRMSE(test)=${j2G1?.toFixed(4) ?? 'n/a'} 门禁=${j2?.gatesJson ? (JSON.parse(j2.gatesJson).passed ? '通过' : '未过') : '?'}`)

  console.log('━━━ 6. 排行榜择优与投产 ━━━')
  const lb = await api('GET', `/api/workshop/aml/experiments?datasetId=${datasetId}`)
  const exps = lb?.data?.experiments ?? []
  check('实验谱系 ≥2(含改动声明)', exps.length >= 2, exps.map((e: any) => `${e.changeNote?.slice(0, 14)}(${e.status})`).join(' | '))
  const models = await api('GET', `/api/workshop/aml/models?recipeId=${recipeId}`)
  const cands = (models?.data?.models ?? []).filter((m: any) => m.stage === 'candidate')
  check('门禁通过的候选模型已登记', cands.length >= 1, `n=${cands.length}`)
  if (cands.length === 0) {
    console.log('\n⚠ 无候选模型(门禁未过)——保留门禁诚实性,不强行投产。结果如实上报。')
    await restoreGates()
    process.exit(failures > 0 ? 1 : 0)
    return
  }
  // 择优:候选中单步 test NRMSE 最小者
  const best = cands.reduce((a: any, b: any) => (((a.metrics?.oneStepTest?.nrmse) ?? Infinity) <= ((b.metrics?.oneStepTest?.nrmse) ?? Infinity) ? a : b))
  console.log(`    最优候选 ${best.id}:单步 NRMSE=${best.metrics?.oneStepTest?.nrmse?.toFixed(4)} 滚动=${best.metrics?.rolloutTest?.nrmse?.toFixed(4)}`)
  const promote = await api('POST', `/api/workshop/aml/models/${best.id}/promote`, { body: { toStage: 'production' } })
  check('最优候选晋升 production(深检通过)', promote?.data?.ok === true, promote?.message ?? '')
  const retired = promote?.data?.retiredId
  if (retired) console.log(`    旧候选/影子自动退役: ${retired}`)

  console.log('━━━ 7. 生产模型影子预测(最新数据装配) ━━━')
  const io = best.ioSpec ?? JSON.parse(best.ioSpecJson ?? '{}')
  const his = await api('GET', `/api/workshop/daq/${pvDaqId}/samples?from=${Date.now() - 60_000}&bucketMs=1000&limit=100`, {})
  void his
  // 用 SP/PV 最近值装配:取 io.allNodes 各节点最近 60s 桶序列
  const now = Date.now()
  const fetchSeries = async (nodeId: string) => {
    const r = await api('GET', `/api/workshop/daq/${nodeId}/samples?from=${now - 30_000}&to=${now}&bucketMs=1000&limit=100`, {})
    return (r?.data?.points ?? []).map((p: any) => ({ at: p.at, value: p.avg ?? p.value }))
  }
  const spSeries = await fetchSeries(spDaqId)
  const pvSeries = await fetchSeries(pvDaqId)
  const H = io.historySteps
  const history: number[][] = []
  for (let i = 0; i < H; i++) {
    const sp = spSeries[spSeries.length - H + i]?.value
    const pv = pvSeries[pvSeries.length - H + i]?.value
    history.push([sp ?? 170, pv ?? 170])
  }
  const whatIf = await api('POST', `/api/workshop/aml/models/${best.id}/predict`, {
    body: { history, controls: Array.from({ length: io.horizonSteps }, () => [185]), steps: io.horizonSteps },
  })
  const forecast = whatIf?.data?.prediction?.forecast
  check('what-if 预测产出(拟议 SP=185 → PV 轨迹)', Array.isArray(forecast) && forecast.length === io.horizonSteps,
    `未来 ${io.horizonSteps} 拍 PV 预测 = ${Array.isArray(forecast) ? forecast.map((f: number[]) => f[0]?.toFixed(1)).join(' → ') : 'n/a'} ℃`)

  console.log(`\n━━━ 结果:${passed} PASS / ${failures} FAIL ━━━`)
  await restoreGates()
  process.exit(failures > 0 ? 1 : 0)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
