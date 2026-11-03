/**
 * 试验计划安全校验(2026-11-02 上线前加固):
 * 计划一旦被 HITL 批准,执行器会以平台身份直接写节点(单卡批准 = 全计划授权)。
 * 因此**创建时与执行前都必须复核节点归属**,防止:
 *  - 跨线写:计划 lineId=A,levels 却点名 B 线的节点(越权写别的产线);
 *  - 类型错配:targets 写成数控节点(读不到真值)或控制量其实是数采节点;
 *  - 量程外水平:创建时就拒绝,避免批准后逐步被 write() 打回、白花产线时间;
 *  - 步限不可达(P2,2026-11-03):水平间隔或当前值到最近水平的距离超过有效单步限制
 *    (节点/参数/配方三层取最小,与 write() 同口径)时,执行首步必被写联锁拒绝 ——
 *    与其浪费一次 HITL 批准和产线窗口,不如创建时就拒绝并告知如何修正。
 * 纯校验函数,直接读控制器/节点仓(无副作用,不写库)。
 */
import { AppError } from '../../../utils/errors'
import { getDcwController } from '../dcw/dcw-controller'
import { stepLimitOf } from '../dcw/param-limits'
import { getDaqNodeRepo } from '../daq/daq-node.repo'
import type { ExperimentPlanBody } from './experiment-runner'

export interface PlanNodeIssue {
  kind: 'control' | 'target' | 'level' | 'step'
  nodeId: string
  message: string
}

/**
 * 校验计划节点集合与量程。返回问题列表(空 = 通过);
 * 调用方决定抛错(创建/执行前)还是仅告警。
 */
export function validatePlanNodes(plan: Pick<ExperimentPlanBody, 'lineId' | 'levels' | 'targets'>): PlanNodeIssue[] {
  const issues: PlanNodeIssue[] = []
  const controller = getDcwController()
  for (const [controlId, levels] of Object.entries(plan.levels)) {
    const node = controller.byId(controlId)
    if (!node) {
      issues.push({ kind: 'control', nodeId: controlId, message: `控制节点 ${controlId} 不存在(须为 DCW 数控节点)` })
      continue
    }
    if (node.lineId && node.lineId !== plan.lineId) {
      issues.push({ kind: 'control', nodeId: controlId, message: `控制节点 ${controlId} 属于产线 ${node.lineId},与计划产线 ${plan.lineId} 不一致(禁止跨线试验)` })
    }
    if (!node.enabled) {
      issues.push({ kind: 'control', nodeId: controlId, message: `控制节点 ${controlId} 已停用(控制已暂停),不能用于试验` })
    }
    // 保写心跳会按 holdIntervalMs 周期重下发当前值并与试验步争夺 60s 写间隔,
    // 实测会造成"永远还需 60s"的活锁(2026-11-02 端到端演示)。试验节点必须关闭心跳。
    if (node.holdIntervalMs && node.holdIntervalMs > 0) {
      issues.push({ kind: 'control', nodeId: controlId, message: `控制节点 ${controlId} 启用了保写心跳(holdIntervalMs=${node.holdIntervalMs}ms):心跳会与试验步竞争写入间隔,请在节点配置中置 0 后再发起试验` })
    }
    for (const level of levels) {
      if (!Number.isFinite(level)) continue
      if (level < node.min || level > node.max) {
        issues.push({ kind: 'level', nodeId: controlId, message: `水平 ${level} 超出节点安全量程 ${node.min}~${node.max}${node.unit ?? ''}` })
      }
    }
    // P2 步限可达性:执行器每步都过 write() 的单步联锁(节点/参数/配方三层取最小)。
    // 这里用同一口径预检,把"首步必被拒"的计划挡在批准前。
    const stepProfile = stepLimitOf(node)
    const finiteLevels = levels.filter(Number.isFinite)
    if (stepProfile.value != null && finiteLevels.length > 0) {
      const unit = node.unit ?? ''
      // (1) 相邻水平间隔:排序后任意相邻两级之差 ≤ 有效步限(保证存在可行遍历;
      //     执行器据此生成同向单调的可行随机序,见 buildExperimentSteps)。
      const sorted = [...finiteLevels].sort((a, b) => a - b)
      for (let i = 1; i < sorted.length; i++) {
        const gap = sorted[i]! - sorted[i - 1]!
        if (gap > stepProfile.value + 1e-9) {
          issues.push({
            kind: 'step',
            nodeId: controlId,
            message: `水平间隔 ${gap}${unit}(水平 ${sorted[i - 1]}→${sorted[i]})超过单步限制 ${stepProfile.value}${unit}(来源:${stepProfile.source}):执行时会被写联锁拒绝;请收窄水平跨度或调大单步限制`,
          })
        }
      }
      // (2) 首步可达:当前值(实写值优先,读回值兜底)到最近水平 ≤ 有效步限。
      //     当前值未知(未写过/未读回)时跳过 —— write() 对首写同样豁免步限。
      const cur = typeof node.value === 'number' ? node.value : (typeof node.readValue === 'number' ? node.readValue : null)
      if (cur != null) {
        const nearest = Math.min(...finiteLevels.map(l => Math.abs(l - cur)))
        if (nearest > stepProfile.value + 1e-9) {
          issues.push({
            kind: 'step',
            nodeId: controlId,
            message: `当前值 ${cur}${unit} 到最近水平的距离 ${Number(nearest.toFixed(6))}${unit} 超过单步限制 ${stepProfile.value}${unit}(来源:${stepProfile.source}):随机化首步必被拒;请先把节点调至任一水平附近或调大单步限制`,
          })
        }
      }
    }
  }
  for (const [controlId, targetId] of Object.entries(plan.targets ?? {})) {
    if (!plan.levels[controlId]) {
      issues.push({ kind: 'target', nodeId: targetId, message: `观测目标绑定到了未声明的控制量 ${controlId}` })
      continue
    }
    const daq = getDaqNodeRepo().byId(targetId)
    if (!daq) {
      issues.push({ kind: 'target', nodeId: targetId, message: `观测目标 ${targetId} 不是数采节点(判读需要 DAQ 序列)` })
      continue
    }
    if (daq.lineId && daq.lineId !== plan.lineId) {
      issues.push({ kind: 'target', nodeId: targetId, message: `观测目标 ${targetId} 属于产线 ${daq.lineId},与计划产线 ${plan.lineId} 不一致` })
    }
  }
  return issues
}

/** 创建/执行前强校验:有问题即 422(消息合并,便于一次改全) */
export function assertPlanNodesSafe(plan: Pick<ExperimentPlanBody, 'lineId' | 'levels' | 'targets'>): void {
  const issues = validatePlanNodes(plan)
  if (issues.length === 0) return
  throw new AppError(422, 'EXPERIMENT_PLAN_NODE_INVALID', `试验计划节点校验失败:${issues.map(i => i.message).join(';')}`)
}
