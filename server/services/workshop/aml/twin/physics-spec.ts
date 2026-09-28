export const PHYSICS_SPEC_VERSION = 'physics-spec.v1' as const
export const PHYSICS_OPERATORS = ['add', 'sub', 'mul', 'div', 'pow', 'exp', 'log', 'min', 'max', 'clamp'] as const
export type PhysicsOperator = typeof PHYSICS_OPERATORS[number]

export interface PhysicsVariableSpec {
  id: string
  /** Optional stable binding to a physical DAQ/DCW node. */
  nodeId?: string
  role: string
  unit: string
  physicalMeaning?: string
  min?: number
  max?: number
  defaultValue?: number
}

export interface PhysicsParameterSpec {
  id: string
  value?: number
  defaultValue?: number
  min?: number
  max?: number
  unit?: string
}

export type PhysicsExpression
  = | number
    | { ref: string }
    | { param: string }
    | { value: number, unit?: string }
    | { const: number, unit?: string }
    | { literal: number, unit?: string }
    | { op: PhysicsOperator, args: PhysicsExpression[] }

export interface PhysicsEquationSpec { lhs: string, rhs: PhysicsExpression, unit?: string }
export interface PhysicsConstraintSpec { id: string, kind?: 'hard_range' | 'max_delta' | 'rate' | 'custom', min?: number, max?: number, unit?: string }
export interface PhysicsMonotonicitySpec { output: string, input: string, direction: 'increasing' | 'decreasing' | 'positive' | 'negative' }
export interface PhysicsDelaySpec { variable: string, steps: number }
export interface PhysicsSpec {
  specVersion: typeof PHYSICS_SPEC_VERSION
  modelId: string
  sceneId: string
  version?: string
  variables: PhysicsVariableSpec[]
  parameters: PhysicsParameterSpec[]
  states: PhysicsEquationSpec[]
  observations: PhysicsEquationSpec[]
  guards?: PhysicsEquationSpec[]
  constraints: PhysicsConstraintSpec[]
  monotonicity?: PhysicsMonotonicitySpec[]
  delays?: PhysicsDelaySpec[]
  sampling?: { periodMs?: number, horizonSteps?: number }
  solver: { method: 'discrete_state_space' | 'ode' | 'pde_reduced' | 'rom', dtSec: number, stabilityPolicy: 'reject_unstable' | 'warn_unstable' }
  provenance: { createdBy: string, evidence?: string[], sourceDocuments?: string[], createdAt?: string }
}

export interface PhysicsSpecIssue { path: string, code: string, message: string, severity: 'error' | 'warning' }
export interface PhysicsSpecValidationResult {
  valid: boolean
  ok: boolean
  errors: string[]
  warnings: string[]
  issues: PhysicsSpecIssue[]
  spec?: PhysicsSpec
}

const OPS = new Set<string>(PHYSICS_OPERATORS)
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_.:-]*$/
const RESERVED = new Set(['__proto__', 'prototype', 'constructor'])
const DIMENSIONLESS = new Set(['', '1', 'ratio', 'fraction', 'percent', '%'])
const UNIT_DIMENSIONS: Record<string, string> = {
  s: 'time', sec: 'time', ms: 'time', min: 'time', h: 'time',
  degc: 'temperature', c: 'temperature', k: 'temperature', degf: 'temperature',
  pa: 'pressure', kpa: 'pressure', mpa: 'pressure', bar: 'pressure', psi: 'pressure',
  g: 'mass', kg: 'mass', mg: 'mass',
  m: 'length', cm: 'length', mm: 'length', km: 'length',
  a: 'current', v: 'voltage', w: 'power', j: 'energy', n: 'force',
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}
function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}
function idOk(value: unknown): value is string {
  return typeof value === 'string' && IDENTIFIER.test(value) && !RESERVED.has(value)
}
function addIssue(issues: PhysicsSpecIssue[], path: string, code: string, message: string, severity: 'error' | 'warning' = 'error') {
  issues.push({ path, code, message, severity })
}
function unitKey(unit: string | undefined): string {
  return (unit ?? '').trim().toLowerCase().replace('°', 'deg')
}
function dimension(unit: string | undefined): string {
  const key = unitKey(unit)
  if (DIMENSIONLESS.has(key)) return 'dimensionless'
  if (UNIT_DIMENSIONS[key]) return UNIT_DIMENSIONS[key]
  if (key.includes('/') || key.includes('*') || key.includes('^')) return `compound:${key}`
  return key ? `unit:${key}` : 'scalar'
}
function compatible(a: string, b: string): boolean {
  return a === '*' || b === '*' || a === b || (a === 'dimensionless' && b === 'scalar') || (b === 'dimensionless' && a === 'scalar')
}
function normalizeExpr(value: unknown): PhysicsExpression | undefined {
  if (finite(value)) return value
  if (!record(value)) return undefined
  if (finite(value.ref)) return undefined
  if (typeof value.ref === 'string') return { ref: value.ref }
  if (typeof value.param === 'string') return { param: value.param }
  for (const key of ['value', 'const', 'literal']) if (finite(value[key])) return { [key]: value[key], ...(typeof value.unit === 'string' ? { unit: value.unit } : {}) } as PhysicsExpression
  if (typeof value.op === 'string' && Array.isArray(value.args)) return { op: value.op as PhysicsOperator, args: value.args.map(item => normalizeExpr(item) ?? item) }
  return undefined
}

interface ExprInfo { unit: string, min: number, max: number, deps: Set<string>, constant?: number }

function validateExpression(value: unknown, path: string, vars: Map<string, PhysicsVariableSpec>, params: Map<string, PhysicsParameterSpec>, issues: PhysicsSpecIssue[]): ExprInfo {
  const expr = normalizeExpr(value)
  if (expr === undefined) {
    addIssue(issues, path, 'AST_NODE', '表达式节点必须是数字、ref、param、literal 或白名单 op')
    return { unit: '*', min: -Infinity, max: Infinity, deps: new Set() }
  }
  if (typeof expr === 'number') return { unit: '*', min: expr, max: expr, deps: new Set(), constant: expr }
  if ('ref' in expr) {
    const baseRef = expr.ref.endsWith('_next') ? expr.ref.slice(0, -5) : expr.ref
    if (!idOk(expr.ref) || !vars.has(baseRef)) addIssue(issues, `${path}.ref`, 'UNKNOWN_VARIABLE', `未声明变量: ${String(expr.ref)}`)
    const v = vars.get(baseRef)
    return { unit: v ? dimension(v.unit) : '*', min: v?.min ?? -Infinity, max: v?.max ?? Infinity, deps: new Set([expr.ref]) }
  }
  if ('param' in expr) {
    if (!idOk(expr.param) || !params.has(expr.param)) addIssue(issues, `${path}.param`, 'UNKNOWN_PARAMETER', `未声明参数: ${String(expr.param)}`)
    const p = params.get(expr.param)
    const value = p?.value ?? p?.defaultValue
    return { unit: p?.unit ? dimension(p.unit) : '*', min: p?.min ?? value ?? -Infinity, max: p?.max ?? value ?? Infinity, deps: new Set() }
  }
  if ('value' in expr || 'const' in expr || 'literal' in expr) {
    const n = 'value' in expr ? expr.value : 'const' in expr ? expr.const : expr.literal
    if (!finite(n)) addIssue(issues, path, 'NON_FINITE', '常量必须是有限数字')
    return { unit: typeof expr.unit === 'string' ? dimension(expr.unit) : '*', min: n, max: n, deps: new Set(), constant: n }
  }
  if (!OPS.has(expr.op)) {
    addIssue(issues, `${path}.op`, 'OPERATOR', `不允许的算子: ${String(expr.op)}`)
    return { unit: '*', min: -Infinity, max: Infinity, deps: new Set() }
  }
  const args = Array.isArray(expr.args) ? expr.args : []
  const arity = expr.op === 'add' || expr.op === 'mul' || expr.op === 'min' || expr.op === 'max'
    ? args.length >= 2
    : expr.op === 'clamp'
      ? args.length === 3
      : args.length === 2 || ((expr.op === 'exp' || expr.op === 'log') && args.length === 1)
  if (!arity) addIssue(issues, `${path}.args`, 'ARITY', `${expr.op} 参数个数不正确`)
  const infos = args.map((arg, index) => validateExpression(arg, `${path}.args[${index}]`, vars, params, issues))
  const deps = new Set<string>()
  for (const info of infos) for (const dep of info.deps) deps.add(dep)
  if (expr.op === 'add' || expr.op === 'sub' || expr.op === 'min' || expr.op === 'max') {
    for (const info of infos.slice(1)) if (!compatible(infos[0]?.unit ?? '*', info.unit)) addIssue(issues, path, 'UNIT_MISMATCH', `${expr.op} 要求参数单位兼容`)
    const min = expr.op === 'sub' ? (infos[0]?.min ?? 0) - (infos[1]?.max ?? 0) : Math.min(...infos.map(i => i.min))
    const max = expr.op === 'sub' ? (infos[0]?.max ?? 0) - (infos[1]?.min ?? 0) : Math.max(...infos.map(i => i.max))
    return { unit: infos.find(i => i.unit !== '*')?.unit ?? '*', min, max, deps }
  }
  if (expr.op === 'mul' || expr.op === 'div') {
    const a = infos[0] ?? { unit: '*', min: -Infinity, max: Infinity, deps: new Set<string>() }
    const b = infos[1] ?? { unit: '*', min: -Infinity, max: Infinity, deps: new Set<string>() }
    if (expr.op === 'div' && b.min <= 0 && b.max >= 0) addIssue(issues, path, 'DIV_ZERO', '除数边界包含零')
    const values = expr.op === 'mul' ? [a.min * b.min, a.min * b.max, a.max * b.min, a.max * b.max] : [a.min / b.min, a.min / b.max, a.max / b.min, a.max / b.max]
    return { unit: '*', min: Math.min(...values), max: Math.max(...values), deps }
  }
  if (expr.op === 'pow') {
    const base = infos[0] ?? { unit: '*', min: -Infinity, max: Infinity, deps: new Set<string>() }
    const exponent = infos[1]
    if (exponent && exponent.min !== exponent.max && base.unit !== '*' && base.unit !== 'scalar' && base.unit !== 'dimensionless') addIssue(issues, path, 'POW_UNIT', '非标量指数只能作用于无量纲底数')
    if (base.min < 0 && exponent && (!Number.isInteger(exponent.min) || !Number.isInteger(exponent.max))) addIssue(issues, path, 'POW_DOMAIN', '负数底数不能使用非整数指数')
    const e = exponent?.constant
    const values = e !== undefined ? [Math.pow(base.min, e), Math.pow(base.max, e), Math.pow(0, e)] : [-Infinity, Infinity]
    return { unit: '*', min: Math.min(...values), max: Math.max(...values), deps }
  }
  if (expr.op === 'exp' || expr.op === 'log') {
    const input = infos[0] ?? { unit: '*', min: -Infinity, max: Infinity, deps: new Set<string>() }
    if (input.unit !== '*' && input.unit !== 'scalar' && input.unit !== 'dimensionless') addIssue(issues, path, 'UNIT_MISMATCH', `${expr.op} 只接受无量纲输入`)
    if (expr.op === 'log' && input.min <= 0) addIssue(issues, path, 'LOG_DOMAIN', 'log 输入必须始终大于零')
    return { unit: 'dimensionless', min: expr.op === 'exp' ? Math.exp(input.min) : Math.log(Math.max(input.min, Number.MIN_VALUE)), max: expr.op === 'exp' ? Math.exp(input.max) : Math.log(input.max), deps }
  }
  const clampValue = infos[0] ?? { unit: '*', min: -Infinity, max: Infinity, deps: new Set<string>() }
  const low = infos[1] ?? clampValue
  const high = infos[2] ?? clampValue
  if (!compatible(clampValue.unit, low.unit) || !compatible(clampValue.unit, high.unit)) addIssue(issues, path, 'UNIT_MISMATCH', 'clamp 参数单位必须兼容')
  if (low.constant !== undefined && high.constant !== undefined && low.constant > high.constant) addIssue(issues, path, 'BOUND_ORDER', 'clamp 下界不能大于上界')
  return { unit: clampValue.unit, min: Math.max(clampValue.min, low.min), max: Math.min(clampValue.max, high.max), deps }
}

export function validatePhysicsSpec(input: unknown): PhysicsSpecValidationResult {
  const issues: PhysicsSpecIssue[] = []
  if (!record(input)) {
    addIssue(issues, '$', 'TYPE', 'PhysicsSpec 必须是对象')
    return result(issues)
  }
  const value = input as Record<string, unknown>
  if (value.specVersion !== PHYSICS_SPEC_VERSION) addIssue(issues, 'specVersion', 'VERSION', `specVersion 必须为 ${PHYSICS_SPEC_VERSION}`)
  for (const key of ['modelId', 'sceneId'] as const) if (!idOk(value[key])) addIssue(issues, key, 'ID', `${key} 必须是安全标识符`)
  const variables: PhysicsVariableSpec[] = Array.isArray(value.variables) ? value.variables as PhysicsVariableSpec[] : []
  const parameters: PhysicsParameterSpec[] = Array.isArray(value.parameters) ? value.parameters as PhysicsParameterSpec[] : []
  const vars = new Map<string, PhysicsVariableSpec>()
  const params = new Map<string, PhysicsParameterSpec>()
  if (!Array.isArray(value.variables)) addIssue(issues, 'variables', 'ARRAY', 'variables 必须是数组')
  for (const [index, variable] of variables.entries()) {
    if (!record(variable) || !idOk(variable.id)) {
      addIssue(issues, `variables[${index}].id`, 'ID', '变量 id 非法')
      continue
    }
    if (variable.nodeId !== undefined && !idOk(variable.nodeId)) addIssue(issues, `variables[${index}].nodeId`, 'NODE_ID', '变量 nodeId 非法')
    if (vars.has(variable.id)) addIssue(issues, `variables[${index}].id`, 'DUPLICATE', `重复变量: ${variable.id}`)
    if (variable.nodeId !== undefined) {
      const owner = [...vars.entries()].find(([, v]) => v.nodeId === variable.nodeId)
      if (owner) addIssue(issues, `variables[${index}].nodeId`, 'NODE_ID_DUPLICATE', `多个变量绑定同一节点 ${variable.nodeId}(alias 映射会互相覆盖):${owner[0]} 与 ${variable.id}`, 'warning')
    }
    vars.set(variable.id, variable)
    if (typeof variable.unit !== 'string' || !variable.unit.trim()) addIssue(issues, `variables[${index}].unit`, 'UNIT', '变量必须声明单位')
    if ((variable.min !== undefined && !finite(variable.min)) || (variable.max !== undefined && !finite(variable.max))) addIssue(issues, `variables[${index}]`, 'BOUND', '变量边界必须是有限数字')
    if (variable.min !== undefined && variable.max !== undefined && variable.min > variable.max) addIssue(issues, `variables[${index}]`, 'BOUND_ORDER', '变量 min 不能大于 max')
  }
  if (!Array.isArray(value.parameters)) addIssue(issues, 'parameters', 'ARRAY', 'parameters 必须是数组')
  for (const [index, parameter] of parameters.entries()) {
    if (!record(parameter) || !idOk(parameter.id)) {
      addIssue(issues, `parameters[${index}].id`, 'ID', '参数 id 非法')
      continue
    }
    if (params.has(parameter.id)) addIssue(issues, `parameters[${index}].id`, 'DUPLICATE', `重复参数: ${parameter.id}`)
    params.set(parameter.id, parameter)
    const pv = parameter.value ?? parameter.defaultValue
    if (!finite(pv)) addIssue(issues, `parameters[${index}]`, 'PARAMETER_VALUE', '参数必须有有限 value/defaultValue')
    if ((parameter.min !== undefined && !finite(parameter.min)) || (parameter.max !== undefined && !finite(parameter.max))) addIssue(issues, `parameters[${index}]`, 'BOUND', '参数边界必须是有限数字')
    if (parameter.min !== undefined && parameter.max !== undefined && parameter.min > parameter.max) addIssue(issues, `parameters[${index}]`, 'BOUND_ORDER', '参数 min 不能大于 max')
    if (finite(pv) && ((parameter.min !== undefined && pv < parameter.min) || (parameter.max !== undefined && pv > parameter.max))) addIssue(issues, `parameters[${index}]`, 'PARAMETER_PRIOR', '参数 value 超出先验边界')
  }
  const equations = (key: string): PhysicsEquationSpec[] => {
    if (!Array.isArray(value[key])) {
      addIssue(issues, key, 'ARRAY', `${key} 必须是数组`)
      return []
    }
    return value[key] as PhysicsEquationSpec[]
  }
  const states = equations('states')
  const observations = equations('observations')
  const guards = Array.isArray(value.guards) ? value.guards as PhysicsEquationSpec[] : []
  const stateIds = new Set(variables.filter(v => v.role === 'state').map(v => v.id))
  const checkEquations = (list: PhysicsEquationSpec[], key: string, allowed: Set<string>) => {
    for (const [index, equation] of list.entries()) {
      if (!record(equation) || !idOk(equation.lhs)) {
        addIssue(issues, `${key}[${index}].lhs`, 'LHS', '方程 lhs 非法')
        continue
      }
      const lhs = equation.lhs.endsWith('_next') ? equation.lhs.slice(0, -5) : equation.lhs
      if (!allowed.has(lhs) && !vars.has(equation.lhs)) addIssue(issues, `${key}[${index}].lhs`, 'TARGET', `方程目标未声明: ${equation.lhs}`)
      const info = validateExpression(equation.rhs, `${key}[${index}].rhs`, vars, params, issues)
      const target = vars.get(lhs) ?? vars.get(equation.lhs)
      if (target && !compatible(dimension(target.unit), info.unit)) addIssue(issues, `${key}[${index}].rhs`, 'UNIT_MISMATCH', `方程 ${equation.lhs} 的 rhs 单位与 lhs 不兼容`)
      if (target && equation.unit && !compatible(dimension(target.unit), dimension(equation.unit))) addIssue(issues, `${key}[${index}].unit`, 'UNIT_MISMATCH', '方程 unit 与 lhs 不兼容')
      if (target && info.deps.size === 0 && info.min !== -Infinity && info.max !== Infinity && target.min !== undefined && target.max !== undefined && (info.min < target.min || info.max > target.max)) {
        const policy = record(value.solver) && value.solver.stabilityPolicy === 'warn_unstable' ? 'warning' : 'error'
        addIssue(issues, `${key}[${index}]`, 'BOUND', `方程输出可能越过 ${target.id} 边界`, policy)
      }
    }
  }
  checkEquations(states, 'states', stateIds)
  checkEquations(observations, 'observations', new Set(variables.filter(v => v.role === 'observation' || v.role === 'target').map(v => v.id)))
  checkEquations(guards, 'guards', new Set(variables.filter(v => v.role === 'guard').map(v => v.id)))
  const constraints = Array.isArray(value.constraints) ? value.constraints as PhysicsConstraintSpec[] : []
  if (!Array.isArray(value.constraints)) addIssue(issues, 'constraints', 'ARRAY', 'constraints 必须是数组')
  for (const [index, constraint] of constraints.entries()) {
    if (!record(constraint) || !idOk(constraint.id)) addIssue(issues, `constraints[${index}].id`, 'ID', '约束 id 非法')
    if ((constraint.min !== undefined && !finite(constraint.min)) || (constraint.max !== undefined && !finite(constraint.max))) addIssue(issues, `constraints[${index}]`, 'BOUND', '约束边界必须是有限数字')
    if (constraint.min !== undefined && constraint.max !== undefined && constraint.min > constraint.max) addIssue(issues, `constraints[${index}]`, 'BOUND_ORDER', '约束 min 不能大于 max')
    const target = vars.get(constraint.id)
    if (target && constraint.unit && !compatible(dimension(target.unit), dimension(constraint.unit))) addIssue(issues, `constraints[${index}].unit`, 'UNIT_MISMATCH', '约束单位与变量不兼容')
  }
  const solver = record(value.solver) ? value.solver as Record<string, unknown> : {}
  if (!finite(solver.dtSec) || solver.dtSec <= 0) addIssue(issues, 'solver.dtSec', 'DT', 'solver.dtSec 必须是正数')
  if (!['discrete_state_space', 'ode', 'pde_reduced', 'rom'].includes(String(solver.method))) addIssue(issues, 'solver.method', 'METHOD', '不支持的 solver.method')
  if (!['reject_unstable', 'warn_unstable'].includes(String(solver.stabilityPolicy))) addIssue(issues, 'solver.stabilityPolicy', 'POLICY', '不支持的 stabilityPolicy')
  if (!record(value.provenance) || typeof value.provenance.createdBy !== 'string' || !value.provenance.createdBy.trim()) addIssue(issues, 'provenance.createdBy', 'PROVENANCE', '必须声明 provenance.createdBy')
  const normalized = { ...value, variables, parameters, states, observations, guards, constraints, monotonicity: Array.isArray(value.monotonicity) ? value.monotonicity : [], delays: Array.isArray(value.delays) ? value.delays : [], sampling: record(value.sampling) ? value.sampling : {}, solver, provenance: value.provenance } as unknown as PhysicsSpec
  return result(issues, normalized)
}

function result(issues: PhysicsSpecIssue[], spec?: PhysicsSpec): PhysicsSpecValidationResult {
  const errors = issues.filter(i => i.severity === 'error').map(i => `${i.path}: ${i.message}`)
  const warnings = issues.filter(i => i.severity === 'warning').map(i => `${i.path}: ${i.message}`)
  return { valid: errors.length === 0, ok: errors.length === 0, errors, warnings, issues, ...(errors.length === 0 && spec ? { spec } : {}) }
}

export class PhysicsSpecValidationError extends Error {
  constructor(public readonly validation: PhysicsSpecValidationResult) {
    super(`Invalid PhysicsSpec: ${validation.errors.join('; ')}`)
    this.name = 'PhysicsSpecValidationError'
  }
}
export function parsePhysicsSpec(input: unknown): PhysicsSpec {
  const checked = validatePhysicsSpec(input)
  if (!checked.valid || !checked.spec) throw new PhysicsSpecValidationError(checked)
  return checked.spec
}
export const assertValidPhysicsSpec = parsePhysicsSpec

export interface ExpressionRuntimeContext { values: Record<string, number>, parameters: Record<string, number>, dtSec?: number }
export function evaluatePhysicsExpression(expression: PhysicsExpression, context: ExpressionRuntimeContext): number {
  if (typeof expression === 'number') return expression
  if ('ref' in expression) return expression.ref === 'dt' || expression.ref === 'dtSec' ? context.dtSec ?? 1 : context.values[expression.ref] ?? Number.NaN
  if ('param' in expression) return context.parameters[expression.param] ?? Number.NaN
  if ('value' in expression || 'const' in expression || 'literal' in expression) return 'value' in expression ? expression.value : 'const' in expression ? expression.const : expression.literal
  const args = expression.args.map(item => evaluatePhysicsExpression(item, context))
  const arg = (index: number): number => args[index] ?? Number.NaN
  switch (expression.op) {
    case 'add': return args.reduce((a, b) => a + b, 0)
    case 'sub': return arg(0) - arg(1)
    case 'mul': return args.reduce((a, b) => a * b, 1)
    case 'div': return arg(0) / arg(1)
    case 'pow': return Math.pow(arg(0), arg(1))
    case 'exp': return Math.exp(arg(0))
    case 'log': return Math.log(arg(0))
    case 'min': return Math.min(...args)
    case 'max': return Math.max(...args)
    case 'clamp': return Math.min(arg(2), Math.max(arg(1), arg(0)))
  }
}

export function ref(id: string): PhysicsExpression {
  return { ref: id }
}
export function param(id: string): PhysicsExpression {
  return { param: id }
}
export function literal(value: number, unit?: string): PhysicsExpression {
  return unit ? { value, unit } : { value }
}
export function op(operator: PhysicsOperator, ...args: PhysicsExpression[]): PhysicsExpression {
  return { op: operator, args }
}
