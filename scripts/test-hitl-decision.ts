/**
 * HITL 决策服务与原生适配契约测试(tsx 直跑):
 *   npx tsx scripts/test-hitl-decision.ts
 *
 * 覆盖(主计划 §13.2/§13.4/§13.5 的硬性验收):
 *  1. 原子抢占:同一条目两次决策 → 第二次 409 ALREADY_RESOLVED;并发两审批人只有一个成功;
 *     直接断言 claimPending 返回 true → false(条件更新闸门);
 *  2. 审批策略:owner_only → 非 owner 成员 403 APPROVAL_FORBIDDEN;any_member → 成员可决策;
 *  3. 资格快照:创建后加入的成员不能决策历史请求;退出再加入(generation+1)失去旧资格;
 *  4. 重启语义:failAllNonTerminalOnRestart 后无 approved/answered 新增,非终态 → failed;
 *  5. delivery_unknown 可达且**不是成功**(不重试、nativeConfirmed=0);
 *  6. 未知 response 枚举 → 400(绝不默认放行);可重试失败 → 回落 pending 后可重试;
 *  7. dcw-approval 走同一抢占闸门;
 *  8. 适配器契约:codex `tool/requestUserInput` → `{answers:[…]}`(不是 {decision});
 *     opencode 多问题逐题 reply、显式 reject 不降级为 once、缺省 fail-closed。
 *
 * 进程内 :memory: 库 + mock harness;不访问网络、不安装任何引擎。
 */
import type { DatabaseSync } from 'node:sqlite'
import { openWorkshopDb } from '../server/services/workshop/db/database'
import { createChannelRepo } from '../server/services/workshop/db/channel.repo'
import { createAgentRepo } from '../server/services/workshop/db/agent.repo'
import { createChannelAgentRepo } from '../server/services/workshop/db/channel-agent.repo'
import { createTaskRepo } from '../server/services/workshop/db/task.repo'
import { createMemoryRepo } from '../server/services/workshop/db/memory.repo'
import { createChannelEventRepo } from '../server/services/workshop/db/channel-event.repo'
import { createTeamRepo } from '../server/services/workshop/db/team.repo'
import { createTeamMemberRepo } from '../server/services/workshop/db/team-member.repo'
import { createMessageRepo } from '../server/services/workshop/db/message.repo'
import { createSubscriptionRepo } from '../server/services/workshop/db/subscription.repo'
import { createAgentChannelManager } from '../server/services/workshop/runtime/manager'
import type { AgentChannelManager } from '../server/services/workshop/runtime/manager'
import { createAgentImpl } from '../server/services/workshop/agents/factory'
import { getHitlRegistry, configureHitlResolver, configureHitlRuntime, encodeHitlAnswers, decodeHitlAnswers, normalizeHitlQuestions } from '../server/services/workshop/agents/hitl-registry'
import type { HitlRuntimePort } from '../server/services/workshop/agents/hitl-registry'
import {
  decideHitlRequest,
  registerHitlNativeDispatcher,
  reconcileHitlOnStartup,
  resolveAnswers,
  canDecideHitlChannel,
  snapshotOfRow,
  HitlDeliveryUnknownError,
  HitlRetryableError,
} from '../server/services/workshop/agents/hitl-decision'
import { getToolApprovals } from '../server/services/workshop/agents/tool-approvals'
import {
  hitlCapabilityMatrix,
  harnessOfProviderKind,
  supportsHitlQuestion,
  supportsHitlMultiQuestion,
  markHarnessHitlVerified,
} from '../server/services/workshop/agents/hitl-capabilities'
import { HITL_TERMINAL_STATUSES } from '../server/services/workshop/db/hitl-request.repo'
import { CodexAgentImpl } from '../server/services/workshop/agents/codex-agent'
import { OpenCodeAgentImpl } from '../server/services/workshop/agents/opencode-agent'
import type { AepHitlQuestion } from '../shared/workshop-protocol'

let failures = 0

function check(name: string, ok: boolean, detail = ''): void {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures += 1
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

interface ErrShape { status?: number, code?: string, message: string }

async function catchErr(fn: () => Promise<unknown> | unknown): Promise<ErrShape> {
  try {
    await fn()
    return { message: '' }
  }
  catch (err) {
    const e = err as { status?: number, code?: string, message?: string }
    return { status: e.status, code: e.code, message: String(e.message ?? err) }
  }
}

function makeManager(db: DatabaseSync): AgentChannelManager {
  return createAgentChannelManager({
    repos: {
      channels: createChannelRepo(db),
      agents: createAgentRepo(db),
      channelAgents: createChannelAgentRepo(db),
      messages: createMessageRepo(db),
      subscriptions: createSubscriptionRepo(db),
      tasks: createTaskRepo(db),
      memories: createMemoryRepo(db),
      channelEvents: createChannelEventRepo(db),
      teams: createTeamRepo(db),
      teamMembers: createTeamMemberRepo(db),
    },
    implFactory: createAgentImpl,
    db,
  })
}

/** 用户固定身份(测试用稳定 id;name 进审计/通知) */
const OWNER = { id: 'u-owner', name: 'owner', role: 'user' }
const BOB = { id: 'u-bob', name: 'bob', role: 'user' }
const CAROL = { id: 'u-carol', name: 'carol', role: 'user' }
const DAVE = { id: 'u-dave', name: 'dave', role: 'user' }

async function main(): Promise<void> {
  console.log('━━━ HITL 决策服务与原生适配契约 ━━━')
  const db = openWorkshopDb(':memory:')
  const manager = makeManager(db)
  const channels = createChannelRepo(db)
  // 决策服务/登记持久化统一从这里取运行时(与插件挂载 globalThis.__workshopManager 等价)
  configureHitlRuntime(() => manager as unknown as HitlRuntimePort)
  const repo = manager.groupChat.hitl
  const reg = getHitlRegistry()

  // ---- 0. 环境:两个 Channel(owner_only / any_member)+ mock lead ----
  console.log('\n--- 0. 环境准备(2 Channel + 成员)---')
  const chOwner = await manager.createChannel({
    name: 'HITL owner_only 频道',
    ownerUserId: OWNER.id,
    leadAgent: { name: 'lead-owner-only', harness: 'mock' },
  })
  const chAny = await manager.createChannel({
    name: 'HITL any_member 频道',
    ownerUserId: OWNER.id,
    leadAgent: { name: 'lead-any-member', harness: 'mock' },
  })
  // 群聊维度:public + 已开启群聊 + 指定审批策略(channels.version 随之 +1 → 快照版本)
  channels.update(chOwner.channelId, { visibility: 'public', chatEnabled: 1, joinPolicy: 'open', approvalPolicy: 'owner_only' })
  channels.update(chAny.channelId, { visibility: 'public', chatEnabled: 1, joinPolicy: 'open', approvalPolicy: 'any_member' })
  const leadOwner = chOwner.leadAgentId!
  const leadAny = chAny.leadAgentId!
  // agentId → channelId 解析(插件用 configureHitlResolver 做同一件事)
  configureHitlResolver((agentId) => {
    if (agentId === leadOwner) return { channelId: chOwner.channelId, agentName: 'lead-owner-only' }
    if (agentId === leadAny) return { channelId: chAny.channelId, agentName: 'lead-any-member' }
    return null
  })

  manager.joinChannel(chOwner.channelId, BOB)
  manager.joinChannel(chAny.channelId, BOB)
  manager.joinChannel(chAny.channelId, CAROL)
  check('环境就绪(2 Channel + bob/carol 已加入)', manager.listChannelMembers(chAny.channelId).length >= 2)

  // ===== 1. 原子抢占 =====
  console.log('\n[1] 原子抢占:并发审批只有一个成功')
  let nativeCalls = 0
  registerHitlNativeDispatcher('codex-approval', async () => {
    await sleep(15) // 拉长窗口:确认第二个请求被"抢占闸门"而非时序挡住
    nativeCalls += 1
    return { via: 'test-dispatcher' }
  })

  reg.register({
    kind: 'codex-approval', id: 't1-approve', agentId: leadAny, channelId: chAny.channelId,
    method: 'confirm', title: '并发抢占测试审批', requestType: 'approval',
  })
  const rowT1 = repo.find('codex-approval', 't1-approve')
  check('登记即持久化事实行(冻结策略快照)', !!rowT1)
  check('策略快照记录创建时资格(owner+bob+carol)',
    !!rowT1 && (snapshotOfRow(rowT1).eligibleUserIds ?? []).includes(BOB.id) && (snapshotOfRow(rowT1).eligibleUserIds ?? []).includes(OWNER.id))
  check('快照 policy/policyVersion 与创建时一致', rowT1?.policy === 'any_member' && (rowT1?.policyVersion ?? 0) > 0)

  const attempt = (u: { id: string, name: string, role: string }) => decideHitlRequest({
    kind: 'codex-approval', id: 't1-approve', user: u, decision: { confirmed: true },
  }).then(r => ({ ok: true as const, r })).catch((e: ErrShape) => ({ ok: false as const, e }))
  const [r1, r2] = await Promise.all([attempt(OWNER), attempt(BOB)])
  const results = [r1, r2]
  const winner = results.find(x => x.ok)
  const loser = results.find(x => !x.ok)
  check('两个审批人并发提交:恰好一个成功', !!winner && !!loser,
    `winner=${winner ? (winner.ok ? 'ok' : 'err') : 'none'} loser=${loser ? 'yes' : 'none'}`)
  check('另一个拿到 409 ALREADY_RESOLVED(附已处理状态)',
    !!loser && !loser.ok && loser.e.status === 409 && loser.e.code === 'ALREADY_RESOLVED',
    loser && !loser.ok ? loser.e.message : '(无败者)')
  check('胜者终态 approved + 引擎确认',
    !!winner && winner.ok && winner.r.status === 'approved' && winner.r.nativeConfirmed === true)
  check('原生只被传导一次(不重复执行)', nativeCalls === 1, `nativeCalls=${nativeCalls}`)

  const dup = await catchErr(() => decideHitlRequest({
    kind: 'codex-approval', id: 't1-approve', user: OWNER, decision: { confirmed: true },
  }))
  check('同一条目再次提交 → 409(幂等,不重复决策)', dup.status === 409 && dup.code === 'ALREADY_RESOLVED', dup.message)

  // 直接断言条件更新闸门(claimPending)
  reg.register({
    kind: 'codex-approval', id: 't1-claim', agentId: leadAny, channelId: chAny.channelId,
    method: 'confirm', title: 'claimPending 直接断言', requestType: 'approval',
  })
  const claimed1 = repo.claimPending('t1-claim', 'decision-1', OWNER.id)
  const claimed2 = repo.claimPending('t1-claim', 'decision-2', BOB.id)
  const claimedRow = repo.findById('t1-claim')
  check('claimPending 第一次返回 true(获得决策权)', claimed1 === true)
  check('claimPending 第二次返回 false(并发抢占失败 → 409)', claimed2 === false)
  check('抢占后 status=resolving 且记录 decisionId/处理人',
    claimedRow?.status === 'resolving' && claimedRow?.responderUserId === OWNER.id && claimedRow?.decisionId === 'decision-1')
  repo.releaseClaim('t1-claim', '测试清理')

  // ===== 2. 审批策略 =====
  console.log('\n[2] 审批策略:owner_only vs any_member')
  reg.register({
    kind: 'codex-approval', id: 't2-owner-only', agentId: leadOwner, channelId: chOwner.channelId,
    method: 'confirm', title: 'owner_only 审批', requestType: 'approval',
  })
  const bobForbidden = await catchErr(() => decideHitlRequest({
    kind: 'codex-approval', id: 't2-owner-only', user: BOB, decision: { confirmed: true },
  }))
  check('owner_only:非 owner 成员 → 403 APPROVAL_FORBIDDEN',
    bobForbidden.status === 403 && bobForbidden.code === 'APPROVAL_FORBIDDEN', `${bobForbidden.status}/${bobForbidden.code}`)
  check('越权被拒后条目仍 pending(未被抢占消耗)', repo.findById('t2-owner-only')?.status === 'pending')
  const ownerAllowed = await decideHitlRequest({
    kind: 'codex-approval', id: 't2-owner-only', user: OWNER, decision: { confirmed: true },
  })
  check('owner_only:owner 可决策', ownerAllowed.status === 'approved')

  reg.register({
    kind: 'codex-approval', id: 't2-any-member', agentId: leadAny, channelId: chAny.channelId,
    method: 'confirm', title: 'any_member 审批', requestType: 'approval',
  })
  const bobAllowed = await decideHitlRequest({
    kind: 'codex-approval', id: 't2-any-member', user: BOB, decision: { confirmed: true },
  })
  check('any_member:普通成员可决策', bobAllowed.status === 'approved')
  const daveDenied = await catchErr(() => decideHitlRequest({
    kind: 'codex-approval', id: 't2-any-member', user: DAVE, decision: { confirmed: true },
  }))
  check('非成员一律 403(未加入者不可见/不可决策)', daveDenied.status === 403)

  // ===== 3. 创建时资格快照 =====
  console.log('\n[3] 资格快照:创建时资格 ∩ 当前资格')
  reg.register({
    kind: 'codex-approval', id: 't3-late-join', agentId: leadAny, channelId: chAny.channelId,
    method: 'confirm', title: '后加入者不可决策', requestType: 'approval',
  })
  const snapLate = snapshotOfRow(repo.find('codex-approval', 't3-late-join')!)
  check('快照不含创建时未加入的 dave', !(snapLate.eligibleUserIds ?? []).includes(DAVE.id))
  manager.joinChannel(chAny.channelId, DAVE)
  check('dave 之后成为 active 成员', manager.groupChat.members.isActiveMember(chAny.channelId, DAVE.id))
  const lateErr = await catchErr(() => decideHitlRequest({
    kind: 'codex-approval', id: 't3-late-join', user: DAVE, decision: { confirmed: true },
  }))
  check('后加入的成员不能决策历史请求(资格按创建时冻结)',
    lateErr.status === 403 && lateErr.code === 'APPROVAL_FORBIDDEN', lateErr.message)

  const genBefore = manager.groupChat.members.findOne(chAny.channelId, CAROL.id)!.generation
  reg.register({
    kind: 'codex-approval', id: 't3-rejoin', agentId: leadAny, channelId: chAny.channelId,
    method: 'confirm', title: '退出再加入失去资格', requestType: 'approval',
  })
  manager.leaveChannel(chAny.channelId, CAROL)
  manager.joinChannel(chAny.channelId, CAROL)
  const genAfter = manager.groupChat.members.findOne(chAny.channelId, CAROL.id)!.generation
  check('退出再加入 → generation +1', genAfter === genBefore + 1, `${genBefore} → ${genAfter}`)
  const rejoinErr = await catchErr(() => decideHitlRequest({
    kind: 'codex-approval', id: 't3-rejoin', user: CAROL, decision: { confirmed: true },
  }))
  check('重新加入的成员失去旧请求资格(代数不匹配 → 403)',
    rejoinErr.status === 403 && rejoinErr.code === 'APPROVAL_FORBIDDEN', rejoinErr.message)

  // ===== 4. 重启语义 =====
  console.log('\n[4] 重启语义:绝不自动批准')
  reg.register({
    kind: 'codex-approval', id: 't4-pending-1', agentId: leadAny, channelId: chAny.channelId,
    method: 'confirm', title: '重启前 pending A', requestType: 'approval',
  })
  reg.register({
    kind: 'codex-approval', id: 't4-pending-2', agentId: leadAny, channelId: chAny.channelId,
    method: 'confirm', title: '重启前 pending B', requestType: 'approval',
  })
  const countsBefore = repo.counts()
  const rec = reconcileHitlOnStartup({ force: true })
  const countsAfter = repo.counts()
  check('启动对账确实处理了非终态条目', rec.failed > 0 && rec.entries.length > 0, `failed=${rec.failed}`)
  check('重启后不存在 pending/resolving',
    (countsAfter.pending ?? 0) === 0 && (countsAfter.resolving ?? 0) === 0,
    JSON.stringify(countsAfter))
  check('重启不自动批准:approved/answered 数量未增加',
    (countsAfter.approved ?? 0) === (countsBefore.approved ?? 0) && (countsAfter.answered ?? 0) === (countsBefore.answered ?? 0),
    `before=${JSON.stringify(countsBefore)} after=${JSON.stringify(countsAfter)}`)
  check('受影响的非终态条目全部 → failed',
    rec.entries.every(e => e.status !== 'approved' && e.status !== 'answered') && (countsAfter.failed ?? 0) >= 2)
  const staleRow = repo.findById('t4-pending-1')
  check('failed 行带明确错误串且 nativeConfirmed=0',
    staleRow?.status === 'failed' && /重启/.test(staleRow?.error ?? '') && staleRow?.nativeConfirmed === 0,
    staleRow?.error ?? '')
  const afterRestart = await catchErr(() => decideHitlRequest({
    kind: 'codex-approval', id: 't4-pending-1', user: OWNER, decision: { confirmed: true },
  }))
  check('重启后对旧条目再决策 → 409(不复活待办)', afterRestart.status === 409, afterRestart.message)

  // ===== 5. delivery_unknown =====
  console.log('\n[5] delivery_unknown:可达且不是成功')
  registerHitlNativeDispatcher('dsh-permission', () => {
    throw new Error('socket hang up(引擎无回执)')
  })
  reg.register({
    kind: 'dsh-permission', id: 't5-unknown', agentId: leadAny, channelId: chAny.channelId,
    method: 'confirm', title: '结果未知的权限请求', requestType: 'approval',
  })
  const unknownErr = await catchErr(() => decideHitlRequest({
    kind: 'dsh-permission', id: 't5-unknown', user: OWNER, decision: { confirmed: true },
  }))
  const unknownRow = repo.findById('t5-unknown')
  check('结果未知 → 502 DELIVERY_UNKNOWN(不是成功)',
    unknownErr.status === 502 && unknownErr.code === 'DELIVERY_UNKNOWN', `${unknownErr.status}/${unknownErr.code}`)
  check('持久化状态 = delivery_unknown', unknownRow?.status === 'delivery_unknown')
  check('未标记引擎确认、未落 approved/answered',
    unknownRow?.nativeConfirmed === 0 && unknownRow?.status !== 'approved' && unknownRow?.status !== 'answered')
  check('delivery_unknown 不属于终态集合(待人工核对)',
    !HITL_TERMINAL_STATUSES.has('delivery_unknown') && HITL_TERMINAL_STATUSES.has('failed'))
  registerHitlNativeDispatcher('dsh-permission', () => {
    throw new HitlDeliveryUnknownError('显式声明结果未知')
  })
  reg.register({
    kind: 'dsh-permission', id: 't5-unknown-2', agentId: leadAny, channelId: chAny.channelId,
    method: 'confirm', title: '显式未知', requestType: 'approval',
  })
  const unknownErr2 = await catchErr(() => decideHitlRequest({
    kind: 'dsh-permission', id: 't5-unknown-2', user: OWNER, decision: { confirmed: true },
  }))
  check('显式 HitlDeliveryUnknownError 同样落入 delivery_unknown',
    unknownErr2.code === 'DELIVERY_UNKNOWN' && repo.findById('t5-unknown-2')?.status === 'delivery_unknown')

  // 可重试失败 → 回落 pending,换人可重试
  registerHitlNativeDispatcher('hermes-permission', () => {
    throw new HitlRetryableError('引擎忙,条目仍在 pending')
  })
  reg.register({
    kind: 'hermes-permission', id: 't5-retry', agentId: leadAny, channelId: chAny.channelId,
    method: 'confirm', title: '可重试失败', requestType: 'approval',
  })
  const retryErr = await catchErr(() => decideHitlRequest({
    kind: 'hermes-permission', id: 't5-retry', user: OWNER, decision: { confirmed: true },
  }))
  check('明确可重试失败 → 让出抢占,回落 pending',
    repo.findById('t5-retry')?.status === 'pending' && retryErr.code !== 'DELIVERY_UNKNOWN', retryErr.message)
  registerHitlNativeDispatcher('hermes-permission', () => ({ via: 'retry-ok' }))
  const retryOk = await decideHitlRequest({
    kind: 'hermes-permission', id: 't5-retry', user: OWNER, decision: { confirmed: true },
  })
  check('让出后可重试并成功', retryOk.status === 'approved' && retryOk.nativeConfirmed === true)

  // ===== 6. 未知 response 枚举不得默认放行 =====
  console.log('\n[6] 未知 response 枚举:直接拒绝,绝不默认允许')
  let ocCalls = 0
  registerHitlNativeDispatcher('opencode-permission', () => {
    ocCalls += 1
    return { via: 'test' }
  })
  reg.register({
    kind: 'opencode-permission', id: 't6-enum', agentId: leadAny, channelId: chAny.channelId,
    method: 'confirm', title: '未知枚举', requestType: 'approval',
  })
  const enumErr = await catchErr(() => decideHitlRequest({
    kind: 'opencode-permission', id: 't6-enum', user: OWNER, decision: { response: 'allow-everything' },
  }))
  check('未知枚举 → 400 INVALID_RESPONSE', enumErr.status === 400 && enumErr.code === 'INVALID_RESPONSE', enumErr.message)
  check('枚举非法时原生零调用(不静默放行)', ocCalls === 0)
  check('枚举非法时条目仍 pending(未被抢占)', repo.findById('t6-enum')?.status === 'pending')
  const rejectOk = await decideHitlRequest({
    kind: 'opencode-permission', id: 't6-enum', user: OWNER, decision: { response: 'reject' },
  })
  check('显式 reject 枚举被接受并落 rejected', rejectOk.status === 'rejected' && ocCalls === 1)

  // ===== 7. dcw-approval 同闸门 =====
  console.log('\n[7] dcw-approval:同抢占闸门 + 工具审批服务')
  const dcwPromise = getToolApprovals().request(leadAny, 'node-1', 'dcw', '设定值下发 100 → 120', { title: 'dcw 决策服务测试' })
  const dcwPending = getToolApprovals().listPending().find(a => a.agentId === leadAny)
  check('dcw 审批已登记并持久化', !!dcwPending && !!repo.find('dcw-approval', dcwPending.id))
  const dcwOk = await decideHitlRequest({
    kind: 'dcw-approval', id: dcwPending!.id, user: OWNER, decision: { confirmed: true, comment: '核对无误' },
  })
  const dcwResult = await dcwPromise
  check('dcw 审批经决策服务落定 approved', dcwOk.status === 'approved' && dcwOk.nativeConfirmed === true)
  check('工具侧拿到批准结果', dcwResult.approved === true && dcwResult.comment === '核对无误')
  const dcwDup = await catchErr(() => decideHitlRequest({
    kind: 'dcw-approval', id: dcwPending!.id, user: BOB, decision: { confirmed: true },
  }))
  check('dcw 二次决策 → 409(同一条目只允许一个决策)', dcwDup.status === 409 && dcwDup.code === 'ALREADY_RESOLVED', dcwDup.message)

  // ===== 8. 定向通知(§8 步骤 3/8)=====
  console.log('\n[8] 通知:按策略定向,不用全局广播')
  const ownerNotes = manager.listNotifications(OWNER.id, { limit: 200 })
  const bobNotes = manager.listNotifications(BOB.id, { limit: 200 })
  check('owner 收到 owner_only 请求通知',
    ownerNotes.some(n => n.type === 'hitl_request' && n.eventId === 'hitl_request:codex-approval:t2-owner-only'))
  check('非合格成员不收到 owner_only 通知(不打扰)',
    !bobNotes.some(n => n.eventId === 'hitl_request:codex-approval:t2-owner-only'))
  check('any_member 频道的请求通知到成员',
    bobNotes.some(n => n.type === 'hitl_request' && n.eventId === 'hitl_request:codex-approval:t2-any-member'))
  check('落定后投递 hitl_resolved 通知(带真实状态)',
    ownerNotes.some(n => n.type === 'hitl_resolved' && n.hitlId === 't2-owner-only'
      && (JSON.parse(n.payloadJson || '{}') as { status?: string }).status === 'approved'))
  check('pending.get 同口径过滤:非成员看不到该频道待办',
    !canDecideHitlChannel(chAny.channelId, { id: 'u-outsider', role: 'user' }))

  // ===== 9. 适配器原生契约 =====
  console.log('\n[9] 适配器契约:codex 提问走 answers / opencode 多问题逐题应答')
  // --- codex:tool/requestUserInput → { answers:[…] };审批 → { decision } ---
  const codex = new CodexAgentImpl({ agentId: 'a-codex', name: 'codex-test', role: 'worker', channelId: chAny.channelId })
  const codexSent: Array<{ method: string, id: unknown, payload: Record<string, unknown> }> = []
  ;(codex as unknown as { client: unknown }).client = {
    alive: true,
    respond: (id: unknown, payload: Record<string, unknown>) => { codexSent.push({ method: 'respond', id, payload }) },
    respondError: (id: unknown, code: number, message: string) => { codexSent.push({ method: 'respondError', id, payload: { code, message } }) },
  }
  const codexQuestions: AepHitlQuestion[] = normalizeHitlQuestions([
    { id: 'q1', header: '步长', question: '第一步取多少?', options: [{ label: '1' }, { label: '5' }] },
    { id: 'q2', header: '备注', question: '补充说明?' },
  ])
  check('codex 全量承载 questions(不只第一题)', codexQuestions.length === 2 && codexQuestions[1]!.id === 'q2')
  const codexPending = (codex as unknown as { pendingApprovals: Map<string, unknown> }).pendingApprovals
  codexPending.set('codex-input-t', { rpcId: 77, timer: null, type: 'question', questions: codexQuestions })
  await codex.respondHitl('codex-approval', 'codex-input-t', {
    value: encodeHitlAnswers([{ id: 'q1', answer: '5' }, { id: 'q2', answer: '无' }]),
  })
  check('codex 提问应答 = client.respond(rpcId,{answers:[…]}),不是 {decision}',
    codexSent.length === 1 && codexSent[0]!.method === 'respond'
    && Array.isArray(codexSent[0]!.payload.answers)
    && (codexSent[0]!.payload as { answers: Array<{ answer: string }> }).answers.length === 2
    && JSON.stringify((codexSent[0]!.payload as { answers: Array<{ answer: string }> }).answers) === JSON.stringify([{ answer: '5' }, { answer: '无' }])
    && !('decision' in codexSent[0]!.payload),
    JSON.stringify(codexSent[0]?.payload))
  codexPending.set('codex-input-c', { rpcId: 78, timer: null, type: 'question', questions: codexQuestions })
  await codex.respondHitl('codex-approval', 'codex-input-c', { cancelled: true })
  check('codex 提问取消 = respondError(-32800 人工取消)',
    codexSent[1]?.method === 'respondError' && (codexSent[1]?.payload as { code?: number }).code === -32800)
  codexPending.set('codex-appr-t', { rpcId: 79, timer: null, type: 'approval', questions: [] })
  await codex.respondHitl('codex-approval', 'codex-appr-t', { confirmed: true })
  check('codex 审批应答 = {decision:accept}',
    codexSent[2]?.method === 'respond' && (codexSent[2]?.payload as { decision?: string }).decision === 'accept')

  // --- opencode:多问题逐题 reply / reject 不降级 / 缺省 fail-closed ---
  const oc = new OpenCodeAgentImpl({ agentId: 'a-open', name: 'oc-test', role: 'worker', channelId: chAny.channelId })
  const ocApi: Array<{ method: string, path: string, body: Record<string, unknown> }> = []
  ;(oc as unknown as { api: unknown }).api = async (method: string, path: string, body: Record<string, unknown>) => {
    ocApi.push({ method, path, body })
    return {}
  }
  const ocPending = (oc as unknown as { pendingHitl: Map<string, unknown> }).pendingHitl
  const ocQuestions: AepHitlQuestion[] = normalizeHitlQuestions([
    { id: 'q-a', question: 'A?', options: ['x', 'y'], multiple: true },
    { id: 'q-b', question: 'B?' },
  ])
  check('opencode questions 保留 per-question id/options/multiSelect',
    ocQuestions.length === 2 && ocQuestions[0]!.multiSelect === true && ocQuestions[0]!.options?.length === 2)
  ocPending.set('oc-q', { kind: 'opencode-permission', id: 'oc-q', type: 'question', sessionId: 'sess-1', timer: null, questions: ocQuestions })
  await oc.respondHitl('opencode-permission', 'oc-q', {
    value: encodeHitlAnswers([{ id: 'q-a', answer: 'x' }, { id: 'q-b', answer: 'B 的答案' }]),
  })
  check('opencode 多问题逐题应答(每个问题一次 /question/{id}/reply)',
    ocApi.length === 2 && ocApi[0]!.path === '/question/q-a/reply' && ocApi[0]!.body.answer === 'x'
    && ocApi[1]!.path === '/question/q-b/reply' && ocApi[1]!.body.answer === 'B 的答案',
    JSON.stringify(ocApi))
  ocApi.length = 0
  ocPending.set('oc-q2', { kind: 'opencode-permission', id: 'oc-q2', type: 'question', sessionId: 'sess-1', timer: null, questions: ocQuestions })
  await oc.respondHitl('opencode-permission', 'oc-q2', { cancelled: true })
  check('opencode 提问取消 → 逐题 POST /question/{id}/reject',
    ocApi.length === 2 && ocApi.every(c => c.path.endsWith('/reject')) && ocApi[0]!.path === '/question/q-a/reject',
    JSON.stringify(ocApi))
  ocApi.length = 0
  ocPending.set('oc-p-reject', { kind: 'opencode-permission', id: 'oc-p-reject', type: 'permission', sessionId: 'sess-1', timer: null, questions: [] })
  await oc.respondHitl('opencode-permission', 'oc-p-reject', { response: 'reject' })
  check('opencode 显式 reject 不再被降级为 once',
    ocApi.length === 1 && ocApi[0]!.body.response === 'reject', JSON.stringify(ocApi))
  ocApi.length = 0
  ocPending.set('oc-p-default', { kind: 'opencode-permission', id: 'oc-p-default', type: 'permission', sessionId: 'sess-1', timer: null, questions: [] })
  await oc.respondHitl('opencode-permission', 'oc-p-default', {})
  check('opencode 缺省(无 confirmed/response)= fail-closed reject',
    ocApi.length === 1 && ocApi[0]!.body.response === 'reject', JSON.stringify(ocApi))
  ocApi.length = 0
  ocPending.set('oc-p-always', { kind: 'opencode-permission', id: 'oc-p-always', type: 'permission', sessionId: 'sess-1', timer: null, questions: [] })
  await oc.respondHitl('opencode-permission', 'oc-p-always', { response: 'always' })
  check('opencode 合法枚举 always 原样透传', ocApi[0]?.body.response === 'always')
  ocPending.set('oc-p-bad', { kind: 'opencode-permission', id: 'oc-p-bad', type: 'permission', sessionId: 'sess-1', timer: null, questions: [] })
  const ocBad = await catchErr(() => oc.respondHitl('opencode-permission', 'oc-p-bad', { response: 'allow-all' }))
  check('opencode 未知枚举在适配器层再次拒绝(双保险)', /未知/.test(ocBad.message), ocBad.message)

  // ===== 10. 答案归一 =====
  console.log('\n[10] 答案归一:信封编解码与按问题 id 对齐')
  const answers = resolveAnswers(ocQuestions, { answers: [{ id: 'q-b', answer: 'B!' }, { id: 'q-a', answer: 'y' }] })
  const encoded = encodeHitlAnswers(answers)
  check('结构化答案按问题 id 对齐(与传入顺序无关)',
    answers[0]!.id === 'q-a' && answers[0]!.answer === 'y' && answers[1]!.answer === 'B!')
  check('多问题信封可无损解码',
    JSON.stringify(decodeHitlAnswers(encoded)) === JSON.stringify([{ id: 'q-a', answer: 'y' }, { id: 'q-b', answer: 'B!' }]))
  check('单问题保持裸文本(旧消费方兼容)', encodeHitlAnswers([{ id: 'q', answer: '纯文本' }]) === '纯文本')
  check('非信封字符串按单答案处理', decodeHitlAnswers('纯文本') === null)

  // ===== 11. 能力矩阵(§13.5:不支持结构化 ask 的必须是 UNSUPPORTED,不是 PASS)=====
  console.log('\n[11] 能力矩阵:结构化能力 + 安装探测 + 状态口径')
  const matrix = hitlCapabilityMatrix({ refresh: true })
  const byId = new Map(matrix.map(r => [r.harness, r]))
  const noHitl = ['mock', 'gemini', 'copilot', 'cursor', 'crush', 'goose', 'pi']
  check('无 HITL 引擎全部标记 UNSUPPORTED(绝不 PASS)',
    noHitl.every((id) => {
      const r = byId.get(id)
      return !!r && r.status === 'UNSUPPORTED' && !r.approval && !r.question && !r.multiQuestion && !r.cancel
    }),
    noHitl.map(id => `${id}=${byId.get(id)?.status}`).join(' '))
  check('声明 HITL 的引擎不会在未验证时被标 PASS',
    ['codex', 'opencode', 'dsh', 'claude', 'qwen', 'hermes', 'omp'].every(id => byId.get(id)?.status !== 'PASS'),
    ['codex', 'opencode', 'dsh', 'claude', 'qwen', 'hermes', 'omp'].map(id => `${id}=${byId.get(id)?.status}`).join(' '))
  check('未安装引擎状态为 BLOCKED 且带人话原因',
    matrix.filter(r => r.status === 'BLOCKED').every(r => r.statusReason.length > 0 && (r.available || !!r.unavailableReason)))
  check('kind → 能力反查:opencode 支持提问/多问题,dcw 不支持',
    supportsHitlQuestion('opencode-permission') && supportsHitlMultiQuestion('opencode-permission')
    && !supportsHitlQuestion('dcw-approval') && harnessOfProviderKind('codex-approval') === 'codex')
  const fakeVerify = await catchErr(() => {
    markHarnessHitlVerified('no-such-engine', { ok: true, evidence: '伪造' })
  })
  check('未安装/未知引擎禁止写入验证记录(不可伪造 PASS)', fakeVerify.message !== '', fakeVerify.message)
  console.log('\n  ── HITL 能力矩阵(本环境实测) ──')
  for (const r of matrix) {
    console.log(`  ${r.harness.padEnd(9)} approval=${r.approval ? 'Y' : '-'} question=${r.question ? 'Y' : '-'} multi=${r.multiQuestion ? 'Y' : '-'} cancel=${r.cancel ? 'Y' : '-'} installed=${r.installed ? 'Y' : 'N'} status=${r.status}`)
  }

  console.log(failures === 0 ? '\n[hitl-decision] 全部通过' : `\n[hitl-decision] ${failures} 项失败`)
  await manager.shutdown().catch(() => {})
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('[hitl-decision] 测试异常终止:', err)
  process.exit(1)
})
