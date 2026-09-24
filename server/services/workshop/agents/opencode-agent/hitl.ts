/**
 * OpenCodeAgentImplHitl —— HITL(权限 / 提问 / 注册)
 * (拆分层,承 OpenCodeAgentImplTurn;方法体与原文件逐行一致)
 */
import { OpenCodeAgentImplTurn } from './turn'
import type { AepHitlQuestion } from '../../../../../shared/workshop-protocol'
import { getHitlRegistry, normalizeHitlQuestions } from '../hitl-registry'
import { harnessSettings } from '../../settings'

export abstract class OpenCodeAgentImplHitl extends OpenCodeAgentImplTurn {
  protected registerPermissionHitl(v2: boolean, props: Record<string, unknown>): void {
    const id = String(props.id ?? '')
    if (!id) return
    if (this.pendingHitl.has(id)) return
    const sessionId = String(props.sessionID ?? this.sessionId ?? '')
    const permission = String(props.permission ?? props.action ?? 'action')
    const patterns = Array.isArray(props.patterns) ? props.patterns.map(String).join(', ') : ''
    const v2res = Array.isArray(props.resources) ? props.resources.map(String).join(', ') : ''
    const detail = patterns || v2res
    const title = `opencode 权限请求:${permission}${detail ? `(${detail})` : ''}`
    this.registerHitl({
      id,
      type: 'permission',
      requestType: 'approval',
      sessionId,
      title,
      detail: `引擎将执行 ${permission}${detail ? ` → ${detail}` : ''};批准放行(once/always),拒绝(reject)则引擎收到 reject。`,
      method: 'confirm',
      // 审批的合法枚举(前端按此渲染按钮;未知值在 respondHitl 被拒)
      options: ['once', 'always', 'reject'],
      nativeRequestId: id,
    })
  }

  /**
   * question.asked → question 型 HITL(全量问题,禁止只取第一题)。
   * 逐题回传 `POST /question/{questionId}/reply`;取消走 `/reject`。
   */
  protected registerQuestionHitl(props: Record<string, unknown>): void {
    const id = String(props.id ?? '')
    if (!id || this.pendingHitl.has(id)) return
    const sessionId = String(props.sessionID ?? this.sessionId ?? '')
    const questions = normalizeHitlQuestions(props.questions)
    const first = questions[0]
    this.registerHitl({
      id,
      type: 'question',
      requestType: 'question',
      sessionId,
      title: String(first?.question ?? first?.header ?? 'opencode 提问'),
      detail: first?.question ?? '',
      method: 'input',
      // 旧 UI 只认 options:string[]:摊平首题选项;结构化答案按 questions 逐题回传
      options: first?.options?.map(o => o.label),
      nativeRequestId: id,
      questions,
    })
  }

  protected registerHitl(input: {
    id: string
    type: 'permission' | 'question'
    requestType: 'question' | 'approval'
    sessionId: string
    title: string
    detail: string
    method: 'confirm' | 'input'
    options?: string[]
    nativeRequestId?: string
    questions?: AepHitlQuestion[]
  }): void {
    const { id } = input
    const registry = getHitlRegistry()
    registry.register({
      kind: 'opencode-permission',
      id,
      agentId: this.selfAgentId,
      agentName: this.agentName,
      channelId: this.channelId,
      pid: this.child?.pid,
      method: input.method,
      title: input.title,
      detail: input.detail,
      options: input.options,
      createdAt: new Date().toISOString(),
      expiresAt: null,
      // v17:question/approval 分开建模 + 原生请求/会话标识(重启对账与能力矩阵)
      requestType: input.requestType,
      nativeRequestId: input.nativeRequestId ?? id,
      sessionId: input.sessionId,
      harness: 'opencode',
      questions: input.questions,
    })
    // 无人应答超时(fail-closed:到时自动拒绝),0 = 无限等待
    const timeoutMs = harnessSettings().hitl_timeout_ms
    const timer = timeoutMs > 0
      ? setTimeout(() => {
          void this.respondHitl('opencode-permission', id, { cancelled: true }).catch(() => {})
          registry.resolve('opencode-permission', id, 'expired')
        }, timeoutMs)
      : null
    this.pendingHitl.set(id, {
      kind: 'opencode-permission',
      id,
      type: input.type,
      sessionId: input.sessionId,
      timer,
      questions: input.questions ?? [],
    })
  }

  // ===== opencode 服务进程与 HTTP 客户端 =====
}
