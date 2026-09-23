/**
 * 群聊/权限/HITL 单测共享库:断言框架 + 场景搭建辅助。
 *
 * 由 scripts/test-group-chat-unit.ts 拆分而来(原文第 20–168 行),语句逐行原文搬运,仅做机械改写:
 *  - 断言框架 / ChatReplyRow / makeManager / 场景搭建原样保留;`passed` / `failures` 两个模块级自由变量
 *    改为导出的 `assertion` 对象(计数语义、调用顺序完全不变);
 *  - 场景搭建的顶层顺序代码包成 createGroupChatTestContext() 工厂,共享状态经 ctx 显式传递;
 *  - server 模块 import 顺序与拆分前逐条一致,且刻意保持 dynamic import ——
 *    它们必须在入口设置 AW_DATA_DIR / AGENTWORKSHOP_TEST 之后才求值。
 */
import type { DatabaseSync } from 'node:sqlite'

const { openWorkshopDb, initWorkshopDb } = await import('../../server/services/workshop/db/database')
const { createChannelRepo } = await import('../../server/services/workshop/db/channel.repo')
const { createAgentRepo } = await import('../../server/services/workshop/db/agent.repo')
const { createChannelAgentRepo } = await import('../../server/services/workshop/db/channel-agent.repo')
const { createTaskRepo } = await import('../../server/services/workshop/db/task.repo')
const { createMemoryRepo } = await import('../../server/services/workshop/db/memory.repo')
const { createChannelEventRepo } = await import('../../server/services/workshop/db/channel-event.repo')
const { createTeamRepo } = await import('../../server/services/workshop/db/team.repo')
const { createTeamMemberRepo } = await import('../../server/services/workshop/db/team-member.repo')
const { createMessageRepo } = await import('../../server/services/workshop/db/message.repo')
const { createSubscriptionRepo } = await import('../../server/services/workshop/db/subscription.repo')
const managerMod = await import('../../server/services/workshop/runtime/manager')
const createAgentChannelManager = managerMod.createAgentChannelManager
export type AgentChannelManager = InstanceType<typeof managerMod.AgentChannelManager>
const { createAgentImpl } = await import('../../server/services/workshop/agents/factory')
const { resolveMentions, extractMentionTokens } = await import('../../server/services/workshop/runtime/chat-mention')
const { projectManagementSnapshotForMember } = await import('../../server/services/workshop/runtime/chat-projection')
const { checkToolAgainstScope, MANAGEMENT_TOOL_NAMES } = await import('../../server/services/workshop/runtime/permission-scope')
const {
  WORKSHOP_PERMISSION_SCOPE_HEADER,
  parseWorkshopPermissionScope,
  intersectWorkshopPermissionScope,
} = await import('../../shared/workshop-protocol')
const { userRepository } = await import('../../server/repositories/user.repository')

// ===== 断言框架(与仓库既有 scripts/test-*.ts 同风格) =====
/** 断言累计状态:拆分前为模块级 `let passed` / `const failures`(语义等价,main.ts 读同一对象汇总) */
export const assertion: { passed: number, failures: string[] } = { passed: 0, failures: [] }
export function check(name: string, ok: boolean, detail = ''): void {
  if (ok) {
    assertion.passed++
    console.log(`  PASS  ${name}${detail ? ` — ${detail}` : ''}`)
  }
  else {
    assertion.failures.push(name)
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
  }
}
export function section(title: string): void {
  console.log(`\n=== ${title} ===`)
}
/** 断言抛出 AppError 且 code 匹配 */
export function checkThrows(name: string, fn: () => unknown, code: string): void {
  try {
    fn()
    check(name, false, '未抛出异常')
  }
  catch (err) {
    const e = err as { code?: string, statusCode?: number, message?: string }
    check(name, e.code === code, `实际 code=${e.code ?? '(none)'} status=${e.statusCode ?? '?'} msg=${e.message ?? ''}`)
  }
}
/**
 * async 版本:await 型接口拒绝的是 Promise,**不会**同步抛出 ——
 * 用 checkThrows 调 async 方法会永远得到"未抛出异常"(实测踩过,断言假通过)。
 */
export async function checkRejects(name: string, fn: () => Promise<unknown>, code: string): Promise<void> {
  try {
    await fn()
    check(name, false, '未抛出异常(期望拒绝)')
  }
  catch (err) {
    const e = err as { code?: string, statusCode?: number, message?: string }
    check(name, e.code === code, `实际 code=${e.code ?? '(none)'} status=${e.statusCode ?? '?'} msg=${e.message ?? ''}`)
  }
}

/** 群聊事实表里 Agent 回复行的证据字段(§12 关联 ID 对照) */
export interface ChatReplyRow {
  id: string
  sourceChatMessageId: string | null
  requesterUserId: string | null
  mentionsJson: string
}

export function makeManager(db: DatabaseSync): AgentChannelManager {
  return createAgentChannelManager({
    repos: {
      users: undefined as never,
      channelEvents: createChannelEventRepo(db),
      channels: createChannelRepo(db),
      agents: createAgentRepo(db),
      teams: createTeamRepo(db),
      teamMembers: createTeamMemberRepo(db),
      channelAgents: createChannelAgentRepo(db),
      messages: createMessageRepo(db),
      subscriptions: createSubscriptionRepo(db),
      tasks: createTaskRepo(db),
      memories: createMemoryRepo(db),
      schedules: undefined as never,
    },
    implFactory: createAgentImpl,
    db,
  })
}

/** 场景搭建后的共享状态类型(拆分前为模块级 ADMIN/A/B/C/D、db、manager、buildChannel) */
export interface GroupChatTestUser {
  id: string
  name: string
  role: string
}

export interface GroupChatTestContext {
  db: DatabaseSync
  manager: AgentChannelManager
  ADMIN: GroupChatTestUser
  A: GroupChatTestUser
  B: GroupChatTestUser
  C: GroupChatTestUser
  D: GroupChatTestUser
  mkUser: (name: string) => GroupChatTestUser
  buildChannel: (name: string) => Promise<{ channelId: string, leadId: string, workerId: string }>
}

// ===== 场景搭建:owner=A / 成员=B、C / 非成员=D =====
// 用户注册到**全局用户系统**(与线上同源):这样 resolveOwnerName 能解析展示名,
// mention 的"展示名解析"路径才被真实覆盖,而不是退化成 id 前缀兜底。
// 注意:不能 import user.service(它经 #imports 依赖 nitro 运行时),直接用仓储。
export function createGroupChatTestContext(): GroupChatTestContext {
  const registered: Array<{ id: string, name: string, role: string }> = []
  function mkUser(name: string): { id: string, name: string, role: string } {
    const { user } = userRepository.createWithRoleBootstrap({
      name,
      email: `${name}@chat-test.local`,
      password: 'Passw0rd!123',
      role: 'user',
      status: 'active',
    })
    const u = { id: user.id, name: user.name, role: user.role }
    registered.push(u)
    return u
  }
  // 首个注册账号会被 bootstrap 为 admin(线上同规则)→ 先建 admin,再建业务用户
  const ADMIN = mkUser('root-admin')
  const A = mkUser('alice')
  const B = mkUser('bob')
  const C = mkUser('carol')
  const D = mkUser('dave')

  const db = openWorkshopDb(':memory:')
  const manager = makeManager(db)

  /** 建一个 owner=A 的 channel(mock lead + 1 worker) */
  async function buildChannel(name: string): Promise<{ channelId: string, leadId: string, workerId: string }> {
    const leadTpl = await manager.createAgent({ name: `${name}-lead`, harness: 'mock', config: { delayMs: 5 } })
    const workerTpl = await manager.createAgent({ name: `${name}-worker`, harness: 'mock', config: { delayMs: 5 } })
    const { channelId, leadAgentId } = await manager.createChannel({
      name,
      description: '群聊单测',
      ownerUserId: A.id,
      leadAgent: { name: `${name}-lead`, harness: 'mock', config: { delayMs: 5 } },
    })
    void leadTpl
    await manager.addAgentToChannel({ channelId, agentId: workerTpl.id, role: 'worker' })
    manager.ensureChannelActive(channelId)
    const worker = manager.deps.repos.channelAgents.listByChannel(channelId).find(m => m.role === 'worker')!
    return { channelId, leadId: leadAgentId!, workerId: worker.id }
  }
  return { db, manager, ADMIN, A, B, C, D, mkUser, buildChannel }
}

// 供各分节场景模块复用(原文中这些是同一作用域内的自由绑定,顺序同 import)
export {
  initWorkshopDb,
  resolveMentions,
  extractMentionTokens,
  projectManagementSnapshotForMember,
  checkToolAgainstScope,
  MANAGEMENT_TOOL_NAMES,
  WORKSHOP_PERMISSION_SCOPE_HEADER,
  parseWorkshopPermissionScope,
  intersectWorkshopPermissionScope,
}
