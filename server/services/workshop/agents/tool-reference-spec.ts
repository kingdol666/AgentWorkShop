/**
 * 工具引用面声明 —— 单一声明源(零依赖叶子模块)。
 *
 * 设计(2026-10-24 工具面计划 WP5):
 *  - 工具是否接收引用型参数(node/line/recipe/dataset/job/model/plan/scene/optimizer 对象)、
 *    该怎么校验,由工具定义自带 `references` 声明;显式无引用声明 `noRefs: true`。
 *  - **声明在注册期强制、校验在执行期实时**:本模块只承载声明与查表,不缓存任何
 *    授权判定(绑定面可在调用间隙被改写,归属必须每次重算 —— 见 tool-verify.ts)。
 *  - 加载器(loader)从 host-tools.json 读出字段,目录装配(catalog)调用
 *    registerToolReferenceDeclarations() 建立查表;插件工具经 registerPluginTool
 *    携带同形字段(可选,存量插件零变化)。
 *  - 命名映射(MCP annotations 预留):refs[].mode='read' ≈ readOnlyHint,
 *    mode='write' ≈ destructiveHint;riskClass='write' → destructiveHint=true。
 */
import type { ToolRefKind as _RefKind } from './tool-reference-kinds'

export type { ToolRefKind } from './tool-reference-kinds'

/** 链式引用类别(经谱系回溯判定归属) */
export type ToolChainKind = 'dataset' | 'job' | 'model' | 'plan' | 'scene' | 'binding' | 'run' | 'recommendation' | 'ontology_draft' | 'ontology_version'

export interface ToolRefRule {
  param: string
  kind: _RefKind
  /** 语义标注(不改变判定逻辑):read=只声明读取该对象;write=会改写该对象 */
  mode?: 'read' | 'write'
}

export interface ToolChainRule {
  param: string
  kind: ToolChainKind
  mode?: 'read' | 'write'
}

/** 一个工具的引用面声明(与 VERIFY_SPECS 的元素同形,平移到数据面) */
export interface ToolVerifySpec {
  /** 必填引用:至少提供一个(缺省形状拒绝;hint 给 Agent 该传什么) */
  atLeastOne?: Array<{ params: string[], hint: string }>
  /** 浅层字符串引用参数 → 判定类别 */
  refs?: ToolRefRule[]
  /** 浅层节点 id 数组参数 */
  nodeLists?: string[]
  /** 深路径节点引用(如 'params[].node_id' / 'packages[].params[].node_id') */
  deepNodeRefs?: string[]
  /** 链式引用(dataset_id/job_id/model_id/plan_id/scene_id/binding_id/run_id/recommendation_id) */
  chained?: ToolChainRule[]
  /** 只读工具:节点只要归属可读产线即可引用(与频道绑线只读扩权同口径;写工具不得开启) */
  readableLineNodes?: boolean
}

/** 工具风险类别(治理面与 MCP annotations 的公共输入) */
export type ToolRiskClass = 'read' | 'write' | 'admin'

/** 带声明字段的工具定义(host-tools.json / 插件注册共用形状) */
export interface ToolWithReferenceDeclaration {
  name: string
  references?: ToolVerifySpec
  noRefs?: boolean
  riskClass?: ToolRiskClass
}

const specByName = new Map<string, ToolVerifySpec | null>()

/** 装载声明表(目录装配时调用;重复调用幂等覆盖) */
export function registerToolReferenceDeclarations(tools: ToolWithReferenceDeclaration[]): void {
  specByName.clear()
  for (const t of tools) {
    if (!t || typeof t.name !== 'string') continue
    if (t.references) specByName.set(t.name, t.references)
    else if (t.noRefs) specByName.set(t.name, null)
  }
}

/**
 * 查声明:
 *  - declared=true, spec=ToolVerifySpec → 按声明校验
 *  - declared=true, spec=null            → 显式无引用(noRefs),不校验
 *  - declared=false, spec=null           → 未声明(调用方决定告警/回滚到 legacy 表)
 */
export function declaredReferenceSpec(name: string): { declared: boolean, spec: ToolVerifySpec | null } {
  if (specByName.has(name)) return { declared: true, spec: specByName.get(name) ?? null }
  return { declared: false, spec: null }
}

/** 已声明工具名集合(测试/审计用) */
export function declaredToolNames(): string[] {
  return [...specByName.keys()].sort()
}

/** 声明是否「有实质校验内容」(空对象等价于 noRefs,但语义不同:空对象=声明过但无规则) */
export function specHasRules(spec: ToolVerifySpec | null): boolean {
  if (!spec) return false
  return Boolean(
    (spec.atLeastOne?.length)
    || (spec.refs?.length)
    || (spec.nodeLists?.length)
    || (spec.deepNodeRefs?.length)
    || (spec.chained?.length),
  )
}

/**
 * 登记制判定(纯函数;注册期调用):
 *  - 'ok'                已声明(有 references 或显式 noRefs)
 *  - 'undeclared-write'  写族未声明 → 拒绝登记(注入面与执行面双关)
 *  - 'undeclared-read'   读族未声明 → 登记 + 告警(限期补齐)
 */
export function declarationVerdict(
  tool: { references?: unknown, noRefs?: boolean },
  isWriteFamily: boolean,
): 'ok' | 'undeclared-write' | 'undeclared-read' {
  if (tool.references || tool.noRefs) return 'ok'
  return isWriteFamily ? 'undeclared-write' : 'undeclared-read'
}
