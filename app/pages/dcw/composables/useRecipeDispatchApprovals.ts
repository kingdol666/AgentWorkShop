import { computed, onUnmounted, ref } from 'vue'
import { apiErrorMessage } from '@/app/utils/api-error'
import { apiFetch } from '~/composables/workshop/apiClient'

/**
 * 整包方案审批(产线 Co-Pilot P2)—— 诊断 Channel recipe_propose 生成的
 * 「配方整包·多套候选」结构化审批单,产线详情页专属卡片的数据源。
 *
 * 数据源与 useDcwParamApprovals 同一端点(GET /api/workshop/agent-tools/approvals?scope=pending,
 * 服务端已按 Channel 可见性 + 审批资格 fail-closed 过滤):整包单 kind 仍是 'dcw',
 * **分流键是 nodeId 前缀 `recipe-propose:<recipeId>`** —— 这里只按前缀收窄
 * (不判 kind);useDcwParamApprovals 按「nodeId ∈ 产线真实节点」过滤,合成 id
 * 天然被排除,该 composable 零改动。两个 composable 各自 30s 轮询同一端点
 * (多一次轻量 GET,计划评审已接受;如后续要省请求可合并为共享一次拉取)。
 * 结构化载荷 payload(多套候选+逐参数预检)由后端可选提供:payload 缺失或
 * schemaVersion 不识别的行由卡片降级渲染 detail 文本 + 仅拒绝(fail-closed:
 * 无 choice 的批准一律按拒绝收敛,故降级面不给批准按钮)。
 * 裁决走既有 POST /agent-tools/approvals/:id/decide(approved + comment + choice,
 * choice=选中方案下标,仅批准时携带;拒绝意见逐字回流 Agent);乐观移除 +
 * 失败回滚 + 卡内红字;30s 轮询 + 裁决后立即刷新;空态由页面 v-if 收敛整卡。
 */

/** 单参数调整行(服务端已预检;预检不过的行仅展示弱化,不参与下发) */
export interface RecipeDispatchParam {
  nodeId: string
  paramName: string
  from: number | string
  to: number | string
  unit?: string
  /** 为什么这样调(Agent 给出的一句话依据;服务端已强制非空) */
  basis: string
  /** 经验引用(经验库条目指针) */
  exp_ref: string
  preflight: { ok: boolean, reason?: string }
}

/** 一套候选方案(1~3 套;批准即整包原子下发该套) */
export interface RecipeDispatchPackage {
  name: string
  rationale: string
  params: RecipeDispatchParam[]
}

/** 结构化审批载荷(approvals 行的可选字段;schemaVersion 守卫在卡片侧) */
export interface RecipeProposePayload {
  schemaVersion: number
  recipeId: string
  lineId: string
  packages: RecipeDispatchPackage[]
  /** 证据置信(后端可能不下发;缺省按 normal) */
  confidence?: 'low' | 'normal'
  /** AML 优化循环活动警示(可选;活动期建议暂缓下发) */
  amlActive?: boolean
}

/** 审批行(GET approvals 返回 ToolApproval 的客户端投影;只取用到的字段) */
export interface RecipeDispatchApprovalRow {
  id: string
  agentId: string
  kind: string
  /** 形如 `recipe-propose:<recipeId>`(分流键;不要用 kind 判断) */
  nodeId: string
  /** 人读摘要(payload 缺失时的降级展示面) */
  detail: string
  createdAt: string
  /** 到期时刻(超时默认不同意;过期由服务端 scope=pending 保证不出现) */
  expiresAt: string
  status: string
  payload?: RecipeProposePayload
}

/** 裁决入参:choice=选中方案下标,仅批准时携带(fail-closed:缺失按拒绝收敛) */
export interface RecipeDispatchDecideOpts {
  approved: boolean
  comment?: string
  choice?: number
}

export function useRecipeDispatchApprovals() {
  const { t } = useI18n()

  const raw = ref<RecipeDispatchApprovalRow[]>([])
  const loading = ref(false)
  /** 逐审批反馈意见输入(经 v-model 下发卡片;decide 时随裁决提交) */
  const comments = ref<Record<string, string>>({})
  /** 在飞裁决的行 id(行内按钮禁用) */
  const decidingId = ref('')
  /** 裁决失败提示(后端可读文案优先;i18n 兜底;成功即清空,卡内红字展示) */
  const decideError = ref('')

  /** 整包方案待批(服务端已过滤权限;这里只做分流前缀与在飞状态收窄) */
  const items = computed<RecipeDispatchApprovalRow[]>(() => {
    return raw.value.filter(a => typeof a.nodeId === 'string'
      && a.nodeId.startsWith('recipe-propose:')
      && a.status === 'pending')
  })

  async function load(): Promise<void> {
    loading.value = true
    try {
      const r = await apiFetch<{ approvals?: RecipeDispatchApprovalRow[] }>({ base: '/api/workshop/agent-tools/approvals', path: '?scope=pending' })
      raw.value = r.approvals ?? []
    }
    catch {
      // 轮询失败保持既有数据(空态不渲染整卡,不打扰产线操作台)
    }
    finally {
      loading.value = false
    }
  }

  /** 手动刷新(裁决链路之外的兜底入口) */
  async function refresh(): Promise<void> {
    await load()
  }

  /**
   * 裁决:批准=按选中方案整包原子下发(choice 必携,未选中在卡片侧已拦);
   * 拒绝=Agent 按原值继续(意见逐字回流)。乐观移除 + 失败回滚(行与意见一并
   * 还原)+ 卡内红字;成功/冲突后立即刷新以服务端事实源收敛。
   */
  async function decide(id: string, opts: RecipeDispatchDecideOpts): Promise<void> {
    if (decidingId.value)
      return
    decidingId.value = id
    decideError.value = ''
    const snapshot = raw.value
    const commentSnapshot = comments.value[id]
    raw.value = raw.value.filter(a => a.id !== id)
    try {
      const body: Record<string, unknown> = { approved: opts.approved, comment: opts.comment ?? '' }
      // choice 仅批准时携带(=选中方案下标);服务端对无 choice 的批准按拒绝收敛
      if (opts.approved && opts.choice !== undefined)
        body.choice = opts.choice
      await apiFetch({
        base: '/api/workshop/agent-tools/approvals',
        path: `/${encodeURIComponent(id)}/decide`,
        init: { method: 'POST', body: JSON.stringify(body) },
      })
    }
    catch (err) {
      // 409 ALREADY_RESOLVED(他人已处理/超时)等:还原行与意见,卡内红字提示
      raw.value = snapshot
      if (commentSnapshot !== undefined)
        comments.value[id] = commentSnapshot
      decideError.value = apiErrorMessage(err, t('recipePropose.decideFail'))
      return
    }
    finally {
      decidingId.value = ''
    }
    Reflect.deleteProperty(comments.value, id)
    await load()
  }

  // ---------- 逐动作审批(权限模型 v2:nodeId = `recipe:<recipeId>`,payload=recipeApprovalPayload) ----------
  /** 逐动作待批单(参数写入/下发/试验/回退;单动作无 choice 语义,批准/拒绝即可) */
  const gateItems = computed<RecipeDispatchApprovalRow[]>(() => {
    return raw.value.filter(a => typeof a.nodeId === 'string'
      && a.nodeId.startsWith('recipe:')
      && !a.nodeId.startsWith('recipe-propose:')
      && a.status === 'pending')
  })

  /** 逐动作裁决(approved + comment;意见逐字回流 Agent) */
  async function decideGate(id: string, approved: boolean, comment: string): Promise<void> {
    if (decidingId.value) return
    decidingId.value = id
    decideError.value = ''
    const snapshot = raw.value
    try {
      await apiFetch({
        base: '/api/workshop/agent-tools/approvals',
        path: `/${encodeURIComponent(id)}/decide`,
        init: { method: 'POST', body: JSON.stringify({ approved, comment: comment ?? '' }) },
      })
    }
    catch (err) {
      raw.value = snapshot
      decideError.value = apiErrorMessage(err, t('recipePropose.decideFail'))
      return
    }
    finally {
      decidingId.value = ''
    }
    await load()
  }

  // 30s 数据轮询(与 useDcwParamApprovals 各自轮询同一端点,轻量 GET 可接受);页面卸载清理
  const timer = setInterval(() => {
    void load()
  }, 30_000)
  onUnmounted(() => clearInterval(timer))

  void load()

  return { items, gateItems, loading, comments, decidingId, decideError, refresh, decide, decideGate }
}
