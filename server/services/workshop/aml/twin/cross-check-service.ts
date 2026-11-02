/**
 * 下发前双通道互审的**服务态**(P5 补全,2026-11-02 上线前加固):
 * 纯判定在 cross-check.ts;本模块负责取证据并接到探索下发路径上:
 *  - 模型通道:渠道绑定模型(aml_channel_profiles.bound_model_id)的 ARX 工件
 *    (model.json 的 A/B/C/D + io_spec 的 mvOrder/cvOrder/norm),阶跃仿真求稳态增益;
 *    非 ARX 工件/OOD 无工件一律 unknown(**不拦**:缺证据不是反证);
 *  - 本体通道:已发布本体的 actuator→target 耦合边(含干预回灌的 support/refute 计数);
 *  - 逃生门 AW_CROSSCHECK_GATE=0 关闭强制(仅保留告警)。
 * 只有"确证冲突"才拒(模型有效应 & 本体明确无路径,或反之);manual 模式交给 HITL 卡。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { getAmlRuntime } from '../runtime'
import { parseIoSpec } from '../model-registry'
import { getChannelTwinProfile } from './channel-profile'
import { resolveCouplingFromOntology } from '../ontology-learning'
import { evaluateCrossCheck, scientificPayloadLines, type CrossCheckResult } from './cross-check'
import type { ArxArtifactLike } from '../action-coverage'

export function crossCheckGateEnabled(): boolean {
  return process.env.AW_CROSSCHECK_GATE !== '0'
}

export interface ModelChannelResolution {
  artifact: ArxArtifactLike | null
  modelId?: string
  reason: string
}

/** 渠道绑定模型 → ARX 工件(含 norm 供物理单位换算);不可用时如实给 reason */
export function resolveModelChannel(channelId: string | undefined): ModelChannelResolution {
  if (!channelId) return { artifact: null, reason: '无频道上下文,模型通道 unknown' }
  let boundModelId: string | undefined
  try {
    boundModelId = getChannelTwinProfile(channelId).boundModelId
  }
  catch {
    return { artifact: null, reason: '频道 profile 不可读,模型通道 unknown' }
  }
  if (!boundModelId) return { artifact: null, reason: '频道未绑定 AML 模型,模型通道 unknown' }
  try {
    const row = getAmlRuntime().repo.model.get(boundModelId)
    if (!row) return { artifact: null, modelId: boundModelId, reason: '绑定模型已不存在,模型通道 unknown' }
    const artifact = JSON.parse(readFileSync(join(row.path, 'model.json'), 'utf8')) as Record<string, unknown>
    if (artifact.kind !== 'linear_state_space@1') {
      return { artifact: null, modelId: boundModelId, reason: `工件类型 ${String(artifact.kind)} 暂不支持动作敏感度(仅 ARX),模型通道 unknown` }
    }
    const io = parseIoSpec(row) as unknown as {
      mvOrder?: string[]
      cvOrder?: string[]
      norm?: { u: { mean: number[], std: number[] }, y: { mean: number[], std: number[] } }
    }
    return {
      artifact: {
        A: artifact.A as number[][],
        B: artifact.B as number[][],
        C: artifact.C as number[][],
        D: artifact.D as number[][],
        mvOrder: (artifact.mvOrder as string[]) ?? io.mvOrder ?? [],
        cvOrder: (artifact.cvOrder as string[]) ?? io.cvOrder ?? [],
        ...(io.norm ? { norm: io.norm } : {}),
      },
      modelId: boundModelId,
      reason: '模型通道就绪(ARX 阶跃仿真)',
    }
  }
  catch (err) {
    return { artifact: null, modelId: boundModelId, reason: `工件读取失败(${err instanceof Error ? err.message : String(err)}),模型通道 unknown` }
  }
}

export interface DispatchCrossCheckInput {
  lineId: string
  controlNodeId: string
  targetNodeId: string
  /** 拟下发步长(物理单位,有正负) */
  proposedDelta: number
  channelId?: string
  /** true=自动执行路径(冲突直接拒);false=需人工批准路径(冲突进审批卡) */
  auto: boolean
}

export interface DispatchCrossCheckOutcome {
  blocked: boolean
  text: string
  warnings: string[]
  result: CrossCheckResult
  modelReason: string
}

export function preDispatchCrossCheck(input: DispatchCrossCheckInput): DispatchCrossCheckOutcome {
  const model = resolveModelChannel(input.channelId)
  const ontology = resolveCouplingFromOntology(input.lineId, input.controlNodeId, input.targetNodeId)
  const result = evaluateCrossCheck({
    controlNodeId: input.controlNodeId,
    targetNodeId: input.targetNodeId,
    proposedDelta: input.proposedDelta,
    auto: input.auto,
    model: { artifact: model.artifact, targetNodeId: input.targetNodeId },
    ontology: { hasCouplingPath: ontology.hasCouplingPath, evidence: ontology.evidence },
  })
  const enabled = crossCheckGateEnabled()
  const blocked = enabled && result.decision === 'reject'
  const lines = scientificPayloadLines(result.payload)
  const text = [
    blocked ? '互审拒绝(双通道确证冲突),本次下发未执行:' : '互审通过(未发现确证冲突)',
    ...result.conflicts.map(c => `  ✗ ${c}`),
    ...result.warnings.map(w => `  ⚠ ${w}`),
    `  [模型通道] ${model.reason}`,
    ...lines.map(l => `  ${l}`),
    blocked ? '  处置:改用人工审批(manual)并由审批人写明理由;或先补数据集/重训模型/更新本体断言。' : '',
  ].filter(Boolean)
  return { blocked, text: text.join('\n'), warnings: result.warnings, result, modelReason: model.reason }
}
