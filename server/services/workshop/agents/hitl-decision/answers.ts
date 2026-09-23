/**
 * 回答归一(问题 id ↔ 文本/选项)
 * (由 server/services/workshop/agents/hitl-decision.ts 按职责拆出;内容逐行原文搬运)
 */
import type { AepHitlQuestion } from '../../../../../shared/workshop-protocol'
import type { HitlDecisionPayload } from './shared'

// ============================================================================
// 结构化答案载荷(编码/解码见 hitl-registry;此处仅做转发与"决策载荷 → 答案列表"的归一)
// ============================================================================

/** 把决策载荷摊平成 (问题 → 答案) 列表:结构化 answers 优先,缺省用 value 兜底 */
export function resolveAnswers(
  questions: AepHitlQuestion[],
  decision: HitlDecisionPayload,
): Array<{ id: string, answer: string }> {
  const provided = decision.answers ?? []
  if (questions.length === 0) {
    const text = decision.value ?? decision.comment ?? ''
    return text ? [{ id: '', answer: text }] : []
  }
  return questions.map((q, i) => {
    const hit = provided.find(a => a.id && a.id === q.id) ?? provided[i]
    const answer = hit?.answer ?? (questions.length === 1 ? (decision.value ?? decision.comment ?? '') : '')
    return { id: q.id || String(i), answer }
  })
}
