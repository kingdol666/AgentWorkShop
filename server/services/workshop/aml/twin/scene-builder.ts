import { parseSceneContract, sha256, type SceneContract, type SceneVariable, type TwinRole } from './contracts'

export interface NodeSemanticInput {
  nodeId: string
  kind: 'daq' | 'dcw'
  name: string
  physicalMeaning?: string
  unit?: string
  min?: number
  max?: number
  processMin?: number
  processMax?: number
  maxStep?: number
  lineId?: string
  protocol?: string
  writable?: boolean
  roleHint?: TwinRole
  evidence?: string[]
}

export interface SceneDraftMeta {
  status: 'draft' | 'frozen'
  contractHash: string
  evidence: Record<string, { role: TwinRole, confidence: number, reasons: string[] }>
  inferredRelations: Array<{ cause: string, effect: string, direction: 'positive' | 'negative' | 'unknown', confidence: number, reason: string }>
  approvedBy?: string
  approvedAt?: string
}

export interface SceneDraft extends SceneContract {
  draftMeta: SceneDraftMeta
}

const text = (node: NodeSemanticInput): string => `${node.name} ${node.physicalMeaning ?? ''} ${(node.evidence ?? []).join(' ')}`.toLowerCase()
const has = (s: string, words: string[]) => words.some(word => s.includes(word))

export function inferNodeRole(node: NodeSemanticInput): { role: TwinRole, confidence: number, reasons: string[] } {
  // A bound DCW is an actuator, never a quality/state observation. Do not let
  // prompt hints relabel a writable output into a non-control role.
  if (node.kind === 'dcw' || node.writable) return { role: 'control', confidence: 1, reasons: ['bound DCW actuator identity'] }
  if (node.roleHint) return { role: node.roleHint, confidence: 1, reasons: ['agent/user roleHint; requires freeze review'] }
  const s = text(node)
  // Safety/guard semantics take priority over quality words (e.g. quality alarm).
  if (has(s, ['报警', '告警', '安全', '上限', '下限', 'defect', 'alarm', 'guard'])) return { role: 'guard', confidence: 0.86, reasons: ['guard semantic'] }
  if (has(s, ['setpoint', '设定', '给定', '阀门', '转速设定', '速度设定'])) return { role: 'control', confidence: 0.72, reasons: ['DAQ semantic resembles setpoint; requires explicit DCW binding before control use'] }
  if (has(s, ['缺陷', '飞边', '缩痕', '偏差', '不良', '质量', '硬度', '重量', '克重', '厚度', '浓度', '出水', '产量', '良率'])) return { role: 'target', confidence: 0.82, reasons: ['quality/output semantic'] }
  if (has(s, ['扰动', '环境', '来料', '批次', '等级', '厚度', 'ambient', 'batch', 'grade'])) return { role: 'disturbance', confidence: 0.68, reasons: ['disturbance semantic'] }
  return { role: 'state', confidence: node.kind === 'daq' ? 0.55 : 0.35, reasons: ['daq/process measurement fallback'] }
}

function variable(node: NodeSemanticInput, role: TwinRole): SceneVariable {
  return { id: variableId(node.nodeId), nodeId: node.nodeId, role, physicalMeaning: node.physicalMeaning ?? node.name, unit: node.unit ?? '', ...(node.processMin != null ? { min: node.processMin } : node.min != null ? { min: node.min } : {}), ...(node.processMax != null ? { max: node.processMax } : node.max != null ? { max: node.max } : {}), ...(node.maxStep != null ? { maxStep: node.maxStep } : {}) }
}

export function discoverSceneNodes(nodes: NodeSemanticInput[]): { nodes: Array<NodeSemanticInput & { inferred: ReturnType<typeof inferNodeRole> }>, counts: Record<TwinRole, number> } {
  const counts = { control: 0, state: 0, feature: 0, disturbance: 0, observation: 0, target: 0, guard: 0 } as Record<TwinRole, number>
  const seen = new Set<string>()
  const result = nodes.map((node) => {
    if (!node.nodeId.trim()) throw new Error('SCENE_NODE_ID_REQUIRED')
    if (seen.has(node.nodeId)) throw new Error(`SCENE_DUPLICATE_NODE:${node.nodeId}`)
    seen.add(node.nodeId)
    for (const value of [node.min, node.max, node.processMin, node.processMax, node.maxStep]) if (value !== undefined && !Number.isFinite(value)) throw new Error(`SCENE_NODE_BOUND_INVALID:${node.nodeId}`)
    if (node.maxStep !== undefined && node.maxStep <= 0) throw new Error(`SCENE_NODE_MAX_STEP_INVALID:${node.nodeId}`)
    if (node.min !== undefined && node.max !== undefined && node.min > node.max) throw new Error(`SCENE_NODE_BOUND_ORDER:${node.nodeId}`)
    if (node.processMin !== undefined && node.processMax !== undefined && node.processMin > node.processMax) throw new Error(`SCENE_NODE_PROCESS_BOUND_ORDER:${node.nodeId}`)
    const inferred = inferNodeRole(node)
    counts[inferred.role] += 1
    return { ...node, inferred }
  })
  return { nodes: result, counts }
}

export function sceneSemanticHash(contract: SceneContract | SceneDraft): string {
  const { draftMeta: _draftMeta, ...canonical } = contract as SceneDraft
  return sha256({ ...canonical, createdAt: '', createdBy: '' })
}

function variableId(nodeId: string): string {
  return `node_${sha256(nodeId).slice(0, 16)}`
}

export function compileSceneDraft(input: { sceneId: string, sceneVersion?: string, lineId: string, productId?: string, recipeId?: string, prompt?: string, createdBy: string, nodes: NodeSemanticInput[], physicsProfileId?: string, objectiveProfileIds?: string[], freeze?: boolean }): SceneDraft {
  if (!input.sceneId.trim() || !input.lineId.trim()) throw new Error('SCENE_ID_AND_LINE_ID_REQUIRED')
  if (!input.createdBy.trim()) throw new Error('SCENE_CREATOR_REQUIRED')
  const discovered = discoverSceneNodes([...input.nodes].sort((a, b) => a.nodeId.localeCompare(b.nodeId)))
  const vars = discovered.nodes.map(node => ({ node, role: node.inferred.role }))
  const controls = vars.filter(x => x.role === 'control').map(x => variable(x.node, 'control'))
  if (vars.some(x => x.role === 'control' && x.node.kind !== 'dcw' && !x.node.writable)) throw new Error('SCENE_CONTROL_MUST_BE_BOUND_DCW')
  const nodeLines = [...new Set(discovered.nodes.map(node => node.lineId).filter((line): line is string => Boolean(line)))]
  if (nodeLines.some(line => line !== input.lineId)) throw new Error(`SCENE_NODE_LINE_MISMATCH:${nodeLines.join(',')}`)
  const states = vars.filter(x => x.role === 'state').map(x => variable(x.node, 'state'))
  const disturbances = vars.filter(x => x.role === 'disturbance').map(x => variable(x.node, 'disturbance'))
  const targets = vars.filter(x => x.role === 'target').map(x => variable(x.node, 'target'))
  const observations = vars.filter(x => x.role === 'observation').map(x => variable(x.node, 'observation'))
  const guards = vars.filter(x => x.role === 'guard').map(x => variable(x.node, 'guard'))
  if (!controls.length) throw new Error('SCENE_NO_CONTROLS')
  if (!targets.length && !states.length) throw new Error('SCENE_NO_OBSERVABLES')
  const constraints = [...targets, ...guards].flatMap(v => v.min != null || v.max != null ? [{ id: v.id, kind: 'hard_range' as const, ...(v.min != null ? { min: v.min } : {}), ...(v.max != null ? { max: v.max } : {}) }] : [])
  const contract: SceneContract = parseSceneContract({
    schemaVersion: 1, createdAt: new Date().toISOString(), createdBy: input.createdBy,
    sceneId: input.sceneId, sceneVersion: input.sceneVersion ?? '0.1.0-draft', lineId: input.lineId,
    ...(input.productId ? { productId: input.productId } : {}), ...(input.recipeId ? { recipeId: input.recipeId } : {}), ...(input.prompt?.trim() ? { scenarioPrompt: input.prompt.trim() } : {}),
    phases: ['discovery', 'exploration', 'calibration', 'shadow', 'online'], controls, states, disturbances,
    observations: [...targets, ...observations, ...guards], guards, constraints,
    physicsProfileId: input.physicsProfileId ?? `declarative-${input.sceneId}`,
    objectiveProfileIds: input.objectiveProfileIds ?? [],
    writePolicy: { minNodeIntervalSec: 60, minLineActionIntervalSec: 60, maxActionsPerRun: 3, maxDeltaPerAction: Object.fromEntries(controls.map(c => [c.id, c.maxStep ?? Math.max(Math.abs((c.max ?? 1) - (c.min ?? 0)) * 0.02, 0.001)])) },
  })
  const evidence = Object.fromEntries(discovered.nodes.map(n => [n.nodeId, { role: n.inferred.role, confidence: n.inferred.confidence, reasons: n.inferred.reasons }]))
  const inferredRelations = controls.flatMap(control => [...targets, ...observations].map(target => ({ cause: control.id, effect: target.id, direction: 'unknown' as const, confidence: 0.25, reason: 'direction requires safe experiment or explicit PhysicsSpec monotonicity' })))
  const draftMeta: SceneDraftMeta = { status: input.freeze ? 'frozen' : 'draft', contractHash: sceneSemanticHash(contract), evidence, inferredRelations }
  return { ...contract, draftMeta }
}

export function freezeSceneDraft(draft: SceneDraft, approvedBy: string, approvedAt = new Date().toISOString()): SceneDraft {
  if (!approvedBy.trim()) throw new Error('SCENE_APPROVER_REQUIRED')
  return { ...draft, draftMeta: { ...draft.draftMeta, status: 'frozen', approvedBy, approvedAt, contractHash: sceneSemanticHash(draft) } }
}
