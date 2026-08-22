// -*- coding: utf-8 -*-
// WS 实时链路实测(需 Node ≥ 22,原生 WebSocket;node scripts/ws-test.mjs)。
//
// 针对运行中的 dev/prod 服务验证 AEP v1 协议全链路:
//  1. 鉴权:无 token 订阅被拒(USER_UNAUTHORIZED);有效 token 通过。
//  2. 快照对齐:无游标 sub → channel.snapshot(实体基线)。
//  3. ping/pong。
//  4. 实时推送:REST 注入人类消息 → WS 收到 a2a.message 帧;验证:
//     - 信封 agentId 归属(人类消息不归属收件 Agent —— 修复回归测试)
//     - seq 单调递增。
//  5. 断线续传:携带 lastSeq 重订 → 重放缺失段(seq > lastSeq,不重复、不跳号)。
//  6. 落库对账:WS 收到的帧在 REST /events 中按同序存在(DB 事实源)。
import { env } from 'node:process'

const BASE = env.AW_BASE ?? 'http://127.0.0.1:3002'
const TOKEN = env.AW_TOKEN ?? 'ut-636e563104b844b591de8aadf6071aea'
const CID = env.AW_CID ?? '4b4d742d-2e27-4f2d-a2c9-c1ce9ceb0411'
const WS_BASE = BASE.replace(/^http/, 'ws')

let failures = 0
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures += 1
}

async function api(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'authorization': `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  })
  const d = await res.json()
  if (d && typeof d === 'object' && 'code' in d && d.code !== 0 && d.code !== 'ok') {
    throw new Error(`${path} -> ${JSON.stringify(d).slice(0, 200)}`)
  }
  return d?.data ?? d
}

/** 打开一条 WS 并等待 open */
function openWs(query) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${WS_BASE}/api/workshop/ws${query}`)
    ws.addEventListener('open', () => resolve(ws), { once: true })
    ws.addEventListener('error', () => reject(new Error('ws connect failed')), { once: true })
  })
}

/** 收帧直到谓词命中(超时抛错);返回命中帧与期间全部帧 */
function waitFrame(ws, pred, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const seen = []
    const timer = setTimeout(() => {
      cleanup()
      reject(new Error(`等帧超时(${timeoutMs}ms);已收 ${seen.length} 帧`))
    }, timeoutMs)
    const onMsg = (ev) => {
      let e
      try {
        e = JSON.parse(ev.data)
      }
      catch { return }
      seen.push(e)
      if (pred(e, seen)) {
        cleanup()
        resolve({ frame: e, seen })
      }
    }
    const cleanup = () => {
      clearTimeout(timer)
      ws.removeEventListener('message', onMsg)
    }
    ws.addEventListener('message', onMsg)
  })
}

const send = (ws, obj) => ws.send(JSON.stringify(obj))

async function main() {
  // ---- 0. 前置:channel 存在 ----
  const events0 = await api('GET', `/api/workshop/channels/${CID}/events?limit=1`)
  const maxSeq0 = events0.maxSeq ?? 0
  console.log(`基线 maxSeq=${maxSeq0}`)

  // ---- 1. 鉴权 ----
  {
    const ws = await openWs('')
    send(ws, { type: 'sub', channelId: CID }) // 无 token 字段
    const { frame } = await waitFrame(ws, e => e.type === 'error' && e.payload?.code === 'USER_UNAUTHORIZED')
    check('无 token sub 被拒(USER_UNAUTHORIZED)', frame.payload.code === 'USER_UNAUTHORIZED')
    ws.close()
  }

  // ---- 2/3. 快照 + ping/pong ----
  const ws = await openWs(`?token=${encodeURIComponent(TOKEN)}`)
  send(ws, { type: 'sub', channelId: CID, token: TOKEN })
  {
    const { frame } = await waitFrame(ws, e => e.type === 'channel.snapshot')
    const p = frame.payload ?? {}
    check('无游标 sub → channel.snapshot', Array.isArray(p.agents) && Array.isArray(p.tasks))
    check('快照含 agents 基线', (p.agents ?? []).length > 0, `agents=${(p.agents ?? []).length}`)
  }
  {
    send(ws, { type: 'ping' })
    const { frame } = await waitFrame(ws, e => e.type === 'pong')
    check('ping → pong', frame.type === 'pong')
  }

  // ---- 4. 实时推送 + 人类消息归属 ----
  let lastSeq = 0
  {
    const before = await api('GET', `/api/workshop/channels/${CID}/events?limit=1`)
    lastSeq = before.maxSeq ?? 0
    const stamp = Date.now().toString(36)
    // 先挂帧监听再注入:帧在 POST 处理中即推送,后挂会错过
    const waitP = waitFrame(ws, e =>
      e.type === 'a2a.message'
      && Number(e.seq ?? 0) > lastSeq
      && JSON.stringify(e.payload?.parts ?? []).includes(stamp), 15000)
    await api('POST', `/api/workshop/channels/${CID}/messages`, {
      toAgentId: 'b0de4cfa-42eb-4c64-90d1-c571bdd069f6',
      text: `[ws-test] 人类实时消息 ${stamp}`,
      priority: 'immediate',
      requireReply: false,
    })
    const { frame } = await waitP
    check('REST 注入 → WS 实时收到 a2a.message', true, `seq=${frame.seq}`)
    check('人类消息信封 agentId 为空(归属修复)', frame.agentId === undefined || frame.agentId === null,
      `agentId=${String(frame.agentId)}`)
    check('帧 seq 单调 > 基线', frame.seq > lastSeq, `${lastSeq} → ${frame.seq}`)
    lastSeq = frame.seq
  }

  // ---- 5. 断线续传:重连 + lastSeq 重放 ----
  {
    ws.close()
    // 关闭后再注入一条(模拟断线窗口内的事件)
    const stamp2 = Date.now().toString(36)
    await api('POST', `/api/workshop/channels/${CID}/messages`, {
      toAgentId: 'b0de4cfa-42eb-4c64-90d1-c571bdd069f6',
      text: `[ws-test] 断线窗口消息 ${stamp2}`,
      priority: 'task',
    })
    const ws2 = await openWs(`?token=${encodeURIComponent(TOKEN)}`)
    const waitP2 = waitFrame(ws2, e =>
      e.type === 'a2a.message' && JSON.stringify(e.payload?.parts ?? []).includes(stamp2), 15000)
    send(ws2, { type: 'sub', channelId: CID, token: TOKEN, lastSeq })
    const { seen } = await waitP2
    const replay = seen.filter(e => typeof e.seq === 'number' && e.seq > lastSeq)
    check('重连 lastSeq → 重放缺失段', replay.length > 0, `重放 ${replay.length} 帧`)
    const seqs = replay.map(e => e.seq)
    const monotonic = seqs.every((s, i) => i === 0 || s > seqs[i - 1])
    check('重放段 seq 严格递增(不重复不跳号)', monotonic, seqs.slice(0, 8).join(','))
    const noSnapshot = !seen.some(e => e.type === 'channel.snapshot')
    check('游标在缓冲窗内 → 不下发全量快照', noSnapshot)
    const last = seqs[seqs.length - 1] ?? lastSeq
    ws2.close()

    // ---- 6. 落库对账:WS 重放帧与 REST /events 同序 ----
    const hist = await api('GET', `/api/workshop/channels/${CID}/events?limit=200`)
    const items = hist.items ?? []
    const bySeq = new Map(items.map(e => [e.seq, e]))
    const replayInDb = replay.every(e => bySeq.has(e.seq))
    check('重放帧全部落库(顺序事实源)', replayInDb)
    const dbMax = Math.max(...items.map(e => e.seq), 0)
    check('DB maxSeq ≥ WS 最后重放 seq', dbMax >= last, `db=${dbMax} ws=${last}`)
  }

  ws.close()
  console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('WS 测试异常:', err.message)
  process.exit(1)
})
