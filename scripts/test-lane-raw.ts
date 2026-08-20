/**
 * LaneBlocks raw 模式逻辑回归(Node 级):pinia + vue 直接驱动
 * useClusteredBlocks(raw),断言 lane 聚类产块/隔离/实时更新/合并语义。
 * 运行:pnpm exec tsx scripts/test-lane-raw.ts
 */
import { createPinia, setActivePinia } from 'pinia'
import { nextTick } from 'vue'
import { useEventsStore } from '../app/stores/workshop/events'
// Nuxt auto-import 的 toValue 在纯 Node 环境手动注入(useClusteredBlocks 未显式 import)
;

(globalThis as { toValue?: unknown }).toValue = (v: unknown): unknown =>
  typeof v === 'function' ? (v as () => unknown)() : v

let failures = 0
const check = (name: string, ok: boolean, detail = ''): void => {
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures += 1
}

async function main(): Promise<void> {
  setActivePinia(createPinia())
  const events = useEventsStore()
  const { useClusteredBlocks } = await import('../app/composables/workshop/useClusteredBlocks')

  const { blocks, totalEvents } = useClusteredBlocks(
    () => 'c1',
    { predicate: (e: { agentId?: string | null }) => e.agentId === 'w1', resetKey: () => 'w1', raw: true },
  )

  const env = (seq: number, type: string, payload: Record<string, unknown>, agentId?: string) =>
    ({ v: 1, type, seq, at: 't', channelId: 'c1', agentId, payload }) as never

  events.ingest(env(1, 'channel.snapshot', {}))
  events.ingest(env(2, 'agent.status', { state: 'busy' }, 'w1'))
  await nextTick()
  check('基础事件成块(life)', blocks.value.length === 1 && blocks.value[0]!.kind === 'life', `blocks=${blocks.value.length}`)

  events.ingest(env(3, 'agent.delta', { delta: 'hello' }, 'w1'))
  events.ingest(env(4, 'agent.delta', { delta: ' world' }, 'w1'))
  await nextTick()
  const stream = blocks.value.find(b => b.kind === 'stream')
  check('delta 流成 stream 块', !!stream)
  check('连续 delta 在 store 层合并为单 item(全文完整)', stream !== undefined
  && stream.events.length === 1
  && (stream.events[0] as { payload?: { delta?: string } }).payload?.delta === 'hello world', `events=${stream?.events.length}`)

  events.ingest(env(5, 'agent.status', { state: 'idle' }, 'w2'))
  await nextTick()
  check('其他 agent 事件不进本 lane', blocks.value.length === 2, `blocks=${blocks.value.length}`)
  check('totalEvents 只计谓词内事件(合并后 2 item)', totalEvents.value === 2, `total=${totalEvents.value}`)

  // 历史回填(头部插入)→ 重建不重复
  const history = [env(1, 'task.status', { state: 'SUBMITTED' })]
  const ring = (events as unknown as { rings: Record<string, { items: unknown[] }> }).rings.c1!
  for (const e of history) if (!ring.items.some(x => (x as { seq: number }).seq === (e as unknown as { seq: number }).seq)) ring.items.push(e)
  ring.items.sort((a, b) => (a as { seq: number }).seq - (b as { seq: number }).seq)
  await nextTick()
  check('历史头部插入后重建(块仍只含本 lane 事件)', blocks.value.every(b => b.agentId === 'w1' || b.agentId === undefined), `blocks=${blocks.value.length}`)

  console.log(failures === 0 ? '\n★ raw lane 聚类回归通过' : `\n${failures} 项失败`)
  process.exit(failures === 0 ? 0 : 1)
}
main().catch((err) => {
  console.error('回归异常:', err)
  process.exit(1)
})
