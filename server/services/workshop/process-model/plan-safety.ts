/**
 * 试验计划安全校验(2026-11-02 上线前加固):
 * 计划一旦被 HITL 批准,执行器会以平台身份直接写节点(单卡批准 = 全计划授权)。
 * 因此**创建时与执行前都必须复核节点归属**,防止:
 *  - 跨线写:计划 lineId=A,levels 却点名 B 线的节点(越权写别的产线);
 *  - 类型错配:targets 写成数控节点(读不到真值)或控制量其实是数采节点;
 *  - 量程外水平:创建时就拒绝,避免批准后逐步被 write() 打回、白花产线时间。
 * 纯校验函数,直接读控制器/节点仓(无副作用,不写库)。
 */
import { AppError } from '../../../utils/errors'
import { getDcwController } from '../dcw/dcw-controller'
import { getDaqNodeRepo } from '../daq/daq-node.repo'
import type { ExperimentPlanBody } from './experiment-runner'

export interface PlanNodeIssue {
  kind: 'control' | 'target' | 'level'
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
    for (const level of levels) {
      if (!Number.isFinite(level)) continue
      if (level < node.min || level > node.max) {
        issues.push({ kind: 'level', nodeId: controlId, message: `水平 ${level} 超出节点安全量程 ${node.min}~${node.max}${node.unit ?? ''}` })
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
