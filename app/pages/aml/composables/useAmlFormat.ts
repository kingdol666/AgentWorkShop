/**
 * AML 页面的呈现格式化:时间/数值/百分比/短 id,以及 job/experiment 状态的中文标签。
 * i18n 绑定在本 composable 内,子组件各自取一份即可(纯函数,无共享可变状态)。
 */
import { AML_EXP_STATUS_KEYS, AML_JOB_STATUS_KEYS, canRetry, isActiveStatus, isTerminalStatus } from '../constants'

export function useAmlFormat() {
  const { t: tt } = useI18n()

  function fmtTime(iso: string | null | undefined): string {
    if (!iso) return '--'
    const d = new Date(iso)
    return Number.isFinite(d.getTime())
      ? `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
      : '--'
  }
  function fmtNum(v: number | null | undefined, digits = 4): string {
    return v == null || !Number.isFinite(v) ? '--' : String(Number(v.toFixed(digits)))
  }
  function fmtPct(v: number | null | undefined, digits = 1): string {
    return v == null || !Number.isFinite(v) ? '--' : `${(v * 100).toFixed(digits)}%`
  }
  function shortId(id: string): string {
    return id.length > 12 ? `${id.slice(0, 10)}…` : id
  }
  function statusLabel(s: string): string {
    return AML_JOB_STATUS_KEYS[s] ? tt(AML_JOB_STATUS_KEYS[s]) : s
  }
  function expStatusLabel(s: string): string {
    return AML_EXP_STATUS_KEYS[s] ? tt(AML_EXP_STATUS_KEYS[s]) : s
  }

  return {
    fmtTime,
    fmtNum,
    fmtPct,
    shortId,
    statusLabel,
    expStatusLabel,
    isActiveStatus,
    isTerminalStatus,
    canRetry,
  }
}
