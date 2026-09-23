/**
 * HITL 能力注册表(§13.5)—— 用**结构化能力记录**取代布尔 `hitl: boolean`。
 *
 * 为什么必须结构化:布尔量无法区分"能审批"和"能提问",更无法表达
 * "能提问但只支持单问题/只能回传字符串"。上层据此决定 UI 形态与降级路径,
 * 任何"不支持结构化提问"的 harness 必须显式记为 `UNSUPPORTED`,
 * **不得**因为 HTTP 200 或 mock 结果被记成 PASS(主计划 §11/§12)。
 *
 * 状态口径:
 *   UNSUPPORTED 引擎无原生 HITL 通道(能力全 false)—— 不是失败,是事实;
 *   BLOCKED     声明了 HITL,但未安装 / 未在本环境跑通原生契约(附人话原因);
 *   PASS        声明了 HITL + 已安装 + 有**真实**契约验证记录(markHarnessHitlVerified);
 *   FAIL        验证记录标记为失败(引擎拒绝/协议不符)。
 *
 * 依赖:`checkHarnessAvailability()`(真实 PATH 探测)与 HARNESS_REGISTRY(能力声明)。
 */
import { HARNESS_REGISTRY, knownHarnesses } from './registry'
import { checkHarnessAvailability } from './harness-availability'
import { harnessOfKind, type HitlKind } from './hitl-registry'

/** 结构化 HITL 能力面 */
export interface HitlCapabilityFacets {
  /** 权限/授权审批(approve/reject)可程序化应答 */
  approval: boolean
  /** 引擎提问(自由文本/选择)可程序化应答 */
  question: boolean
  /** 一次请求可携带**多问题**并逐题回答(只取第一题 = false) */
  multiQuestion: boolean
  /** 原生应答是结构化载荷(optionId/answers[] 等),而非仅字符串/布尔 */
  structuredResponse: boolean
  /** 支持取消/中止(不得把取消降级为同意) */
  cancel: boolean
}

export type HitlCapabilityStatus = 'PASS' | 'FAIL' | 'BLOCKED' | 'UNSUPPORTED'

export interface HitlCapabilityRecord extends HitlCapabilityFacets {
  harness: string
  label: string
  /** providerKind(登记进 hitl-registry 的 kind:codex-approval / opencode-permission / …) */
  providerKind: HitlKind | ''
  /** 引擎是否安装(PATH 探测);进程内引擎恒 true */
  installed: boolean
  /** 当前环境可用(checkHarnessAvailability;未安装含人话原因) */
  available: boolean
  inprocess: boolean
  /** 探测命令与解析到的可执行文件 */
  command: string | null
  resolvedPath: string | null
  /** 不可用原因(人话;可直接展示) */
  unavailableReason: string | null
  status: HitlCapabilityStatus
  /** 状态原因(为什么不是 PASS) */
  statusReason: string
  /** 真实契约验证记录(时间/证据/覆盖能力);未验证 = null */
  verified: HitlVerification | null
  /** 静态证据(file:line) */
  evidence: string[]
}

export interface HitlVerification {
  at: string
  /** 证据串(命令输出摘要 / 原生 requestId 等) */
  evidence: string
  /** 本次验证覆盖的能力面 */
  facets: Partial<HitlCapabilityFacets>
  ok: boolean
}

// ============================================================================
// 各 harness 的**如实声明**(无原生通道 = 全 false;不得虚报)
// ============================================================================

interface HitlDeclaration {
  providerKind: HitlKind | ''
  facets: HitlCapabilityFacets
  /** 静态证据(file:line) */
  evidence: string[]
  /** 不支持的原因(全 false 时必填) */
  unsupportedReason?: string
}

const NO_HITL = (reason: string): HitlDeclaration => ({
  providerKind: '',
  facets: {
    approval: false, question: false, multiQuestion: false, structuredResponse: false, cancel: false,
  },
  evidence: ['server/services/workshop/agents/registry.ts:62-103(能力声明 hitl:false,适配器无 register/resolve 调用)'],
  unsupportedReason: reason,
})

/** harness → 声明(缺省 = 无 HITL) */
const DECLARATIONS: Record<string, HitlDeclaration> = {
  omp: {
    providerKind: 'omp-dialog',
    facets: { approval: true, question: true, multiQuestion: false, structuredResponse: false, cancel: true },
    evidence: [
      'server/services/workshop/agents/harness-terminal.ts:273(extension_ui_request → registry.register)',
      'server/services/workshop/agents/harness-terminal.ts:624(extension_ui_response → resolve answered/cancelled)',
      'server/services/workshop/agents/harness-terminal.ts:416(omp 撤销 → cancelled)',
    ],
  },
  codex: {
    providerKind: 'codex-approval',
    facets: { approval: true, question: true, multiQuestion: true, structuredResponse: true, cancel: true },
    evidence: [
      'server/services/workshop/agents/codex-agent.ts:545(item/commandExecution|fileChange/requestApproval → registerApprovalHitl)',
      'server/services/workshop/agents/codex-agent.ts:585(tool/requestUserInput → registerUserInputHitl,全量 questions)',
      'server/services/workshop/agents/codex-agent.ts:625(respondUserInput:client.respond(rpcId,{answers}))',
      'server/services/workshop/agents/codex-agent.ts:202(respondHitl:question→answers / approval→decision)',
    ],
  },
  opencode: {
    providerKind: 'opencode-permission',
    facets: { approval: true, question: true, multiQuestion: true, structuredResponse: true, cancel: true },
    evidence: [
      'server/services/workshop/agents/opencode-agent.ts:703(permission.asked|permission.v2.asked → registerPermissionHitl)',
      'server/services/workshop/agents/opencode-agent.ts:708(question.asked → registerQuestionHitl,全量 questions)',
      'server/services/workshop/agents/opencode-agent.ts:241(respondHitl:POST /session/:id/permissions,POST /question/:id/reply|reject)',
    ],
  },
  dsh: {
    providerKind: 'dsh-permission',
    facets: { approval: true, question: false, multiQuestion: false, structuredResponse: true, cancel: true },
    evidence: [
      'server/services/workshop/agents/dsh-agent.ts:552(session/request_permission → registry.register)',
      'server/services/workshop/agents/dsh-agent.ts:162(respondHitl:selected optionId / cancelled;fail-closed)',
    ],
    unsupportedReason: 'ACP 只有权限请求,无自由提问通道(question=false)',
  },
  claude: {
    providerKind: 'claude-permission',
    facets: { approval: true, question: false, multiQuestion: false, structuredResponse: false, cancel: true },
    evidence: [
      'server/services/workshop/agents/claude-agent.ts:543(canUseTool → registry.register)',
      'server/services/workshop/agents/claude-agent.ts:167(respondHitl:PermissionVerdict allow/deny;超时 deny)',
    ],
    unsupportedReason: 'SDK 只有 canUseTool 裁决,无提问通道(question=false)',
  },
  qwen: {
    providerKind: 'qwen-permission',
    facets: { approval: true, question: false, multiQuestion: false, structuredResponse: false, cancel: true },
    evidence: [
      'server/services/workshop/agents/qwen-agent.ts:523(旧版 ACP requestToolCallConfirmation → register)',
      'server/services/workshop/agents/qwen-agent.ts:182(respondHitl:allow/reject/cancelled)',
    ],
    unsupportedReason: 'ACP 只有工具确认,无提问通道(question=false)',
  },
  hermes: {
    providerKind: 'hermes-permission',
    facets: { approval: true, question: false, multiQuestion: false, structuredResponse: true, cancel: true },
    evidence: [
      'server/services/workshop/agents/hermes-agent.ts:508(session/request_permission → register)',
      'server/services/workshop/agents/hermes-agent.ts:143(respondHitl:selected optionId / cancelled)',
    ],
    unsupportedReason: 'ACP 只有权限确认,无提问通道(question=false)',
  },
  dcw: {
    providerKind: 'dcw-approval',
    facets: { approval: true, question: false, multiQuestion: false, structuredResponse: false, cancel: true },
    evidence: [
      'server/services/workshop/agents/tool-approvals.ts:63(request → registry.register)',
      'server/services/workshop/agents/tool-approvals.ts:88(decide:approved+comment)',
      'server/services/workshop/agents/tool-approvals.ts:112(cancelPendingFor → cancelled)',
    ],
    unsupportedReason: '数控下发审批只有批准/拒绝二值,无提问通道(question=false)',
  },
  mock: NO_HITL('mock 为进程内联调引擎,无原生 HITL 通道(测试请经 registerHitlNativeDispatcher 注入)'),
  gemini: NO_HITL('gemini CLI stream-json 无程序化审批通道,AW 工具走 MCP 白名单'),
  copilot: NO_HITL('copilot CLI --allow-tool 白名单制,无程序化审批通道'),
  cursor: NO_HITL('cursor CLI 无 --force 时只提案,无程序化审批通道'),
  crush: NO_HITL('crush run 非交互模式,无程序化审批通道'),
  goose: NO_HITL('goose run stream-json 无程序化审批通道'),
  pi: NO_HITL('pi -p --mode json 无程序化审批通道'),
}

const ALL_FALSE: HitlCapabilityFacets = {
  approval: false, question: false, multiQuestion: false, structuredResponse: false, cancel: false,
}

/** 真实契约验证记录(globalThis:跨 HMR/多入口存活;只有跑过真实引擎才允许写入) */
const g = globalThis as typeof globalThis & { __hitlVerifications?: Record<string, HitlVerification> }

function verifications(): Record<string, HitlVerification> {
  g.__hitlVerifications ??= {}
  return g.__hitlVerifications
}

/**
 * 记录一次**真实**原生契约验证(仅测试/运维脚本调用)。
 * 未安装的 harness 不允许标记(先跑通再说);facets 只记录本次真正覆盖的能力面。
 */
export function markHarnessHitlVerified(harness: string, verification: {
  ok: boolean
  evidence: string
  facets?: Partial<HitlCapabilityFacets>
}): void {
  // 未安装的引擎不得留下"验证记录"(否则会伪造 PASS)
  const availability = checkHarnessAvailability(harness, undefined, { refresh: true })
  if (!availability.available) {
    throw new Error(`引擎 ${harness} 未安装/不可用,禁止标记 HITL 验证:${availability.error ?? ''}`)
  }
  verifications()[harness] = {
    at: new Date().toISOString(),
    evidence: verification.evidence,
    facets: verification.facets ?? {},
    ok: verification.ok,
  }
}

export function clearHarnessHitlVerifications(): void {
  g.__hitlVerifications = {}
}

/** 单 harness 能力记录(available 实时探测:未安装绝不标 PASS) */
export function hitlCapabilityOf(harness: string, opts: { refresh?: boolean } = {}): HitlCapabilityRecord {
  const def = HARNESS_REGISTRY[harness]
  const decl = DECLARATIONS[harness]
  // 非引擎型提供方(dcw = 平台内进程内审批):无 CLI 可探测,恒"在位"
  const availability = def
    ? checkHarnessAvailability(harness, undefined, { refresh: opts.refresh })
    : { id: harness, available: true, inprocess: true, command: null, resolvedPath: null, error: null }
  const facets = decl?.facets ?? ALL_FALSE
  const declared = facets.approval || facets.question
  const verified = verifications()[harness] ?? null

  let status: HitlCapabilityStatus
  let statusReason: string
  if (!declared) {
    status = 'UNSUPPORTED'
    statusReason = decl?.unsupportedReason ?? '无原生 HITL 通道'
  }
  else if (!availability.available) {
    status = 'BLOCKED'
    statusReason = `引擎未安装/不可用:${availability.error ?? '未知原因'}`
  }
  else if (!verified) {
    status = 'BLOCKED'
    statusReason = '已安装,但未在本环境真实触发原生 ask/approval 契约(静态声明不计 PASS)'
  }
  else if (!verified.ok) {
    status = 'FAIL'
    statusReason = `真实契约验证失败:${verified.evidence}`
  }
  else {
    status = 'PASS'
    statusReason = `真实契约验证通过(${verified.at}):${verified.evidence}`
  }

  return {
    harness,
    label: def?.label ?? harness,
    providerKind: decl?.providerKind ?? '',
    ...facets,
    installed: availability.available,
    available: availability.available,
    inprocess: availability.inprocess,
    command: availability.command,
    resolvedPath: availability.resolvedPath,
    unavailableReason: availability.error,
    status,
    statusReason,
    verified,
    evidence: decl?.evidence ?? [],
  }
}

/** 全量能力矩阵(按 registry 顺序;未声明的 harness 自动 UNSUPPORTED) */
export function hitlCapabilityMatrix(opts: { refresh?: boolean, only?: string[] } = {}): HitlCapabilityRecord[] {
  const ids = opts.only ?? [...new Set([...knownHarnesses(), ...Object.keys(DECLARATIONS)])]
  return ids.map(id => hitlCapabilityOf(id, opts))
}

/**
 * kind(providerKind)→ harness 反查(应答路由/能力校验用)。
 * 例:'opencode-permission' → 'opencode';未知 kind 返回 null。
 */
export function harnessOfProviderKind(kind: string): string | null {
  for (const [harness, decl] of Object.entries(DECLARATIONS)) {
    if (decl.providerKind && decl.providerKind === kind) return harness
  }
  return null
}

/**
 * 该 kind 是否允许结构化提问应答(question 型)。
 * 返回 false 时上层必须拒绝把自由文本当"授权同意"处理 —— 二者语义不同(§8)。
 */
export function supportsHitlQuestion(kind: string): boolean {
  const harness = harnessOfProviderKind(kind)
  if (!harness) return false
  return DECLARATIONS[harness]?.facets.question === true
}

/** 该 kind 是否支持多问题(只取第一题 = 不支持) */
export function supportsHitlMultiQuestion(kind: string): boolean {
  const harness = harnessOfProviderKind(kind)
  if (!harness) return false
  return DECLARATIONS[harness]?.facets.multiQuestion === true
}

/** 能力记录 → 供登记方写入 hitl_requests.harness 的规范化标识(未知 kind 回落 kind 自身) */
export function harnessIdOfKind(kind: string): string {
  return harnessOfProviderKind(kind) ?? harnessOfKind(kind)
}

/** 汇总(报告/断言用):PASS/FAIL/BLOCKED/UNSUPPORTED 各多少条 */
export function hitlCapabilitySummary(opts: { refresh?: boolean } = {}): Record<HitlCapabilityStatus, number> & { total: number } {
  const out: Record<HitlCapabilityStatus, number> = { PASS: 0, FAIL: 0, BLOCKED: 0, UNSUPPORTED: 0 }
  for (const r of hitlCapabilityMatrix(opts)) out[r.status] += 1
  return { ...out, total: Object.values(out).reduce((a, b) => a + b, 0) }
}
