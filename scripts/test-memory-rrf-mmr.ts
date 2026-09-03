/**
 * 记忆检索 v2 算法测试:RRF 融合 / MMR 多样性 / kind 感知半衰期 / 任务关联加权 / 策展层排除。
 * 运行: npx tsx --tsconfig .nuxt/tsconfig.server.json scripts/test-memory-rrf-mmr.ts
 */
import type { DatabaseSync } from 'node:sqlite'
import { openWorkshopDb } from '../server/services/workshop/db/database'
import { createMemoryRepo, TEAM_AGENT_ID } from '../server/services/workshop/db/memory.repo'
import { AgentMemory, buildMatchQuery, estimateTokens } from '../server/services/workshop/runtime/memory'

let failures = 0
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures += 1
}

const db: DatabaseSync = openWorkshopDb(':memory:')
const repo = createMemoryRepo(db)
const seg = (s: string): string => s.replace(/([\u4e00-\u9fff])/g, ' $1 ')

// ===== buildMatchQuery:CJK 词项扩容 + 去重 =====
console.log('\n--- buildMatchQuery(CJK 词项扩容)---')
{
  const q = buildMatchQuery('网关限流方案讨论,部署脚本与令牌桶阈值约定')
  const termCount = q ? q.split(' OR ').length : 0
  check('CJK 单字词项上限提升(>12)', termCount > 12, `terms=${termCount}`)
  const deduped = buildMatchQuery('限流 限流 限流')
  check('词项去重', deduped !== null && deduped.split(' OR ').length === 2, `terms=${deduped}`) // 限/流
  check('token 估算为正', estimateTokens('abc 中文') > 0)
}

// ===== RRF 融合:FTS+向量双榜融合(词袋 embedder)=====
console.log('\n--- RRF 融合(混合检索)---')
{
  // hash 词袋 provider:同词集 → 相近向量(零网络)
  const { createHashEmbeddingProvider } = await import('../server/services/workshop/runtime/embedding-provider')
  const embedder = createHashEmbeddingProvider(64)

  const rows = [
    { dedup: 'task:a', title: 'Redis 缓存穿透方案', content: '布隆过滤器前置拦截,空值缓存五分钟' },
    { dedup: 'task:b', title: 'Redis 雪崩预案', content: '过期时间加随机抖动,多级缓存兜底' },
    { dedup: 'task:c', title: '部署脚本清单', content: 'docker compose 拉镜像,健康检查后切流量' },
  ]
  for (const r of rows) {
    repo.upsert({ channelId: 'ch1', agentId: 'a1', kind: 'episodic-task', title: r.title, titleFts: seg(r.title), content: seg(r.content), importance: 0.8, taskId: r.dedup, dedupKey: `task:${r.dedup}` })
  }
  const mem = new AgentMemory(repo, { channelId: 'ch1', agentId: 'a1', embedder })
  // 向量可命中(词袋相似)但 FTS 无词面匹配的查询:RRF 仍能通过向量榜给出结果
  const hits = await mem.recallRows('cache 穿透 拦截')
  check('向量榜独有命中可达(RRF 不丢向量结果)', hits.some(s => s.title === 'Redis 缓存穿透方案'), JSON.stringify(hits.map(s => s.title)))

  // 双榜同时命中:融合排序应把两榜都命中的排前
  const both = await mem.recallRows('Redis 雪崩')
  check('双榜命中排序靠前', both.length > 0 && both[0]!.title === 'Redis 雪崩预案', JSON.stringify(both.map(s => `${s.title}:${s.score}`)))
}

// ===== kind 感知半衰期:semantic 不衰减,episodic-task 14d =====
console.log('\n--- kind 感知半衰期 ---')
{
  const old = new Date(Date.now() - 60 * 86_400_000).toISOString()
  repo.upsert({ channelId: 'ch1', agentId: 'old1', kind: 'semantic', title: '六十天前的架构决策', titleFts: seg('六十天前的架构决策'), content: seg('内核结论:单写多读'), importance: 0.9, taskId: null, dedupKey: 'manual:old-sem' })
  repo.upsert({ channelId: 'ch1', agentId: 'old1', kind: 'episodic-task', title: '六十天前的任务', titleFts: seg('六十天前的任务'), content: seg('过程性记录,内容已过时'), importance: 0.9, taskId: 't-old', dedupKey: 'task:t-old' })
  // 直接改 created_at 模拟老化(upsert ON CONFLICT 会刷新,故用参数化 UPDATE)
  db.prepare('UPDATE agent_memories SET created_at = ? WHERE agent_id = ?').run(old, 'old1')

  const mem = new AgentMemory(repo, { channelId: 'ch1', agentId: 'old1' })
  const hits = await mem.recallRows('六十天前')
  const sem = hits.find(s => s.title === '六十天前的架构决策')
  const epi = hits.find(s => s.title === '六十天前的任务')
  check('semantic 知识不随时近衰减(分高于 episodic)', sem !== undefined && epi !== undefined && sem.score > epi.score, `sem=${sem?.score} epi=${epi?.score}`)
}

// ===== 任务关联加权:兄弟/父任务记忆置顶 =====
console.log('\n--- 任务关联加权(related-task boost)---')
{
  repo.upsert({ channelId: 'ch1', agentId: 'rel', kind: 'episodic-task', title: '无关旧任务', titleFts: seg('无关旧任务'), content: seg('数据库迁移完成,版本升到 v14'), importance: 0.8, taskId: 't-other', dedupKey: 'task:t-other' })
  repo.upsert({ channelId: 'ch1', agentId: 'rel', kind: 'episodic-task', title: '兄弟任务结论', titleFts: seg('兄弟任务结论'), content: seg('API 网关路由表已生成'), importance: 0.55, taskId: 't-sib1', dedupKey: 'task:t-sib1' })
  const mem = new AgentMemory(repo, { channelId: 'ch1', agentId: 'rel' })
  // 查询词面同时弱命中两行;兄弟任务 id 加权后必须反超高重要度旧行
  const hits = await mem.recallRows('任务 结论 数据库 网关', { relatedTaskIds: ['t-sib1', 't-parent'] })
  check('兄弟任务记忆加权反超(置顶)', hits[0]?.title === '兄弟任务结论', JSON.stringify(hits.map(s => `${s.title}:${s.score}`)))
  const hitsNoRel = await mem.recallRows('任务 结论 数据库 网关', { touch: false })
  check('无关联集时高重要度旧行居前(对照)', hitsNoRel[0]?.title === '无关旧任务', JSON.stringify(hitsNoRel.map(s => `${s.title}:${s.score}`)))
}

// ===== 策展层:brief 走 L0 置顶,L1 引子不重复;chronicle 不进 L1 但 L2 可检索 =====
console.log('\n--- 策展层(L0/L1/L2 分层)---')
{
  const mem = new AgentMemory(repo, { channelId: 'ch1', agentId: 'cur' })
  await mem.save({ title: '普通结论', content: '普通检索应该能命中', scope: 'private', dedupKey: 'note:normal' })
  mem.repo.upsert({ channelId: 'ch1', agentId: 'cur', kind: 'brief', title: '会话简报', titleFts: seg('会话简报'), content: seg('最近完成:普通结论'), importance: 0.6, taskId: null, dedupKey: 'brief:cur' })
  mem.repo.upsert({ channelId: 'ch1', agentId: 'cur', kind: 'chronicle', title: '团队编年史', titleFts: seg('团队编年史'), content: seg('完成 普通结论'), importance: 0.9, taskId: null, dedupKey: 'chronicle:ch1' })

  // L1(recall):brief 经 L0 路径恰好注入一次(去重靠 excludeCurated);chronicle 不进 L1
  const primer = await mem.recall('普通')
  const briefHits = (primer?.match(/会话简报/g) ?? []).length
  check('brief 恰好注入一次(L0 路径)', briefHits === 1, `hits=${briefHits}`)
  check('L1 引子不含 chronicle(防双份注入)', primer !== null && !primer.includes('编年史'))

  // L2(search_memory/recallRows):策展层可被检索(特性)
  const found = await mem.recallRows('编年史')
  check('L2 search_memory 可命中 chronicle', found.some(s => s.title === '团队编年史'), JSON.stringify(found.map(s => s.title)))
}

// ===== team 域可见性:episodic-team-task 对全员 shared 可检索 =====
console.log('\n--- team-task 共享域 ---')
{
  repo.upsert({ channelId: 'ch1', agentId: TEAM_AGENT_ID, kind: 'episodic-team-task', title: '团队任务成果', titleFts: seg('团队任务成果'), content: seg('数据迁移已全部完成并验证'), importance: 0.8, taskId: 't-team', dedupKey: 'team-task:t-team' })
  const memB = new AgentMemory(repo, { channelId: 'ch1', agentId: 'member-b' })
  const seen = await memB.recallRows('数据迁移', { scope: 'shared' })
  check('其他成员 shared 域可命中 team-task 行', seen.some(s => s.title === '团队任务成果'), JSON.stringify(seen.map(s => s.title)))
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
