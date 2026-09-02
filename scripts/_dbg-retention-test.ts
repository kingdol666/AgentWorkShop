/**
 * 保留策略单元验证(hardening GROW-1 / AC-5):临时库种过期行 → sweep → 断言。
 * 用法:npx tsx scripts/_dbg-retention-test.ts
 */
import { DatabaseSync } from 'node:sqlite'
import { runRetentionSweep } from '../server/services/workshop/db/retention'

const db = new DatabaseSync(':memory:')
db.exec('CREATE TABLE messages (id TEXT PRIMARY KEY, created_at TEXT NOT NULL)')
db.exec('CREATE TABLE audit_log (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL)')
db.exec('CREATE TABLE approval_history (id TEXT PRIMARY KEY, created_at TEXT NOT NULL)')
const old = new Date(Date.now() - 40 * 86_400_000).toISOString()
const ancient = new Date(Date.now() - 120 * 86_400_000).toISOString()
const fresh = new Date(Date.now() - 1000).toISOString()
for (let i = 0; i < 12; i++) {
  db.prepare('INSERT INTO messages VALUES (?,?)').run(`m${i}`, i < 8 ? old : fresh)
  db.prepare('INSERT INTO audit_log (at) VALUES (?)').run(i < 6 ? ancient : fresh)
  db.prepare('INSERT INTO approval_history VALUES (?,?)').run(`a${i}`, fresh)
}
console.log('SWEEP =', JSON.stringify(runRetentionSweep(db)))
const c = (t: string) => String((db.prepare(`SELECT COUNT(*) c FROM ${t}`).get() as { c: number }).c)
console.log(`剩量 messages=${c('messages')}(期望4) audit=${c('audit_log')}(期望6) approval=${c('approval_history')}(期望12)`)

process.env.AW_RETENTION_DISABLED = '1'
console.log('逃生门 =', JSON.stringify(runRetentionSweep(db)), '(期望 [])')
