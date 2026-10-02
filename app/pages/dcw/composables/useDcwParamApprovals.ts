import { computed, onUnmounted, ref } from 'vue'
import { apiFetch } from '~/composables/workshop/apiClient'
import { useDcwStream } from '~/composables/workshop/useDcwStream'
import { useHitlStore } from '~/stores/workshop/hitl'
import type { useDcwDetailScope } from './useDcwDetailScope'

/**
 * HITL 下发参数审批(产线详情页卡)—— 本产线控制节点的 Agent 写入待批项。
 *
 * 数据源(GET /api/workshop/agent-tools/approvals?scope=pending,服务端已按
 * Channel 可见性 + 审批资格 fail-closed 过滤):行载荷带 nodeId/expiresAt,
 * ① kind='dcw' 只留下发审批;② nodeId ∈ 本产线节点 —— 精确过滤到当前产线
 * (hitl/pending 的 AepHitlItem 无结构化 nodeId,故不作数据源)。
 * 发起者名以全局 HITL store(dcw-approval 条目)补全,缺失回退 agentId。
 * 裁决走既有 POST /agent-tools/approvals/:id/decide(approved + comment,
 * 拒绝意见逐字回流 Agent);30s 轮询 + 裁决后立即刷新;空态由页面 v-if 收敛整卡。
 */

/** 审批行(GET approvals 返回 ToolApproval 的客户端投影;只取用到的字段) */
export interface DcwApprovalRow {
  id: string
  agentId: string
  kind: string
  nodeId: string
  /** 人读摘要(节点/物理量/当前值→目标值/步长依据,服务端生成,有什么展示什么) */
  detail: string
  createdAt: string
  /** 到期时刻(超时默认不同意) */
  expiresAt: string
  status: string
}

export function useDcwParamApprovals(scope: ReturnType<typeof useDcwDetailScope>) {
  const dcw = useDcwStream()
  const hitl = useHitlStore()
  const { lineNodes } = scope

  const items = ref<DcwApprovalRow[]>([])
  /** 逐审批拒绝意见输入(经 v-model 下发卡片;decide 时随 rejected 提交) */
  const comments = ref<Record<string, string>>({})
  const decidingId = ref('')
  /** 1s 心跳(倒计时用;读取它的渲染在每秒重算剩余秒数) */
  const nowMs = ref(Date.now())

  /** 本产线可见待批(服务端已过滤权限;这里只做产线与类型收窄) */
  const approvalItems = computed<DcwApprovalRow[]>(() => {
    const ids = new Set(lineNodes.value.map(n => n.id))
    return items.value.filter(a => a.kind === 'dcw' && ids.has(a.nodeId) && a.status === 'pending')
  })

  /** 发起者名(HITL 统一待办的 agentName 优先;缺失回退 agentId) */
  function approvalAgentName(a: DcwApprovalRow): string {
    return hitl.items.find(i => i.kind === 'dcw-approval' && i.id === a.id)?.agentName ?? a.agentId
  }

  /** 审批目标节点名(节点已删除时回退短 id) */
  function approvalNodeName(a: DcwApprovalRow): string {
    return dcw.nodeById(a.nodeId)?.name ?? a.nodeId.slice(0, 8)
  }

  /** 剩余秒数(读取 nowMs 心跳;超时默认不同意) */
  function approvalRemainingSec(a: DcwApprovalRow): number {
    return Math.max(0, Math.ceil((Date.parse(a.expiresAt) - nowMs.value) / 1000))
  }

  async function load(): Promise<void> {
    try {
      const r = await apiFetch<{ approvals?: DcwApprovalRow[] }>({ base: '/api/workshop/agent-tools/approvals', path: '?scope=pending' })
      items.value = r.approvals ?? []
    }
    catch {
      // 轮询失败保持既有数据(空态不渲染整卡,不打扰产线操作台)
    }
  }

  /** 裁决:approved=true 立即执行;false 拒绝(意见逐字回流 Agent)。成功/冲突后立即刷新 */
  async function decideApproval(id: string, approved: boolean): Promise<void> {
    decidingId.value = id
    try {
      await apiFetch({
        base: '/api/workshop/agent-tools/approvals',
        path: `/${encodeURIComponent(id)}/decide`,
        init: { method: 'POST', body: JSON.stringify({ approved, comment: comments.value[id] ?? '' }) },
      })
      items.value = items.value.filter(a => a.id !== id)
    }
    catch {
      // 409 ALREADY_RESOLVED(他人已处理/超时)等:以服务端事实源收敛
    }
    finally {
      Reflect.deleteProperty(comments.value, id)
      decidingId.value = ''
      await load()
    }
  }

  // 30s 数据轮询 + 1s 倒计时心跳(同一定时器计数,避免双计时器漂移;仅客户端:SSR 顶层 setInterval 会被 Nuxt 拒绝)
  if (import.meta.client) {
    let tick = 0
    const timer = setInterval(() => {
      nowMs.value = Date.now()
      tick++
      if (tick % 30 === 0) void load()
    }, 1000)
    onUnmounted(() => clearInterval(timer))
  }

  void load()
  // 发起者名依赖全局 HITL 待办快照(幂等;挂载基线对齐,后续由 AEP hitl.* 帧增量收敛)
  void hitl.loadSnapshot()

  return {
    approvalItems,
    approvalComments: comments,
    approvalDecidingId: decidingId,
    approvalRemainingSec,
    approvalAgentName,
    approvalNodeName,
    decideApproval,
  }
}
