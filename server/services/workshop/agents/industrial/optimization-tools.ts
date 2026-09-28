/**
 * 工艺优化 Channel 专属工具(2026-09-26 解耦计划)。
 *
 * toolOptimizationExplore —— 探索模式核心:goal 驱动的真实激励步。
 * 一次调用 = ①读 goal 与当前工况 → ②生成激励值(按方向与步长,clamp 到调试范围)
 * → ③经 dcw_control 全治理链真实写入(绑定鉴权/HITL/写限界/调控闭环,与本平台任何
 * agent 下发同源,不新造权限) → ④等待工艺响应 → ⑤读回目标 DAQ 均值 →
 * ⑥探索记录落库 optimization_explorations(写入值↔响应值配对,训练数据回流事实源)
 * → 返回学习摘要(参数波动 ↔ 目标响应)。
 * 多轮迭代与方向判断由 agent 编排(工况提示词提供节点物理意义与调试跨度)。
 */
import { createId } from '../../aml/twin/contracts'
import { getAmlRuntime } from '../../aml/runtime'
import { getChannelTwinProfile } from '../../aml/twin/channel-profile'
import { getAgentNodeBindingRepo } from '../node-bindings.repo'
import { getDaqController } from '../../daq/daq-controller'
import { getDcwController } from '../../dcw/dcw-controller'
import type { HostToolResult } from '../host-tool-bridge/types'
import { toolDcwControl } from './dcw-tools'

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

async function readTargetMean(nodeId: string, windowMs = 45_000): Promise<number | null> {
  const now = Date.now()
  try {
    const pts = await getDaqController().samples(nodeId, { fromMs: now - windowMs, toMs: now, bucketMs: 1000, limit: 60 }) as Array<{ at?: number, value?: number, avg?: number }>
    const vals = pts.map(p => Number(p.value ?? p.avg)).filter(Number.isFinite)
    if (vals.length === 0) return null
    return vals.reduce((a, b) => a + b, 0) / vals.length
  }
  catch {
    return null
  }
}

export async function toolOptimizationExplore(agentId: string, args: {
  control_node_id?: string
  target_node_id?: string
  direction?: 'up' | 'down'
  step?: number | string
  settle_seconds?: number | string
  hypothesis?: string
}, channelId?: string): Promise<HostToolResult> {
  try {
    const profile = getChannelTwinProfile(channelId ?? '')
    if (profile.profile !== 'aml_optimization') return { text: 'optimization_explore 仅适用于工艺优化 Channel。', isError: true }
    const goal = (args as { objective?: Record<string, unknown> }).objective ?? profile.objective ?? {}
    const goalText = Object.keys(goal).length > 0 ? JSON.stringify(goal) : '(Channel 未设置 goal —— 建议先在 Channel 设置中定义优化目标)'

    const repo = getAgentNodeBindingRepo()
    const dcwBindings = repo.byAgent(agentId).filter(b => b.kind === 'dcw')
    const controlNodeId = String(args.control_node_id ?? '').trim() || dcwBindings[0]?.nodeId || ''
    if (!controlNodeId) return { text: '未指定控制节点且当前无数控绑定;请传 control_node_id 或先绑定数控节点。', isError: true }
    const binding = repo.find(agentId, controlNodeId, 'dcw')
    const node = getDcwController().byId(controlNodeId)
    if (!binding || !node) return { text: `控制节点 ${controlNodeId} 无效(未绑定或不存在)。`, isError: true }

    // 步长来源优先级:显式 args > 绑定 tuning.step > 场景 control.maxStep > 量程 1/20
    const sceneControl = (profile.sceneContract as { controls?: Array<{ nodeId?: string, maxStep?: number }> } | undefined)?.controls?.find(c => c.nodeId === controlNodeId)
    const tuningStep = binding.tuning?.step
    const fallbackStep = Math.abs((node.max - node.min) / 20)
    const step = Number(args.step ?? tuningStep ?? sceneControl?.maxStep ?? fallbackStep)
    if (!Number.isFinite(step) || step <= 0) return { text: `激励步长无效:${step}(可传 step 或在绑定上设置 tuning.step)。`, isError: true }
    const tuneMin = binding.tuning?.min ?? node.min
    const tuneMax = binding.tuning?.max ?? node.max
    const direction = args.direction === 'down' ? -1 : 1
    const proposed = Number(node.value ?? 0) + direction * step
    const target = Math.min(tuneMax, Math.max(tuneMin, proposed))
    const clamped = Math.abs(target - proposed) > 1e-9

    const daqBindings = repo.byAgent(agentId).filter(b => b.kind === 'daq')
    const targetNodeId = String(args.target_node_id ?? '').trim() || daqBindings[0]?.nodeId || ''
    if (!targetNodeId) return { text: '未指定目标观测节点且当前无数采绑定;请传 target_node_id 或先绑定数采节点。', isError: true }

    const targetBefore = await readTargetMean(targetNodeId)

    // 真实写入:复用 dcw_control 全治理链(手动绑定会挂 HITL,auto+bounded 走限界直写)
    const settleSec = Math.min(300, Math.max(10, Number(args.settle_seconds ?? 45)))
    const write = await toolDcwControl(agentId, {
      node_id: controlNodeId,
      value: target,
      hypothesis: args.hypothesis ?? `探索激励(${direction > 0 ? 'up' : 'down'} ${Number(step).toFixed(3)};goal=${goalText.slice(0, 120)})`,
    }, channelId)
    const writeOk = !write.isError

    let targetAfter: number | null = null
    if (writeOk) {
      await sleep(settleSec * 1000)
      targetAfter = await readTargetMean(targetNodeId)
    }

    const record = {
      id: createId('opt-exploration'),
      channelId: channelId ?? '',
      agentId,
      goalJson: JSON.stringify(goal),
      controlNodeId,
      controlBefore: Number(node.value ?? 0),
      controlAfter: writeOk ? target : Number(node.value ?? 0),
      controlStep: step,
      targetNodeId,
      targetBefore,
      targetAfter,
      direction: direction > 0 ? 'up' : 'down',
      hypothesis: String(args.hypothesis ?? ''),
      writeStatus: writeOk ? 'ok' : 'rejected',
      writeMessage: write.text.slice(0, 400),
    }
    try {
      const rt = getAmlRuntime()
      rt.db.prepare(`INSERT INTO optimization_explorations(id,channel_id,agent_id,goal_json,control_node_id,control_before,control_after,control_step,target_node_id,target_before,target_after,direction,hypothesis,write_status,write_message,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(record.id, record.channelId, record.agentId, record.goalJson, record.controlNodeId, record.controlBefore, record.controlAfter, record.controlStep, record.targetNodeId, record.targetBefore, record.targetAfter, record.direction, record.hypothesis, record.writeStatus, record.writeMessage, new Date().toISOString())
    }
    catch (err) {
      return { text: `探索步已执行但记录落库失败:${err instanceof Error ? err.message : String(err)}\n\n${write.text}`, isError: writeOk ? undefined : true }
    }

    if (!writeOk) {
      return { text: `探索步被拒绝(未写入产线,已记录 rejected):\n${write.text}`, isError: true }
    }
    const deltaTarget = targetAfter != null && targetBefore != null ? targetAfter - targetBefore : null
    const lines = [
      `探索步完成(已真实写入产线并记录):`,
      `  记录: ${record.id}`,
      `  控制: ${node.name}(${controlNodeId}) ${record.controlBefore} → ${record.controlAfter}(步长 ${Number(step).toFixed(3)},方向 ${record.direction}${clamped ? ',触调试边界截断' : ''})`,
      `  响应: ${targetNodeId} ${targetBefore != null ? targetBefore.toFixed(3) : 'n/a'} → ${targetAfter != null ? targetAfter.toFixed(3) : 'n/a'}(Δ=${deltaTarget != null ? deltaTarget.toFixed(3) : 'n/a'},窗口 ${settleSec}s)`,
      `  goal: ${goalText}`,
      deltaTarget != null
        ? `  学习: 该方向目标响应 ${deltaTarget > 0 ? '上升' : '下降'} ${Math.abs(deltaTarget).toFixed(3)};继续探索请按此符号外推,或反向验证。`
        : '  学习: 响应窗口内未读到稳定差分;建议增大 settle_seconds 或检查目标节点采样。',
      `探索记录已归档,可在 AML 界面与训练数据回流中使用。`,
    ]
    return { text: lines.join('\n') }
  }
  catch (err) {
    return { text: `探索步失败:${err instanceof Error ? err.message : String(err)}`, isError: true }
  }
}

/** 探索记录查询(供 agent 复盘与提示词组装;按 Channel 最近优先) */
export function optimizationExplorationsOf(channelId: string, limit = 50): Array<Record<string, unknown>> {
  try {
    return getAmlRuntime().db.prepare('SELECT * FROM optimization_explorations WHERE channel_id = ? ORDER BY created_at DESC LIMIT ?').all(channelId, limit) as Array<Record<string, unknown>>
  }
  catch {
    return []
  }
}
