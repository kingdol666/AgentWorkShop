/**
 * CodexAgentImplLayer02 —— HITL:审批与用户输入的注册与应答
 * (分层 3/4,承 CodexAgentImplLayer01;方法体与原文件逐行一致)
 */
import { CodexAgentImplLayer01 } from './01-turn'
import type { AgentEvent } from '../agent-interface'
import { decodeHitlAnswers, getHitlRegistry, normalizeHitlQuestions } from '../hitl-registry'
import { harnessSettings } from '../../settings'
import { randomUUID } from 'node:crypto'

export abstract class CodexAgentImplLayer02 extends CodexAgentImplLayer01 {
  /** supervise 用:收齐整个回合的事件流(supervise 决策解析在调用方) */
  protected async collectTurnEvents(prompt: string, timeoutMs: number, signal?: AbortSignal): Promise<AgentEvent[]> {
    const events: AgentEvent[] = []
    for await (const e of this.streamTurn(prompt, undefined, timeoutMs, signal)) {
      events.push(e)
      if (e.kind === 'error') break
    }
    return events
  }

  // ===== HITL 登记 =====

  protected registerApprovalHitl(rpcId: string | number, itemId: string, kindLabel: 'command' | 'file', p: Record<string, unknown>): void {
    const id = `codex-${itemId}`
    if (this.pendingApprovals.has(id)) return
    const title = kindLabel === 'command'
      ? `codex 命令审批:${String(p.command ?? '(未知命令)').slice(0, 200)}`
      : `codex 文件变更审批:${String(p.cwd ?? p.grantRoot ?? '')}`
    const registry = getHitlRegistry()
    registry.register({
      kind: 'codex-approval',
      id,
      agentId: this.selfAgentId,
      agentName: this.agentName,
      channelId: this.channelId,
      pid: this.client?.pid,
      method: 'confirm',
      title,
      detail: typeof p.reason === 'string' ? p.reason : undefined,
      createdAt: new Date().toISOString(),
      expiresAt: null,
      // v17:question/approval 分开建模 + 原生请求/会话标识(重启对账与能力矩阵)
      requestType: 'approval',
      nativeRequestId: String(rpcId),
      sessionId: this.threadId ?? '',
      harness: 'codex',
    })
    const timeoutMs = harnessSettings().hitl_timeout_ms
    const timer = timeoutMs > 0
      ? setTimeout(() => {
          void this.respondHitl('codex-approval', id, { cancelled: true }).catch(() => {})
          registry.resolve('codex-approval', id, 'expired')
        }, timeoutMs)
      : null
    this.pendingApprovals.set(id, { rpcId, timer, type: 'approval', questions: [] })
  }

  /**
   * tool/requestUserInput → question 型 HITL。
   * 全量 questions 原样承载(旧实现只取第一题,多问题直接丢);应答走 respondUserInput
   * 的 `{answers:[…]}` 协议,**不得**复用审批的 `{decision}`。
   */
  protected registerUserInputHitl(rpcId: string | number, p: Record<string, unknown>): void {
    const id = `codex-input-${randomUUID().slice(0, 8)}`
    const questions = normalizeHitlQuestions(p.questions)
    const first = questions[0]
    const registry = getHitlRegistry()
    registry.register({
      kind: 'codex-approval',
      id,
      agentId: this.selfAgentId,
      agentName: this.agentName,
      channelId: this.channelId,
      pid: this.client?.pid,
      method: 'input',
      title: String(first?.question ?? first?.header ?? 'codex 提问'),
      detail: typeof p.reason === 'string' ? p.reason : undefined,
      // 旧 UI 只认 options:string[]:把首题选项摊平(结构化答案仍按 questions 回传)
      options: first?.options?.map(o => o.label),
      createdAt: new Date().toISOString(),
      expiresAt: null,
      requestType: 'question',
      nativeRequestId: String(rpcId),
      sessionId: this.threadId ?? '',
      harness: 'codex',
      questions,
    })
    const timeoutMs = harnessSettings().hitl_timeout_ms
    const timer = timeoutMs > 0
      ? setTimeout(() => {
          void this.respondUserInput(rpcId, id, { cancelled: true }).catch(() => {})
        }, timeoutMs)
      : null
    this.pendingApprovals.set(id, { rpcId, timer, type: 'question', questions })
  }

  /**
   * 提问应答(codex app-server `tool/requestUserInput`):
   * 成功 → `client.respond(rpcId, { answers: [{ answer }] })`(按问题顺序,多问题逐条);
   * 取消 → `client.respondError(rpcId, -32800, '人工取消')`。
   * 两条路径都**不是** `{decision}` —— 那是审批协议的载荷。
   */
  protected async respondUserInput(
    rpcId: string | number,
    id: string,
    outcome: { cancelled?: boolean, value?: string, answers?: Array<{ id?: string, answer: string }> },
  ): Promise<void> {
    const pending = this.pendingApprovals.get(id)
    if (!pending) return
    const client = this.client
    if (!client) return
    if (outcome.cancelled) {
      client.respondError(rpcId, -32800, '人工取消')
      getHitlRegistry().resolve('codex-approval', id, 'cancelled')
    }
    else {
      // 按问题顺序对齐答案(结构化 answers 优先,单问题回落裸文本)
      const structured = outcome.answers ?? []
      const encoded = decodeHitlAnswers(outcome.value)
      const answers = pending.questions.length > 0
        ? pending.questions.map((q, i) => ({
            answer: structured.find(a => a.id && a.id === q.id)?.answer
              ?? structured[i]?.answer
              ?? encoded?.find(a => a.id === q.id)?.answer
              ?? encoded?.[i]?.answer
              ?? (pending.questions.length === 1 ? (outcome.value ?? '') : ''),
          }))
        : [{ answer: outcome.value ?? '' }]
      client.respond(rpcId, { answers })
      getHitlRegistry().resolve('codex-approval', id, 'answered')
    }
    if (pending.timer) clearTimeout(pending.timer)
    this.pendingApprovals.delete(id)
  }

  // ===== 客户端管理 =====
}
