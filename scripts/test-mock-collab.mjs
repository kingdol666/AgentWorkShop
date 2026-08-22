// -*- coding: utf-8 -*-
// 多 Agent 实时通信 + FIFO 执行 E2E(mock harness;node scripts/test-mock-collab.mjs)
//
// 隔离环境:新建专属 channel(mock lead + 2 名 mock worker),跑完即删。
// 覆盖:
//  T1 任务 FIFO 逐条执行 —— HITL 直发 3 个任务给同一 worker:
//     完成顺序 === 提交顺序;执行严格串行(同一 worker 任意时刻至多 1 个 WORKING);
//     每任务走完 WORKING→COMPLETED(progress 25/50/75→artifact)。
//  T2 消息逐条处理 + 逐条回执 —— agent→agent 连发 8 条 requireReply 消息
//     (含同毫秒突发):每条恰好一条回执(in_reply_to 一一对应),
//     回执顺序 === 发送顺序(FIFO;rowid 决胜回归)。
//  T3 实时消息按需获取即时性 —— idle worker 收 immediate 消息:
//     发送→回执到达时延 < 5s(mailbox 到信唤醒 + 消费循环即时接单)。
//  T4 lead 调度闭环 —— 常规任务(无 @,默认路由 lead):lead 派发子任务 →
//     worker 完成 → lead 汇总 → 父任务 COMPLETED(多 Agent 协同全链路)。
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
  if (d && typeof d === 'object' && 'code' in d && d.code !== 0 && d.code !== 'ok') {
    throw new Error(`${method} ${path} -> ${JSON.stringify(d).slice(0, 220)}`)
  }
  return d?.data ?? d
}

/** 轮询直到谓词命中(返回谓词结果)或超时 */
async function pollUntil(fn, timeoutMs, label) {
  const t0 = Date.now()
  for (;;) {
    const v = await fn().catch(() => null)
    if (v) return { ok: true, value: v, elapsed: Date.now() - t0 }
    if (Date.now() - t0 > timeoutMs) return { ok: false, value: null, elapsed: Date.now() - t0, label }
    await sleep(300)
  }
}

/** channel 事件流(按 seq 升序;用于重建时序) */
async function events(cid, limit = 500) {
  const d = await api('GET', `/api/workshop/channels/${cid}/events?limit=${limit}`)
  return d.items ?? []
}

/** channel 全量消息行(含回执;按 createdAt 升序) */
async function messages(cid, limit = 400) {
  const rows = await api('GET', `/api/workshop/channels/${cid}/messages?limit=${limit}`)
  return Array.isArray(rows) ? rows.slice().sort((a, b) => a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0) : []
}

async function main() {
  // ---- 环境装配:专属 channel + mock lead + 2 mock worker ----
  const stamp = Date.now().toString(36)
  const created = await api('POST', '/api/workshop/channels', {
    name: `fifo-e2e-${stamp}`,
    description: 'FIFO/实时通信 E2E(自动创建,跑完即删)',
    leadAgent: { name: 'e2e-lead', harness: 'mock', config: { delayMs: 100 } },
  })
  const cid = created.channelId
  const leadId = created.leadAgentId
  console.log(`channel=${cid.slice(0, 8)} lead=${leadId.slice(0, 8)}`)
  try {
    const w1 = (await api('POST', `/api/workshop/channels/${cid}/agents`, { name: 'e2e-worker-1', harness: 'mock', config: { delayMs: 350 } })).id
    const w2 = (await api('POST', `/api/workshop/channels/${cid}/agents`, { name: 'e2e-worker-2', harness: 'mock', config: { delayMs: 120 } })).id
    console.log(`workers: w1=${w1.slice(0, 8)} w2=${w2.slice(0, 8)}`)

    // ================= T1:任务 FIFO 逐条执行 =================
    console.log('\n--- T1:任务 FIFO 逐条执行(HITL 直发 ×3 → 同一 worker) ---')
    const markers = ['FIFO-A', 'FIFO-B', 'FIFO-C']
    const t1 = []
    for (const m of markers) {
      // 顺序提交(每个 POST 落库后再发下一个):入队顺序确定 → 完成顺序必须一致
      const t = await api('POST', `/api/workshop/channels/${cid}/tasks`, {
        title: `${m} 顺序验证`,
        description: `${m}:按提交顺序逐条执行`,
        assigneeId: w1,
        parts: [{ text: `${m} body` }],
      })
      t1.push({ id: t.id, m })
    }
    const idByMarker = new Map(t1.map(x => [x.id, x.m]))
    const allDone = await pollUntil(async () => {
      const tasks = await api('GET', `/api/workshop/channels/${cid}/tasks`)
      return t1.every(x => tasks.find(t => t.id === x.id)?.state === 'COMPLETED') || null
    }, 30_000, 'T1 全部完成')
    check('T1 三个任务全部 COMPLETED', allDone.ok, `${allDone.elapsed}ms`)

    // 时序重建:task.status 事件按 seq → 完成顺序 + 串行性
    {
      const evs = (await events(cid)).filter(e => e.type === 'task.status')
        .map(e => ({ seq: e.seq, taskId: e.payload?.taskId, state: e.payload?.state }))
        .filter(x => idByMarker.has(x.taskId))
      const completionOrder = evs.filter(x => x.state === 'COMPLETED').map(x => idByMarker.get(x.taskId))
      check('T1 完成顺序 === 提交顺序(A→B→C)', completionOrder.join(',') === markers.join(','), completionOrder.join(','))
      // 串行:WORKING 区间不重叠 —— WORKING(x) 出现时,前一任务必须已 COMPLETED
      let prevOpen = null
      let serial = true
      for (const x of evs) {
        if (x.state === 'WORKING') {
          if (prevOpen) {
            serial = false
            break
          }
          prevOpen = x.taskId
        }
        if (x.state === 'COMPLETED' && prevOpen === x.taskId) prevOpen = null
      }
      check('T1 同一 worker 任意时刻至多 1 个任务在执行(严格串行)', serial)
      // 每任务走过 WORKING
      for (const x of t1) {
        check(`T1 ${idByMarker.get(x.id)} 经 WORKING 转移`, evs.some(e => e.taskId === x.id && e.state === 'WORKING'))
      }
    }

    // ================= T2:消息逐条处理 + 逐条回执(FIFO) =================
    console.log('\n--- T2:消息逐条处理 + 逐条回执(连发 8 条 requireReply) ---')
    const N = 8
    const sent = []
    for (let i = 1; i <= N; i++) {
      // 同步连发(近同毫秒突发;验证 rowid 决胜 FIFO)
      sent.push(api('POST', `/api/workshop/channels/${cid}/messages`, {
        toAgentId: w2, fromAgentId: leadId,
        text: `逐条消息 ${i}/${N}`,
        priority: 'immediate', requireReply: true,
      }).then(r => ({ id: r.messageId, i })))
    }
    const sentMsgs = await Promise.all(sent)
    const replySet = new Set(sentMsgs.map(x => x.id))
    const gotReplies = await pollUntil(async () => {
      const rows = await messages(cid)
      const replies = rows.filter(r => r.fromAgentId === w2
        && r.metadata?.['x-aw-in-reply-to'] && replySet.has(r.metadata['x-aw-in-reply-to']))
      return replies.length >= N ? replies : null
    }, 20_000, 'T2 全部回执')
    check('T2 每条消息恰好收到一条回执(N/N)', gotReplies.ok, `${gotReplies.value?.length ?? 0}/${N}`)
    {
      const replies = gotReplies.value ?? []
      // 并发 POST 的服务器入队顺序 ≠ 客户端编号顺序;FIFO 契约 = 按入队顺序执行。
      // 以入队时间戳(消息行 createdAt)为基准:回执顺序映射回原消息后单调不减
      // (同毫秒并列组内任意序均可),跨毫秒组必须升序。
      const createdAtByMsg = new Map(
        (await messages(cid))
          .filter(r => replySet.has(r.id))
          .map(r => [r.id, r.createdAt]),
      )
      const stamps = replies.map(r => createdAtByMsg.get(r.metadata['x-aw-in-reply-to']))
      const nonDecreasing = stamps.every((v, idx) => idx === 0 || v >= stamps[idx - 1])
      check('T2 回执顺序与入队时间戳单调一致(FIFO 按入队序;同毫秒并列可任意序)', nonDecreasing, stamps.join(','))
      // 逐条语义:无重复回执、无遗漏
      const uniqTargets = new Set(replies.map(r => r.metadata['x-aw-in-reply-to']))
      check('T2 回执一一对应(无重复/无遗漏)', uniqTargets.size === N && replies.length === N)
    }

    // ================= T3:实时消息即时性(按需获取) =================
    console.log('\n--- T3:实时消息按需获取即时性(idle worker,immediate) ---')
    {
      const t0 = Date.now()
      const r = await api('POST', `/api/workshop/channels/${cid}/messages`, {
        toAgentId: w2, fromAgentId: leadId,
        text: '实时性探针:请立即回执',
        priority: 'immediate', requireReply: true,
      })
      const probe = await pollUntil(async () => {
        const rows = await messages(cid)
        return rows.find(x => x.fromAgentId === w2 && x.metadata?.['x-aw-in-reply-to'] === r.messageId) ?? null
      }, 10_000, 'T3 回执')
      const ms = Date.now() - t0
      check('T3 发送→回执到达(< 5s;mailbox 到信即时唤醒 + 消费循环即时接单)', probe.ok && ms < 5000, `${ms}ms`)
    }

    // ================= T4:lead 调度闭环(多 Agent 协同) =================
    console.log('\n--- T4:lead 调度闭环(默认路由 → lead 派发 → worker 完成 → 父任务收口) ---')
    {
      const parent = await api('POST', `/api/workshop/channels/${cid}/tasks`, {
        title: `协同闭环-${stamp}`,
        description: 'lead 应派发子任务给空闲 worker 并在子任务完成后汇总收口',
        parts: [{ text: '协同闭环 body' }],
      })
      const done = await pollUntil(async () => {
        const tasks = await api('GET', `/api/workshop/channels/${cid}/tasks`)
        const st = tasks.find(t => t.id === parent.id)?.state
        return st === 'COMPLETED' || null
      }, 40_000, 'T4 父任务 COMPLETED')
      check('T4 父任务经 lead 调度收口为 COMPLETED', done.ok, `${done.elapsed}ms`)
      // 派发链路:存在子任务(指派给 worker)且完成
      const tasks = await api('GET', `/api/workshop/channels/${cid}/tasks`)
      const children = tasks.filter(t => t.parentId === parent.id)
      check('T4 lead 派发了子任务且子任务完成', children.length > 0 && children.every(c => c.state === 'COMPLETED'),
        `children=${children.length}`)
      // lead 汇总交付物
      const parentTask = tasks.find(t => t.id === parent.id)
      check('T4 父任务带汇总交付物(summary)', (parentTask?.artifacts?.length ?? 0) > 0)
    }
  }
  finally {
    // ---- 清理:删除测试 channel(级联清理 agents/tasks/messages) ----
    try {
      await api('DELETE', `/api/workshop/channels/${cid}`)
      console.log(`\n(测试 channel ${cid.slice(0, 8)} 已删除)`)
    }
    catch (err) {
      console.log(`\n(清理失败,请手动删除 channel ${cid}:${err.message})`)
    }
  }

  console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('E2E 异常:', err.message)
  process.exit(1)
})
