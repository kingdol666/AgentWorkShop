// -*- coding: utf-8 -*-
// 任务管理不变量 E2E(node scripts/test-task-invariants.mjs)
//
// 实证三条核心不变量(单 worker 串行 + 事件流精确重建):
//  I1 单 WORKING:任意时刻同一 agent 至多 1 个 WORKING 任务(事件区间重叠检测)
//  I2 FIFO:ASSIGNED 任务按创建顺序依次进入 WORKING
//  I3 状态链:每个任务完整走 ASSIGNED → WORKING → COMPLETED,无跳步、无回退
//  I4 前端同步:agent.status 的 currentTaskId 与唯一 WORKING 任务始终一致(busy 期间)
import { env } from 'node:process'

const BASE = env.AW_BASE ?? 'http://127.0.0.1:3002'
const TOKEN = env.AW_TOKEN ?? 'ut-636e563104b844b591de8aadf6071aea'

let failures = 0
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures += 1
}
const sleep = ms => new Promise(r => setTimeout(r, ms))

async function api(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'authorization': `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  })
  const d = await res.json().catch(() => ({}))
  if (d?.code !== undefined && d.code !== 0 && d.code !== 'ok') {
    throw new Error(`${method} ${path} -> ${JSON.stringify(d).slice(0, 200)}`)
  }
  return d?.data ?? d
}

async function main() {
  const stamp = Date.now().toString(36)
  const created = await api('POST', '/api/workshop/channels', {
    name: `invariant-e2e-${stamp}`,
    description: '任务不变量 E2E(自动清理)',
    leadAgent: { name: 'inv-lead', harness: 'mock', config: { delayMs: 60 } },
  })
  const cid = created.channelId
  try {
    const w = await api('POST', `/api/workshop/channels/${cid}/agents`, { name: 'inv-worker', harness: 'mock', config: { delayMs: 260 } })
    const wid = w.id
    console.log(`channel=${cid.slice(0, 8)} worker=${wid.slice(0, 8)}`)

    // ===== 顺序提交 6 个任务(确定性 FIFO 创建序) =====
    const N = 6
    const tasks = []
    for (let i = 1; i <= N; i++) {
      const t = await api('POST', `/api/workshop/channels/${cid}/tasks`, {
        title: `INV-${String(i).padStart(2, '0')}`,
        description: `不变量验证任务 ${i}`,
        assigneeId: wid,
        parts: [{ text: `INV-${i}` }],
      })
      tasks.push(t)
    }
    console.log(`已顺序提交 ${N} 个任务(单 worker,delayMs=260 → 每任务约 1s,全程 ~7s)`)

    // ===== 全程轮询采样:任意时刻 WORKING 数(REST 快照) =====
    const samples = []
    const t0 = Date.now()
    while (Date.now() - t0 < 40_000) {
      const list = await api('GET', `/api/workshop/channels/${cid}/tasks`).catch(() => null)
      if (list) {
        const working = list.filter(t => t.state === 'WORKING')
        samples.push({ at: Date.now(), workingCount: working.length, workingIds: working.map(t => t.id) })
        if (list.every(t => ['COMPLETED', 'FAILED', 'CANCELED'].includes(t.state)) && list.length >= N) break
      }
      await sleep(200)
    }
    const maxWorking = Math.max(0, ...samples.map(s => s.workingCount))
    check(`I1 单 WORKING(全程采样 ${samples.length} 次,峰值 ${maxWorking})`, maxWorking <= 1)
    const executed = samples.filter(s => s.workingCount === 1).length
    check('I1b 执行期间确实处于 WORKING 态(采样非全 0)', executed > 0, `${executed} 次采样有 1 个 WORKING`)

    // ===== 事件流精确重建:状态路径 + WORKING 区间重叠 + currentTaskId 一致性 =====
    const evs = (await api('GET', `/api/workshop/channels/${cid}/events?limit=500`)).items ?? []
    const seq = evs.map(e => e.seq)
    check('事件流 seq 严格递增', seq.every((s, i) => i === 0 || s > seq[i - 1]))
    const taskEvs = evs
      .filter(e => e.type === 'task.status')
      .map(e => ({ seq: e.seq, taskId: e.payload?.taskId, state: e.payload?.state, assigneeId: e.payload?.assigneeId }))
      .filter(x => tasks.some(t => t.id === x.taskId))
    const agentEvs = evs
      .filter(e => e.type === 'agent.status' && e.agentId === wid)
      .map(e => ({ seq: e.seq, state: e.payload?.state, currentTaskId: e.payload?.currentTaskId ?? null }))

    // I3:每任务状态路径 = [ASSIGNED, WORKING, COMPLETED](容许 SUBMITTED 首帧)
    const pathOf = new Map()
    for (const x of taskEvs) {
      const arr = pathOf.get(x.taskId) ?? []
      if (arr[arr.length - 1] !== x.state) arr.push(x.state)
      pathOf.set(x.taskId, arr)
    }
    const expectOrder = tasks.map(t => t.id)
    let pathsOk = true
    const workingStartSeq = new Map()
    const workingEndSeq = new Map()
    for (const t of tasks) {
      const path = pathOf.get(t.id) ?? []
      const core = path.filter(s => s !== 'SUBMITTED')
      if (core.join(',') !== 'ASSIGNED,WORKING,COMPLETED') {
        pathsOk = false
        console.log(`   任务 ${t.title} 路径异常: ${path.join(' → ')}`)
      }
      const wSeq = taskEvs.find(x => x.taskId === t.id && x.state === 'WORKING')?.seq
      const cSeq = taskEvs.find(x => x.taskId === t.id && x.state === 'COMPLETED')?.seq
      if (wSeq) workingStartSeq.set(t.id, wSeq)
      if (cSeq) workingEndSeq.set(t.id, cSeq)
    }
    check(`I3 每任务状态链 ASSIGNED→WORKING→COMPLETED(${N}/${pathOf.size} 有事件)`, pathsOk && pathOf.size === N)

    // I2:WORKING 开始的 seq 顺序 === 创建顺序
    const startOrder = expectOrder
      .filter(id => workingStartSeq.has(id))
      .sort((a, b) => workingStartSeq.get(a) - workingStartSeq.get(b))
    check('I2 FIFO:进入 WORKING 的顺序 === 任务创建顺序', startOrder.join(',') === expectOrder.join(','),
      startOrder.map(id => tasks.find(t => t.id === id)?.title).join(' → '))

    // I1(事件级):WORKING 区间互不重叠
    let overlap = false
    const intervals = expectOrder
      .filter(id => workingStartSeq.has(id) && workingEndSeq.has(id))
      .map(id => [workingStartSeq.get(id), workingEndSeq.get(id), id])
    for (let i = 1; i < intervals.length; i++) {
      const cur = intervals[i]
      const prev = intervals[i - 1]
      if (cur && prev && cur[0] <= prev[1]) overlap = true
      if (overlap) break
    }
    check('I1(事件级)WORKING 区间零重叠', !overlap, `${intervals.length} 个区间`)

    // I4:busy 期间 currentTaskId === 当前唯一 WORKING 任务
    // 重建每 seq 时刻的 working 任务(区间内)并与最近 agent.status 对齐
    const workingAt = s => intervals.find(([a, b]) => s >= a && s <= b)?.[2] ?? null
    let mismatch = 0
    let checked = 0
    for (const a of agentEvs) {
      if (a.state !== 'busy') continue
      const cur = workingAt(a.seq)
      checked += 1
      if (cur && a.currentTaskId && a.currentTaskId !== cur) mismatch += 1
    }
    check('I4 busy 期间 currentTaskId 与唯一 WORKING 任务一致', mismatch === 0, `检查 ${checked} 帧,失配 ${mismatch}`)

    // 终态收口
    const final = await api('GET', `/api/workshop/channels/${cid}/tasks`)
    check('全部任务 COMPLETED', final.filter(t => tasks.some(x => x.id === t.id)).every(t => t.state === 'COMPLETED'),
      `${final.filter(t => t.state === 'COMPLETED').length}/${N}`)
  }
  finally {
    try {
      await api('DELETE', `/api/workshop/channels/${cid}`)
      console.log(`\n(测试 channel ${cid.slice(0, 8)} 已删除)`)
    }
    catch (err) {
      console.log(`\n(清理失败:${err.message})`)
    }
  }
  console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('E2E 异常:', err.message)
  process.exit(1)
})
