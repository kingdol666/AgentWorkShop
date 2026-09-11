/**
 * 回归测试 —— 事件 ring 增量索引与增量时间线的**语义等价性**。
 *
 * 背景(为什么要测):events store 的两条热路径从"每帧全量过滤"改成了增量,
 * 增量实现的危险在于**悄悄与全量语义分叉**(少一条、多一条、淘汰后残留),
 * 而这类 bug 只在长会话里出现,人工测不出来。所以这里做**属性对照测试**:
 * 用同一串随机操作(ingest / 淘汰 / 历史合并 / 过滤切换 / 聚焦切换)同时喂给
 * 「真实 store」与「朴素全量参照实现」,逐拍比对结果必须完全一致。
 *
 * 运行:node scripts/test-events-index.mjs
 */
import { register } from 'node:module'
import { createPinia, setActivePinia } from 'pinia'

register(new URL('./_audit/ts-resolve-hook.mjs', import.meta.url).href)

const { useEventsStore, matchesTimeline, FILTER_TYPES } = await import('../app/stores/workshop/events.ts')

let pass = 0
const fails = []
const check = (name, ok, detail = '') => {
  if (ok) {
    pass++
    console.log(`  ✔ ${name}${detail ? ` — ${detail}` : ''}`)
    return
  }
  fails.push(name)
  console.log(`  ✘ ${name}${detail ? ` — ${detail}` : ''}`)
}

const RING_CAP = 5000

// ---------- 朴素参照实现 ----------
// 关键:谓词**复用产品导出的 matchesTimeline**。本测试要证明的是"增量维护状态
// (byAgent 桶 / upToIdx / headSeq / 淘汰同步)与全量重算等价",不是重新推导过滤语义。
// 自己再抄一份谓词只会引入假阳性(第一版就两次栽在这上面:key 档位的 tier 判定、
// 以及 key 档位提前返回而不受 focus 影响)。
const refFilter = (items, filter, focus) =>
  items.filter(e => matchesTimeline(e, filter, FILTER_TYPES[filter], focus))

const refByAgent = (items, agentId) => items.filter(e => e.agentId === agentId)

// ---------- 随机操作序列 ----------
let seed = 0x2F6E2B1
const rnd = () => {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
  return seed / 0x100000000
}
const pick = arr => arr[Math.floor(rnd() * arr.length)]

const AGENTS = ['a1', 'a2', 'a3', 'a4', 'a5']
const TYPES = ['agent.message', 'agent.delta', 'agent.status.message', 'a2a.message', 'task.status', 'task.progress', 'a2a.artifact', 'error', 'agent.member']

function mkEnvelope(seq) {
  const type = pick(TYPES)
  const agentId = type === 'error' ? undefined : pick(AGENTS)
  // 覆盖各档位:task.status 的终态/等待态、require-reply 的 attention、普通过程帧
  const status = type === 'task.status' ? pick(['WORKING', 'COMPLETED', 'FAILED', 'WAITING']) : undefined
  return {
    seq,
    channelId: 'ch1',
    type,
    agentId,
    taskId: type.startsWith('task.') ? `t${Math.floor(rnd() * 3)}` : undefined,
    at: new Date(1700000000000 + seq * 10).toISOString(),
    payload: type === 'agent.delta'
      ? { delta: `d${seq}` }
      : (status ? { state: status } : (rnd() < 0.2 ? { metadata: { 'x-aw-require-reply': 'true' } } : {})),
  }
}

const FILTERS = ['all', 'messages', 'tasks', 'team', 'errors', 'key']

async function main() {
  setActivePinia(createPinia())
  const store = useEventsStore()
  const CH = 'ch1'

  // 初始快照(建立 ring)
  store.ingest({ seq: 0, channelId: CH, type: 'channel.snapshot', payload: {} })

  let seq = 0
  let mismatches = 0
  const STEPS = 6000
  // 4000 步之后超过 RING_CAP 会开始淘汰 —— 专门覆盖"淘汰后索引残留"这一最易错的分支
  const historyScript = []
  for (let i = 0; i < 6; i++) {
    const extra = []
    for (let k = 0; k < 40; k++) extra.push(mkEnvelope(seq + 1 + k))
    historyScript.push({ atStep: Math.floor(STEPS * (i + 1) / 7), items: extra })
  }

  for (let step = 0; step < STEPS; step++) {
    // 1) 推进 seq 并 ingest 一帧
    seq += 1
    const e = mkEnvelope(seq)
    store.ingest(e)

    // 2) 偶发:切换过滤 / 聚焦
    if (step % 250 === 0) store.setFilter(CH, pick(FILTERS))
    if (step % 317 === 0) store.setFocusAgent(CH, rnd() < 0.6 ? pick(AGENTS) : null)

    // 3) 偶发:历史批量合并(走 reindex 全量重建路径)
    const script = historyScript.find(s => s.atStep === step)
    if (script) {
      for (const item of script.items) store.ingest(item)
      seq += script.items.length
    }

    // 4) 对照:ring items 本身
    const ring = store.rings[CH]
    if (!ring) {
      mismatches++
      console.log(`  ! step ${step}: ring 丢失`)
      break
    }

    // 5) 对照:每个 agent 的子序列(索引)必须与全量过滤一致
    for (const a of AGENTS) {
      const got = store.agentEvents(CH, a)
      const want = refByAgent(ring.items, a)
      if (got.length !== want.length || got.some((x, i) => x !== want[i])) {
        mismatches++
        console.log(`  ! step ${step} agent=${a} 索引漂移:got=${got.length} want=${want.length}`)
        break
      }
    }
    if (mismatches) break

    // 6) 对照:时间线(增量)必须与全量过滤一致
    const filter = store.filters[CH] ?? 'all'
    const focus = store.focusAgents[CH] ?? null
    const gotTl = store.timeline(CH)
    const wantTl = refFilter(ring.items, filter, focus)
    if (gotTl.length !== wantTl.length || gotTl.some((x, i) => x !== wantTl[i])) {
      mismatches++
      console.log(`  ! step ${step} timeline(${filter},focus=${focus}) 漂移:got=${gotTl.length} want=${wantTl.length}`)
      break
    }
  }

  check(`${STEPS} 步随机操作后 ring 未丢失`, Boolean(store.rings[CH]))
  check('agent 子序列索引与全量过滤逐拍一致', mismatches === 0, `mismatches=${mismatches}`)
  check('增量时间线与全量过滤逐拍一致', mismatches === 0, `mismatches=${mismatches}`)
  check('ring 已触发淘汰(覆盖淘汰分支)', store.rings[CH].items.length <= RING_CAP,
    `items=${store.rings[CH].items.length} cap=${RING_CAP}`)
  // 关键:总 seq 必须超过 cap,否则整段测试根本没走到"满环 + 头部淘汰"这条最易错的分支
  check('总 seq 已越过 ring 容量(确认走过淘汰路径)', seq > RING_CAP, `seq=${seq} cap=${RING_CAP}`)

  // 索引无悬挂引用:所有桶内元素必须仍在 items 中(否则是内存泄漏 + 查询命中幽灵条目)
  const inRing = new Set(store.rings[CH].items)
  let dangling = 0
  for (const a of AGENTS) for (const e of store.agentEvents(CH, a)) if (!inRing.has(e)) dangling++
  check('索引无悬挂引用(不持有已淘汰条目)', dangling === 0, `dangling=${dangling}`)

  // 索引覆盖率:所有带 agentId 的 items 都能在其桶里找到
  let uncovered = 0
  for (const e of store.rings[CH].items) {
    if (!e.agentId) continue
    if (!store.agentEvents(CH, e.agentId).includes(e)) uncovered++
  }
  check('索引覆盖完整(每条带 agentId 的事件都在桶内)', uncovered === 0, `uncovered=${uncovered}`)

  // 快照重建必须清空索引
  store.ingest({ seq: seq + 100, channelId: CH, type: 'channel.snapshot', payload: {} })
  const emptyOk = AGENTS.every(a => store.agentEvents(CH, a).length === 0) && store.timeline(CH).length === 0
  check('channel.snapshot 重建后索引与时间线均为空', emptyOk)

  console.log(`\n结果:${pass} 通过 / ${fails.length} 失败`)
  process.exit(fails.length === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
