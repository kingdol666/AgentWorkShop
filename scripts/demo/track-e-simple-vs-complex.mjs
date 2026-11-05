#!/usr/bin/env node
/**
 * Track E：端到端对比实测 —— 简单任务（单 Channel）vs 复杂任务（多 Channel 协同，菱形 DAG）。
 *
 * 场景 S（简单）：1 频道 / 1 交付物 / 1 工作项（无依赖）→ tick 自动派发 → 完成 → 成果链 → 完成门禁。
 * 场景 C（复杂）：3 频道（前端 A / 后端 B / 测试 C）/ 4 工作项，W4 dependsOn=[W2,W3] 菱形汇合：
 *   W1(A) → {W2(B), W3(A)} → W4(C)。关键机制断言：仅完成 W2 时 W4 必须保持 DRAFT（多依赖门），
 *   W2+W3 全部终态后才派发 W4（此前所有演示均为线性链，菱形汇合为首测）。
 *
 * 运行：node scripts/demo/track-e-simple-vs-complex.mjs
 */
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync, openSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const ROOT = join(tmpdir(), `aw-track-e-${Date.now().toString(36)}`)
mkdirSync(join(ROOT, 'home'), { recursive: true })
const EVID = join(REPO, 'docs/audit/evidence/2026-11-05-route-demo')
mkdirSync(EVID, { recursive: true })

const results = []
const ok = (id, name, cond, detail = '') => {
  results.push({ id, name, pass: Boolean(cond), detail: String(detail).slice(0, 400) })
  console.log(`${cond ? '✔' : '✖'} [${id}] ${name}${cond ? '' : ` — ${String(detail).slice(0, 300)}`}`)
}
const sleep = ms => new Promise(r => setTimeout(r, ms))

let port = 0
for (const p of [3952, 3951, 3950]) {
  try {
    const r = await fetch(`http://127.0.0.1:${p}/api/health`, { signal: AbortSignal.timeout(1200) })
    if (r.ok) continue
  }
  catch { /* free */ }
  port = p
  break
}
if (!port) throw new Error('无空闲端口')
const BASE = `http://127.0.0.1:${port}`
process.env.AW_BASE = BASE
process.env.NO_PROXY = '127.0.0.1,localhost'
const logFd = openSync(join(ROOT, 'server.log'), 'a')
const child = spawn(process.execPath, [join(REPO, '.output/server/index.mjs')], {
  cwd: REPO,
  env: {
    ...process.env,
    PORT: String(port),
    NITRO_PORT: String(port),
    AW_MODE: 'home',
    AW_HOME: join(ROOT, 'home'),
    NUXT_SESSION_PASSWORD: 'TrackE#2026-simple-vs-complex-32chars-key',
    AW_RATE_LIMIT_OFF: '1',
    NO_PROXY: '127.0.0.1,localhost',
  },
  stdio: ['ignore', logFd, logFd],
  windowsHide: true,
})

async function api(method, path, body, token, timeoutMs = 120_000) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  })
  let json = null
  try {
    json = await res.json()
  }
  catch { /* non-json */ }
  return { status: res.status, ...json }
}

try {
  let healthy = false
  for (let i = 0; i < 60; i++) {
    await sleep(1000)
    try {
      const h = await api('GET', '/api/health', undefined, undefined, 3000)
      if (h.data?.status === 'ok' && h.data?.workshop === 'ready') {
        healthy = true
        break
      }
    }
    catch { /* wait */ }
  }
  ok('E0', '隔离实例启动', healthy, `port=${port}`)
  if (!healthy) throw new Error('server not ready')

  const reg = await api('POST', '/api/users/register', { name: 'tracke', email: 'te@awshop.local', password: 'TrackE#2026' })
  const H = () => reg.data?.token

  const mkChannel = async (name, lead) => (await api('POST', '/api/workshop/channels', { name, leadAgent: { name: lead, harness: 'mock' } }, H())).data
  const tokOf = async ch => (await api('POST', `/api/workshop/channels/${ch.channelId}/agents/${ch.leadAgentId}/rotate-token`, {}, H())).data?.token
  const autosOf = async pid => ((await api('GET', `/api/workshop/projects/${pid}/events?limit=100`, undefined, H())).data ?? [])
    .filter(e => e.type === 'work.dispatch_auto')
    .map((e) => {
      try {
        return JSON.parse(e.payloadJson)?.workItemId
      }
      catch { return '' }
    })
  const stateOf = async (pid, wiId) => (((await api('GET', `/api/workshop/projects/${pid}/work-items`, undefined, H())).data ?? []).find(w => w.id === wiId))?.state

  const chainResults = async (pid, channels) => {
    await api('POST', `/api/workshop/projects/${pid}/reconcile`, {}, H())
    const drafts = (await api('GET', `/api/workshop/projects/${pid}/results`, undefined, H())).data ?? []
    for (const d of drafts.filter(x => x.status === 'draft')) {
      // 成果草稿必须先由所属频道 lead 提交（project_submit_result）才能进入复核/验收
      const ch = channels.find(c => c.channelId === d.channelId)
      await api('POST', '/api/workshop/agent-tools/invoke', {
        agentId: ch.leadAgentId, tool: 'project_submit_result', args: { result_id: d.id, summary: 'track-e 交付' },
      }, H())
      await api('POST', `/api/workshop/projects/${pid}/results/${d.id}/review`, { decision: 'reviewed' }, H())
      const acc = (await api('POST', `/api/workshop/projects/${pid}/results/${d.id}/request-acceptance`, {}, H())).data
      await api('POST', `/api/workshop/projects/${pid}/approvals/${acc.id}/decide`, { approve: true, reason: 'track-e' }, H())
    }
    const completeReq = (await api('POST', `/api/workshop/projects/${pid}/complete`, {}, H())).data
    if (completeReq?.id) {
      await api('POST', `/api/workshop/projects/${pid}/approvals/${completeReq.id}/decide`, { approve: true }, H())
    }
    return (await api('GET', `/api/workshop/projects/${pid}`, undefined, H())).data?.status
  }

  // ═══ 场景 S：简单任务（单 Channel）═══
  const sStart = Date.now()
  const sProj = (await api('POST', '/api/workshop/projects', {
    name: '简单任务 · 单频道修复文档', objective: '单个频道独立完成', successCriteria: ['交付文档'], leaderHarness: 'mock', autoDispatch: true,
  }, H())).data
  const sCh = await mkChannel('单频道 · 文档组', 'Doc Lead')
  await api('POST', `/api/workshop/projects/${sProj.id}/channels`, { channelId: sCh.channelId, charter: '文档修复' }, H())
  const sD = (await api('POST', `/api/workshop/projects/${sProj.id}/deliverables`, { name: '修复文档', ownerChannelId: sCh.channelId, required: true }, H())).data
  await api('POST', `/api/workshop/projects/${sProj.id}/activate`, {}, H())
  const sPlan = (await api('POST', `/api/workshop/projects/${sProj.id}/plan/request-approval`, { version: 1, plan: { facts: ['单工作项'] } }, H())).data
  await api('POST', `/api/workshop/projects/${sProj.id}/approvals/${sPlan.id}/decide`, { approve: true }, H())
  const sW = (await api('POST', `/api/workshop/projects/${sProj.id}/work-items`, {
    deliverableId: sD.id, channelId: sCh.channelId, title: 'S-W1 修复 API 文档', brief: '修正过时段落', execBudgetMinutes: 20, dedupeKey: 'te-s1',
  }, H())).data
  sCh.token = await tokOf(sCh)
  await api('POST', `/api/workshop/projects/${sProj.id}/kernel/tick`, {}, H())
  const sTasks = (await api('GET', `/api/workshop/channels/${sCh.channelId}/tasks`, undefined, H())).data ?? []
  const sRoot = sTasks.find(t => t.projectWorkItemId === sW.id)
  ok('ES1', '简单任务：单频道 W1 自动派发（无其他频道干扰）', (await stateOf(sProj.id, sW.id)) === 'DISPATCHED' && Boolean(sRoot), `state=${await stateOf(sProj.id, sW.id)}`)
  await api('POST', `/api/workshop/tasks/${sRoot.id}/complete`, { artifacts: [{ artifactId: 'te-doc', name: 'fixed-doc.md', parts: [{ text: '修复内容' }] }] }, sCh.token)
  await api('POST', `/api/workshop/projects/${sProj.id}/kernel/tick`, {}, H())
  const sAutos = await autosOf(sProj.id)
  ok('ES2', '简单任务：恰好 1 次 dispatch_auto 且为 W1', sAutos.length === 1 && sAutos[0] === sW.id, `autos=${JSON.stringify(sAutos)}`)
  const sStatus = await chainResults(sProj.id, [sCh])
  ok('ES3', '简单任务：成果链 + 完成门禁 → completed', sStatus === 'completed', `status=${sStatus}`)
  const sMs = Date.now() - sStart

  // ═══ 场景 C：复杂任务（3 频道菱形 DAG）═══
  const cStart = Date.now()
  const cProj = (await api('POST', '/api/workshop/projects', {
    name: '复杂任务 · 三频道菱形协同', objective: '前端/后端/测试三频道菱形汇合交付', successCriteria: ['契约先行', '双实现齐备后测试'], leaderHarness: 'mock', autoDispatch: true,
  }, H())).data
  const fe = await mkChannel('前端频道', 'FE Lead')
  const be = await mkChannel('后端频道', 'BE Lead')
  const qa = await mkChannel('测试频道', 'QA Lead')
  for (const [ch, charter] of [[fe, '前端实现'], [be, '后端实现'], [qa, '集成测试']]) {
    await api('POST', `/api/workshop/projects/${cProj.id}/channels`, { channelId: ch.channelId, charter }, H())
  }
  const dFE = (await api('POST', `/api/workshop/projects/${cProj.id}/deliverables`, { name: '前端交付', ownerChannelId: fe.channelId, required: true }, H())).data
  const dBE = (await api('POST', `/api/workshop/projects/${cProj.id}/deliverables`, { name: '后端交付', ownerChannelId: be.channelId, required: true }, H())).data
  const dQA = (await api('POST', `/api/workshop/projects/${cProj.id}/deliverables`, { name: '集成测试报告', ownerChannelId: qa.channelId, required: true }, H())).data
  await api('POST', `/api/workshop/projects/${cProj.id}/activate`, {}, H())
  const cPlan = (await api('POST', `/api/workshop/projects/${cProj.id}/plan/request-approval`, { version: 1, plan: { facts: ['菱形 DAG: W1→{W2,W3}→W4'] } }, H())).data
  await api('POST', `/api/workshop/projects/${cProj.id}/approvals/${cPlan.id}/decide`, { approve: true }, H())
  const w1 = (await api('POST', `/api/workshop/projects/${cProj.id}/work-items`, { deliverableId: dFE.id, channelId: fe.channelId, title: 'C-W1 契约定义', brief: '接口契约', execBudgetMinutes: 20, dedupeKey: 'te-c1' }, H())).data
  const w2 = (await api('POST', `/api/workshop/projects/${cProj.id}/work-items`, { deliverableId: dBE.id, channelId: be.channelId, title: 'C-W2 后端实现', brief: '按契约实现', execBudgetMinutes: 30, dependsOn: [w1.id], dedupeKey: 'te-c2' }, H())).data
  const w3 = (await api('POST', `/api/workshop/projects/${cProj.id}/work-items`, { deliverableId: dFE.id, channelId: fe.channelId, title: 'C-W3 前端实现', brief: '按契约实现', execBudgetMinutes: 30, dependsOn: [w1.id], dedupeKey: 'te-c3' }, H())).data
  const w4 = (await api('POST', `/api/workshop/projects/${cProj.id}/work-items`, { deliverableId: dQA.id, channelId: qa.channelId, title: 'C-W4 集成测试', brief: '双实现齐备后测试', execBudgetMinutes: 30, dependsOn: [w2.id, w3.id], dedupeKey: 'te-c4' }, H())).data
  for (const ch of [fe, be, qa]) ch.token = await tokOf(ch)

  await api('POST', `/api/workshop/projects/${cProj.id}/kernel/tick`, {}, H())
  ok('EC1', '复杂任务：W1 自动派发进前端频道，W4 未派发（依赖门）', (await stateOf(cProj.id, w1.id)) === 'DISPATCHED' && (await stateOf(cProj.id, w4.id)) === 'DRAFT', `w1=${await stateOf(cProj.id, w1.id)} w4=${await stateOf(cProj.id, w4.id)}`)

  const rootIn = async (ch, wiId) => (((await api('GET', `/api/workshop/channels/${ch.channelId}/tasks`, undefined, H())).data ?? [])
    .filter(t => t.projectWorkItemId === wiId).sort((a, b) => (b.projectAttemptNo ?? 0) - (a.projectAttemptNo ?? 0))[0])
  const finish = async (ch, wiId) => {
    const root = await rootIn(ch, wiId)
    await api('POST', `/api/workshop/tasks/${root.id}/complete`, { artifacts: [{ artifactId: `te-${wiId.slice(0, 6)}`, name: 'delivery.md', parts: [{ text: '交付' }] }] }, ch.token)
  }

  await finish(fe, w1.id)
  await api('POST', `/api/workshop/projects/${cProj.id}/kernel/tick`, {}, H())
  const w2s = await stateOf(cProj.id, w2.id)
  const w3s = await stateOf(cProj.id, w3.id)
  const w4afterW1 = await stateOf(cProj.id, w4.id)
  ok('EC2', 'W1 完成回调 → W2(后端B) 与 W3(前端A) 同时就绪派发（并行就绪集）', ['DISPATCHED', 'COMPLETED'].includes(w2s) && ['DISPATCHED', 'COMPLETED'].includes(w3s) && w4afterW1 === 'DRAFT', `w2=${w2s} w3=${w3s} w4=${w4afterW1}`)

  await finish(be, w2.id)
  await api('POST', `/api/workshop/projects/${cProj.id}/kernel/tick`, {}, H())
  const w4afterW2 = await stateOf(cProj.id, w4.id)
  ok('EC3', '菱形门：仅完成 W2（W3 未完成）→ W4 保持 DRAFT（多依赖未齐备不派发）', w4afterW2 === 'DRAFT', `w4=${w4afterW2}`)

  await finish(fe, w3.id)
  await api('POST', `/api/workshop/projects/${cProj.id}/kernel/tick`, {}, H())
  const w4final = await stateOf(cProj.id, w4.id)
  ok('EC4', 'W3 也完成 → 双依赖齐备 → W4 派发进测试频道', ['DISPATCHED', 'COMPLETED'].includes(w4final), `w4=${w4final}`)

  await finish(qa, w4.id)
  await api('POST', `/api/workshop/projects/${cProj.id}/kernel/tick`, {}, H())
  const cAutos = await autosOf(cProj.id)
  const allDone = [w1, w2, w3, w4].map(w => w.id)
  ok('EC5', '复杂任务：恰好 4 次 dispatch_auto，W1 最先 W4 最后（菱形时序正确）',
    cAutos.length === 4 && cAutos[0] === w1.id && cAutos[3] === w4.id && new Set(cAutos).size === 4,
    `autos=${JSON.stringify(cAutos.map(a => allDone.indexOf(a) + 1))}`)
  const cStatus = await chainResults(cProj.id, [fe, be, qa])
  ok('EC6', '复杂任务：三交付物成果链 + 完成门禁 → completed', cStatus === 'completed', `status=${cStatus}`)
  const cMs = Date.now() - cStart

  // 对比指标 + timeline 导出
  const cEvents = ((await api('GET', `/api/workshop/projects/${cProj.id}/events?limit=100`, undefined, H())).data ?? [])
    .filter(e => e.type === 'work.dispatch_auto' || e.type === 'work.completed')
    .map(e => ({ type: e.type, at: e.createdAt, workItemId: (() => {
      try {
        return JSON.parse(e.payloadJson)?.workItemId
      }
      catch { return '' }
    })() }))
  const summary = {
    generatedAt: new Date().toISOString(),
    port,
    scenario: 'Track E: 简单任务(单Channel) vs 复杂任务(3频道菱形DAG) 端到端对比实测',
    simple: { projectId: sProj.id, channels: 1, workItems: 1, dispatchAuto: sAutos.length, elapsedMs: sMs, status: sStatus },
    complex: {
      projectId: cProj.id, channels: 3, workItems: 4, dispatchAuto: cAutos.length, elapsedMs: cMs, status: cStatus,
      dag: 'W1(FE) -> {W2(BE), W3(FE)} -> W4(QA)',
      timeline: cEvents,
    },
    pass: results.filter(r => r.pass).length,
    fail: results.filter(r => !r.pass).length,
    results,
  }
  writeFileSync(join(EVID, 'track-e-simple-vs-complex.json'), `${JSON.stringify(summary, null, 2)}\n`)
  console.log(`\n=== TRACK E pass=${summary.pass} fail=${summary.fail} | simple=${sMs}ms complex=${cMs}ms → ${EVID} ===`)
  process.exitCode = summary.fail > 0 ? 1 : 0
}
catch (err) {
  console.error('Track E 异常:', err)
  process.exitCode = 1
}
finally {
  try {
    const exited = new Promise((r) => {
      const t = setTimeout(r, 8000)
      child.on('exit', () => {
        clearTimeout(t)
        r(null)
      })
    })
    child.kill()
    await exited
  }
  catch { /* ignore */ }
  await sleep(1000)
}
