/**
 * SceneContract → PhysicsSpec 骨架生成(自动建模编译器的第一块)。
 *
 * 任意场景只要 SceneContract 冻结、变量带 nodeId/量程,就能得到一个
 * 可校准、可训练的起步物理模型:
 *  - 每个 state 变量:一阶惯性弛豫方程 `s' = s + dt·(clamp(控制线性混合) − s)/τ`,
 *    τ 与各控制增益全部是带先验盒的可校准参数(训练期 stage A 拟合);
 *  - 每个 target/observation/guard 变量:恒等观测方程(persistence 基线,
 *    未被 state 方程驱动时物理目标=最后测量,残差负责学动态);
 *  - 约束从 scene.constraints 原样继承。
 *
 * 变量 id 做标识符净化(scene id 可能非 ASCII),nodeId 保留原值供
 * 训练/评估/服役三侧经 alias 映射回真实节点。
 */
import { sha256, type SceneContract, type SceneVariable } from './contracts'
import { PHYSICS_SPEC_VERSION, validatePhysicsSpec, type PhysicsEquationSpec, type PhysicsExpression, type PhysicsParameterSpec, type PhysicsSpec, type PhysicsVariableSpec } from './physics-spec'

function sanitizeId(raw: string, fallbackPrefix: string): string {
  const cleaned = String(raw).replace(/[^A-Za-z0-9_.:-]/g, '_').replace(/^[^A-Za-z_]+/, `_${fallbackPrefix}_`)
  return cleaned.length > 0 ? cleaned : `${fallbackPrefix}_${sha256(raw).slice(0, 8)}`
}

function variableOf(v: SceneVariable, role: string, used: Set<string>): PhysicsVariableSpec {
  let id = sanitizeId(v.id, 'v')
  while (used.has(id)) id = `${id}_${used.size}`
  used.add(id)
  return {
    id,
    ...(v.nodeId ? { nodeId: v.nodeId } : {}),
    role,
    unit: v.unit || '1',
    physicalMeaning: v.physicalMeaning,
    ...(v.min !== undefined ? { min: v.min } : {}),
    ...(v.max !== undefined ? { max: v.max } : {}),
  }
}

function ref(id: string): PhysicsExpression {
  return { ref: id }
}

function param(id: string): PhysicsExpression {
  return { param: id }
}

function op(operator: string, ...args: PhysicsExpression[]): PhysicsExpression {
  return { op: operator as never, args }
}

function spanOf(v: SceneVariable): number {
  if (v.min !== undefined && v.max !== undefined) return Math.max(Math.abs(v.max - v.min), 1)
  return Math.max(Math.abs(v.max ?? v.min ?? 0) * 0.5, 10)
}

/**
 * 从冻结 SceneContract 生成骨架 PhysicsSpec(返回前经 validatePhysicsSpec 自检,
 * 生成的 spec 保证可直接进入 twin_physics_spec_validate/compile → hybrid 训练)。
 */
export function draftPhysicsSpecFromScene(input: { scene: SceneContract, createdBy: string, dtSec?: number }): PhysicsSpec {
  const scene = input.scene
  const used = new Set<string>()
  const byNode = new Map<string, string>()
  const idMap = new Map<string, string>()
  const originalBySpecId = new Map<string, SceneVariable>()
  const variables: PhysicsVariableSpec[] = []
  // 同一 nodeId 只创建一个 spec 变量(amlkit alias 以 nodeId 为键,重复会互相覆盖):
  // 场景里 state 与 target 指向同一物理节点时,复用先建变量的 id。
  const push = (v: SceneVariable, role: string): string => {
    const existing = v.nodeId ? byNode.get(v.nodeId) : undefined
    if (existing) {
      idMap.set(v.id, existing)
      return existing
    }
    const spec = variableOf(v, role, used)
    idMap.set(v.id, spec.id)
    originalBySpecId.set(spec.id, v)
    if (spec.nodeId) byNode.set(spec.nodeId, spec.id)
    variables.push(spec)
    return spec.id
  }
  for (const v of scene.controls) push(v, 'control')
  for (const v of scene.states) push(v, 'state')
  for (const v of scene.disturbances) push(v, 'disturbance')
  for (const v of scene.observations) {
    // 优化目标(target)若尚无同节点状态,升格为 state:它将获得一阶惯性动力学方程
    // (τ/增益可校准)—— 这正是「目标要有因果物理模型」的关键;仅作观测不做状态的目标
    // 只能 persistence,物理无动力可学。
    const existing = v.nodeId ? byNode.get(v.nodeId) : undefined
    if (v.role === 'target' && !existing) {
      push(v, 'state')
      continue
    }
    push(v, v.role === 'target' ? 'target' : v.role === 'guard' ? 'guard' : 'observation')
  }
  for (const v of scene.guards) {
    if (!idMap.has(v.id)) push(v, 'guard')
  }

  const parameters: PhysicsParameterSpec[] = []
  const states: PhysicsEquationSpec[] = []
  for (const variable of variables.filter(v => v.role === 'state')) {
    // 原场景变量一律经 originalBySpecId 反查(观测升格为状态的 target 变量也在其中;
    // 只查 scene.states 会让升格变量拿不到量程 → 先验盒退化 → 校准被裁坏)
    const sceneVar = originalBySpecId.get(variable.id)
    const tauId = sanitizeId(`tau_${variable.id}`, 'p')
    parameters.push({ id: tauId, value: 5, min: 0.5, max: 600, unit: 's' })
    // 控制线性混合:offset_s + Σ gain·c,全部可校准;量程钳位防越界
    const mixArgs: PhysicsExpression[] = []
    const offsetId = sanitizeId(`offset_${variable.id}`, 'p')
    const span = spanOf(sceneVar ?? { id: variable.id } as SceneVariable)
    const base = sceneVar?.min ?? -(sceneVar?.max ?? span)
    parameters.push({ id: offsetId, value: base + span / 2, min: base - span, max: base + span, unit: variable.unit })
    mixArgs.push(param(offsetId))
    for (const control of variables.filter(v => v.role === 'control')) {
      const gainId = sanitizeId(`gain_${variable.id}_by_${control.id}`, 'p')
      // 增益先验盒 = 状态量程/控制量程的自然尺度 ×2 裕量:
      // 每单位控制变化最多把状态推过整个量程;盒太宽会让网格校准失去分辨率。
      const controlOriginal = originalBySpecId.get(control.id)
      const controlSpan = controlOriginal ? spanOf(controlOriginal) : 1
      const gainBox = Math.max(2 * (span / Math.max(controlSpan, 1e-6)), 0.5)
      parameters.push({ id: gainId, value: 0, min: -gainBox, max: gainBox })
      mixArgs.push(op('mul', param(gainId), ref(control.id)))
    }
    let mix: PhysicsExpression = op('add', ...mixArgs)
    if (variable.min !== undefined && variable.max !== undefined) {
      mix = op('clamp', mix, { value: variable.min }, { value: variable.max })
    }
    states.push({ lhs: `${variable.id}_next`, rhs: op('div', op('sub', mix, ref(variable.id)), param(tauId)) })
  }

  // 恒等观测:场景 target/observation(经 idMap 去重后)= persistence 基线
  // (state 驱动可由 Agent 后续替换方程);guard 同理。
  const identity = (variable: PhysicsVariableSpec): PhysicsEquationSpec => ({ lhs: variable.id, rhs: ref(variable.id), unit: variable.unit })
  const observedIds = new Set<string>()
  for (const v of scene.observations) {
    if (v.role !== 'target' && v.role !== 'observation') continue
    const id = idMap.get(v.id)
    if (id) observedIds.add(id)
  }
  const guardIds = new Set<string>()
  for (const v of scene.guards) {
    const id = idMap.get(v.id)
    if (id) guardIds.add(id)
  }
  const observations = variables.filter(v => observedIds.has(v.id)).map(identity)
  const guards = variables.filter(v => guardIds.has(v.id)).map(identity)

  const constraints = scene.constraints.map(c => ({
    id: idMap.get(c.id) ?? sanitizeId(c.id, 'c'),
    kind: (c.kind ?? 'hard_range') as 'hard_range',
    ...(c.min !== undefined ? { min: c.min } : {}),
    ...(c.max !== undefined ? { max: c.max } : {}),
  }))

  const draft: PhysicsSpec = {
    specVersion: PHYSICS_SPEC_VERSION,
    modelId: sanitizeId(`draft-${scene.sceneId}`, 'draft'),
    sceneId: scene.sceneId,
    version: '0.1.0-skeleton',
    variables,
    parameters,
    states,
    observations,
    guards,
    constraints,
    monotonicity: [],
    delays: [],
    sampling: { horizonSteps: 4 },
    solver: { method: 'ode', dtSec: input.dtSec ?? 1, stabilityPolicy: 'reject_unstable' },
    provenance: {
      createdBy: input.createdBy,
      createdAt: new Date().toISOString(),
      evidence: [
        `auto skeleton from frozen SceneContract ${scene.sceneId}@${scene.sceneVersion} hash=${sha256(scene)}`,
        'per-state first-order lag with calibratable tau/gains; identity observations (persistence baseline)',
        'refine equations via twin_physics_spec_validate before compile/train',
      ],
    },
  }
  const checked = validatePhysicsSpec(draft)
  if (!checked.valid || !checked.spec) {
    throw new Error(`PHYSICS_SPEC_DRAFT_INVALID:${checked.errors.join('; ')}`)
  }
  return checked.spec
}
