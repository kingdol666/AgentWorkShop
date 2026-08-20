/**
 * 事件消费去重回归(逻辑级):
 *  断言"每个 WS 事件恰好消费一次、绝不重复渲染"的三条防线:
 *  R1. delta 合并(ingest)× loadHistory 历史回填 → 同段文本只出现一次(consumed seq 集合)
 *  R2. 历史头部插入 × 聚类器增量推进 → 已聚类事件不成第二块(头部 seq 检测重建;真实 BlockClusterer)
 *  R3. 快照对齐/重放与过滤切换 → 聚类重建后仍无重复(真实 BlockClusterer)
 * 注:events store 的 ingest/loadHistory 含 $fetch,纯 Node 环境按实现等价复刻
 *     (与 stores/workshop/events.ts 保持同步);聚类器为真实导入。
 * 运行:pnpm exec tsx scripts/test-dedup-logic.ts
 */
import { BlockClusterer } from '../app/composables/workshop/useEventBlocks'
import type { AepEnvelope } from '../shared/workshop-protocol'

const env = (seq: number, type: string, payload: Record<string, unknown>, agentId = 'w1'): AepEnvelope =>
  ({ v: 1, type, seq, at: new Date().toISOString(), channelId: 'c1', agentId, payload }) as AepEnvelope

let failures = 0
const check = (name: string, ok: boolean, detail = ''): void => {
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures += 1
}

// ===== events.ingest / loadHistory 等价复刻(与 stores/workshop/events.ts 同步) =====
function makeRing() {
  return { lastSeq: 0, items: [] as AepEnvelope[], consumed: new Set<number>() }
}
type Ring = ReturnType<typeof makeRing>
function ingest(ring: Ring, e: AepEnvelope): void {
  if (e.type === 'channel.snapshot') {
    ring.lastSeq = e.seq
    ring.items = []
    ring.consumed = new Set([e.seq])
    return
  }
  if (typeof e.seq === 'number' && e.seq > ring.lastSeq) {
    ring.consumed.add(e.seq)
    if (e.type === 'agent.delta') {
      const last = ring.items[ring.items.length - 1]
      if (last && last.type === 'agent.delta' && last.agentId === e.agentId && (last.taskId ?? null) === (e.taskId ?? null)) {
        (last.payload as { delta: string }).delta += (e.payload as { delta: string }).delta
        ring.lastSeq = e.seq
        return
      }
    }
    ring.items.push(e)
    ring.lastSeq = e.seq
  }
}
function loadHistoryInto(ring: Ring, frames: AepEnvelope[]): void {
  for (const e of frames) {
    if (typeof e.seq !== 'number' || e.seq > ring.lastSeq) continue
    if (ring.consumed.has(e.seq)) continue
    ring.items.push(e)
    ring.consumed.add(e.seq)
  }
  ring.items.sort((a, b) => a.seq - b.seq)
}

// ===== R1:delta 合并 × loadHistory 历史回填 =====
console.log('R1. delta 合并 × 历史回填(consumed seq 去重)')
{
  const ring = makeRing()
  ingest(ring, env(100, 'channel.snapshot', {}))
  ingest(ring, env(101, 'agent.delta', { delta: '你好' }))
  ingest(ring, env(102, 'agent.delta', { delta: '，worker' })) // 合并进 seq=101
  const history = [env(101, 'agent.delta', { delta: '你好' }), env(102, 'agent.delta', { delta: '，worker' }), env(99, 'task.status', { state: 'WORKING' })]
  loadHistoryInto(ring, history)
  const texts = ring.items.filter(i => i.type === 'agent.delta').map(i => (i.payload as { delta: string }).delta)
  const dupCount = texts.join('\n').split('，worker').length - 1
  check('合并过的 delta 不被历史回填重复插入', dupCount === 1, `delta frames=${JSON.stringify(texts)}`)
  check('未被消费的历史帧正常补入(可见)', ring.items.some(i => i.seq === 99 && i.type === 'task.status'))
  check('items 按 seq 升序', ring.items.every((it, i, a) => i === 0 || a[i - 1]!.seq <= it.seq))
}

// ===== R2:历史头部插入 × 聚类器增量推进(真实 BlockClusterer) =====
console.log('R2. 历史头部插入 × 聚类器增量(头部 seq 检测重建)')
{
  const clusterer = new BlockClusterer()
  const live = [
    env(101, 'agent.delta', { delta: '流式输出A' }),
    env(102, 'task.status', { state: 'WORKING' }),
    env(103, 'agent.delta', { delta: '流式输出B' }),
    env(104, 'agent.delta', { delta: '续' }), // 与 103 同源连续 → 聚类器层再合并进同块
  ]
  clusterer.sync(live)
  const before = clusterer.blocks.length

  // 历史回填:seq ≤ 快照游标(100)的 100 帧(与 live 101+ 无重叠;
  // 与 live 重叠的场景由 store 的 consumed 闸门拦截,见 R1)
  const history = Array.from({ length: 100 }, (_, i) => env(i + 1, 'task.status', { state: 'SUBMITTED' }))
  const merged = [...history, ...live].sort((a, b) => a.seq - b.seq)
  clusterer.sync(merged)

  const blocksWith = (text: string) => clusterer.blocks.filter(b => b.events.some(e => (e.payload as { delta?: string }).delta === text)).length
  check('已聚类流事件不成第二块(A)', blocksWith('流式输出A') === 1, `A块数=${blocksWith('流式输出A')}`)
  check('已聚类流事件不成第二块(B)', blocksWith('流式输出B') === 1, `B块数=${blocksWith('流式输出B')}`)
  check('历史事件被全量重建聚类(可见)', clusterer.blocks.length >= before, `blocks=${clusterer.blocks.length}`)
  // 全序列无任何事件被消费两次:逐块 events 展开后 seq 无重复
  const allSeqs = clusterer.blocks.flatMap(b => b.events.map(e => e.seq))
  check('全部块内事件 seq 无重复(每事件恰好消费一次)', new Set(allSeqs).size === allSeqs.length, `events=${allSeqs.length}`)
}

// ===== R3:重放对齐 + 过滤切换重建 =====
console.log('R3. 重放对齐 / 过滤切换(每事件恰好一次)')
{
  // 快照对齐:同批事件二次投递(重连重放)→ ingest seq 闸门丢弃
  const ring = makeRing()
  ingest(ring, env(100, 'channel.snapshot', {}))
  const batch = [env(101, 'agent.delta', { delta: 'x' }), env(102, 'task.status', { state: 'WORKING' })]
  for (const e of batch) ingest(ring, e)
  for (const e of batch) ingest(ring, e) // 重放
  check('重放帧被 seq 闸门丢弃', ring.items.length === 2, `items=${ring.items.length}`)

  // 过滤切换:聚类器对不同子序列切换后仍无重复消费
  const c = new BlockClusterer()
  const events = [
    env(1, 'agent.delta', { delta: 's1' }, 'w1'),
    env(2, 'task.status', { state: 'WORKING' }),
    env(3, 'agent.delta', { delta: 's2' }, 'w1'),
    env(4, 'agent.delta', { delta: 's3' }, 'w2'),
  ]
  c.sync(events) // 全量
  c.sync(events.filter(e => e.agentId === 'w1')) // 切换到过滤视图
  c.sync(events) // 切回全量
  const allSeqs = c.blocks.flatMap(b => b.events.map(e => e.seq))
  const w1StreamBlocks = c.blocks.filter(b => b.events.some(e => (e.payload as { delta?: string }).delta === 's1')).length
  check('过滤来回切换后事件仍只消费一次', new Set(allSeqs).size === allSeqs.length && allSeqs.length === 4, `events=${allSeqs.length}`)
  check('过滤来回切换后流块不重复', w1StreamBlocks === 1, `s1块数=${w1StreamBlocks}`)
}

console.log(failures === 0 ? '\n★ 全部通过:每事件恰好消费一次,无重复渲染' : `\n${failures} 项失败 ❌`)
process.exit(failures === 0 ? 0 : 1)
