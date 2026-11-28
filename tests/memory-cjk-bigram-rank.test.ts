/**
 * 中文 FTS 排序回归（2026-11-28 遗留项闭环）：
 * 单字 OR 榜的 bm25 长文档归一化惩罚长知识行 + RRF(k=60) 压缩名次差 ——
 * 唯一中文词查询下,长语义知识行会被一批共享散字的新鲜短过程行挤到 10 名开外,
 * 叠加时近/重要度后被挤出注入窗。修复:recall 增设「二元短语精度榜」
 * (buildBigramQuery),相邻字对只在词真的出现时命中,精确行拿独立高权重榜。
 *
 * 复现要点:过程行必须含查询散字(水/冷/流/量)但**不含相邻的「冷却」**——
 * 这样旧口径下它们靠 bm25+时近霸榜,新口径下只有知识行命中二元短语榜。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'

process.env.AGENTWORKSHOP_TEST = '1'
process.env.AW_MODE = 'home'
process.env.AW_MEMORY_GRAPH_RETRIEVAL = '0'

const { initWorkshopDb } = await import('../server/services/workshop/db/database')
const { createMemoryRepo } = await import('../server/services/workshop/db/memory.repo')
const { AgentMemory, buildBigramQuery, buildMatchQuery } = await import('../server/services/workshop/runtime/memory')

const db = new DatabaseSync(':memory:')
initWorkshopDb(db)
const repo = createMemoryRepo(db)
const CH = 'ch-bigram-test'
const mk = (agentId: string) => new AgentMemory(repo, { agentId, channelId: CH })

test('buildBigramQuery 产出相邻字对短语,并正确截断', () => {
  const q = buildBigramQuery('冷却水流量')
  assert.equal(q, '"冷 却" OR "却 水" OR "水 流" OR "流 量"', '相邻字对按序展开')
  assert.equal(buildBigramQuery('调整'), '"调 整"', '单 run 两字 → 一对')
  const capped = buildBigramQuery('一二三四五六七八九十甲乙丙丁')
  assert.ok(capped && capped.split(' OR ').length <= 8, '词项必须截断防爆炸')
  assert.equal(buildBigramQuery('SP 227 ok'), null, '无 CJK 串 → 无短语榜')
  // 与单字榜互补:同一查询两条榜的词项形态
  const match = buildMatchQuery('冷却水流量')
  assert.ok(match && match.includes('"冷"') && match.includes('"却"'), '单字榜仍是召回兜底')
})

test('唯一中文词查询:精确含词的知识行不再被散字过程行挤出前列', async () => {
  const m = mk('ag-know')
  // 长语义知识行(400+ 字,bm25 长文档归一化会重罚它):3 天前沉淀
  const knowledge = [
    '冷却水流量工艺知识手册：产线长期验证结论,冷却水流量控制在 32 L/min 时良率最优。',
    '若冷却水流量低于 28 L/min,模温波动超过 2.3 度,产品出现缩痕的概率显著上升;',
    '若高于 36 L/min,能耗明显增加而良率无进一步改善。调参顺序:先定冷却水流量,',
    '再调熔体温度,最后微调保压压力。历史教训:只调保压不调冷却水流量,症状会复发。',
  ].join('')
  await m.save({ title: '冷却水流量调参知识', content: knowledge, scope: 'shared', importance: 0.85 })
  // 把知识行回拨 3 天,让过程行拿满时近分(复现「时近/重要度占优」的挤压)
  db.prepare(`UPDATE agent_memories SET created_at = datetime('now', '-3 days') WHERE agent_id = 'ag-know' AND kind = 'semantic'`)
    .run()
  // 14 条新鲜短过程行:含散字 水/冷/流/量,但不含相邻「冷却」→ 精度榜零命中
  for (let i = 0; i < 14; i++) {
    await m.recordTaskOutcome({
      id: `task-big-${i}`, channelId: CH, title: `水冷机组流量微调 ${i}`,
      description: `调整流量阀开度,记录水流读数与产量,批次 ${i}`,
      state: 'COMPLETED', assigneeId: 'ag-know', sessionId: '', artifacts: [], history: [],
    } as never)
  }
  const hits = await m.recallRows('冷却水流量', { scope: 'shared', limit: 5 })
  assert.ok(hits.length > 0, '查询必须命中')
  const top = hits[0]!
  assert.equal(top.kind, 'semantic', `榜首应是知识行,实际: ${top.kind} ${top.title}`)
  assert.ok(top.title.includes('冷却水流量调参知识'), `榜首应是知识行,实际: ${top.title}`)
  // 旧口径下知识行排在 10 名开外;新口径必须进前 2
  const rank = hits.findIndex(h => h.title.includes('冷却水流量调参知识')) + 1
  assert.ok(rank >= 1 && rank <= 2, `知识行排名 ${rank} 应 ≤2`)
})

test('精度榜不破坏既有排序:纯英文/数字查询与普通中文查询行为不变', async () => {
  const m = mk('ag-order')
  await m.save({ title: '熔体温度设定', content: '熔体温度 SP 227,实际 208.6', scope: 'shared' })
  const hitsCjk = await m.recallRows('熔体温度', { scope: 'shared' })
  assert.ok(hitsCjk.some(h => h.title.includes('熔体温度设定')), '中文查询仍命中')
  const hitsEn = await m.recallRows('SP 227', { scope: 'shared' })
  assert.ok(hitsEn.some(h => h.content.includes('227')), '英文数字查询仍命中(无二元榜,行为不变)')
})
