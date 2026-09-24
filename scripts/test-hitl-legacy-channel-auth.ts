/**
 * HITL 无持久化行时的遗留 Channel 授权回归测试:
 *   pnpm exec tsx scripts/test-hitl-legacy-channel-auth.ts
 */
import { AppError } from '../server/utils/errors'
import { configureHitlRuntime, getHitlRegistry, type HitlRuntimePort } from '../server/services/workshop/agents/hitl-registry'
import { decideHitlRequest, registerHitlNativeDispatcher } from '../server/services/workshop/agents/hitl-decision'

const legacyChannel = { id: 'legacy-channel', ownerUserId: null, approvalPolicy: 'any_member' }
const claimedChannel = { id: 'claimed-channel', ownerUserId: 'u-owner', approvalPolicy: 'any_member' }
const channels = new Map([
  [legacyChannel.id, legacyChannel],
  [claimedChannel.id, claimedChannel],
])
const members = new Set(['claimed-channel:u-member'])
let runtime: HitlRuntimePort | null = null
let approvalChecks = 0
let legacyReadChecks = 0
let nativeCalls = 0
let failures = 0

function check(name: string, ok: boolean, detail = ''): void {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures += 1
}

async function captureError(fn: () => Promise<unknown>): Promise<{ status?: number, code?: string } | null> {
  try {
    await fn()
    return null
  }
  catch (err) {
    const error = err as { status?: number, code?: string }
    return error
  }
}

function register(id: string, channelId: string): void {
  getHitlRegistry().register({
    kind: 'codex-approval',
    id,
    agentId: `agent-${id}`,
    channelId,
    method: 'confirm',
    title: 'authorization regression',
    requestType: 'approval',
  })
}

async function main(): Promise<void> {
  configureHitlRuntime(() => runtime)
  register('legacy-no-row', legacyChannel.id)
  register('claimed-no-row', claimedChannel.id)

  runtime = {
    groupChat: {
      hitl: {
        find: () => undefined,
        listNonTerminal: () => [],
      },
      members: { listActiveByChannel: () => [] },
    },
    notifyUser: () => ({ id: 'notification', inserted: true }),
    listChannelsVisibleTo: () => [...channels.values()],
    listChannelsForUser: userId => [...channels.values()].filter(channel => channel.ownerUserId === null || channel.ownerUserId === userId),
    requireChannelMember: (channelId, user) => {
      const channel = channels.get(channelId)
      if (!channel) throw new AppError(404, 'NOT_FOUND', 'channel not found')
      if (user.role !== 'admin' && channel.ownerUserId === null) throw new AppError(403, 'FORBIDDEN_LEGACY', 'legacy channel')
      return channel
    },
    requireCanApprove: (channelId, user) => {
      approvalChecks += 1
      const channel = channels.get(channelId)
      if (!channel) throw new AppError(404, 'NOT_FOUND', 'channel not found')
      if (channel.ownerUserId === null) throw new AppError(403, 'FORBIDDEN_LEGACY', 'legacy channel requires claim')
      if (channel.ownerUserId !== user.id && !(channel.approvalPolicy === 'any_member' && members.has(`${channelId}:${user.id}`))) {
        throw new AppError(403, 'APPROVAL_FORBIDDEN', 'current approval policy denied')
      }
      return channel
    },
    getChannelForUser: (channelId, userId) => {
      legacyReadChecks += 1
      const channel = channels.get(channelId)
      if (!channel || (channel.ownerUserId !== null && channel.ownerUserId !== userId)) {
        throw new AppError(403, 'SCOPE_VIOLATION', 'channel not visible')
      }
      return channel
    },
    findChannelAgentById: () => undefined,
    respondHarnessHitl: async () => {},
  } as unknown as HitlRuntimePort

  registerHitlNativeDispatcher('codex-approval', async () => {
    nativeCalls += 1
    return { via: 'test' }
  })

  const legacyError = await captureError(() => decideHitlRequest({
    kind: 'codex-approval',
    id: 'legacy-no-row',
    user: { id: 'u-member', role: 'user' },
    decision: { confirmed: true },
  }))
  check('无持久化行的 owner=NULL legacy channel 对普通登录用户 fail-closed',
    legacyError?.status === 403 && legacyError.code === 'FORBIDDEN_LEGACY_APPROVAL', JSON.stringify(legacyError))
  check('遗留请求被拒后仍 pending，且未调用旧只读守卫或原生批准',
    getHitlRegistry().find('codex-approval', 'legacy-no-row')?.status === 'pending'
    && legacyReadChecks === 0 && nativeCalls === 0,
    `legacyRead=${legacyReadChecks}, approvalChecks=${approvalChecks}(审批守卫可被咨询,以拒为结论), native=${nativeCalls}`)

  const claimedResult = await decideHitlRequest({
    kind: 'codex-approval',
    id: 'claimed-no-row',
    user: { id: 'u-member', role: 'user' },
    decision: { confirmed: true },
  })
  check('无行但已有显式 owner 与当前 any_member 资格时仍可决策',
    claimedResult.status === 'approved' && !claimedResult.persisted && nativeCalls === 1)

  runtime = null
  register('no-auth-runtime', claimedChannel.id)
  const unavailableError = await captureError(() => decideHitlRequest({
    kind: 'codex-approval',
    id: 'no-auth-runtime',
    user: { id: 'u-member', role: 'user' },
    decision: { confirmed: true },
  }))
  check('无持久化行且当前授权运行时缺失时拒绝，而非跳过授权',
    unavailableError?.status === 503 && unavailableError.code === 'HITL_AUTH_UNAVAILABLE'
    && getHitlRegistry().find('codex-approval', 'no-auth-runtime')?.status === 'pending'
    && nativeCalls === 1, JSON.stringify(unavailableError))

  registerHitlNativeDispatcher('codex-approval', null)
  configureHitlRuntime(null)
  console.log(failures === 0 ? '\n[hitl-legacy-channel-auth] 全部通过' : `\n[hitl-legacy-channel-auth] ${failures} 项失败`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('[hitl-legacy-channel-auth] 测试异常终止:', err)
  process.exit(1)
})
