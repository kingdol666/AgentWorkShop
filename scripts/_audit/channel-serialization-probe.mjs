#!/usr/bin/env node
/**
 * channel-serialization-probe.mjs —— 同 Channel 内并发会话能力探针。
 * 两个独立工作项（无依赖）快速派发到同一 mock lead：
 *  - 若串行：W2 在 W1 COMPLETED 前保持 SUBMITTED（时间线无重叠）
 *  - 若并行：两 root 时间线重叠
 * 输出每 500ms 的状态时间线到 bench/results/<rid>/serialization-probe.json
 */
import { writeFileSync, mkdirSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..', '..')
const args = process.argv.slice(2)
const arg = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? (args[i + 1] ?? '') : d }
const base = arg('base', 'http://127.0.0.1:3580').replace(/\/$/, '')
const outDir = resolve(arg('out', join(REPO, 'bench', 'results', `${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}-serialization-probe`)))

let token = ''
const api = async (method, path, body) => {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  })
  const json = await res.json().catch(() => null)
  return { status: res.status, data: json?.data, message: json?.message ?? '' }
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

async function main() {
  const st = await api('GET', '/api/users/setup-status')
  if (st.data?.needsSetup) {
    const r = await api('POST', '/api/users/register', { name: 'p', email: 'admin@awshop.local', password: 'admin123' })
    token = r.data?.token ?? ''
  } else {
    const lg = await api('POST', '/api/users/login', { email: 'admin@awshop.local', password: 'admin123' })
    token = lg.data?.token ?? ''
  }
  const tplName = `串行探针-${randomUUID().slice(0, 5)}`
  await api('POST', '/api/workshop/project-blueprints', {
    name: tplName,
    blueprint: {
      name: '串行探针会话', objective: 'probe', routingPolicy: 'legacy', planApprovalRequired: false,
      channels: [{ key: 'c1', name: 'C1', charter: 'c', leadHarness: 'mock' }],
      plan: {
        deliverables: [{ key: 'd1', name: 'D1', channelKey: 'c1' }],
        work_items: [
          { key: 'w1', title: 'P1 并发项一', deliverableKey: 'd1', channelKey: 'c1' },
          { key: 'w2', title: 'P2 并发项二', deliverableKey: 'd1', channelKey: 'c1', resultKey: 'second' },
        ],
      },
    },
  })
  const inst = await api('POST', '/api/workshop/projects/instantiate', { template: tplName })
  const pid = inst.data?.projectId
  if (!pid) {
    console.error('[abort] 实例化失败:', inst.status, String(inst.message ?? '').slice(0, 120))
    process.exit(1)
  }
  const snap = await api('GET', `/api/workshop/projects/${pid}/snapshot`)
  const items = snap.data?.workItems ?? []
  const w1 = items.find(x => x.title.startsWith('P1'))?.id
  const w2 = items.find(x => x.title.startsWith('P2'))?.id
  if (!w1 || !w2) {
    console.error('[abort] 工作项缺失:', JSON.stringify(items.map(x => x.title)))
    process.exit(1)
  }
  // 快速连发两个 dispatch
  const d1 = await api('POST', `/api/workshop/projects/${pid}/work-items/${w1}/dispatch`)
  const d2 = await api('POST', `/api/workshop/projects/${pid}/work-items/${w2}/dispatch`)
  if (d1.status !== 200 || d2.status !== 200) {
    console.error('[abort] 派发失败:', d1.status, String(d1.message).slice(0, 80), '|', d2.status, String(d2.message).slice(0, 80))
    process.exit(1)
  }
  // 时间线采样：500ms 一次，记录两工作项 + root 任务状态
  const timeline = []
  const t0 = Date.now()
  let bothDone = false
  for (let i = 0; i < 200 && !bothDone; i++) {
    await sleep(100)
    const its = await api('GET', `/api/workshop/projects/${pid}/work-items`)
    const rows = its.data?.workItems ?? its.data ?? []
    const s1 = rows.find(x => x.id === w1)?.state
    const s2 = rows.find(x => x.id === w2)?.state
    const prev = timeline[timeline.length - 1]
    if (!prev || prev.w1 !== s1 || prev.w2 !== s2) timeline.push({ t: Math.round((Date.now() - t0) / 100) / 10, w1: s1, w2: s2 })
    if (s1 === 'COMPLETED' && s2 === 'COMPLETED') bothDone = true
  }
  // 重叠分析：是否存在某时刻两工作项同时非 SUBMITTED（都在执行/完成中）
  let overlap = false, overlapAt = null
  for (const p of timeline) {
    if (p.w1 !== undefined && p.w1 !== 'DRAFT' && p.w1 !== 'SUBMITTED' && p.w2 !== undefined && p.w2 !== 'DRAFT' && p.w2 !== 'SUBMITTED') { overlap = true; overlapAt = p.t; break }
  }
  mkdirSync(outDir, { recursive: true })
  const verdict = overlap ? 'PARALLEL' : 'SERIALIZED'
  writeFileSync(join(outDir, 'serialization-probe.json'), JSON.stringify({ at: new Date().toISOString(), verdict, overlapAt, note: 'mock 秒完成时采样不可分辨——串行/并行的结论以 withExecLock 代码证据为准；换 omp lead 重跑可分辨', timeline }, null, 2))
  console.log(`判定: ${verdict}${overlapAt != null ? `（重叠始于 ${overlapAt}s）` : ''} → ${outDir}`)
  console.log('时间线（前 20）:', JSON.stringify(timeline.slice(0, 20)))
}

main().catch((err) => { console.error('FAIL:', err?.message ?? err); process.exit(1) })
