import { ref } from 'vue'
import { useDcwStream } from '~/composables/workshop/useDcwStream'
import type { DcwParamLedger } from '#shared/dcw-protocol'

/**
 * 参数台账(调控闭环:当前值/配方目标/lastGood 三值对照 + 设定历史 + 优化记录)。
 * 台账按节点按需拉取(选中节点变化才请求),单步回退经 write() 门控。
 */
export function useDcwLedger() {
  const dcw = useDcwStream()

  // ---------- 参数台账(调控闭环:三值对照 + 设定历史 + 优化记录) ----------
  const ledgerNodeId = ref('')
  const ledger = ref<DcwParamLedger | null>(null)
  const ledgerLoading = ref(false)
  async function loadLedger(): Promise<void> {
    if (!ledgerNodeId.value) return
    ledgerLoading.value = true
    try {
      ledger.value = await dcw.fetchLedger(ledgerNodeId.value)
    }
    finally {
      ledgerLoading.value = false
    }
  }
  /** 单步回退(经 write() 门控;回退后刷新台账) */
  async function rollbackLedgerNode(): Promise<void> {
    if (!ledgerNodeId.value) return
    await dcw.rollbackNode(ledgerNodeId.value)
    await loadLedger()
  }

  return { ledgerNodeId, ledger, ledgerLoading, loadLedger, rollbackLedgerNode }
}
