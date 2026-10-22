/**
 * PUT /api/workshop/channels/:id/tools —— 保存 Channel 工具选择(全量替换)。
 *
 * body: { mode: 'all'|'selected', tools: [{ name, enabled }] }
 *  - all: 全部合格工具启用;只持久化 enabled=false 的行(deny-list)
 *  - selected: 仅勾选工具启用;持久化提交的全量行(allow-list)
 *
 * 硬规则不可覆盖:selected 模式下显式启用一个对 lead/worker 都不合格的工具 → 409。
 * 鉴权:Channel 属主或 admin;遗留公共 Channel 需 admin。
 */
import { readBody } from 'h3'
import { resolveUser, requireAdmin } from '../../../../workshop/caller'
import { defineApiHandler } from '@/server/utils/response'
import { getWorkshopManager } from '@/server/plugins/workshop'
import { getToolRegistryRepo, type ChannelToolPolicyEntry, type ToolPolicyMode } from '@/server/services/workshop/db/tool-registry.repo'
import { buildChannelToolView } from '@/server/services/workshop/tools/catalog-view'
import { notifyToolChange } from '@/server/services/workshop/agents/plugin-tools'
import { recordOps } from '@/server/services/workshop/ops/ops'
import { AppError } from '@/server/utils/errors'

const TOOL_NAME_RE = /^[a-z][a-z0-9_]{1,63}$/
const MAX_TOOLS = 500

interface ToolInput { name?: unknown, enabled?: unknown }
interface Body { mode?: unknown, tools?: unknown }

export default defineApiHandler(async (event) => {
  const user = resolveUser(event)
  const id = String(event.context.params?.id ?? '')
  const manager = getWorkshopManager()
  const channel = manager.getChannelForUser(id, user.id)
  if (channel.ownerUserId === null) requireAdmin(event)

  const body = (await readBody<Body>(event)) ?? {}
  if (body.mode !== undefined && body.mode !== 'all' && body.mode !== 'selected') {
    throw new AppError(400, 'VALIDATION_ERROR', 'mode 只能是 all 或 selected')
  }
  const mode: ToolPolicyMode = body.mode === 'selected' ? 'selected' : 'all'
  if (!Array.isArray(body.tools)) {
    throw new AppError(400, 'VALIDATION_ERROR', 'body 应为 { mode, tools: [{ name, enabled }] }')
  }
  if (body.tools.length > MAX_TOOLS) {
    throw new AppError(400, 'VALIDATION_ERROR', `tools 最多 ${MAX_TOOLS} 条`)
  }

  const view = buildChannelToolView(id)
  const byName = new Map(view.tools.map(t => [t.name, t]))
  const seen = new Set<string>()
  const entries: ChannelToolPolicyEntry[] = []
  const unknown: string[] = []
  const unavailable: string[] = []
  const ineligible: Array<{ name: string, reason: string }> = []

  for (const raw of body.tools as ToolInput[]) {
    const name = typeof raw?.name === 'string' ? raw.name : ''
    if (raw?.enabled !== undefined && typeof raw.enabled !== 'boolean') {
      throw new AppError(400, 'VALIDATION_ERROR', `工具 ${name || '(空)'} 的 enabled 必须是 boolean`)
    }
    if (!TOOL_NAME_RE.test(name)) unknown.push(name || '(空)')
    if (seen.has(name)) throw new AppError(400, 'DUPLICATE_TOOL', `工具重复提交: ${name}`)
    seen.add(name)
    const enabled = raw?.enabled === true
    const tool = byName.get(name)
    if (!tool) {
      unknown.push(name)
      continue
    }
    if (enabled) {
      // all 模式下 enabled=true 只是“默认启用”(不落库),不可用/被硬规则挡住的工具仍不会生效;
      // selected 模式是显式 allow-list,启用一个不可用或永不合格的工具必须拒绝并说明原因。
      if (mode === 'selected' && !tool.available) unavailable.push(name)
      const hardBlocked = !tool.eligibility.lead.eligible && !tool.eligibility.worker.eligible
      if (mode === 'selected' && hardBlocked) {
        const reason = tool.eligibility.lead.reason !== 'OK' ? tool.eligibility.lead.reason : tool.eligibility.worker.reason
        ineligible.push({ name, reason })
      }
    }
    entries.push({ name, enabled })
  }

  if (unknown.length > 0) {
    throw new AppError(400, 'UNKNOWN_TOOL', `未知工具: ${unknown.slice(0, 10).join(', ')}${unknown.length > 10 ? ' …' : ''}`)
  }
  if (unavailable.length > 0) {
    throw new AppError(409, 'TOOL_UNAVAILABLE', `工具当前未注册/插件未启用: ${unavailable.slice(0, 10).join(', ')}`)
  }
  if (ineligible.length > 0) {
    const first = ineligible[0]!
    throw new AppError(409, 'TOOL_NOT_ELIGIBLE', `工具 ${first.name} 被硬规则排除(${first.reason});Channel 开关不能绕过角色/档位/写守卫。`)
  }

  try {
    getToolRegistryRepo().savePolicy(id, mode, entries, user.id)
  }
  catch (err) {
    throw new AppError(503, 'TOOL_REGISTRY_UNAVAILABLE', `工具策略保存失败: ${err instanceof Error ? err.message : String(err)}`)
  }

  // 在跑 omp 会话立即重发 set_host_tools;pi 下一回合;MCP 引擎由执行闸门兜底。
  notifyToolChange()

  const disabled = entries.filter(e => !e.enabled).length
  recordOps({
    actor: user.id,
    actorName: user.name,
    actorKind: 'user',
    action: 'tool_policy.update',
    targetKind: 'channel',
    targetId: id,
    kind: 'system',
    scope: 'system',
    summary: `Channel 工具策略已更新: mode=${mode}, 启用=${entries.length - disabled}, 停用=${disabled}`,
    detail: { mode, tools: entries },
  })

  return buildChannelToolView(id)
})
