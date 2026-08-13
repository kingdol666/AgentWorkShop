/**
 * Subscription 仓储:subscriptions 表(Agent 订阅同事产出)。
 * agent_id + target_agent_id 复合主键,重复订阅自动去重。
 * 工厂接收 DatabaseSync(依赖注入),不持有任何单例。
 */
import type { DatabaseSync } from 'node:sqlite'
import type { SubscriptionRow } from './database'

const COLS = 'agent_id AS agentId, target_agent_id AS targetAgentId, created_at AS createdAt'

export type SubscriptionRepo = ReturnType<typeof createSubscriptionRepo>

export function createSubscriptionRepo(db: DatabaseSync) {
  const insert = db.prepare(
    `INSERT OR IGNORE INTO subscriptions (agent_id, target_agent_id, created_at) VALUES (?, ?, ?)`,
  )
  const removeStmt = db.prepare(
    `DELETE FROM subscriptions WHERE agent_id = ? AND target_agent_id = ?`,
  )
  const selectByAgent = db.prepare(
    `SELECT ${COLS} FROM subscriptions WHERE agent_id = ? ORDER BY createdAt ASC`,
  )
  const selectByTarget = db.prepare(
    `SELECT ${COLS} FROM subscriptions WHERE target_agent_id = ? ORDER BY createdAt ASC`,
  )

  return {
    /** 添加订阅(幂等,复合主键去重) */
    add(agentId: string, targetAgentId: string): SubscriptionRow {
      const row: SubscriptionRow = {
        agentId,
        targetAgentId,
        createdAt: new Date().toISOString(),
      }
      insert.run(row.agentId, row.targetAgentId, row.createdAt)
      return row
    },

    remove(agentId: string, targetAgentId: string): void {
      removeStmt.run(agentId, targetAgentId)
    },

    /** 某 Agent 订阅的全部目标 */
    listByAgent(agentId: string): SubscriptionRow[] {
      return selectByAgent.all(agentId) as unknown as SubscriptionRow[]
    },

    /** 订阅某 Agent 的全部订阅者 */
    listByTarget(targetAgentId: string): SubscriptionRow[] {
      return selectByTarget.all(targetAgentId) as unknown as SubscriptionRow[]
    },
  }
}
