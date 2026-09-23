/**
 * 小镇视图 — Agent 工业节点绑定 / 手动确认审批
 *
 * 自 TownView.vue 抽出(纯结构搬移,行为与模板契约逐字保持):
 *   - 选中角色 → 拉取其工具授权绑定与待审批行(1s 轮询);
 *   - 绑定/解绑/模式切换/审批决定(REST,server 权威)。
 */
import { onBeforeUnmount, reactive, ref, watch } from 'vue'
import type { Ref } from 'vue'
import type { useDaqStream } from '@/app/composables/workshop/useDaqStream'
import type { useDcwStream } from '@/app/composables/workshop/useDcwStream'
import type { AgentNodeBindingRow, ToolApprovalRow } from './town-view-types'

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
    await fetch('/api/workshop/agent-tools/bindings', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ agentId: selected.value.id, nodeId: agentBindNodeId.value, kind: agentBindKind.value, mode: agentBindMode.value }),
    })
    agentBindNodeId.value = ''
    await loadAgentBindings()
  }

  async function unbindAgentNode(id: string): Promise<void> {
    await fetch(`/api/workshop/agent-tools/bindings/${id}`, { method: 'DELETE', headers: authHeaders() })
    await loadAgentBindings()
  }

  async function setBindingMode(id: string, mode: 'auto' | 'manual'): Promise<void> {
    await fetch(`/api/workshop/agent-tools/bindings/${id}`, { method: 'PATCH', headers: authHeaders(), body: JSON.stringify({ mode }) })
    await loadAgentBindings()
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

  return { approvalRemainingSec, agentBindings, agentBindKind, agentBindNodeId, agentBindMode, pendingApprovals, approvalComments, bindAgentNode, unbindAgentNode, setBindingMode, decideApproval, bindingNodeName }
}
