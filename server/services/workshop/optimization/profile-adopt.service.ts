/**
 * Profile 模型采纳服务 —— Agent 迭代闭环的"采纳"环节(OW-adopt)。
 *
 * 闭环语义:Agent 训练出新模型(aml_job_submit→done)后,可以用
 * `optimizer_profile_propose` 工具发起「采纳提议」:复制当前已发布 Profile
 * 的全部求解配置、换上新模型工件、生成新草稿版本,并挂一张 HITL 卡。
 * 人类批准 → **发布新版本 + 自动重绑**所有绑定在旧版本的 Agent(绑定 revision+1,
 * 在飞求解按 BINDING_STALE 收敛,下一次 solve 即用新模型);拒绝 → 零写,意见回流。
 *
 * 治理不变量:
 *  - 提议 = 草稿 + 卡,本身不改运行行为(旧版本继续求解);
 *  - 发布只发生在人类批准之后(单一咽喉,dispatcher/decide 双入口同路由);
 *  - 模型工件/求解器/模板兼容性在提议时校验(D21 矩阵,不兼容 422);
 *  - 全链审计(actor 三态,publish/adopt/rebind 各一条)。
 */
import { AppError } from '../../../utils/errors'
import { getAmlRuntime } from '../aml/runtime'
import { recordOps } from '../ops/ops'
import { getProfileRepo, parseProfileRow } from './profile.repo'
import { getBindingRepo } from './binding.repo'
import { assertProfileSolverCompatible, type OptimizationProfile } from './contracts'
import type { ProblemTemplateRef, SolverRef } from '../process-model/contracts'
import { securityRecipeDispatchTimeoutMs } from '../settings'
import { createLogger } from '../logger'

import { getToolApprovals } from '../agents/tool-approvals'

const log = createLogger('optimizer.profile-adopt')

export const PROFILE_ADOPT_PREFIX = 'optimizer-profile:'

export function isProfileAdoptCard(nodeId: string): boolean {
  return nodeId.startsWith(PROFILE_ADOPT_PREFIX)
}

export interface ProposeAdoptionInput {
  /** 发起 Agent 的 channel 实例 id(HITL 卡挂在其频道) */
  agentInstanceId: string
  /** 人类发起时为用户 id;Agent 发起传 agentId(actorKind='agent') */
  initiatorId: string
  initiatorKind?: 'user' | 'agent'
  profileId: string
  modelId: string
  /** 可选切换问题模板/求解器(不兼容 → 422,D21 矩阵) */
  templateRef?: ProblemTemplateRef
  solverRef?: SolverRef
  /** 提议理由(必填;审批卡展示) */
  reason: string
  /** 依赖注入(单测 stub 用) */
  deps?: {
    requestApproval?: (agentId: string, nodeId: string, kind: 'dcw', detail: string, opts?: { title?: string, timeoutMs?: number, payload?: unknown }) => Promise<{ approved: boolean, comment: string, choice: number | null }>
  }
}

export interface ProposeAdoptionResult {
  cardId: string
  profileId: string
  version: number
  priorVersion: number
  modelId: string
  decision: { approved: boolean, comment: string, choice: number | null }
  published: boolean
  rebindCount: number
}

/** 提议采纳:建草稿新版本 + 挂 HITL 卡 + 等待裁决(approved 时已完成发布与重绑)。 */
export async function proposeProfileAdoption(input: ProposeAdoptionInput): Promise<ProposeAdoptionResult> {
  const repo = getProfileRepo()
  const published = repo.latestPublished(input.profileId)
  if (!published) {
    throw new AppError(404, 'PROFILE_NOT_PUBLISHED', `Profile ${input.profileId} 没有已发布版本;采纳以已发布版本为基线`)
  }
  const model = getAmlRuntime().repo.model.get(input.modelId)
  if (!model) throw new AppError(404, 'MODEL_NOT_FOUND', `模型 ${input.modelId} 不存在(先经 AML 训练登记)`)

  const prior = parseProfileRow(published)
  const version = published.version + 1
  const nextProfile: OptimizationProfile = {
    ...prior,
    version,
    status: 'draft',
    modelRef: {
      modelId: input.modelId,
      artifactKind: (model.artifactKind || 'onnx_one_step@1') as OptimizationProfile['modelRef']['artifactKind'],
      modelInterface: (model.modelInterface || 'one_step') as OptimizationProfile['modelRef']['modelInterface'],
      artifactHash: model.artifactHash || '',
      stage: 'candidate',
    },
    ...(input.templateRef ? { problemTemplateRef: input.templateRef } : {}),
    ...(input.solverRef ? { solverRef: input.solverRef } : {}),
  }
  // D21 分派矩阵:工件×模板×求解器不兼容在此显式拒绝(不产生草稿)
  assertProfileSolverCompatible(nextProfile)
  repo.insert(nextProfile, input.initiatorId)

  const cardId = `${PROFILE_ADOPT_PREFIX}${input.profileId}@${version}`
  const detail = [
    `模型采纳提议:${input.profileId} v${published.version} → v${version}`,
    `新模型:${input.modelId}(${nextProfile.modelRef.artifactKind},hash ${String(nextProfile.modelRef.artifactHash).slice(0, 12)}…)`,
    nextProfile.problemTemplateRef !== prior.problemTemplateRef || nextProfile.solverRef !== prior.solverRef
      ? `求解配置变更:模板 ${prior.problemTemplateRef}→${nextProfile.problemTemplateRef},求解器 ${prior.solverRef}→${nextProfile.solverRef}`
      : `求解配置不变(模板 ${nextProfile.problemTemplateRef} / ${nextProfile.solverRef})`,
    `理由:${input.reason}`,
    `批准 = 冻结发布 v${version} 并把绑定在 v${published.version} 的 Agent 自动重绑(在飞求解 BINDING_STALE 收敛);拒绝 = 零写。`,
  ].join('\n')

  recordOps({
    actor: input.initiatorId,
    actorName: input.initiatorId,
    actorKind: input.initiatorKind ?? 'agent',
    action: 'optimizer.profile.adopt_propose',
    kind: 'system',
    targetKind: 'optimizer_profile',
    targetId: `${input.profileId}@${version}`,
    summary: `提议采纳模型 ${input.modelId} → ${input.profileId}@${version}(卡 ${cardId})`,
    detail: { profileId: input.profileId, version, priorVersion: published.version, modelId: input.modelId, reason: input.reason },
  })

  const requestApproval = input.deps?.requestApproval
    ?? ((agentId: string, nodeId: string, kind: 'dcw', detail_: string, opts?: { title?: string, timeoutMs?: number, payload?: unknown }) =>
      getToolApprovals().request(agentId, nodeId, kind, detail_, opts))

  const decision = await requestApproval(input.agentInstanceId, cardId, 'dcw', detail, {
    title: `模型采纳:${input.profileId} → v${version}`,
    timeoutMs: securityRecipeDispatchTimeoutMs(),
    payload: { schemaVersion: 1, profileId: input.profileId, version, priorVersion: published.version, modelId: input.modelId },
  })

  if (!decision.approved) {
    return { cardId, profileId: input.profileId, version, priorVersion: published.version, modelId: input.modelId, decision: { approved: false, comment: decision.comment, choice: decision.choice ?? null }, published: false, rebindCount: 0 }
  }
  // 批准路径的发布/重绑在单一咽喉(decideProfileAdoption)已完成;此处防御式复核
  const publishedRow = repo.get(input.profileId, version)
  const rebindCount = countBindingsOn(input.profileId, version)
  return {
    cardId,
    profileId: input.profileId,
    version,
    priorVersion: published.version,
    modelId: input.modelId,
    decision: { approved: true, comment: decision.comment, choice: decision.choice ?? null },
    published: publishedRow?.status === 'published',
    rebindCount,
  }
}

function countBindingsOn(profileId: string, version: number): number {
  return getBindingRepo().listAll(500).filter(b => b.profileId === profileId && b.profileVersionNumber === version).length
}

export interface DecideAdoptionInput {
  /** 审批单 id(ap-…;listPending 的主键) */
  cardId: string
  /** 卡的 nodeId(optimizer-profile:<id>@<v>);缺省时经审批单反查 */
  nodeId?: string
  approved: boolean
  comment: string
  actingUser: { id: string, name?: string }
  via: 'hitl/respond' | 'decide-endpoint'
  /** 依赖注入(单测 stub);缺省走真实 ToolApprovalService(卡必须在册) */
  deps?: {
    decideApproval?: (id: string, approved: boolean, comment: string, by: string, name: string) => void
  }
}

/** 卡落定(真实面:审批必须在册;stub 面:直接回调)。失败不击穿咽喉主流程。 */
function settle(deps: DecideAdoptionInput['deps'], cardId: string, approved: boolean, comment: string, by: string, name: string): void {
  try {
    const decide = deps?.decideApproval ?? ((id: string, ok: boolean, msg: string, by2: string, name2: string) => getToolApprovals().decide(id, ok, msg, by2, name2))
    decide(cardId, approved, comment, by, name)
  }
  catch (err) {
    log.warn(`[profile-adopt] 卡落定失败(不影响裁决结果):${err instanceof Error ? err.message : String(err)}`)
  }
}

export interface DecideAdoptionResult {
  handled: boolean
  approved: boolean
  comment: string
  code?: string
  published?: { profileId: string, version: number, rebindCount: number }
}

/** 单一咽喉:optimizer-profile:* 卡的裁决 → 发布 + 重绑 + 审计(业务拒绝在咽喉内落定)。 */
export async function decideProfileAdoption(input: DecideAdoptionInput): Promise<DecideAdoptionResult> {
  // nodeId 解析:分支显式传入优先;否则经审批单反查(卡 id ≠ nodeId,两个命名空间)
  const nodeId = input.nodeId
    ?? getToolApprovals().listPending().find(a => a.id === input.cardId)?.nodeId
    ?? input.cardId
  if (!isProfileAdoptCard(nodeId)) return { handled: false, approved: input.approved, comment: input.comment }
  const parsed = nodeId.slice(PROFILE_ADOPT_PREFIX.length).split('@')
  const profileId = parsed[0] ?? ''
  const version = Number(parsed[1])
  if (!profileId || !Number.isInteger(version)) {
    throw new AppError(422, 'PROFILE_ADOPT_CARD_INVALID', `采纳卡 nodeId 形状非法:${nodeId}`)
  }
  const repo = getProfileRepo()
  const row = repo.get(profileId, version)
  if (!row) {
    settle(input.deps, input.cardId, false, `Profile ${profileId}@${version} 已不存在;按拒收敛`, input.actingUser.id, input.actingUser.name ?? '')
    return { handled: true, approved: false, comment: '目标 Profile 版本不存在', code: 'PROFILE_NOT_FOUND' }
  }

  if (!input.approved) {
    // 拒绝:草稿保留(可修订后重新 propose,新卡重走),零写
    settle(input.deps, input.cardId, false, input.comment || '采纳提议被拒绝', input.actingUser.id, input.actingUser.name ?? '')
    recordOps({
      actor: input.actingUser.id, actorName: input.actingUser.name ?? input.actingUser.id, actorKind: 'user',
      action: 'optimizer.profile.adopt_reject', kind: 'system',
      targetKind: 'optimizer_profile', targetId: `${profileId}@${version}`,
      summary: `拒绝模型采纳 ${profileId}@${version}(草稿保留,零写)`,
      detail: { profileId, version, comment: input.comment, via: input.via },
    })
    return { handled: true, approved: false, comment: input.comment || '采纳提议被拒绝', code: 'PROFILE_ADOPT_REJECTED' }
  }

  // 批准:发布冻结 + 自动重绑(旧 published 版本 → 新版本;revision+1 使在飞求解 BINDING_STALE 收敛)
  const priorVersion = version - 1
  try {
    repo.publish(profileId, version)
    const rebindCount = rebindBindings(profileId, priorVersion, version)
    recordOps({
      actor: input.actingUser.id, actorName: input.actingUser.name ?? input.actingUser.id, actorKind: 'user',
      action: 'optimizer.profile.adopt', kind: 'system',
      targetKind: 'optimizer_profile', targetId: `${profileId}@${version}`,
      summary: `批准并发布 ${profileId}@${version}(重绑 ${rebindCount} 个绑定;来自采纳卡)`,
      detail: { profileId, version, priorVersion, rebindCount, via: input.via, comment: input.comment },
    })
    settle(input.deps, input.cardId, true, input.comment || `已发布 v${version},重绑 ${rebindCount} 个绑定`, input.actingUser.id, input.actingUser.name ?? '')
    return { handled: true, approved: true, comment: input.comment, published: { profileId, version, rebindCount } }
  }
  catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    settle(input.deps, input.cardId, false, `发布失败,按拒收敛:${message}`, input.actingUser.id, input.actingUser.name ?? '')
    recordOps({
      actor: input.actingUser.id, actorName: input.actingUser.name ?? input.actingUser.id, actorKind: 'user',
      action: 'optimizer.profile.adopt_reject', kind: 'system', level: 'error',
      targetKind: 'optimizer_profile', targetId: `${profileId}@${version}`,
      summary: `采纳发布失败按拒收敛 ${profileId}@${version}:${message}`,
      detail: { profileId, version, error: message, via: input.via },
    })
    return { handled: true, approved: false, comment: `发布失败:${message}`, code: 'PROFILE_ADOPT_PUBLISH_FAILED' }
  }
}

function rebindBindings(profileId: string, fromVersion: number, toVersion: number): number {
  const repo = getBindingRepo()
  let count = 0
  for (const b of repo.listAll(500)) {
    if (b.profileId !== profileId || b.profileVersionNumber !== fromVersion) continue
    const moved = repo.rebindVersion(b.id, toVersion)
    if (moved > 0) count += 1
  }
  return count
}
