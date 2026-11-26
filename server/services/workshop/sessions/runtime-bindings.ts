/**
 * 会话 runtime 的工业绑定摘要（只读）。
 *
 * 节点/recipe 绑定本身是「按 agentId 的 JSON 仓库 + 每次工具调用实时读取」，
 * 因此绑定变更在下一回合就生效；这里只把 effective 绑定面、可选资源与会话
 * 冻结的产品/配方快照汇总给 UI。冻结快照不会因绑定变化而改动。
 */
import type { DatabaseSync } from 'node:sqlite'
import { AppError } from '../../../utils/errors'
import { parseJson } from '../db/database'
import { createChannelAgentRepo } from '../db/channel-agent.repo'
import { createChannelRepo } from '../db/channel.repo'
import { createChannelSessionRepo } from '../db/channel-session.repo'
import { createSessionBindingOverrideRepo } from '../db/session-binding.repo'
import { resolveTrustedSessionBinding } from '../agents/session-snapshot'
import { getDcwRecipeRepo } from '../dcw/dcw-recipe.repo'
import { readSessionRuntimeOverrides } from './runtime-overrides'

export type RuntimeBindingKind = 'daq' | 'dcw' | 'recipe' | 'line-recipe'
export type RuntimeBindingMode = 'auto' | 'manual'

export interface RuntimeBindingNodeResource {
  id: string
  name: string
  unit: string
  lineId: string | null
}

export interface RuntimeBindingRecipeResource {
  id: string
  name: string
  version: number
  lineId: string | null
  productId: string | null
}

export interface RuntimeBindingLineResource {
  id: string
  name: string
}

export interface SessionRuntimeBindingDeps {
  listDaqNodes: () => RuntimeBindingNodeResource[]
  listDcwNodes: () => RuntimeBindingNodeResource[]
  listRecipes: () => RuntimeBindingRecipeResource[]
  listLines: () => RuntimeBindingLineResource[]
  lineMode: (user: { id: string, role: string }, lineId: string | null) => 'none' | 'readonly' | 'operate'
  bindingsOf: (agentId: string) => Array<{ id: string, nodeId: string, kind: string, mode: string }>
  toolRefresh: (harness: string) => 'native' | 'list_changed' | 'per_turn'
}

export interface RuntimeBindingView {
  id: string
  kind: RuntimeBindingKind
  nodeId: string
  name: string
  unit: string
  lineId: string | null
  mode: RuntimeBindingMode
}

export interface SessionRuntimeBindingSummary {
  channelId: string
  sessionId: string
  runtimeObjectId: string
  harness: string
  channelMode: 'generic' | 'production_line_integrated'
  lineId: string | null
  productId: string | null
  bindingSnapshotRevision: number
  /** 有效范围配方（覆盖行按当前 recipe 定义实时解析；快照会话为创建时版本） */
  scopeRecipes: Array<{ id: string, name: string, version: number }>
  /** true = 覆盖行生效，product/line/recipes 可运行期修改 */
  scopeMutable: boolean
  scopeSource: 'override' | 'snapshot' | 'none'
  bindings: RuntimeBindingView[]
  resources: {
    daqNodes: RuntimeBindingNodeResource[]
    dcwNodes: RuntimeBindingNodeResource[]
    recipes: RuntimeBindingRecipeResource[]
    lines: RuntimeBindingLineResource[]
  }
  toolRefresh: 'native' | 'list_changed' | 'per_turn'
  /** 绑定在下一回合/下一次工具调用生效；会话冻结快照不变。 */
  effectiveAt: 'next_turn'
}

export interface SessionRuntimeBindingInput {
  channelId: string
  sessionId: string
  agentId: string
  user: { id: string, role: string }
}

function memberMapOf(raw: string): Record<string, string> {
  const parsed = parseJson<unknown>(raw, {})
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value === 'string') out[key] = value
  }
  return out
}

function kindOf(raw: string): RuntimeBindingKind | null {
  return raw === 'daq' || raw === 'dcw' || raw === 'recipe' || raw === 'line-recipe' ? raw : null
}

export function createSessionRuntimeBindingService(db: DatabaseSync, deps: SessionRuntimeBindingDeps) {
  const channels = createChannelRepo(db)
  const agents = createChannelAgentRepo(db)
  const sessions = createChannelSessionRepo(db)

  function get(input: SessionRuntimeBindingInput): SessionRuntimeBindingSummary {
    const session = sessions.findById(input.sessionId)
    if (!session || session.channelId !== input.channelId) {
      throw new AppError(404, 'NOT_FOUND', `会话不存在: ${input.sessionId}`)
    }
    if (!Object.values(memberMapOf(session.memberMapJson)).includes(input.agentId)) {
      throw new AppError(404, 'NOT_FOUND', `会话 runtime 不存在: ${input.agentId}`)
    }
    const member = agents.findByChannelAgent(input.channelId, input.agentId)
    if (!member) throw new AppError(404, 'NOT_FOUND', `会话 runtime 不存在: ${input.agentId}`)
    const channel = channels.findById(input.channelId)
    const trusted = resolveTrustedSessionBinding(db, session, { recipeLookup: id => getDcwRecipeRepo().byId(id) })
    const scopeLine = channel?.lineId || trusted?.lineId || null
    const visible = (lineId: string | null): boolean => {
      // lineMode(null) 对特权角色返回 operate、普通用户返回 none —— 与 filterByLine 同口径，
      // 未挂线/悬空对象只对特权角色可见。
      return deps.lineMode(input.user, lineId) !== 'none'
    }

    const daqNodes = deps.listDaqNodes()
    const dcwNodes = deps.listDcwNodes()
    const recipes = deps.listRecipes()
    const lines = deps.listLines()
    const daqById = new Map(daqNodes.map(n => [n.id, n]))
    const dcwById = new Map(dcwNodes.map(n => [n.id, n]))
    const recipeById = new Map(recipes.map(r => [r.id, r]))
    const lineById = new Map(lines.map(l => [l.id, l]))

    const bindings: RuntimeBindingView[] = []
    for (const binding of deps.bindingsOf(input.agentId)) {
      const kind = kindOf(binding.kind)
      if (!kind) continue
      let node: RuntimeBindingNodeResource | RuntimeBindingRecipeResource | RuntimeBindingLineResource | undefined
      if (kind === 'daq') node = daqById.get(binding.nodeId)
      else if (kind === 'dcw') node = dcwById.get(binding.nodeId)
      else if (kind === 'recipe') node = recipeById.get(binding.nodeId)
      else node = lineById.get(binding.nodeId)
      const lineId = kind === 'line-recipe' ? binding.nodeId : (node && 'lineId' in node ? node.lineId : null)
      if (!visible(lineId)) continue
      bindings.push({
        id: binding.id,
        kind,
        nodeId: binding.nodeId,
        name: node?.name ?? binding.nodeId,
        unit: (node && 'unit' in node ? node.unit : '') ?? '',
        lineId,
        mode: binding.mode === 'manual' ? 'manual' : 'auto',
      })
    }

    const inScope = (lineId: string | null): boolean => (!scopeLine || lineId === scopeLine) && visible(lineId)
    const filteredDaq = daqNodes.filter(n => inScope(n.lineId))
    const filteredDcw = dcwNodes.filter(n => inScope(n.lineId))
    const filteredRecipes = recipes.filter(r => inScope(r.lineId))
    const filteredLines = lines.filter(l => (!scopeLine || l.id === scopeLine) && visible(l.id))

    const scopeRecipes = (trusted?.recipes ?? []).map((recipe) => {
      const found = recipeById.get(recipe.id)
      // 配方名同样受产线可见性约束；无权产线只回 id（不新增名字级披露）。
      const name = found && visible(found.lineId) ? found.name : recipe.id
      return { id: recipe.id, name, version: recipe.version }
    })
    const overrideRow = (() => {
      try {
        return createSessionBindingOverrideRepo(db).get(session.id)
      }
      catch {
        return undefined
      }
    })()

    const effectiveHarness = readSessionRuntimeOverrides(db, input.agentId).harness ?? member.harness
    return {
      channelId: input.channelId,
      sessionId: input.sessionId,
      runtimeObjectId: input.agentId,
      harness: effectiveHarness,
      channelMode: trusted && session.channelMode === 'production_line_integrated' ? 'production_line_integrated' : 'generic',
      lineId: scopeLine,
      productId: trusted?.productId ?? null,
      bindingSnapshotRevision: trusted?.bindingSnapshotRevision ?? 0,
      scopeRecipes,
      scopeMutable: Boolean(trusted?.mutable),
      scopeSource: trusted ? (overrideRow ? 'override' : 'snapshot') : 'none',
      bindings,
      resources: {
        daqNodes: filteredDaq,
        dcwNodes: filteredDcw,
        recipes: filteredRecipes,
        lines: filteredLines,
      },
      toolRefresh: deps.toolRefresh(effectiveHarness),
      effectiveAt: 'next_turn',
    }
  }

  return { get }
}

export type SessionRuntimeBindingService = ReturnType<typeof createSessionRuntimeBindingService>
