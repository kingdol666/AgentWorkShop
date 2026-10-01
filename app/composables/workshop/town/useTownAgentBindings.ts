/**
 * 小镇视图 — Agent 工业节点绑定 / 手动确认审批
 *
 * 自 TownView.vue 抽出(纯结构搬移,行为与模板契约逐字保持):
 *   - 选中角色 → 拉取其工具授权绑定与待审批行(1s 轮询);
 *   - 绑定/解绑/模式切换/审批决定(REST,server 权威);
 *   - 模式切换为两段式:manual→auto 先经 autoConfirmState 驱动的风险确认弹窗,
 *     确认后才携带 confirm:true 提交(与服务端 confirm 闸同口径,计划铁律 2)。
 */
import { onBeforeUnmount, reactive, ref, watch } from 'vue'
import type { Ref } from 'vue'
import type { useDaqStream } from '@/app/composables/workshop/useDaqStream'
import type { useDcwStream } from '@/app/composables/workshop/useDcwStream'
import type { AgentNodeBindingRow, ToolApprovalRow } from './town-view-types'

/** manual→auto 风险确认弹窗的共享状态(由 AutoModeConfirmModal.vue 呈现) */
export interface AutoModeConfirmState {
  open: boolean
  /** 受影响节点名列表(弹窗「影响节点」行;当前一次只切一条绑定,预留列表形状) */
  nodeNames: string[]
  /** 上次 confirm 提交失败(switchFail 提示) */
  fail: boolean
}

export function useTownAgentBindings(params: {
  selected: Ref<{ kind: 'agent' | 'device', id: string, scale: number, rotation: number } | null>
  daq: ReturnType<typeof useDaqStream>
  dcw: ReturnType<typeof useDcwStream>
}) {
  const { selected, daq, dcw } = params

  // ===== Agent 工业节点绑定(数采/数控工具授权)+ 手动确认审批面板 =====

  /** 审批剩余秒数(超时默认拒绝;轮询刷新粒度) */
  function approvalRemainingSec(ap: ToolApprovalRow): number {
    return Math.max(0, Math.ceil((Date.parse(ap.expiresAt) - Date.now()) / 1000))
  }

  const authHeaders = (): Record<string, string> => {
    const token = document.cookie.match(/(?:^|;\s*)token=([^;]+)/)?.[1] ?? ''
    return { 'content-type': 'application/json', 'authorization': `Bearer ${decodeURIComponent(token)}` }
  }

  const agentBindings = ref<AgentNodeBindingRow[]>([])
  const agentBindKind = ref<'dcw' | 'daq'>('dcw')
  const agentBindNodeId = ref('')
  const agentBindMode = ref<'auto' | 'manual'>('auto')
  const pendingApprovals = ref<ToolApprovalRow[]>([])
  const approvalComments = reactive<Record<string, string>>({})
  let approvalPoll: ReturnType<typeof setInterval> | null = null

  async function loadAgentBindings(): Promise<void> {
    const id = selected.value?.id
    if (selected.value?.kind !== 'agent' || !id) return
    try {
      const r = await fetch(`/api/workshop/agent-tools/bindings?agentId=${encodeURIComponent(id)}`, { headers: authHeaders() }).then(x => x.json())
      agentBindings.value = r.data?.bindings ?? []
    }
    catch { /* 忽略轮询失败 */ }
  }

  async function loadPendingApprovals(): Promise<void> {
    const id = selected.value?.id
    if (selected.value?.kind !== 'agent' || !id) return
    try {
      const r = await fetch(`/api/workshop/agent-tools/approvals?agentId=${encodeURIComponent(id)}`, { headers: authHeaders() }).then(x => x.json())
      pendingApprovals.value = r.data?.approvals ?? []
    }
    catch { /* 忽略轮询失败 */ }
  }

  async function bindAgentNode(): Promise<void> {
    if (!selected.value?.id || !agentBindNodeId.value) return
    const r = await fetch('/api/workshop/agent-tools/bindings', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ agentId: selected.value.id, nodeId: agentBindNodeId.value, kind: agentBindKind.value, mode: agentBindMode.value }),
    }).then(x => x.json())
    // dcw 首绑被服务端强制 manual(modeForced/notice):把创建面板的模式选择器
    // 同步回真实落库值,避免"选了 auto 却静默变 manual"的无提示漂移
    const realMode = r?.data?.binding?.mode
    if (realMode === 'auto' || realMode === 'manual') agentBindMode.value = realMode
    agentBindNodeId.value = ''
    await loadAgentBindings()
  }

  async function unbindAgentNode(id: string): Promise<void> {
    await fetch(`/api/workshop/agent-tools/bindings/${id}`, { method: 'DELETE', headers: authHeaders() })
    await loadAgentBindings()
  }

  // ===== 控制模式切换(两段式):manual→auto 必经风险确认弹窗 =====

  /** 确认弹窗共享状态(同上 AutoModeConfirmState) */
  const autoConfirmState = reactive<AutoModeConfirmState>({ open: false, nodeNames: [], fail: false })
  /** 弹窗挂起期间待确认的绑定 id(空串=无挂起) */
  let pendingAutoBindingId = ''

  /** 实际提交 PATCH(confirm=true 仅在弹窗确认后携带);网络/服务端失败返回 false */
  async function doSetBindingMode(id: string, mode: 'auto' | 'manual', confirm = false): Promise<boolean> {
    const r = await fetch(`/api/workshop/agent-tools/bindings/${id}`, {
      method: 'PATCH',
      headers: authHeaders(),
      body: JSON.stringify(confirm ? { mode, confirm: true } : { mode }),
    })
    if (!r.ok) return false
    await loadAgentBindings()
    return true
  }

  /** 模式切换统一入口(select @change 直连;服务端还有同口径 confirm 闸兜底):
   *  同名不变更 / auto→manual 直接放行;manual→auto 先弹风险确认(记录受影响
   *  节点名),确认后才带 confirm:true 真正提交。 */
  async function requestBindingMode(b: AgentNodeBindingRow, mode: 'auto' | 'manual'): Promise<void> {
    if (mode === b.mode) return
    if (mode === 'auto' && b.mode === 'manual') {
      pendingAutoBindingId = b.id
      autoConfirmState.nodeNames = [bindingNodeName(b)]
      autoConfirmState.fail = false
      autoConfirmState.open = true
      return
    }
    await doSetBindingMode(b.id, mode)
  }

  /** 弹窗「确认切 auto」:带 confirm:true 提交;失败保持弹窗并亮 switchFail */
  async function confirmAutoSwitch(): Promise<void> {
    if (!pendingAutoBindingId) {
      autoConfirmState.open = false
      return
    }
    const ok = await doSetBindingMode(pendingAutoBindingId, 'auto', true)
    if (!ok) {
      autoConfirmState.fail = true
      return
    }
    pendingAutoBindingId = ''
    autoConfirmState.fail = false
    autoConfirmState.open = false
  }

  /** 弹窗「取消」:丢弃挂起的切换,不发任何请求(select 显示值随轮询回到 manual) */
  function cancelAutoSwitch(): void {
    pendingAutoBindingId = ''
    autoConfirmState.fail = false
    autoConfirmState.open = false
  }

  async function decideApproval(id: string, approved: boolean): Promise<void> {
    await fetch(`/api/workshop/agent-tools/approvals/${id}/decide`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ approved, comment: approvalComments[id] ?? '' }),
    })
    Reflect.deleteProperty(approvalComments, id)
    await loadPendingApprovals()
  }

  watch(() => selected.value?.id, (id) => {
    if (approvalPoll) {
      clearInterval(approvalPoll)
      approvalPoll = null
    }
    if (selected.value?.kind === 'agent' && id) {
      void loadAgentBindings()
      void loadPendingApprovals()
      approvalPoll = setInterval(() => {
        void loadPendingApprovals()
      }, 1000)
    }
  }, { immediate: true })
  onBeforeUnmount(() => {
    if (approvalPoll) clearInterval(approvalPoll)
  })

  /** 绑定行的节点名(dcw/daq store 解析) */
  function bindingNodeName(b: AgentNodeBindingRow): string {
    return b.kind === 'dcw' ? dcw.nodeById(b.nodeId)?.name ?? b.nodeId : daq.nodeById(b.nodeId)?.name ?? b.nodeId
  }

  return { approvalRemainingSec, agentBindings, agentBindKind, agentBindNodeId, agentBindMode, pendingApprovals, approvalComments, bindAgentNode, unbindAgentNode, requestBindingMode, autoConfirmState, confirmAutoSwitch, cancelAutoSwitch, decideApproval, bindingNodeName }
}
