/**
 * ManagerInternal —— 内部辅助:路由、唤醒、作用域守卫
 * (拆分层,承 ManagerSchedules)
 */
import { ManagerSchedules } from './schedules'
import type { A2AMessage } from '../../types/a2a'
import type { ChannelAgentRow } from '../../db/database'
import type { WorkspaceTask } from '../../types/task'
import { AppError } from '../../../../utils/errors'
import { rowToTask } from './helpers'

export abstract class ManagerInternal extends ManagerSchedules {
  protected route(channelId: string, message: A2AMessage): string[] {
    // 总线通知(a2a.message)由 ChannelRuntime 构造时注入的 onRouted 回调统一发出
    // (见 ensureChannelRuntime):调度器直呼 runtime.route 的消息同样可见
    return this.ensureChannelRuntime(channelId).route(message)
  }

  protected wakeAgent(channelId: string, agentId: string): void {
    this.ensureAgentRuntime(channelId, agentId)?.wakeMailbox()
  }

  /**
   * 成员寻址(A2A 身份命中率的核心):接受 id(实例/模板)、名字、唯一名字前缀。
   * 多智能体对话中 LLM 常以名字称呼同事,名册缓存也可能滞后于成员重建 ——
   * 精确 id 未命中时按名字/前缀解析,让"想发给谁"总能落到"谁"的实例上;
   * 解析失败时把当前名册(id | 名字)放进错误信息,LLM 下一轮即可自我纠正。
   */
  protected resolveMemberRef(channelId: string, ref: string): ChannelAgentRow {
    const trimmed = ref.trim()
    if (!trimmed) throw new AppError(400, 'BAD_REQUEST', '缺少目标成员引用(to_agent_id/assignee_id)')
    const members = this.deps.repos.channelAgents.listByChannel(channelId).filter(m => m.enabled === 1)
    // ① 精确实例 id
    const byId = members.find(m => m.id === trimmed)
    if (byId) return byId
    // ② 模板 id(名册/记忆中的旧实例 id 复用同一模板 → 按模板命中当前实例)
    const byTemplate = members.find(m => m.templateId === trimmed)
    if (byTemplate) return byTemplate
    // ③ 名字精确(大小写不敏感;含"← 你"等标记已剥离)
    const lower = trimmed.toLowerCase()
    const byName = members.find(m => m.name.toLowerCase() === lower)
    if (byName) return byName
    // ④ 唯一名字前缀/包含(多候选 → 拒绝,防止误投)
    const partial = members.filter(m => m.name.toLowerCase().includes(lower))
    if (partial.length === 1) return partial[0]!
    const roster = members.map(m => `${m.id} | ${m.name}(${m.role})`).join('; ')
    throw new AppError(404, 'MEMBER_NOT_FOUND',
      `目标成员未命中: "${trimmed}"。当前 Channel 名册(用其中 id 或名字寻址): ${roster}`)
  }

  /** 成员寻址(公开包装:REST/工具桥共用;语义同 resolveMemberRef) */
  resolveChannelMember(channelId: string, ref: string): { id: string, name: string, role: string } {
    const m = this.resolveMemberRef(channelId, ref)
    return { id: m.id, name: m.name, role: m.role }
  }

  /** 校验调用方是本 channel 实例;返回实例行(含 role) */
  protected requireMember(channelId: string, agentId: string): ChannelAgentRow {
    const m = this.deps.repos.channelAgents.findByChannelAgent(channelId, agentId)
    if (!m) throw new AppError(403, 'SCOPE_VIOLATION', '调用方 Agent 不在本 channel')
    return m
  }

  protected requireTaskInScope(channelId: string, callerAgentId: string, taskId: string): WorkspaceTask {
    this.requireMember(channelId, callerAgentId)
    const row = this.deps.repos.tasks.findById(taskId)
    if (!row) throw new AppError(404, 'NOT_FOUND', `任务不存在: ${taskId}`)
    if (row.channelId !== channelId) {
      throw new AppError(403, 'SCOPE_VIOLATION', '任务不在本 channel')
    }
    return rowToTask(row)
  }
}
