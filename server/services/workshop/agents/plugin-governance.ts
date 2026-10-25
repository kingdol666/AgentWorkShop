/**
 * plugin-governance —— 插件工具的平台侧治理闸门(WP4b / WP8)。
 *
 * 背景:插件工具历史上只过「团队插件开关 + roles」两道,不经 grant-guard/tool-verify/HITL。
 * 本模块把三类治理补齐到**所有分发路径共用的单点**(dispatchHostToolInner 与
 * manager.invokeHostTool 都调用,原生/omp/REST/MCP 桥同源):
 *   1. kb_agent 写知识库(action=ingest)必须挂 HITL 审批(缺省 action 的入库意图启发拦截);
 *   2. 插件工具声明了 references 才做引用面校验(存量未声明插件行为不变);
 *   3. 插件工具调用结果统一入 audit(action=plugin.tool.call)。
 *
 * 铁律:审批与校验都在服务端执行期发生;注入面(是否展示工具)不是安全边界。
 */
import { checkToolAgainstScope } from '../runtime/permission-scope'
import { getToolApprovals } from './tool-approvals'
import { verifyToolReferences } from './industrial/tool-verify'
import { recordOps } from '../ops/ops'
import type { HostToolResult } from './host-tool-bridge/types'

export interface PluginGovernanceIdentity {
  agentId: string
  channelId: string
  role: 'lead' | 'worker'
  name: string
}

/** 知识库入库意图启发词(辅助防线;完备防线 = action=ingest 契约 + riskClass=write 治理) */
const INGEST_INTENT_PATTERNS = [
  /入库/,
  /沉淀/,
  /写(入|进)?知识库/,
  /知识库[^。;]{0,12}(写|存|记)/,
  /\bingest\b/i,
  /\bindex\s+(this|the)\s+file\b/i,
  /\badd\s+(to\s+)?(the\s+)?knowledge\s*base\b/i,
]

const KB_TOOL = 'kb_agent'

/** 入库守卫是否启用(env 逃生门;关闭只影响启发拦截,action=ingest 审批始终生效) */
function ingestGuardEnabled(): boolean {
  return process.env.AW_KB_INGEST_GUARD !== '0'
}

function looksLikeIngest(prompt: string): boolean {
  return INGEST_INTENT_PATTERNS.some(re => re.test(prompt))
}

/**
 * kb_agent 写入治理:action=ingest → HITL 审批(批准才继续);action 缺省且 prompt 命中
 * 入库意图 → 拒绝并提示改用 action=ingest。
 * 返回 null = 放行。
 */
async function governKbAgent(identity: PluginGovernanceIdentity, toolName: string, args: Record<string, unknown>): Promise<HostToolResult | null> {
  if (toolName !== KB_TOOL) return null
  const action = String(args.action ?? '').trim().toLowerCase()
  const prompt = String(args.prompt ?? '')
  if (action && action !== 'query' && action !== 'ingest') {
    return { text: `kb_agent.action 取值非法(${action}):只能是 query(只读)或 ingest(写知识库)。`, isError: true }
  }
  if (action !== 'ingest') {
    if (ingestGuardEnabled() && looksLikeIngest(prompt)) {
      return {
        text: '工具调用被拒(kb_agent 入库守卫):检测到入库/沉淀意图但未声明 action=ingest。请改用 action=ingest 重试——入库会进入平台审批(HITL),批准后才会写入知识库。',
        isError: true,
      }
    }
    return null
  }
  // 写入知识库:显式人工审批(与配方/产线写同源审批服务;缺省超时=拒绝)
  const detail = `知识库入库审批(kb_agent):\n${prompt.slice(0, 1200)}`
  const decision = await getToolApprovals().request(identity.agentId, '', 'kb', detail, {
    title: '知识库入库审批',
    payload: { tool: 'kb_agent', action: 'ingest', prompt: prompt.slice(0, 2000), mode: String(args.mode ?? 'sync') },
  })
  if (!decision.approved) {
    recordOps({
      actor: identity.agentId, actorName: identity.name, actorKind: 'agent',
      action: 'plugin.tool.denied', kind: 'system', level: 'warn',
      targetKind: 'tool', targetId: toolName,
      summary: `知识库入库被拒绝/超时(审批 ${decision.id})`,
      detail: { decision: decision.id, comment: decision.comment, prompt: prompt.slice(0, 200) },
    })
    return { text: `知识库入库未获批准(审批 ${decision.id}:${decision.comment || '超时或人工拒绝'}),未写入知识库。`, isError: true }
  }
  return null
}

/**
 * 插件工具治理入口。返回 null = 放行;返回结果 = 拒绝。
 * 调用点:dispatch.ts 插件分支 / manager.invokeHostTool 插件分支(两处同源)。
 */
export async function governPluginToolCall(
  identity: PluginGovernanceIdentity,
  toolName: string,
  args: Record<string, unknown>,
  declared?: { references?: { atLeastOne?: unknown }, noRefs?: boolean },
): Promise<HostToolResult | null> {
  try {
    const kbDenied = await governKbAgent(identity, toolName, args)
    if (kbDenied) return kbDenied
    // WP8②:插件显式声明 references 才做引用面校验(未声明存量零变化)
    if (declared?.references) {
      const denied = verifyToolReferences(identity.agentId, toolName, args, declared.references as Parameters<typeof verifyToolReferences>[3])
      if (denied) return denied
    }
    return null
  }
  catch (err) {
    // 治理层自身故障 → fail-closed(与 grant-guard / tool-verify 同纪律)
    return {
      text: `插件工具治理校验异常(${toolName}):${err instanceof Error ? err.message : String(err)}。请稍后重试;若持续出现请联系管理员。`,
      isError: true,
    }
  }
}

/** 插件调用结果审计(WP8③;成功与失败都留痕,便于审计面回答「谁在何时调了插件工具」) */
export function auditPluginToolCall(
  identity: PluginGovernanceIdentity,
  toolName: string,
  result: { text?: string, isError?: boolean },
): void {
  try {
    recordOps({
      actor: identity.agentId,
      actorName: identity.name,
      actorKind: 'agent',
      action: 'plugin.tool.call',
      kind: 'system',
      level: result.isError ? 'warn' : 'info',
      targetKind: 'tool',
      targetId: toolName,
      summary: `插件工具调用:${toolName}(${result.isError ? '失败' : '成功'})`,
      detail: { channelId: identity.channelId, role: identity.role, isError: Boolean(result.isError), text: String(result.text ?? '').slice(0, 400) },
    })
  }
  catch { /* 审计失败不阻断工具结果 */ }
}

/** 供外部(测试/调用方)复用:知识库入库动作判定 */
export function kbActionOf(args: Record<string, unknown>): 'query' | 'ingest' | 'invalid' {
  const action = String(args.action ?? '').trim().toLowerCase()
  if (!action) return 'query'
  if (action === 'query' || action === 'ingest') return action
  return 'invalid'
}

export { checkToolAgainstScope }
