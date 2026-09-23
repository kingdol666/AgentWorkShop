/**
 * 审计日志的展示格式化:时间戳、详情 JSON、来源/分类文案。
 *
 * 纯展示层(除 i18n 外无副作用):结果表的行渲染与详情面板共用同一套口径,
 * 时间格式固定为 MM-DD HH:mm:ss(与 DAQ/DCW 台账同语),非法时间原样回显不吞掉证据。
 */
import type { OpsLogRow } from '@/app/composables/workshop/useOpsLog'

export function useLogsFormat() {
  const { t: tt } = useI18n()

  /** 该行是否带结构化详情(空对象 = 无) */
  function hasDetail(row: OpsLogRow): boolean {
    return !!row.detailJson && row.detailJson !== '{}'
  }

  /** 详情 JSON 美化(解析失败原样回显:审计证据宁缺毋滥) */
  function pretty(json: string): string {
    try {
      return JSON.stringify(JSON.parse(json), null, 2)
    }
    catch {
      return json
    }
  }

  function fmtTime(at: string): string {
    const d = new Date(at)
    if (!Number.isFinite(d.getTime())) return at
    const p = (n: number) => String(n).padStart(2, '0')
    return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
  }

  function srcLabel(kind: string): string {
    return kind === 'agent' ? 'Agent' : kind === 'user' ? tt('logs.src.user') : tt('logs.src.system')
  }

  function kindLabel(kind: string): string {
    return kind ? tt(`logs.kind.${kind}`) : '—'
  }

  return { hasDetail, pretty, fmtTime, srcLabel, kindLabel }
}
