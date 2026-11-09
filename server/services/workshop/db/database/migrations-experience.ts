/**
 * RSI 经验层（2026-11-09）增量迁移。
 *
 * 只做加列/加索引，不重建任何表：
 *  - agent_memories 增加 outcome/evidence_json/scope_kind/scope_key/status/expires_at
 *    —— 经验条目的证据链、可共享作用域与生命周期状态（plan WP-A1）；
 *  - analysis_reports 增加 recipe_run_id（WP-D1 证据外键；写入路径随后承接）。
 *
 * 时序要求：本函数在 migrateSessionContextColumns 之后执行即可；不涉及 tasks 重建。
 * 既有行按默认值解释：outcome='neutral' / scope_kind='session' / status='active'
 * —— 老行等价于"未经验证的会话级叙事记忆"，行为与迁移前一致（不加分、不参与经验门）。
 */
import type { DatabaseSync } from 'node:sqlite'
import { migrateAddColumn } from './migrations'

export function migrateExperienceColumns(db: DatabaseSync): void {
  // 结果极性 + 证据链：evidence_json 契约见 ExperienceEvidence（非法 JSON 由 repo 拒绝写入）
  migrateAddColumn(db, 'agent_memories', 'outcome', 'TEXT NOT NULL DEFAULT \'neutral\'')
  migrateAddColumn(db, 'agent_memories', 'evidence_json', 'TEXT NOT NULL DEFAULT \'\'')
  // 作用域：scope_key 存 lineId/productId（scope_kind=session/channel/global 时为空串）
  migrateAddColumn(db, 'agent_memories', 'scope_kind', 'TEXT NOT NULL DEFAULT \'session\'')
  migrateAddColumn(db, 'agent_memories', 'scope_key', 'TEXT NOT NULL DEFAULT \'\'')
  // 生命周期：line/global 写入默认 candidate（先验证再晋级，防错误经验复利）
  migrateAddColumn(db, 'agent_memories', 'status', 'TEXT NOT NULL DEFAULT \'active\'')
  migrateAddColumn(db, 'agent_memories', 'expires_at', 'TEXT')
  // WP-D1：效果指标与 recipe 的显式外键（此前只能靠 ops log 文本关联）
  migrateAddColumn(db, 'analysis_reports', 'recipe_run_id', 'TEXT NOT NULL DEFAULT \'\'')
}

/**
 * 索引必须在迁移补列之后创建（缺列时建索引会中断初始化）。
 * scope 索引服务跨 Channel 共享检索；status 索引服务过期/退休扫描。
 */
export function ensureExperienceIndexes(db: DatabaseSync): void {
  db.exec('CREATE INDEX IF NOT EXISTS idx_memories_scope ON agent_memories(scope_kind, scope_key, status, created_at DESC)')
  db.exec('CREATE INDEX IF NOT EXISTS idx_memories_status ON agent_memories(status, expires_at)')
  db.exec('CREATE INDEX IF NOT EXISTS idx_analysis_recipe_run ON analysis_reports(recipe_run_id)')
}
