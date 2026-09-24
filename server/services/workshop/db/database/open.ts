/**
 * 打开/初始化数据库(PRAGMA、建表、种子、sqlite-vec)
 * (由 server/services/workshop/db/database.ts 按职责拆出;内容逐行原文搬运)
 */
import type * as sqliteVec from 'sqlite-vec'
import { DatabaseSync } from 'node:sqlite'
import { SCHEMA_SQL } from './schema'
import { createRequire } from 'node:module'
import { migrateAddColumn, migrateAgentTeamTaskGuardrailColumns, migrateAgentTeamTaskGuardrails, migrateDropOwnerFks, migrateGroupChatV17, migrateLegacySchema, migrateMissingForeignKeys } from './migrations'
import { seedDefaultWorkshopData } from './seed'

export const require = createRequire(import.meta.url)
export function openWorkshopDb(path: string): DatabaseSync {
  // allowExtension + 尝试加载 sqlite-vec(向量检索);失败静默降级纯 FTS(受控环境可能禁扩展)
  const db = new DatabaseSync(path, { allowExtension: true })
  // busy_timeout:retention/backup 等第二连接持写锁时,主连接等待而非立即 SQLITE_BUSY
  db.exec('PRAGMA busy_timeout = 5000')
  try {
    const { getLoadablePath } = require('sqlite-vec') as typeof sqliteVec
    db.loadExtension(getLoadablePath())
  }
  catch {
    // 扩展不可用:记忆系统自动退化为 FTS-only(vecInit 将失败并禁用向量)
  }
  initWorkshopDb(db)
  return db
}

/** 对已打开的库执行初始化:WAL + 外键约束 + 建表 + 增量迁移 */
export function initWorkshopDb(db: DatabaseSync): void {
  db.exec('PRAGMA journal_mode = WAL;')
  // S6:synchronous=NORMAL(WAL 推荐档)——与 TSDB 仿真库对齐;断电最多丢最后一个事务,不损坏库
  db.exec('PRAGMA synchronous = NORMAL;')
  db.exec('PRAGMA foreign_keys = ON;')
  db.exec(SCHEMA_SQL)
  // Add guardrail metadata before any legacy tasks-table rebuild so values can be copied safely.
  migrateAgentTeamTaskGuardrailColumns(db)
  migrateLegacySchema(db)
  migrateAddColumn(db, 'channels', 'scenario_prompt', 'TEXT NOT NULL DEFAULT \'\'')
  // v11:channel 级默认 LLM(四引擎统一注入面;成员 config 显式指定时优先)
  migrateAddColumn(db, 'channels', 'llm_json', 'TEXT NOT NULL DEFAULT \'\'')
  // 派发路由理由(koda RouteDecision 借鉴):lead 派发留痕"为什么派给他",供审计与前端呈现
  migrateAddColumn(db, 'tasks', 'route_reason', 'TEXT NOT NULL DEFAULT \'\'')
  // v10:模板可见性列(既有库补列;默认 private,仅属主可见)
  migrateAddColumn(db, 'agents', 'visibility', 'TEXT NOT NULL DEFAULT \'private\'')
  migrateAddColumn(db, 'teams', 'visibility', 'TEXT NOT NULL DEFAULT \'private\'')
  // 回填:内置/遗留公共模板(owner NULL)强制 public —— 升级后保持全员可读可用
  db.exec('UPDATE agents SET visibility = \'public\' WHERE owner_user_id IS NULL')
  db.exec('UPDATE teams SET visibility = \'public\' WHERE owner_user_id IS NULL')
  // 运维日志(OpsLog)维度列:既有库补列(新库由上方 DDL 直建)
  migrateAddColumn(db, 'audit_log', 'line_id', 'TEXT NOT NULL DEFAULT \'\'')
  migrateAddColumn(db, 'audit_log', 'product_id', 'TEXT NOT NULL DEFAULT \'\'')
  migrateAddColumn(db, 'audit_log', 'recipe_id', 'TEXT NOT NULL DEFAULT \'\'')
  migrateAddColumn(db, 'audit_log', 'kind', 'TEXT NOT NULL DEFAULT \'\'')
  migrateAddColumn(db, 'audit_log', 'summary', 'TEXT NOT NULL DEFAULT \'\'')
  migrateMissingForeignKeys(db)
  // Run after legacy task-table rebuilds so guardrail metadata and its index survive upgrades.
  migrateAgentTeamTaskGuardrails(db)
  migrateDropOwnerFks(db)
  migrateGroupChatV17(db)
  seedDefaultWorkshopData(db)
}

/**
 * v17 迁移:群聊/成员/HITL 相关列与不变量回填。
 *
 * 规则(主计划 §3.1 / §13.7):
 * - 既有 owner 非 NULL 的 Channel 一律 private + owner_approve + owner_only + chat_enabled=0,
 *   即**默认不改变任何既有可见性/权限行为**。
 * - owner 为 NULL 的遗留 Channel 同样保持 private + chat_enabled=0:不能被自动变成公开群聊;
 *   必须由 admin 显式认领(写 owner_user_id)后再由 owner 开启群聊。
 * - 每个 owner 非 NULL 的 Channel 必须恰好一条 active owner 成员记录(缺失则补写)。
 */
