#!/usr/bin/env node
/**
 * 提示词注入取证探针(2026-10-28 多专家整改验收用)。
 *
 * 以同一 AW_HOME 只读方式装配"运行时提示词"里的工业上下文段(工业语义卡 × 执行模式 ×
 * 绑定节点),用于证明 worker 绑定节点后**运行时真的把节点卡注入提示词** —— 该函数
 * (buildIndustrialContext / nodeSemanticCards)就是 prompt-builder 在每回合拼 system
 * prompt 时调用的同一个。
 *
 * 频道执行模式在运行期由 manager 提供(channelIdOfAgent);探针以 channel_agents 表
 * 复刻同一查表(不伪造任何业务状态)。
 *
 * 用法:node --import tsx scripts/_audit/prompt-injection-probe.mts <agentId>
 */
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

process.env.AW_MODE = process.env.AW_MODE ?? 'home'
process.env.AW_SKIP_DATA_LOCK = '1'

const agentId = String(process.argv[2] ?? '').trim()
if (!agentId) {
  console.error('usage: prompt-injection-probe.mts <agentId>')
  process.exit(2)
}

const home = String(process.env.AW_HOME ?? '')
let channelId: string | null = null
let profileMode = ''
try {
  // 只读连接(不跑迁移、不抢写锁):频道执行模式来自 aml_channel_profiles,
  // 与运行时 executionModeOfChannel 同一张表/同一归一语义
  const db = new DatabaseSync(join(home, 'data', 'workshop.sqlite'), { readOnly: true })
  try {
    const row = db.prepare('SELECT channel_id FROM channel_agents WHERE id = ?').get(agentId) as { channel_id?: string } | undefined
    channelId = row?.channel_id ?? null
    const p = channelId
      ? db.prepare('SELECT execution_mode FROM aml_channel_profiles WHERE channel_id = ?').get(channelId) as { execution_mode?: string } | undefined
      : undefined
    profileMode = String(p?.execution_mode ?? '')
    const { configureAmlRuntime } = await import('../../server/services/workshop/aml/runtime')
    configureAmlRuntime(db as never)
  }
  catch { /* 读失败 → 模式卡退化为 auto(与运行时异常同语义) */ }
}
catch { /* DB 不可读 → 模式卡退化为 auto(与运行时缺 manager 时同语义) */ }

// 运行期由 manager 提供同一查表(探针内等价桩)
;(globalThis as Record<string, unknown>).__workshopManager = {
  channelIdOfAgent: (id: string) => (id === agentId ? channelId : null),
}

const { buildIndustrialContext, nodeSemanticCards } = await import('../../server/services/workshop/agents/industrial-context')
const { getAgentNodeBindingRepo } = await import('../../server/services/workshop/agents/node-bindings.repo')

const bindings = getAgentNodeBindingRepo().byAgent(agentId).map(b => ({ nodeId: b.nodeId, kind: b.kind, mode: b.mode }))
let text = ''
let cards = ''
let stale = -1
let error = ''
try {
  text = buildIndustrialContext(agentId)
}
catch (err) {
  error += `buildIndustrialContext: ${err instanceof Error ? err.message : String(err)}; `
}
try {
  const c = nodeSemanticCards(agentId)
  cards = c.text
  stale = c.stale
}
catch (err) {
  error += `nodeSemanticCards: ${err instanceof Error ? err.message : String(err)}`
}

process.stdout.write(JSON.stringify({ agentId, channelId, profileMode, bindings, text, cards, stale, error }))
