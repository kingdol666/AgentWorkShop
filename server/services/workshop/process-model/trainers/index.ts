/**
 * 内置训练器 / 目标模板注册(G1.4 / G2.8)。
 *
 * 配置驱动:ProcessModelSpec.trainer.ref → resolveTrainingAdapter → 真实训练实现。
 * 未注册的训练器/模板一律拒绝(不再返回 accepted 占位)。
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { AppError } from '../../../../utils/errors'
import { getTwinProviderRegistry, type TwinProviderRegistry } from '../../aml/twin/provider-registry'
import type { ObjectiveAdapter, TrainingAdapter } from '../../aml/twin/provider-contracts'
import { canonicalJson, sha256 } from '../../aml/twin/contracts'
import type { ProcessModelSpec, TrainerRef } from '../contracts'
import { LINEAR_MPC_TEMPLATE, STEADY_RESPONSE_TEMPLATE } from '../../optimization/templates'
import { readDataset } from './dataset-reader'
import { trainLinearArx } from './linear-arx'
import { trainStaticResponse } from './static-response'

export interface TrainingRunInput {
  datasetDir: string
  spec: ProcessModelSpec
  jobDir: string
}

export interface TrainingRunResult {
  artifactKind: 'linear_state_space@1' | 'static_response@1'
  artifactHash: string
  metrics: Record<string, unknown>
  artifact: Record<string, unknown>
}

const linearAdapter: TrainingAdapter = {
  manifest: {
    adapterRef: 'linear_arx@1', version: '1', artifactKind: 'linear_state_space@1',
    displayName: '线性 ARX 辨识(带显式延迟)', description: '最小二乘/岭回归辨识 ARX,编译为状态空间;产出 A/B/C/D/偏置/延迟/残差校准',
    capabilities: { multiStep: true, mpc: true, configDriven: true },
  },
  train(input: unknown): TrainingRunResult {
    const { datasetDir, spec } = input as TrainingRunInput
    const ds = readDataset(datasetDir)
    const config = spec.trainer.config as { arOrder: number, inputOrder: number, ridgeLambda: number, standardize: boolean }
    const artifact = trainLinearArx(ds, config, { variables: spec.variables, beatMs: spec.timing.beatMs })
    const metrics = {
      platform: {
        modelType: artifact.kind,
        modelKind: 'linear_state_space',
        oneStepVal: artifact.metrics.oneStepVal,
        oneStepTest: { windows: artifact.metrics.windows, nrmse: artifact.metrics.oneStepNrmse },
        rolloutTest: { windows: artifact.metrics.windows, horizon: ds.P, nrmse: artifact.metrics.rolloutNrmse },
        rolloutImprovement: artifact.metrics.rolloutImprovement,
        persistenceNrmse: artifact.metrics.persistenceNrmse,
      },
      artifactKind: artifact.kind,
      residual: artifact.residual,
    }
    const artifactHash = sha256(canonicalJson(artifact))
    return { artifactKind: artifact.kind, artifact: artifact as unknown as Record<string, unknown>, artifactHash, metrics }
  },
}

const staticAdapter: TrainingAdapter = {
  manifest: {
    adapterRef: 'static_response@1', version: '1', artifactKind: 'static_response@1',
    displayName: '静态响应面(1/2 阶)', description: '稳态/批次样本聚合,拟合线性或含二次项/交互项的响应面;导出系数与留出残差',
    capabilities: { steadyState: true, configDriven: true },
  },
  train(input: unknown): TrainingRunResult {
    const { datasetDir, spec } = input as TrainingRunInput
    const ds = readDataset(datasetDir)
    const config = spec.trainer.config as { order: 1 | 2, ridgeLambda: number, standardize: boolean }
    const artifact = trainStaticResponse(ds, config, { variables: spec.variables, beatMs: spec.timing.beatMs })
    const metrics = {
      platform: {
        modelType: artifact.kind,
        modelKind: 'static_response',
        oneStepTest: { windows: ds.split.test, nrmse: artifact.metrics.holdoutNrmse },
        improvement: artifact.metrics.improvement,
        persistenceNrmse: artifact.metrics.persistenceNrmse,
      },
      artifactKind: artifact.kind,
      residual: artifact.residual,
    }
    const artifactHash = sha256(canonicalJson(artifact))
    return { artifactKind: artifact.kind, artifact: artifact as unknown as Record<string, unknown>, artifactHash, metrics }
  },
}

const linearMpcObjective: ObjectiveAdapter = {
  manifest: { ref: 'linear_mpc_quadratic@1', version: '1', solverFamilies: ['osqp'], displayName: '线性 MPC 二次型' },
  compile(input: unknown) {
    const config = input as Record<string, unknown>
    const weights = config.cvWeights as Record<string, number> | undefined
    const du = config.duWeights as Record<string, number> | undefined
    if (!weights || !Object.keys(weights).length) throw new AppError(422, 'PROBLEM_CONFIG_INVALID', 'linear_mpc_quadratic 需要 cvWeights')
    if (!du || !Object.keys(du).length) throw new AppError(422, 'PROBLEM_CONFIG_INVALID', 'linear_mpc_quadratic 需要 duWeights')
    for (const [k, v] of [...Object.entries(weights), ...Object.entries(du)]) {
      if (!Number.isFinite(v) || v < 0) throw new AppError(422, 'PROBLEM_CONFIG_INVALID', `权重 ${k} 必须为非负有限数`)
    }
    const terminal = Number(config.terminalWeight ?? 1)
    if (!Number.isFinite(terminal) || terminal < 0) throw new AppError(422, 'PROBLEM_CONFIG_INVALID', 'terminalWeight 必须非负')
    return { template: LINEAR_MPC_TEMPLATE, ...config, terminalWeight: terminal }
  },
}

const steadyObjective: ObjectiveAdapter = {
  manifest: { ref: 'steady_response@1', version: '1', solverFamilies: ['scipy'], displayName: '稳态响应面目标' },
  compile(input: unknown) {
    const config = input as Record<string, unknown>
    const economic = config.economicWeights as Record<string, number> | undefined
    const cvWeights = config.cvWeights as Record<string, number> | undefined
    if (!economic && !cvWeights) throw new AppError(422, 'PROBLEM_CONFIG_INVALID', 'steady_response 需要 economicWeights 或 cvWeights')
    return { template: STEADY_RESPONSE_TEMPLATE, ...config }
  },
}

/** 幂等注册内置 Adapter;从插件装配与训练入口都可调用。 */
export function registerBuiltinOptimizerAdapters(registry: TwinProviderRegistry = getTwinProviderRegistry()) {
  const result = registry.registerTwinPluginContribution('builtin-optimizer-process-model', {
    trainingAdapters: [linearAdapter, staticAdapter],
    objectiveProfiles: [linearMpcObjective, steadyObjective],
  })
  return result
}

export function resolveTrainingAdapterOrThrow(ref: TrainerRef) {
  const found = getTwinProviderRegistry().resolveTrainingAdapter(ref)
  if (!found) throw new AppError(422, 'UNSUPPORTED_TRAINER', `训练器 ${ref} 未注册;允许:linear_arx@1 / static_response@1`)
  return found
}

/** 执行训练并落工件(供 job-orchestrator 的内置训练分支调用)。 */
export function runBuiltinTraining(ref: TrainerRef, input: TrainingRunInput): TrainingRunResult {
  registerBuiltinOptimizerAdapters()
  const found = resolveTrainingAdapterOrThrow(ref)
  const result = found.adapter.train(input) as TrainingRunResult
  const artifactsDir = join(input.jobDir, 'artifacts')
  mkdirSync(artifactsDir, { recursive: true })
  // 工件主文件 + 完整性清单(A12:缺文件/被篡改在注册阶段可判定)
  const entryFile = 'model.json'
  writeFileSync(join(artifactsDir, entryFile), JSON.stringify(result.artifact, null, 2))
  writeFileSync(join(artifactsDir, 'metrics.json'), JSON.stringify(result.metrics, null, 2))
  writeFileSync(join(artifactsDir, 'artifact_manifest.json'), JSON.stringify({
    kind: result.artifactKind,
    schemaVersion: 1,
    entryFile,
    requiredFiles: [entryFile, 'metrics.json'],
    artifactHash: result.artifactHash,
  }, null, 2))
  return result
}
