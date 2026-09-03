/**
 * 动态记忆感知测试:按需抓取(recallRows scope 过滤/原文还原/touch)、
 * 主动沉淀(save 私有/共享分流 + 共享域 dedupKey 命名空间)、
 * 记忆引子(小预算 primer + 工具提示行)。
 * 运行: npx tsx scripts/test-memory-dynamic.ts
 */
import type { DatabaseSync } from 'node:sqlite'
import { openWorkshopDb } from '../server/services/workshop/db/database'
import { createMemoryRepo, TEAM_AGENT_ID } from '../server/services/workshop/db/memory.repo'
import { AgentMemory } from '../server/services/workshop/runtime/memory'

let failures = 0
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures += 1
}

const db: DatabaseSync = openWorkshopDb(':memory:')
const repo = createMemoryRepo(db)
const seg = (s: string): string => s.replace(/([\u4e00-\u9fff])/g, ' $1 ')

// 播种:a1 私有 × 2、a2 私有 × 1、team 公共 × 1、他 channel 的 team 行 × 1(隔离守卫)
repo.upsert({ channelId: 'ch1', agentId: 'a1', kind: 'episodic-task', title: '网关限流方案', titleFts: seg('网关限流方案'), content: seg('最终采用令牌桶算法限流,阈值100qps'), importance: 0.8, taskId: 't1', dedupKey: 'task:t1' })
repo.upsert({ channelId: 'ch1', agentId: 'a1', kind: 'episodic-task', title: '部署脚本草稿', titleFts: seg('部署脚本草稿'), content: seg('deploy.sh 需要先source env'), importance: 0.4, taskId: 't2', dedupKey: 'task:t2' })
repo.upsert({ channelId: 'ch1', agentId: 'a2', kind: 'episodic-task', title: '他人限流笔记', titleFts: seg('他人限流笔记'), content: seg('a2自己的限流杂记'), importance: 0.8, taskId: 't3', dedupKey: 'task:t3' })
repo.upsert({ channelId: 'ch1', agentId: TEAM_AGENT_ID, kind: 'semantic', title: 'channel 限流约定', titleFts: seg('channel 限流约定'), content: seg('全channel统一用令牌桶,禁用计数器'), importance: 0.9, taskId: null, dedupKey: 'conv:ratelimit' })
repo.upsert({ channelId: 'ch2', agentId: TEAM_AGENT_ID, kind: 'semantic', title: '他channel限流约定', titleFts: seg('他channel限流约定'), content: seg('ch2专属公共记忆不应被ch1看到'), importance: 0.9, taskId: null, dedupKey: 'conv:other' })

const memA1 = new AgentMemory(repo, { channelId: 'ch1', agentId: 'a1' })

console.log('--- 按需抓取 recallRows ---')
{
  const auto = await memA1.recallRows('限流 令牌桶')
  check('auto 域命中本人 + 公共记忆', auto.some(s => s.title === '网关限流方案') && auto.some(s => s.title === 'channel 限流约定'), JSON.stringify(auto.map(s => s.title)))
  check('auto 域不含他人私有记忆', auto.every(s => s.title !== '他人限流笔记'))
  check('auto 域不含他 channel 公共记忆', auto.every(s => s.title !== '他channel限流约定'))
  check('source 标注 private/shared', auto.some(s => s.source === 'private') && auto.some(s => s.source === 'shared'))
  const own = auto.find(s => s.title === '网关限流方案')
  check('content 还原为未切分原文', own !== undefined && !/\s/.test(own.content.slice(0, 4)) && own.content.includes('令牌桶'), own?.content.slice(0, 20))
  check('返回综合分 score', auto.every(s => typeof s.score === 'number' && s.score > 0))

  const sharedOnly = await memA1.recallRows('限流', { scope: 'shared' })
  check('shared 域仅公共记忆', sharedOnly.length > 0 && sharedOnly.every(s => s.source === 'shared'), JSON.stringify(sharedOnly.map(s => s.title)))
  check('shared 域严格本 channel', sharedOnly.every(s => s.title !== '他channel限流约定'))

  const privOnly = await memA1.recallRows('限流', { scope: 'private' })
  check('private 域仅本人记忆', privOnly.length > 0 && privOnly.every(s => s.source === 'private'), JSON.stringify(privOnly.map(s => s.title)))

  const before = repo.listByAgent('a1', 10).find(r => r.title === '网关限流方案')!.accessCount
  await memA1.recallRows('网关 限流')
  const after = repo.listByAgent('a1', 10).find(r => r.title === '网关限流方案')!.accessCount
  check('recallRows 触发 touch(强化后续排序)', after === before + 1, `before=${before} after=${after}`)

  // scope 域内完全无记忆才真正返回空(全新 channel;有记忆时弱命中/时近兜底会返回行,by design)
  const none = await new AgentMemory(repo, { channelId: 'ch-empty', agentId: 'nobody' }).recallRows('完全不存在的关键词xyzq')
  check('无命中返回空数组(无记忆 agent)', Array.isArray(none) && none.length === 0)
  const fallback = await memA1.recallRows('完全不存在的关键词xyzq')
  check('FTS 无命中走时近兜底(有记忆 agent 返回最近行)', fallback.length > 0, JSON.stringify(fallback.map(s => s.title)))
}

console.log('\n--- 主动沉淀 save(私有/共享分流)---')
{
  const priv = await memA1.save({ title: 'SQLite 并发写坑', content: '并发写会 SQLITE_BUSY,须串行化写入', scope: 'private', dedupKey: 'note:sqlite' })
  check('私有沉淀落入本人域', repo.findByAgentDedup('ch1', 'a1', 'note:sqlite') !== null && priv.scope === 'private')

  const shared = await memA1.save({ title: '限流阈值结论', content: '全队统一令牌桶阈值100qps', scope: 'shared', dedupKey: 'conv:threshold' })
  const teamRow = repo.findByAgentDedup('ch1', TEAM_AGENT_ID, `agent:a1:conv:threshold`)
  check('共享沉淀落入 team 公共域(来源命名空间 dedupKey)', teamRow !== null && shared.dedupKey === 'agent:a1:conv:threshold')

  // 同 raw key 不同 agent:命名空间隔离互不覆盖
  const memA2 = new AgentMemory(repo, { channelId: 'ch1', agentId: 'a2' })
  await memA2.save({ title: 'a2 的阈值结论', content: 'a2认为阈值应按服务分级', scope: 'shared', dedupKey: 'conv:threshold' })
  const teamRows = repo.listByAgentChannel('ch1', TEAM_AGENT_ID, 100).filter(r => r.content.includes('阈值') || r.title.includes('阈值'))
  check('多 agent 同 raw key 共享沉淀互不覆盖', repo.findByAgentDedup('ch1', TEAM_AGENT_ID, 'agent:a1:conv:threshold') !== null && repo.findByAgentDedup('ch1', TEAM_AGENT_ID, 'agent:a2:conv:threshold') !== null, `rows=${teamRows.length}`)

  // 共享沉淀即时对全员可检索
  const a2sees = await memA2.recallRows('阈值 令牌桶', { scope: 'shared' })
  check('共享沉淀对其他 agent 即时可检索', a2sees.some(s => s.title === '限流阈值结论'), JSON.stringify(a2sees.map(s => s.title)))

  // 稳定 dedupKey 幂等刷新不重复
  await memA1.save({ title: '限流阈值结论', content: '修订:阈值升到200qps', scope: 'shared', dedupKey: 'conv:threshold' })
  const count = repo.listByAgentChannel('ch1', TEAM_AGENT_ID, 100).filter(r => r.dedupKey === undefined && r.title === '限流阈值结论').length
  const refreshed = repo.listByAgentChannel('ch1', TEAM_AGENT_ID, 100).some(r => r.title === '限流阈值结论')
  check('稳定 dedupKey 幂等刷新', refreshed && count <= 1)
}

console.log('\n--- 记忆引子 primer(小预算注入)---')
{
  const block = await memA1.recall('限流 令牌桶 部署', { touch: false })
  check('primer 返回记忆块', block !== null)
  check('primer 含按需抓取工具提示', block !== null && block.includes('search_memory'), block?.slice(-80))
  // v2 三层注入:L0 简报(save(shared) 后自动存在)+ L1 引子 + 提示,同在 300 tok 引子预算 + 500 tok 总预算内
  check('primer 含 L0 会话简报', block !== null && block.includes('会话简报'))
  check('primer 小预算(行数受限)', block !== null && block.split('\n').length < 16, `lines=${block?.split('\n').length}`)

  const memTiny = new AgentMemory(repo, { channelId: 'ch1', agentId: 'a1', budgetTokens: 5 })
  check('极小预算 primer 无行则 null', (await memTiny.recall('限流')) === null)
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
