/**
 * 可信学习上下文(Task 3)。
 *
 * `actor` 必须来自宿主认证/任务执行主体;`authorizationEpoch` 来自可撤销的持久授权版本
 * 记录(learning_authorization_epochs),**不能**用会话绑定修订/snapshot hash 代替
 * ——绑定不变不代表成员角色或调用身份仍有权。构造失败不授予复用资格。
 */
import type { DatabaseSync } from 'node:sqlite'
import type { ContextResolution, LearningEnvironment, TrustedLearningContext } from './types'

export interface HostExecutionRefs {
  /** 宿主认证主体(用户 id / 服务身份);空 → 不可信 */
  actor: string | null
  channelId: string
  sessionId: string
  /** 授权版本;由宿主在构造时给出,并与持久记录一致 */
  authorizationEpoch: number
  /** 通用对象权威引用(Project/设计对象/产线产品);空 → 不可信 */
  subjectRef: string | null
  environment: LearningEnvironment
  industrial?: {
    lineId: string
    productId: string
    recipeRevision?: string
    runId?: string
  }
}

export function readLearningAuthorizationEpoch(db: DatabaseSync): number {
  const row = db.prepare('SELECT COALESCE(MAX(epoch), 0) AS epoch FROM learning_authorization_epochs')
    .get() as { epoch?: number } | undefined
  return Number(row?.epoch ?? 0)
}

/**
 * 授权变更(成员/角色、绑定、产品、经验权限或策略)必须与更新事务一起调用;
 * 一期用单调计数保守失效所有在途决策与缓存。
 */
export function advanceLearningAuthorizationEpoch(db: DatabaseSync, actor: string, reason: string): number {
  db.prepare('BEGIN IMMEDIATE').run()
  try {
    const next = readLearningAuthorizationEpoch(db) + 1
    db.prepare('INSERT INTO learning_authorization_epochs(id, epoch, reason, actor, at) VALUES (?, ?, ?, ?, ?)')
      .run(`ep-${next}-${Date.now()}`, next, reason, actor, new Date().toISOString())
    db.prepare('COMMIT').run()
    return next
  }
  catch (err) {
    try {
      db.prepare('ROLLBACK').run()
    }
    catch { /* 已回滚 */ }
    throw err
  }
}

export function buildTrustedLearningContext(refs: HostExecutionRefs): ContextResolution {
  const actor = String(refs.actor ?? '').trim()
  if (!actor) return { ok: false, reason: 'TRUSTED_CONTEXT_UNAVAILABLE' }
  const subjectRef = String(refs.subjectRef ?? '').trim()
  if (!subjectRef) return { ok: false, reason: 'TRUSTED_CONTEXT_UNAVAILABLE' }
  if (!refs.channelId?.trim()) return { ok: false, reason: 'TRUSTED_CONTEXT_UNAVAILABLE' }
  const epoch = Number(refs.authorizationEpoch)
  if (!Number.isSafeInteger(epoch) || epoch < 0) return { ok: false, reason: 'TRUSTED_CONTEXT_UNAVAILABLE' }
  const industrial = refs.industrial
  if (industrial) {
    if (!industrial.lineId?.trim() || !industrial.productId?.trim()) {
      return { ok: false, reason: 'TRUSTED_CONTEXT_UNAVAILABLE' }
    }
  }
  const context: TrustedLearningContext = {
    actor,
    channelId: refs.channelId,
    sessionId: refs.sessionId ?? '',
    authorizationEpoch: epoch,
    subjectRef,
    environment: refs.environment,
    ...(industrial
      ? {
          industrial: {
            lineId: industrial.lineId,
            productId: industrial.productId,
            ...(industrial.recipeRevision ? { recipeRevision: industrial.recipeRevision } : {}),
            ...(industrial.runId ? { runId: industrial.runId } : {}),
          },
        }
      : {}),
  }
  return { ok: true, context }
}
