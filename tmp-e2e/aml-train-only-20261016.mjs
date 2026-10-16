#!/usr/bin/env node
/** AML 数据集+真训练段(修正版:SP 也建镜像数采节点,批次期间双通道采样)。 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const BASE = 'http://127.0.0.1:3998'
const HOME_AML = 'D:/tmp/aw-aml/home/aml'
const TAG = `t${Date.now().toString(36).slice(-4)}`
process.env.NO_PROXY = '127.0.0.1,localhost'
let pass = 0
const fails = []
const ok = (n, c, d = '') => { if (c) { pass++; console.log(`  ✔ ${n}`) } else { fails.push(n); console.log(`  ✖ ${n}${d ? ` — ${String(d).slice(0, 220)}` : ''}`) } }
const sleep = ms => new Promise(r => setTimeout(r, ms))
async function api(method, path, body, token, timeoutMs = 120_000) {
  const r = await fetch(BASE + path, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) })
  return { status: r.status, ...(await r.json().catch(() => ({}))) }
}
const token = (await api('POST', '/api/users/login', { email: 'aml-aml7fib@awshop.local', password: 'Aml#2026Admin' })).data?.token
ok('S0 复用实例 admin 登录', Boolean(token))
const H = () => token

const lineId = (await api('POST', '/api/workshop/dcw/lines', { name: `训练线-${TAG}` }, H())).data?.line?.id
const productId = (await api('POST', '/api/workshop/dcw/products', { lineId, name: `产品-${TAG}` }, H())).data?.product?.id
const tplKey = (await api('POST', '/api/workshop/dcw/templates', { name: `SP-${TAG}`, ch: '烘干温度', unit: '℃', min: 0, max: 260, decimals: 1 }, H())).data?.template?.key
const dcwNodeId = (await api('POST', '/api/workshop/dcw', { templateRef: tplKey, name: `SP-${TAG}`, driver: 'modbus-tcp', lineId, stepLimit: 60, driverConfig: { host: '127.0.0.1', port: 15041, unitId: 1, register: 40021, dataType: 'float32', byteOrder: 'big' } }, H())).data?.node?.id
const recipeId = (await api('POST', '/api/workshop/dcw/recipes', { productId, name: `配方-${TAG}`, params: [{ nodeId: dcwNodeId, value: 150, min: 40, max: 220 }] }, H())).data?.recipe?.id
// 双镜像数采:PV(40001 target) + SP(40021 control) —— 数据集节点必须是数采节点
const pvDaq = (await api('POST', '/api/workshop/daq', { templateRef: 'daq-temp-tc', name: `PV-${TAG}`, driver: 'modbus-tcp', lineId, intervalMs: 1000, driverConfig: { host: '127.0.0.1', port: 15041, unitId: 1, register: 40001, registerType: 'holding', dataType: 'float32', byteOrder: 'big' } }, H())).data?.node?.id
const spDaq = (await api('POST', '/api/workshop/daq', { templateRef: 'daq-temp-tc', name: `SP镜像-${TAG}`, driver: 'modbus-tcp', lineId, intervalMs: 1000, driverConfig: { host: '127.0.0.1', port: 15041, unitId: 1, register: 40021, registerType: 'holding', dataType: 'float32', byteOrder: 'big' } }, H())).data?.node?.id
await api('POST', '/api/workshop/daq/controller', { action: 'start' }, H())
const ls = await api('POST', `/api/workshop/dcw/lines/${lineId}/start`, { recipeId }, H())
ok('S1 建线+双镜像(SP/PV)+开跑', ls.status === 200 && Boolean(pvDaq && spDaq), ls.message ?? '')
// 三个批次 + 批内阶跃(富动态信号过 G1;3 批满足 byRun val/test 与门禁 G4)
const SP_STEPS = [165, 165, 165] // 三批同剖面(150→165):val/test 同分布,泛化门(G3)可比
for (let b = 1; b <= 3; b++) {
  if (b > 1) {
    await sleep(70_000) // recipe 下发间隔门
    const ls2 = await api('POST', `/api/workshop/dcw/lines/${lineId}/start`, { recipeId }, H())
    ok(`S1b 第 ${b} 批开跑`, ls2.status === 200, ls2.message ?? '')
  }
  else {
    // 首批起始 SP 设为本批基准
    await sleep(5000)
  }
  console.log('  · 第 ' + b + ' 批采样 6 分钟(同剖面 150→165)…')
  for (let i = 0; i < 6; i++) { await sleep(30_000) }
  // 批内阶跃:半程 +15℃(写控门 60s,距开跑已 3 分钟无冲突)
  const w = await api('POST', `/api/workshop/dcw/${dcwNodeId}/write`, { value: SP_STEPS[b - 1], hypothesis: `AML 数据集富动态信号(批次${b}阶跃)` }, H())
  console.log(`    · 批${b}阶跃 → ${SP_STEPS[b - 1]}℃: ${w.status === 200 ? 'ok' : JSON.stringify(w).slice(0, 120)}`)
  for (let i = 0; i < 6; i++) { await sleep(30_000) }
  ok(`S2 第 ${b} 批停线闭合`, (await api('POST', `/api/workshop/dcw/lines/${lineId}/stop`, {}, H())).status === 200)
  await sleep(3000)
}

const code = readFileSync('server/services/workshop/aml/python/train-example.py', 'utf8')
const ds = await api('POST', '/api/workshop/aml/datasets', {
  lineId, productId, recipeId,
  nodes: [{ nodeId: spDaq, role: 'control' }, { nodeId: pvDaq, role: 'target' }],
  beatMs: 1000, window: { historySteps: 10, horizonSteps: 2 },
  cleaning: { hampelK: 3, maxInterpMs: 5000 },
  split: { valRatio: 0.2, testRatio: 0.1, seed: 42 },
  purpose: 'mpc_surrogate',
}, H())
const dsId = ds.data?.dataset?.id
ok('T1 数据集构建就绪(双通道·真实批次)', ds.status === 200 && Boolean(dsId) && (ds.data?.dataset?.rowCount ?? 0) > 50, `rows=${ds.data?.dataset?.rowCount} ${JSON.stringify(ds).slice(0, 180)}`)
if (dsId) {
  console.log(`  · dataset=${dsId} rows=${ds.data.dataset.rowCount} runs=${ds.data.dataset.runIds?.length}`)
  const job = await api('POST', '/api/workshop/aml/jobs', { datasetId: dsId, purpose: 'mpc_surrogate', code, params: { epochs: 300, hidden: 128, lr: 0.005, batch: 128 }, modelName: `训练模型-${TAG}` }, H())
  const jobId = job.data?.job?.id ?? job.data?.id
  ok('T2 训练作业受理', job.status === 200 && Boolean(jobId), JSON.stringify(job).slice(0, 200))
  let jd = null
  const t0 = Date.now()
  for (let i = 0; i < 90; i++) {
    await sleep(10_000)
    jd = (await api('GET', `/api/workshop/aml/jobs/${jobId}`, undefined, H())).data ?? {}
    const st = jd.job?.status ?? jd.status
    if (st === 'completed' || st === 'done' || st === 'failed' || st === 'cancelled') { console.log(`  · 作业 ${jobId} → ${st}(${Math.round((Date.now() - t0) / 1000)}s)`); break }
    if (i % 3 === 2) console.log(`    …[${Math.round((Date.now() - t0) / 1000)}s] ${st} ${jd.job?.progress ?? ''}`)
  }
  const final = jd?.job?.status ?? jd?.status
  ok('T3 训练到成功终态(completed/done)', final === 'completed' || final === 'done', JSON.stringify(jd).slice(0, 260))
  const candidates = [join(HOME_AML, 'jobs', jobId, 'artifacts', 'model.onnx'), `${HOME_AML}/jobs/${jobId}/artifacts/model.onnx`]
  const exists = candidates.some(c => existsSync(c))
  const hitPath = candidates.find(c => existsSync(c))
  if (hitPath) console.log(`  · model.onnx ${(statSync(hitPath).size / 1024).toFixed(1)}KB`)
  const models = await api('GET', '/api/workshop/aml/models', undefined, H())
  const hit = (models.data?.models ?? []).find(m => String(m.name ?? '').includes(TAG) || m.jobId === jobId)
  ok('T5 模型注册在册', Boolean(hit), JSON.stringify(models.data?.models?.slice(0, 1)).slice(0, 200))
  if (hit) console.log('  · 模型:', JSON.stringify(hit).slice(0, 240))
  if (jd?.job?.metrics || hit?.metrics) console.log('  · 指标:', JSON.stringify(jd?.job?.metrics ?? hit?.metrics).slice(0, 200))
}
console.log(`\n════ AML 训练段:${pass}/${pass + fails.length} ════`)
if (fails.length) { for (const f of fails) console.log('  ✖', f); process.exit(1) }
console.log('AML TRAIN OK')
