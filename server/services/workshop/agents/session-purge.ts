/**
 * 会话永久清理（2026-11-25 归档对话管理）。
 *
 * 只接受「手工会话 + 已归档 + 已关闭」三条件同时成立的行：归档/关闭是清理前的
 * 两道人为确认，避免把仍在运行或由项目生命周期管理的会话行直接从库里抹掉。
 *
 * 清理范围（同一事务）：
 *   - 会话行本身（channel_sessions）
 *   - 该会话克隆出的成员实例（channel_agents，订阅随 FK 级联；另做显式删除兼容旧库）
 *   - mailbox 消息 / 群聊消息与投递 / 任务 / 记忆（按 session_id 或 clone 身份命中）
 * 不清理全局审计与通道事件流（audit_log/channel_events）：它们是平台级留痕，
 * 且删除会破坏 WS seq 连续性。节点绑定是 JSON 持久层，由 manager 在事务提交后清理。
 */
import type { DatabaseSync } from 'node:sqlite'
import { AppError } from '../../../utils/errors'
import { withTransaction } from '../db/transaction'
import type { ChannelSessionRow } from '../db/channel-session.repo'

export interface SessionPurgeCounts {
  sessions: number
  agents: number
  messages: number
  tasks: number
  chatMessages: number
  chatDeliveries: number
  memories: number
}

export function cloneIdsOf(memberMapJson: string): string[] {
  try {
    const map = JSON.parse(memberMapJson || '{}') as unknown
    if (!map || typeof map !== 'object' || Array.isArray(map)) return []
    return Object.values(map as Record<string, unknown>).filter((v): v is string => typeof v === 'string' && v.length > 0)
  }
  catch {
    return []
  }
}

/** `IN (?,?,…)` 的参数占位；空数组由调用方跳过该分支。 */
function placeholders(n: number): string {
  return Array.from({ length: n }, () => '?').join(',')
}

/** 永久删除的前置闸门（manager 在停摘运行时之前也必须先调用，避免 409 路径产生副作用）。 */
export function assertSessionPurgeable(
  session: Pick<ChannelSessionRow, 'status' | 'archivedAt' | 'instanceKind'>,
): void {
  if (session.instanceKind !== 'manual') {
    throw new AppError(409, 'SESSION_MANAGED', '项目/任务会话由项目生命周期管理，不能永久删除')
  }
  if (!session.archivedAt) {
    throw new AppError(409, 'SESSION_NOT_ARCHIVED', '会话尚未归档，不能永久删除（请先归档）')
  }
  if (session.status !== 'closed') {
    throw new AppError(409, 'SESSION_NOT_CLOSED', '会话尚未关闭，不能永久删除（请先归档以完成关闭）')
  }
}

export function purgeArchivedSessionData(
  db: DatabaseSync,
  session: Pick<ChannelSessionRow, 'id'>,
): SessionPurgeCounts {
  return withTransaction(db, () => {
    // 事务内重读并重新过闸：DELETE 与并发 restore 之间不允许用旧快照绕过「已归档+已关闭」。
    // BEGIN IMMEDIATE 已持有写锁，后续 restore 只能等待本事务结束。
    const current = db.prepare(`SELECT id, channel_id AS channelId, status, archived_at AS archivedAt,
        instance_kind AS instanceKind, member_map_json AS memberMapJson
      FROM channel_sessions WHERE id = ?`).get(session.id) as unknown as Pick<ChannelSessionRow,
      'id' | 'channelId' | 'status' | 'archivedAt' | 'instanceKind' | 'memberMapJson'> | undefined
    if (!current) throw new AppError(404, 'NOT_FOUND', `会话不存在: ${session.id}`)
    assertSessionPurgeable(current)

    const clones = cloneIdsOf(current.memberMapJson)
    // 空 clone 列表用 NULL 占位：`IN (NULL)` 恒不命中，清理 SQL 无需分支。
    const inClones = clones.length > 0 ? placeholders(clones.length) : 'NULL'
    const sessionId = current.id
    const channelId = current.channelId

    // 团队共享记忆(agent_id='__team__')可能带当前 session_id(shared 策略写入),但它是
    // 频道级共享行,不能随单会话删除 —— 两种查询都显式排除。
    try {
      db.prepare(`DELETE FROM agent_memories_vec WHERE mem_rowid IN (
          SELECT rowid FROM agent_memories
          WHERE agent_id <> '__team__' AND (session_id = ? OR agent_id IN (${inClones}))
        )`).run(sessionId, ...clones)
    }
    catch { /* vec0 未启用 */ }

    const memories = db.prepare(`DELETE FROM agent_memories
      WHERE agent_id <> '__team__' AND (session_id = ? OR agent_id IN (${inClones}))`)
      .run(sessionId, ...clones).changes

    const chatDeliveries = db.prepare(`DELETE FROM chat_deliveries
      WHERE session_id = ? OR target_agent_id IN (${inClones})`).run(sessionId, ...clones).changes

    const chatMessages = db.prepare(`DELETE FROM chat_messages
      WHERE session_id = ? OR sender_id IN (${inClones})`).run(sessionId, ...clones).changes

    const messages = db.prepare(`DELETE FROM messages
      WHERE session_id = ? OR from_agent_id IN (${inClones}) OR to_agent_id IN (${inClones})`)
      .run(sessionId, ...clones, ...clones).changes

    // 任务按树清理：根命中 session/assignee 后，连同其后代一起删（防止子任务被派给基础成员
    // 且 session_id 未落时成为孤儿）。UNION 去重防异常环。
    const tasks = db.prepare(`WITH RECURSIVE purge_tasks(id) AS (
        SELECT id FROM tasks WHERE session_id = ? OR assignee_id IN (${inClones})
        UNION
        SELECT t.id FROM tasks t JOIN purge_tasks p ON t.parent_id = p.id
      )
      DELETE FROM tasks WHERE id IN (SELECT id FROM purge_tasks)`).run(sessionId, ...clones).changes

    db.prepare(`DELETE FROM subscriptions
      WHERE agent_id IN (${inClones}) OR target_agent_id IN (${inClones})`)
      .run(...clones, ...clones)
    const agents = Number(db.prepare(`DELETE FROM channel_agents WHERE channel_id = ? AND id IN (${inClones})`)
      .run(channelId, ...clones).changes)

    const sessions = db.prepare('DELETE FROM channel_sessions WHERE id = ?').run(sessionId).changes

    return {
      sessions: Number(sessions),
      agents: Number(agents),
      messages: Number(messages),
      tasks: Number(tasks),
      chatMessages: Number(chatMessages),
      chatDeliveries: Number(chatDeliveries),
      memories: Number(memories),
    }
  })
}
