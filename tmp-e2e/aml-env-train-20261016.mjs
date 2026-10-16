#!/usr/bin/env node
/**
 * AML 环境供给 + 真训练验收 2026-10-16(全局 0.7.65 包 · 全新 home · 模拟无 uv 用户)。
 *   node tmp-e2e/aml-env-train-20261016.mjs
 *
 * ══ 验收标准(先行定义)══
 *  E1 无 uv 探测:全新环境 + PATH 剃掉 uv → env.uv.ok=false(前端「一键安装 uv」前置态)
 *  E2 一键安装 uv:POST /aml/env/uv → 轮询任务 → uv.ok=true 且路径落在 <amlRoot>/tools(私有,不写 PATH)
 *  E3 一键建 venv:POST /aml/env/venv → 轮询 → venv.ready=true(uv 供给 Python + requirements 依赖)
 *  E4 依赖真装:venv python 实跑 import numpy/pandas/sklearn/torch/onnx/onnxruntime/scipy 并打印版本
 *  D  数据:PLC 真连建线开跑→采样成批→停线闭合→数据集构建就绪(rowCount>50)
 *  T  真训练:内联参考训练器提交作业 → 作业到终态 completed → artifacts/model.onnx 落盘 → 模型注册在册
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import { spawnSync } from 'node:child_process'

const BASE = 'http://127.0.0.1:3998'
const HOME = 'D:/tmp/aw-aml/home'
const TAG = `aml${Date.now().toString(36).slice(-4)}`
process.env.NO_PROXY = '127.0.0.1,localhost'

let pass = 0
const fails = []
const ok = (n, c, d = '') => { if (c) { pass++; console.log(`  ✔ ${n}`) } else { fails.push(n); console.log(`  ✖ ${n}${d ? ` — ${String(d).slice(0, 220)}` : ''}`) } }
const sleep = ms => new Promise(r => setTimeout(r, ms))
async function api(method, path, body, token, timeoutMs = 120_000) {
  const r = await fetch(BASE + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  })
  return { status: r.status, ...(await r.json().catch(() => ({}))) }
}

/* 0. admin */
let token = (await api('POST', '/api/users/register', { name: 'aml-admin', email: `aml-${TAG}@awshop.local`, password: 'Aml#2026Admin' })).data?.token
ok('0.1 首注册即 admin(全新 home)', Boolean(token))
const H = () => token

/* E1 无 uv 探测 + 启动预热任务可见 */
const env0 = await api('GET', '/api/workshop/aml/env', undefined, H())
const st0 = env0.data ?? {}
console.log(`  · amlRoot=${st0.amlRoot} | uv=${JSON.stringify(st0.uv)} | python=${JSON.stringify(st0.python)}`)
ok('E1 PATH 剃 uv → 探测为缺失(一键安装前置态)', st0.uv?.ok === false, JSON.stringify(st0.uv))
console.log(`  · python 探测: ${JSON.stringify(st0.python)}`)
{
  const t = st0.task
  ok('E1b 启动预热自动建环境任务在册(面板可见/可轮询)', t?.kind === 'create-venv', JSON.stringify(t)?.slice(0, 160))
}

/* E2 等待预热(回退路径)完成 → 一键安装 uv */
{
  // 预热(非 uv 回退路径:pip 装 torch 等,较慢)完成后,单任务锁才释放
  let st = st0
  const t0 = Date.now()
  for (let i = 0; i < 300; i++) {
    if (st.task && st.task.status !== 'running') break
    await sleep(6000)
    st = (await api('GET', '/api/workshop/aml/env', undefined, H())).data ?? {}
    if (i % 10 === 9) console.log(`    …预热[${Math.round((Date.now() - t0) / 1000)}s] ${(st.task?.log ?? []).slice(-1)[0] ?? ''}`.slice(0, 170))
  }
  console.log(`  · 预热任务终态: ${st.task?.status}(${st.task?.kind});日志尾:`, (st.task?.log ?? []).slice(-3).join(' | ').slice(0, 240))
  ok('E2a 预热完成(回退路径供给出基线环境)', st.task?.status === 'done', JSON.stringify(st.task)?.slice(0, 200))
  ok('E2b 预热后 venv 就绪(无需人工干预即可用)', st.venv?.ready === true, JSON.stringify(st.venv))
}

{
  const post = await api('POST', '/api/workshop/aml/env/uv', {}, H())
  ok('E2c 一键安装 uv 任务受理', post.status === 200 && Boolean(post.data), JSON.stringify(post).slice(0, 160))
  let st = null
  const t0 = Date.now()
  for (let i = 0; i < 80; i++) {
    await sleep(5000)
    const g = await api('GET', '/api/workshop/aml/env', undefined, H())
    st = g.data ?? {}
    const task = st.task
    if (task && task.status !== 'running') {
      console.log(`  · 任务 ${task.kind} → ${task.status}(日志尾):`, (task.log ?? []).slice(-3).join(' | ').slice(0, 200))
      break
    }
    if (i % 4 === 3) console.log(`    …[${Math.round((Date.now() - t0) / 1000)}s] task=${task?.status} ${(task?.log ?? []).slice(-1)[0] ?? ''}`.slice(0, 160))
  }
  ok('E2d uv 安装完成且探测转 ok', st?.uv?.ok === true, JSON.stringify(st?.uv))
  const uvPath = String(st?.uv?.path ?? '')
  ok('E2e uv 落在私有 tools 目录(不写 PATH/免管理员)', uvPath.replace(/\\/g, '/').includes('/aml/tools/'), uvPath)
  console.log(`  · uv ${st?.uv?.version} @ ${uvPath} (source=${st?.uv?.source})`)
}

/* E3 一键重建 venv(uv 供给路径) */
{
  const post = await api('POST', '/api/workshop/aml/env/venv', { force: true }, H())
  ok('E3a 重建 venv(force)任务受理', post.status === 200 && Boolean(post.data), JSON.stringify(post).slice(0, 160))
  let st = null
  const t0 = Date.now()
  for (let i = 0; i < 240; i++) {
    await sleep(5000)
    const g = await api('GET', '/api/workshop/aml/env', undefined, H())
    st = g.data ?? {}
    const task = st.task
    if (task && task.status !== 'running') {
      console.log(`  · 任务 ${task.kind} → ${task.status}(日志尾):`, (task.log ?? []).slice(-4).join(' | ').slice(0, 260))
      break
    }
    if (i % 6 === 5) console.log(`    …[${Math.round((Date.now() - t0) / 1000)}s] ${(task?.log ?? []).slice(-1)[0] ?? ''}`.slice(0, 170))
  }
  ok('E3b uv 重建 venv 就绪(依赖安装完成)', st?.venv?.ready === true, JSON.stringify(st?.venv))
  const usedUv = (st?.task?.log ?? []).some(l => l.includes('使用 uv'))
  ok('E3c 重建日志确认走 uv 供给', usedUv, (st?.task?.log ?? []).slice(0, 6).join(' | ').slice(0, 200))
  console.log(`  · venv python=${st?.venv?.pythonPath} | size=${st?.venv?.sizeMb}MB`)
  const venvPy = String(st?.venv?.pythonPath ?? '')
  ok('E3d venv python 路径存在', Boolean(venvPy) && existsSync(venvPy), venvPy)

  /* E4 依赖真装(实跑 import) */
  if (venvPy && existsSync(venvPy)) {
    const probe = spawnSync(venvPy, ['-c', 'import numpy,pandas,sklearn,torch,onnx,onnxruntime,scipy;print(\'numpy\',numpy.__version__);print(\'pandas\',pandas.__version__);print(\'sklearn\',sklearn.__version__);print(\'torch\',torch.__version__);print(\'onnx\',onnx.__version__);print(\'onnxruntime\',onnxruntime.__version__);print(\'scipy\',scipy.__version__)'], { encoding: 'utf8', timeout: 300_000 })
    const out = `${probe.stdout ?? ''}${probe.stderr ?? ''}`
    const vers = (out.match(/(numpy|pandas|sklearn|torch|onnx|onnxruntime|scipy) [\d.]+/g) ?? [])
    ok('E4 七大依赖实跑 import 通过并出版本', probe.status === 0 && vers.length >= 7, out.slice(-260))
    console.log('  · 依赖版本:', vers.join(' | '))
  }
}

/* D 数据:PLC 真连建线→采样成批→闭合 */
console.log('\n[D] 数据链路(PLC)')
const lineId = (await api('POST', '/api/workshop/dcw/lines', { name: `AML产线-${TAG}` }, H())).data?.line?.id
const productId = (await api('POST', '/api/workshop/dcw/products', { lineId, name: `AML产品-${TAG}` }, H())).data?.product?.id
const tplKey = (await api('POST', '/api/workshop/dcw/templates', { name: `SP-${TAG}`, ch: '烘干温度', unit: '℃', min: 0, max: 260, decimals: 1 }, H())).data?.template?.key
const dcwNodeId = (await api('POST', '/api/workshop/dcw', { templateRef: tplKey, name: `SP-${TAG}`, driver: 'modbus-tcp', lineId, stepLimit: 60, driverConfig: { host: '127.0.0.1', port: 15041, unitId: 1, register: 40021, dataType: 'float32', byteOrder: 'big' } }, H())).data?.node?.id
const recipeId = (await api('POST', '/api/workshop/dcw/recipes', { productId, name: `AML配方-${TAG}`, params: [{ nodeId: dcwNodeId, value: 150, min: 40, max: 220 }] }, H())).data?.recipe?.id
const daqNodeId = (await api('POST', '/api/workshop/daq', { templateRef: 'daq-temp-tc', name: `PV-${TAG}`, driver: 'modbus-tcp', lineId, intervalMs: 1000, driverConfig: { host: '127.0.0.1', port: 15041, unitId: 1, register: 40001, registerType: 'holding', dataType: 'float32', byteOrder: 'big' } }, H())).data?.node?.id
await api('POST', '/api/workshop/daq/controller', { action: 'start' }, H())
const ls = await api('POST', `/api/workshop/dcw/lines/${lineId}/start`, { recipeId }, H())
ok('D1 建线/开跑(SP=150)', ls.status === 200 && Boolean(daqNodeId), ls.message ?? '')
console.log('  · 采样 6 分钟攒批次(≥300s 门槛)…')
for (let i = 0; i < 12; i++) {
  await sleep(30_000)
  if (i % 4 === 3) console.log(`    …[${(i + 1) * 30}s]`)
}
const stop = await api('POST', `/api/workshop/dcw/lines/${lineId}/stop`, {}, H())
ok('D2 停线闭合批次', stop.status === 200, JSON.stringify(stop).slice(0, 100))
await sleep(3000)

/* T 真训练 */
console.log('\n[T] 模型训练(venv 实跑 → ONNX)')
{
  const code = readFileSync('server/services/workshop/aml/python/train-example.py', 'utf8')
  const ds = await api('POST', '/api/workshop/aml/datasets', {
    lineId, productId, recipeId,
    nodes: [
      { nodeId: dcwNodeId, role: 'control' },
      { nodeId: daqNodeId, role: 'target' },
    ],
    beatMs: 1000,
    window: { historySteps: 10, horizonSteps: 2 },
    cleaning: { hampelK: 3, maxInterpMs: 5000 },
    split: { valRatio: 0.2, testRatio: 0.1, seed: 42 },
    purpose: 'mpc_surrogate',
  }, H())
  const dsId = ds.data?.dataset?.id
  ok('T1 数据集构建就绪', ds.status === 200 && Boolean(dsId) && (ds.data?.dataset?.rowCount ?? 0) > 50,
    `rows=${ds.data?.dataset?.rowCount} ${JSON.stringify(ds).slice(0, 160)}`)
  if (!dsId) { console.log('  数据集构建失败,终止训练段') }
  else {
    console.log(`  · dataset=${dsId} rows=${ds.data.dataset.rowCount} runs=${ds.data.dataset.runIds?.length}`)
    const job = await api('POST', '/api/workshop/aml/jobs', {
      datasetId: dsId,
      purpose: 'mpc_surrogate',
      code,
      params: { epochs: 60, hidden: 64, lr: 0.002, batch: 128 },
      modelName: `AML验收模型-${TAG}`,
    }, H())
    const jobId = job.data?.job?.id ?? job.data?.id
    ok('T2 训练作业受理', job.status === 200 && Boolean(jobId), JSON.stringify(job).slice(0, 200))
    let jd = null
    const t0 = Date.now()
    for (let i = 0; i < 120; i++) {
      await sleep(10_000)
      const g = await api('GET', `/api/workshop/aml/jobs/${jobId}`, undefined, H())
      jd = g.data ?? {}
      const st = jd.job?.status ?? jd.status
      if (st === 'completed' || st === 'done' || st === 'failed' || st === 'cancelled') {
        console.log(`  · 作业 ${jobId} → ${st}(用时 ${Math.round((Date.now() - t0) / 1000)}s)`)
        break
      }
      if (i % 3 === 2) console.log(`    …[${Math.round((Date.now() - t0) / 1000)}s] ${st}${jd.job?.progress != null ? ` ${jd.job.progress}%` : ''}`)
    }
    const final = jd?.job?.status ?? jd?.status
    ok('T3 训练到 completed 终态', final === 'completed', JSON.stringify(jd).slice(0, 260))
    // 产物核对:model.onnx
    const amlRoot = st0.amlRoot
    const onnx = `${amlRoot}/jobs/${jobId}/artifacts/model.onnx`
    const onnxWin = onnx.replace(/\//g, '\\')
    const exists = existsSync(onnx) || existsSync(onnxWin)
    ok('T4 artifacts/model.onnx 落盘', exists, onnx)
    if (exists) console.log(`  · model.onnx ${(statSync(existsSync(onnx) ? onnx : onnxWin).size / 1024).toFixed(1)}KB`)
    // 模型注册
    const models = await api('GET', '/api/workshop/aml/models', undefined, H())
    const list = models.data?.models ?? []
    const hit = list.find(m => String(m.name ?? '').includes(TAG) || m.jobId === jobId)
    ok('T5 模型注册在册(含指标)', Boolean(hit), JSON.stringify(list.slice(0, 2)).slice(0, 200))
    if (hit) console.log('  · 模型:', JSON.stringify({ id: hit.id, name: hit.name, status: hit.status }).slice(0, 160))
  }
}

console.log(`\n════ AML 环境+训练验收:${pass}/${pass + fails.length} 通过 ════`)
if (fails.length) { console.log('未通过:'); for (const f of fails) console.log('  ✖', f); process.exit(1) }
console.log('AML ENV+TRAIN OK')
