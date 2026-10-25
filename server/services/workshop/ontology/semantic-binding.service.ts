/**
 * 语义绑定服务 —— 本体实体 ↔ 现有平台对象(daq_node / dcw_node / recipe_param)。
 *
 * 铁律:本体不复制系统对象。绑定只登记「语义 → 真实 id」的映射,存在性、归属、
 * 单位、读写能力每次编辑与发布都**实时**回查活体对象(与 tool-verify 同口径)。
 *
 * 单位:换算唯一边界是 shared/units.ts;量纲相容性由 shared/dimensions 判定。
 * 同量纲不同字面单位(degc↔k)必须显式给 scale/offset,否则 422 UNIT_TRANSFORM_REQUIRED。
 */
import { AppError } from '../../../utils/errors'
import { getDaqNodeRepo } from '../daq/daq-node.repo'
import { getDcwController } from '../dcw/dcw-controller'
import type { BindingDraft, OntologyDraftDoc, OntologyEntity } from './contracts'
import { unitsCompatible } from './contracts'
import { dimensionOf, normalizeUnit, unitRelation } from '@/shared/dimensions'
import type { BindingRow } from './repo'

export interface ResolvedTarget {
  platformKind: BindingDraft['platformKind']
  platformId: string
  targetSub: string
  name: string
  unit: string
  min: number | null
  max: number | null
  stepLimit: number | null
  writable: boolean
  lineId: string
  enabled: boolean
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/** 解析绑定目标(不存在返回 null;不抛错,便于批量报告) */
export function resolveBindingTarget(binding: Pick<BindingDraft, 'platformKind' | 'platformId' | 'targetSub'>): ResolvedTarget | null {
  if (binding.platformKind === 'daq_node') {
    const node = getDaqNodeRepo().byId(binding.platformId)
    if (!node) return null
    return {
      platformKind: 'daq_node', platformId: node.id, targetSub: '',
      name: node.name, unit: node.unit ?? '', min: num(node.min), max: num(node.max), stepLimit: null,
      writable: false, lineId: node.lineId ?? '', enabled: node.enabled !== false,
    }
  }
  if (binding.platformKind === 'dcw_node') {
    const node = getDcwController().byId(binding.platformId)
    if (!node) return null
    return {
      platformKind: 'dcw_node', platformId: node.id, targetSub: '',
      name: node.name, unit: node.unit ?? '', min: num(node.min), max: num(node.max), stepLimit: num(node.stepLimit),
      writable: true, lineId: node.lineId ?? '', enabled: node.enabled !== false,
    }
  }
  if (binding.platformKind === 'recipe_param') {
    const recipe = getDcwController().listRecipes().find(r => r.id === binding.platformId)
    if (!recipe) return null
    const key = binding.targetSub || ''
    const param = recipe.params.find(p => p.nodeId === key)
    if (!param) return null
    const node = getDcwController().byId(param.nodeId)
    return {
      platformKind: 'recipe_param', platformId: recipe.id, targetSub: param.nodeId,
      name: `${recipe.name}/${param.nodeId}`, unit: node?.unit ?? '',
      min: num(param.min ?? node?.min), max: num(param.max ?? node?.max), stepLimit: num(param.stepLimit ?? node?.stepLimit),
      writable: true, lineId: recipe.lineId ?? '', enabled: true,
    }
  }
  // device / spec_variable / scene_variable / condition:无活体目录面,只做形状校验
  return null
}

/** 单条绑定的形状校验(纯函数:目标已解析;可单测,不查库) */
export function assertBindingShape(
  entity: OntologyEntity,
  binding: BindingDraft,
  target: ResolvedTarget,
  opts: { lineId?: string } = {},
): ResolvedTarget {
  if (!target.enabled) {
    throw new AppError(422, 'TARGET_DISABLED', `绑定 ${binding.id} 的目标「${target.name}」已停用`)
  }
  // 产线归属:文档有授权锚时绑定不得跨线
  if (opts.lineId && target.lineId && opts.lineId !== target.lineId) {
    throw new AppError(422, 'ONTOLOGY_SCOPE_MISMATCH',
      `绑定 ${binding.id} 的目标「${target.name}」属于产线 ${target.lineId},与本体授权锚 ${opts.lineId} 不一致`)
  }
  // 读写能力
  if ((binding.direction === 'write' || binding.direction === 'read_write') && !target.writable) {
    throw new AppError(422, 'ACCESS_MODE_CONFLICT',
      `绑定 ${binding.id} 声明 ${binding.direction},但目标 ${binding.platformKind}:${binding.platformId} 是只读通道;写入应绑定 dcw_node 或 recipe_param`)
  }
  // 数据类型(实体 attrs.dataType 非数值时不得绑定数值通道)
  const declaredType = entity.attrs.dataType
  if (typeof declaredType === 'string' && declaredType !== 'number') {
    throw new AppError(422, 'TYPE_MISMATCH',
      `实体「${entity.key}」声明 dataType=${declaredType},而目标「${target.name}」是数值通道;请改正实体类型`)
  }
  // 单位:声明单位 vs 目标单位
  const declared = binding.unitDeclared || entity.unit || ''
  if (declared && target.unit) {
    const relation = unitRelation(declared, target.unit)
    if (relation.kind === 'incompatible') {
      throw new AppError(422, 'UNIT_MISMATCH',
        `绑定 ${binding.id} 的声明单位「${declared}」(${relation.from})与目标单位「${target.unit}」(${relation.to})量纲不相容`)
    }
    if (relation.kind === 'convertible') {
      const explicit = Number.isFinite(binding.scale) && binding.scale !== 0
        && (binding.scale !== 1 || binding.offset !== 0)
      if (!explicit) {
        throw new AppError(422, 'UNIT_TRANSFORM_REQUIRED',
          `绑定 ${binding.id} 的单位「${declared}」与目标单位「${target.unit}」同量纲但字面不同(${normalizeUnit(declared)}≠${normalizeUnit(target.unit)});必须显式给出 scale/offset,禁止按 1/0 兜底`)
      }
    }
  }
  if (!Number.isFinite(binding.scale) || binding.scale === 0) {
    throw new AppError(422, 'UNIT_CONTRACT_INVALID', `绑定 ${binding.id} 的 scale 必须为非零有限数`)
  }
  return target
}

/** 单条绑定的活体校验(throw AppError:422 形状/单位/能力) */
export function assertBindingLive(entity: OntologyEntity, binding: BindingDraft, opts: { lineId?: string } = {}): ResolvedTarget {
  const target = resolveBindingTarget(binding)
  if (!target) {
    throw new AppError(422, 'TARGET_NOT_FOUND',
      `绑定 ${binding.id} 的目标 ${binding.platformKind}:${binding.platformId}${binding.targetSub ? `#${binding.targetSub}` : ''} 不存在;请先创建该节点/配方参数`)
  }
  return assertBindingShape(entity, binding, target, opts)
}

export interface BindingValidationReport {
  ok: boolean
  failures: Array<{ bindingId: string, code: string, message: string }>
  resolved: ResolvedTarget[]
}

/**
 * 批量活体校验(草稿期每次编辑 + 发布前复核):
 *  - 逐条存在性/单位/能力;
 *  - 同一物理目标被两个实体声明为**写** → 409 BINDING_TARGET_OWNED(一个量只有一个写语义);
 *  - 同一实体同目标的读写方向冲突 → 422。
 */
export function validateDraftBindings(
  doc: OntologyDraftDoc,
  opts: { lineId?: string, resolver?: (binding: BindingDraft) => ResolvedTarget | null } = {},
): BindingValidationReport {
  const entities = new Map(doc.entities.map(e => [e.key, e]))
  const failures: BindingValidationReport['failures'] = []
  const resolved: ResolvedTarget[] = []
  const writeOwners = new Map<string, string>()
  const resolver = opts.resolver ?? resolveBindingTarget

  for (const binding of doc.bindings) {
    const entity = entities.get(binding.entityKey)
    if (!entity) {
      failures.push({ bindingId: binding.id, code: 'ONTOLOGY_UNKNOWN_ENTITY', message: `绑定 ${binding.id} 的实体「${binding.entityKey}」不存在` })
      continue
    }
    try {
      const target = resolver(binding)
      if (!target) {
        throw new AppError(422, 'TARGET_NOT_FOUND',
          `绑定 ${binding.id} 的目标 ${binding.platformKind}:${binding.platformId}${binding.targetSub ? `#${binding.targetSub}` : ''} 不存在;请先创建该节点/配方参数`)
      }
      assertBindingShape(entity, binding, target, opts)
      resolved.push(target)
      if (binding.direction === 'write' || binding.direction === 'read_write') {
        const key = `${binding.platformKind}:${binding.platformId}${binding.targetSub ? `#${binding.targetSub}` : ''}`
        const owner = writeOwners.get(key)
        if (owner && owner !== binding.entityKey) {
          failures.push({
            bindingId: binding.id, code: 'BINDING_TARGET_OWNED',
            message: `目标 ${key} 已被实体「${owner}」声明为写语义,不能再由「${binding.entityKey}」写入(一个物理量只能有一个写语义)`,
          })
        }
        else { writeOwners.set(key, binding.entityKey) }
      }
    }
    catch (err) {
      const e = err as { code?: string, message?: string }
      failures.push({ bindingId: binding.id, code: e.code ?? 'ONTOLOGY_INVALID', message: e.message ?? String(err) })
    }
  }
  return { ok: failures.length === 0, failures, resolved }
}

/** 发布前/运行时的漂移检测:目标被删/停用/单位变更 → drift */
export interface BindingDriftReport {
  ok: boolean
  drifted: Array<{ bindingId: string, reason: string }>
}

export function detectBindingDrift(bindings: BindingRow[]): BindingDriftReport {
  const drifted: BindingDriftReport['drifted'] = []
  for (const row of bindings) {
    const target = resolveBindingTarget({ platformKind: row.platformKind as BindingDraft['platformKind'], platformId: row.platformId, targetSub: row.targetSub })
    if (!target) {
      drifted.push({ bindingId: row.id, reason: '目标不存在(节点/配方参数已删除)' })
      continue
    }
    if (!target.enabled) {
      drifted.push({ bindingId: row.id, reason: '目标已停用' })
      continue
    }
    if (row.unitTarget && target.unit && normalizeUnit(row.unitTarget) !== normalizeUnit(target.unit)) {
      drifted.push({ bindingId: row.id, reason: `目标单位已变更(${row.unitTarget} → ${target.unit})` })
      continue
    }
    if (row.unitDeclared && target.unit && !unitsCompatible(row.unitDeclared, target.unit)) {
      drifted.push({ bindingId: row.id, reason: `声明单位「${row.unitDeclared}」与目标单位「${target.unit}」量纲不相容` })
    }
  }
  return { ok: drifted.length === 0, drifted }
}

/** 供 UI/工具展示:目标量纲注记 */
export function describeTarget(target: ResolvedTarget) {
  return {
    ...target,
    dimension: dimensionOf(target.unit),
  }
}

export { dimensionOf }
