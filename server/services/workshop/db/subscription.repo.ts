/**
 * Subscription 仓储:subscriptions 表(Agent 订阅同事产出,按 channel 隔离)。
 * channel_id + agent_id + target_agent_id 复合主键,重复订阅自动去重。
 * 工厂接收 DatabaseSync(依赖注入),不持有任何单例。
 */
import type { DatabaseSync } from 'node:sqlite'
import type { SubscriptionRow } from './database'

const COLS = 'channel_id AS channelId, agent_id AS agentId, target_agent_id AS targetAgentId, created_at AS createdAt'

export type SubscriptionRepo = ReturnType<typeof createSubscriptionRepo>

export function createSubscriptionRepo(db: DatabaseSync) {
  const insert = db.prepare(
    `INSERT OR IGNORE INTO subscriptions (channel_id, agent_id, target_agent_id, created_at) VALUES (?, ?, ?, ?)`,
  )
  const removeStmt = db.prepare(
    `DELETE FROM subscriptions WHERE channel_id = ? AND agent_id = ? AND target_agent_id = ?`,
  )
  const removeByAgentStmt = db.prepare(
    `DELETE FROM subscriptions WHERE channel_id = ? AND agent_id = ?`,
  )
  const selectByAgent = db.prepare(
    `SELECT ${COLS} FROM subscriptions WHERE channel_id = ? AND agent_id = ? ORDER BY createdAt ASC`,
  )
  const selectByTarget = db.prepare(
    `SELECT ${COLS} FROM subscriptions WHERE channel_id = ? AND target_agent_id = ? ORDER BY createdAt ASC`,
  )

  return {
    /** 添加订阅(幂等,复合主键去重) */
    add(channelId: string, agentId: string, targetAgentId: string): SubscriptionRow {
      const row: SubscriptionRow = {
        channelId,
        agentId,
        targetAgentId,
        createdAt: new Date().toISOString(),
      }
      insert.run(row.channelId, row.agentId, row.targetAgentId, row.createdAt)
      return row
    },

    remove(channelId: string, agentId: string, targetAgentId: string): void {
      removeStmt.run(channelId, agentId, targetAgentId)
    },

    /** 移除某成员(channel, agent)的全部订阅(成员移除时清理) */
    removeByAgent(channelId: string, agentId: string): void {
      removeByAgentStmt.run(channelId, agentId)
    },

    /** 某 Agent 订阅的全部目标(本 channel 内) */
    listByAgent(channelId: string, agentId: string): SubscriptionRow[] {
      return selectByAgent.all(channelId, agentId) as unknown as SubscriptionRow[]
    },

    /** 订阅某 Agent 的全部订阅者(本 channel 内) */
    listByTarget(channelId: string, targetAgentId: string): SubscriptionRow[] {
      return selectByTarget.all(channelId, targetAgentId) as unknown as SubscriptionRow[]
    },
  }
}
