/**
 * 场景 A —— v17 迁移与不变量回填:新表/新列存在;旧结构库升级后既有 Channel 保持 private/owner_approve/owner_only/chat 关(行为零变化);owner 成员回填幂等、非法取值收敛为最保守档。
 *
 * 原文 scripts/test-group-chat-unit.ts 第 170–232 行(section 横幅 + 顶层语句块):
 * 语句逐行原文搬运,仅把顶层块包成函数、把共享状态改为 ctx 参数。
 *
 * 本段用**旧结构库**验证真实升级路径,故 node:sqlite 仍是函数内原位 dynamic import(与拆分前一致)。
 */
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { check, initWorkshopDb, section } from './lib'
import type { GroupChatTestContext } from './lib'

export async function runSectionA(ctx: GroupChatTestContext): Promise<void> {
  const { db, A } = ctx
  section('A. v17 迁移与不变量回填')
  const tables = (db.prepare('SELECT name FROM sqlite_master WHERE type=\'table\'').all() as Array<{ name: string }>).map(r => r.name)
  for (const t of ['channel_members', 'chat_messages', 'chat_deliveries', 'user_notifications', 'outbox_events', 'hitl_requests']) {
    check(`表 ${t} 已创建`, tables.includes(t))
  }
  const cols = (db.prepare('PRAGMA table_info(channels)').all() as Array<{ name: string }>).map(c => c.name)
  for (const c of ['visibility', 'join_policy', 'approval_policy', 'chat_enabled', 'version']) {
    check(`channels.${c} 已加列`, cols.includes(c))
  }
  // 迁移安全:用**旧结构库**验证真实升级路径。
  // 关键语义:ALTER TABLE ADD COLUMN 的 DEFAULT 会填充既有行 → 升级后既有 Channel
  // 一律 private/owner_approve/owner_only/chat_enabled=0,**行为零变化**;
  // 且迁移**不得**在每次启动时把 owner 显式设置的 public 打回 private(否则设置无法持久)。
  const { DatabaseSync } = await import('node:sqlite')
  const legacyPath = join(process.env.AW_DATA_DIR!, 'legacy-upgrade.sqlite')
  const legacyDb = new DatabaseSync(legacyPath)
  legacyDb.exec(`CREATE TABLE channels (
    id             TEXT PRIMARY KEY,
    name           TEXT NOT NULL,
    description    TEXT NOT NULL DEFAULT '',
    scenario_prompt TEXT NOT NULL DEFAULT '',
    llm_json       TEXT NOT NULL DEFAULT '',
    lead_agent_id  TEXT,
    workspace      TEXT NOT NULL DEFAULT '',
    enabled        INTEGER NOT NULL DEFAULT 1,
    owner_user_id  TEXT,
    created_at     TEXT NOT NULL,
    updated_at     TEXT NOT NULL
  )`)
  const now = new Date().toISOString()
  const legacyId = randomUUID()
  legacyDb.prepare('INSERT INTO channels (id, name, description, scenario_prompt, llm_json, lead_agent_id, workspace, enabled, owner_user_id, created_at, updated_at) VALUES (?, ?, \'\', \'\', \'\', NULL, \'\', 1, ?, ?, ?)')
    .run(legacyId, 'legacy', A.id, now, now)
  const orphanId = randomUUID()
  legacyDb.prepare('INSERT INTO channels (id, name, description, scenario_prompt, llm_json, lead_agent_id, workspace, enabled, owner_user_id, created_at, updated_at) VALUES (?, ?, \'\', \'\', \'\', NULL, \'\', 1, NULL, ?, ?)')
    .run(orphanId, 'orphan', now, now)
  // 升级
  initWorkshopDb(legacyDb)
  const upg = legacyDb.prepare('SELECT id, visibility, join_policy AS joinPolicy, approval_policy AS approvalPolicy, chat_enabled AS chatEnabled FROM channels WHERE id = ?').get(legacyId) as { visibility: string, joinPolicy: string, approvalPolicy: string, chatEnabled: number }
  check('升级后既有 Channel visibility=private', upg.visibility === 'private', upg.visibility)
  check('升级后既有 Channel joinPolicy=owner_approve', upg.joinPolicy === 'owner_approve', upg.joinPolicy)
  check('升级后既有 Channel approvalPolicy=owner_only', upg.approvalPolicy === 'owner_only', upg.approvalPolicy)
  check('升级后既有 Channel chatEnabled=0(不可写公开群聊)', upg.chatEnabled === 0, String(upg.chatEnabled))
  const upgOwnerMembers = legacyDb.prepare('SELECT user_id AS userId, role, status FROM channel_members WHERE channel_id = ?').all(legacyId) as Array<{ userId: string, role: string, status: string }>
  check('升级回填 owner 成员且恰好一条 active owner', upgOwnerMembers.length === 1 && upgOwnerMembers[0]!.userId === A.id && upgOwnerMembers[0]!.role === 'owner' && upgOwnerMembers[0]!.status === 'active', JSON.stringify(upgOwnerMembers))
  const upgOrphan = legacyDb.prepare('SELECT visibility, chat_enabled AS chatEnabled FROM channels WHERE id = ?').get(orphanId) as { visibility: string, chatEnabled: number }
  check('升级后 owner=NULL 遗留 Channel 仍为 private + chat 关', upgOrphan.visibility === 'private' && upgOrphan.chatEnabled === 0)
  check('升级后 owner=NULL 遗留 Channel 无 owner 成员行', (legacyDb.prepare('SELECT COUNT(*) AS n FROM channel_members WHERE channel_id = ?').get(orphanId) as { n: number }).n === 0)
  // 幂等 + 不覆盖合法设置:owner 显式开启 public 后再次 init 必须保持 public(设置可持久)
  legacyDb.exec(`UPDATE channels SET visibility = 'public', join_policy = 'open', approval_policy = 'any_member', chat_enabled = 1 WHERE id = '${legacyId}'`)
  initWorkshopDb(legacyDb)
  const again = legacyDb.prepare('SELECT visibility, join_policy AS joinPolicy, approval_policy AS approvalPolicy, chat_enabled AS chatEnabled FROM channels WHERE id = ?').get(legacyId) as { visibility: string, joinPolicy: string, approvalPolicy: string, chatEnabled: number }
  check('重复 init 幂等且不覆盖 owner 显式设置', again.visibility === 'public' && again.joinPolicy === 'open' && again.approvalPolicy === 'any_member' && again.chatEnabled === 1, JSON.stringify(again))
  // 非法值收敛:未知取值回落最保守档(不放宽权限)
  legacyDb.exec(`UPDATE channels SET visibility = 'PUBLIC_BOGUS', join_policy = 'bogus', approval_policy = 'bogus', chat_enabled = 7 WHERE id = '${legacyId}'`)
  initWorkshopDb(legacyDb)
  const clamped = legacyDb.prepare('SELECT visibility, join_policy AS joinPolicy, approval_policy AS approvalPolicy, chat_enabled AS chatEnabled FROM channels WHERE id = ?').get(legacyId) as { visibility: string, joinPolicy: string, approvalPolicy: string, chatEnabled: number }
  check('非法取值收敛为最保守档', clamped.visibility === 'private' && clamped.joinPolicy === 'owner_approve' && clamped.approvalPolicy === 'owner_only' && clamped.chatEnabled === 0, JSON.stringify(clamped))
  legacyDb.close()
}
