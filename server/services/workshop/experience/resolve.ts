/**
 * 统一经验解析器(Task 4)。
 *
 * 所有读取面(自动注入 / 主动检索 / 管理审阅)共用同一授权与过滤顺序:
 *   ① 授权与 epoch 校验 → ② 按当前产品/配方/环境硬过滤 → ③ 检索排序与裁剪。
 * 自动只认 validated + 当前上下文获准的 canary/active 部署;shadow 仅供隔离评估;
 * review 才可见候选。撤权/切产品/退休后旧内容立即不再返回。
 */
import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { readLearningAuthorizationEpoch } from './trusted-context'
import { unsegmentCJK } from '../runtime/memory/helpers'
import type {
  ArtifactUseDecision,
  ExperienceDeployment,
  ExperienceLifecycle,
  ExperienceQuery,
  ExperienceResolution,
  ExperienceResolutionItem,
  TrustedLearningContext,
} from './types'

export const EXPERIENCE_POLICY_VERSION = 'governed-v1'

interface CandidateRow {
  version_id: string
  experience_id: string
  scope_kind: string
  scope_key: string
  content: string
  lifecycle: string
  deployment: string
  beta_ancestors_json: string
  title: string
  content_raw: string
}

const LIST_SQL = `
  SELECT v.version_id, v.experience_id, v.scope_kind, v.scope_key, v.content,
         v.lifecycle, v.deployment, v.beta_ancestors_json,
         m.title, m.content AS content_raw
    FROM experience_heads h
    JOIN experience_versions v ON v.version_id = h.version_id
    JOIN agent_memories m ON m.id = v.experience_id
   WHERE v.lifecycle NOT IN ('retired', 'expired', 'superseded', 'quarantined', 'contested', 'legacy-unverified')
`

const scopeMatches = (row: CandidateRow, context: TrustedLearningContext): boolean => {
  if (row.scope_kind === 'line') return Boolean(context.industrial?.lineId && row.scope_key === context.industrial.lineId)
  if (row.scope_kind === 'product') return Boolean(context.industrial?.productId && row.scope_key === context.industrial.productId)
  if (row.scope_kind === 'channel') return !row.scope_key || row.scope_key === context.channelId
  if (row.scope_kind === 'agent') return row.scope_key === context.actor
  return row.scope_kind === 'global'
}

const purposeAllows = (
  purpose: ExperienceQuery['purpose'],
  lifecycle: ExperienceLifecycle,
  deployment: ExperienceDeployment,
): boolean => {
  if (purpose === 'automatic') return lifecycle === 'validated' && (deployment === 'active' || deployment === 'canary')
  if (purpose === 'explicit') return lifecycle === 'validated' || lifecycle === 'evaluating'
  return lifecycle === 'candidate' || lifecycle === 'evaluating' || lifecycle === 'validated'
}

const textMatches = (query: string, row: CandidateRow): boolean => {
  const q = query.trim().toLowerCase()
  if (!q) return true
  const haystack = `${unsegmentCJK(row.title)} ${unsegmentCJK(row.content_raw || row.content)} ${unsegmentCJK(row.content)}`.toLowerCase()
  return q.split(/\s+/).filter(Boolean).every(token => haystack.includes(token))
}

export function resolveExperience(
  db: DatabaseSync,
  context: TrustedLearningContext,
  query: ExperienceQuery,
): ExperienceResolution {
  const decisionBase = {
    decisionId: `aud-${randomUUID().slice(0, 8)}`,
    versionIds: [] as string[],
    contextEpoch: context.authorizationEpoch,
    policyVersion: EXPERIENCE_POLICY_VERSION,
  }
  // ① epoch 必须等于当前持久授权版本;不匹配即拒用(不回退宽域)
  const currentEpoch = readLearningAuthorizationEpoch(db)
  if (context.authorizationEpoch !== currentEpoch) {
    return { items: [], decision: { ...decisionBase, reason: `EPOCH_STALE: context=${context.authorizationEpoch} current=${currentEpoch}` } }
  }
  const rows = db.prepare(LIST_SQL).all() as unknown as CandidateRow[]
  const items: ExperienceResolutionItem[] = []
  const skipped: string[] = []
  for (const row of rows) {
    const lifecycle = row.lifecycle as ExperienceLifecycle
    const deployment = row.deployment as ExperienceDeployment
    if ((JSON.parse(row.beta_ancestors_json || '[]') as string[]).length > 0) {
      skipped.push(`${row.version_id}:BETA_ANCESTOR`)
      continue
    }
    if (!scopeMatches(row, context)) {
      skipped.push(`${row.version_id}:SCOPE_MISMATCH`)
      continue
    }
    // ② 环境硬过滤:未知环境不扩域
    if (context.environment === 'unknown') {
      skipped.push(`${row.version_id}:CONTEXT_ENVIRONMENT_UNKNOWN`)
      continue
    }
    if (!purposeAllows(query.purpose, lifecycle, deployment)) {
      skipped.push(`${row.version_id}:PURPOSE_DENIED(${lifecycle}/${deployment})`)
      continue
    }
    if (!textMatches(query.text, row)) continue
    items.push({
      versionId: row.version_id,
      experienceId: row.experience_id,
      title: unsegmentCJK(row.title),
      content: unsegmentCJK(row.content_raw || row.content),
      lifecycle,
      deployment,
      referenceOnly: query.purpose === 'explicit' && deployment !== 'active' && deployment !== 'canary',
    })
  }
  // ③ 排序:active > canary > 其他;裁到 limit
  const rank = (d: ExperienceDeployment): number => (d === 'active' ? 0 : d === 'canary' ? 1 : 2)
  items.sort((a, b) => rank(a.deployment) - rank(b.deployment) || a.versionId.localeCompare(b.versionId))
  const limited = items.slice(0, Math.max(0, query.limit))
  return {
    items: limited,
    decision: {
      ...decisionBase,
      versionIds: limited.map(i => i.versionId),
      reason: skipped.length > 0 ? `filtered:${skipped.length}` : 'ok',
    },
  }
}

/** 自动注入资格(供记忆召回/overlay 复用,避免各自实现一套判定) */
export function isAutoInjectable(deployment: ExperienceDeployment, lifecycle: ExperienceLifecycle): boolean {
  return lifecycle === 'validated' && (deployment === 'active' || deployment === 'canary')
}

export type { ArtifactUseDecision }
