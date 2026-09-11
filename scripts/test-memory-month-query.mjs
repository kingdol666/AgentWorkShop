/**
 * 回归测试 —— 记忆反思查询下推(P1-3)
 * 断言:listByAgentKindMonth / countByAgentKindMonth 与「全量拉取 + JS filter」结果完全一致,
 * 且跨月/跨年边界正确。
 * 运行: npx tsx scripts/test-memory-month-query.mjs
 */
import { DatabaseSync } from 'node:sqlite'
import { readFileSync } from 'node:fs'
import { createMemoryRepo } from '../server/services/workshop/db/memory.repo.ts'

let pass = 0, fail = 0
const check = (n, ok, d = '') => {
  if (ok) {
    pass++
    console.log('  PASS  ' + n)
    return
  }
  fail++
  console.log('  FAIL  ' + n + (d ? '  — ' + d : ''))
}

// 用真实 schema 建库:保证测试与生产表结构(索引/触发器/唯一约束)完全一致
const db = new DatabaseSync(':memory:')
const schemaSql = readFileSync(new URL('../server/services/workshop/db/schema.sql', import.meta.url), 'utf8')
db.exec(schemaSql)

const repo = createMemoryRepo(db)
const AGENT = 'a1'
// 直接写主表以便精确控制 created_at(upsert 不接受时间覆盖)
// 先建 channel(FK 约束),再插记忆行
db.prepare(`INSERT INTO channels (id, name, created_at, updated_at) VALUES ('c1','t',?,?)`)
  .run(new Date().toISOString(), new Date().toISOString())
const ins = db.prepare(
  `INSERT INTO agent_memories (id, channel_id, agent_id, kind, title, title_fts, content, importance, dedup_key, access_count, created_at)
   VALUES (?, 'c1', ?, ?, ?, ?, ?, 1, ?, 0, ?)`,
)
for (const [id, kind, at] of [
  ['m1', 'episodic-task', '2026-09-01T00:00:00.000Z'],
  ['m2', 'episodic-task', '2026-09-15T12:00:00.000Z'],
  ['m3', 'episodic-task', '2026-09-30T23:59:59.000Z'],
  ['m4', 'episodic-task', '2026-10-01T00:00:00.000Z'], // 下月首刻,必须排除
  ['m5', 'episodic-session', '2026-09-10T00:00:00.000Z'], // 不同 kind,必须排除
  ['m6', 'episodic-task', '2025-12-31T23:00:00.000Z'], // 去年 12 月
  ['m7', 'episodic-task', '2026-01-01T00:00:00.000Z'],
]) {
  ins.run(id, AGENT, kind, id, id, id, id, at)
}
// 另一 agent 的行不得串入
ins.run('other1', 'a2', 'episodic-task', 'o', 'o', 'o', 'o', '2026-09-05T00:00:00.000Z')

console.log('\n━━━ 1. 与全量 JS filter 语义一致 ━━━')
const all = repo.listByAgentWithRowid(AGENT, 1_000_000)
for (const month of ['2026-09', '2026-10', '2025-12', '2026-01', '2027-01']) {
  const expect = all.filter(r => r.kind === 'episodic-task' && r.createdAt.slice(0, 7) === month).map(r => r.id).sort()
  const got = repo.listByAgentKindMonth(AGENT, 'episodic-task', month).map(r => r.id).sort()
  check(`${month}: 行集一致 [${expect.join(',')}]`, JSON.stringify(expect) === JSON.stringify(got), `got [${got.join(',')}]`)
  check(`${month}: 计数一致 (${expect.length})`, repo.countByAgentKindMonth(AGENT, 'episodic-task', month) === expect.length)
}

console.log('\n━━━ 2. 边界正确性 ━━━')
const sep = repo.listByAgentKindMonth(AGENT, 'episodic-task', '2026-09').map(r => r.id)
check('9 月含首日 m1', sep.includes('m1'))
check('9 月含末日 23:59:59 的 m3', sep.includes('m3'))
check('9 月不含 10-01T00:00:00 的 m4', !sep.includes('m4'))
check('9 月不含 session 类 m5', !sep.includes('m5'))
check('9 月共 3 条', sep.length === 3, 'len=' + sep.length)
check('12 月跨年查询正确', repo.listByAgentKindMonth(AGENT, 'episodic-task', '2025-12').map(r => r.id).join(',') === 'm6')

console.log(`\n━━━ 结果:${pass} passed, ${fail} failed ━━━\n`)
process.exit(fail === 0 ? 0 : 1)
