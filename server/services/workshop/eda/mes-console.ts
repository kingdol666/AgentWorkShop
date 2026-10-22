/**
 * MES 调试台用户面服务(plan1 BLOCKER B2 修正)。
 *
 * Agent 面的 mes-controller 授权口径是 agentId→dcw 绑定(人类没有绑定,直接复用
 * 会全 403 或被迫伪造 agentId);限流也按 agentId 记账。用户面在这里单独收敛:
 *  - 可见点 = 可读产线(readonly 及以上)上的 mes-rest 节点(跨线/孤儿不可见);
 *  - 频控按 userId 独立记账(30 次/60s,Agent 面的 6 次/60s 是对话节奏,对调试台过苛);
 *  - 取数直接走驱动结构化接口 fetchHistory(onRows 回调),不经 controller 的
 *    Agent 向 prose 组装 —— preview 需要结构化统计/采样,不是一次调用能复用的。
 *  - req 回显一律过 redactHeaders/redactQuery(凭据零透出,B3);driverConfig 原文绝不回显。
 */
import type { ResolvedUser } from '@/server/api/workshop/caller'
import { lineMode } from '../permissions'
import { getDcwNodeRepo } from '../dcw/dcw-node.repo'
import { resolveDcwDriver } from '../dcw/drivers'
import { historyFormatOf } from '../dcw/drivers/mes-rest'
import { mesDictionaryOfNode } from '../mes/mes-controller'
import { recordOps } from '../ops/ops'
import { redactHeaders, redactQuery } from './redact'

const WINDOW_MAX_MS = 7 * 24 * 3600_000
const ROWS_MAX = 5000
const SAMPLE_ROWS = 3

// ===== userId 频控(30 次/60s) =====
const rateStamps = new Map<string, number[]>()

export function mesUserRateReset(): void {
  rateStamps.clear()
}

function rateCheck(userId: string): boolean {
  const now = Date.now()
  const stamps = (rateStamps.get(userId) ?? []).filter(t => now - t < 60_000)
  if (stamps.length >= 30) {
    rateStamps.set(userId, stamps)
    return false
  }
  stamps.push(now)
  rateStamps.set(userId, stamps)
  return true
}

/** 用户可读产线上的 mes-rest 点位(调试台目录面) */
export function visibleMesNodesForUser(user: ResolvedUser): Array<{ id: string, name: string, lineId: string, unit: string, hasHistory: boolean, format: string }> {
  const out: Array<{ id: string, name: string, lineId: string, unit: string, hasHistory: boolean, format: string }> = []
  for (const n of getDcwNodeRepo().all()) {
    if (n.driver !== 'mes-rest' || !n.enabled) continue
    if (lineMode(user, n.lineId) === 'none') continue
    const cfg = n.driverConfig ?? {}
    out.push({
      id: n.id,
      name: n.name,
      lineId: n.lineId ?? '',
      unit: n.unit ?? '',
      hasHistory: Boolean(cfg.historyMap),
      format: historyFormatOf(cfg as Record<string, unknown>),
    })
  }
  return out
}

function readableMesNode(user: ResolvedUser, nodeId: string) {
  const node = getDcwNodeRepo().byId(nodeId)
  if (!node || node.driver !== 'mes-rest' || !node.enabled) return null
  if (lineMode(user, node.lineId) === 'none') return null
  return node
}

export interface MesPreviewResult {
  nodeId: string
  nodeName: string
  format: string
  window: { from: string, to: string }
  totalRows: number
  complete: boolean
  stats: { min: number | null, max: number | null, mean: number | null, std: number | null }
  sample: string[]
  dictionary: Array<{ field: string, label?: string, unit?: string, description?: string }>
  requestEcho: { method: string, path: string, query: Record<string, string>, headers: Record<string, string> }
}

/**
 * 点位历史取数预览(结构化):统计 + ≤3 行采样 + 字段字典 + 脱敏 req 回显。
 * 标量/向量给出数值统计;图像/表格/事件只给行数与记录摘要(像素/大字段不进响应)。
 */
export async function mesPreview(user: ResolvedUser, args: {
  nodeId: string
  fromIso: string
  toIso: string
  maxRows?: number
}): Promise<{ ok: true, data: MesPreviewResult } | { ok: false, status: number, code: string, message: string }> {
  if (!rateCheck(user.id)) {
    return { ok: false, status: 429, code: 'MES_RATE_LIMITED', message: 'MES 调试台取数过于频繁(每分钟 30 次),请稍后再试。' }
  }
  const node = readableMesNode(user, args.nodeId)
  if (!node) {
    return { ok: false, status: 403, code: 'SCOPE_VIOLATION', message: '点位不存在、未启用或不在你的可读产线上。' }
  }
  const cfg = node.driverConfig ?? {}
  if (!cfg.historyMap) {
    return { ok: false, status: 400, code: 'BAD_REQUEST', message: '该点位未配置历史映射(historyMap),无法取数。' }
  }
  const fromMs = Date.parse(args.fromIso)
  const toMs = Date.parse(args.toIso)
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || fromMs >= toMs) {
    return { ok: false, status: 400, code: 'VALIDATION_ERROR', message: 'from/to 必须是合法时间且 from < to。' }
  }
  if (toMs - fromMs > WINDOW_MAX_MS) {
    return { ok: false, status: 400, code: 'VALIDATION_ERROR', message: '时间窗超限(最大 7 天),请缩小窗口。' }
  }
  const maxRows = Math.min(Math.max(Math.round(Number(args.maxRows)) || 1000, 1), ROWS_MAX)

  // req 回显(脱敏):historyMap 的 path/query/headers 模板;baseUrl 属节点配置可见面,一并给出
  let requestEcho: MesPreviewResult['requestEcho'] = { method: 'GET', path: '', query: {}, headers: {} }
  try {
    const map = JSON.parse(String(cfg.historyMap)) as { method?: string, path?: string, query?: Record<string, unknown>, headers?: Record<string, unknown> }
    requestEcho = {
      method: String(map.method ?? 'GET').toUpperCase(),
      path: String(map.path ?? ''),
      query: redactQuery(map.query ?? {}),
      headers: redactHeaders(map.headers ?? {}),
    }
  }
  catch { /* historyMap 非法 JSON:驱动取数时会报 400,这里回显留空 */ }

  const rows: Array<Record<string, unknown>> = []
  const driver = resolveDcwDriver('mes-rest')
  if (!driver.fetchHistory) {
    return { ok: false, status: 503, code: 'UNAVAILABLE', message: 'mes-rest 驱动不支持历史取数。' }
  }
  let complete: boolean
  let dictionary: MesPreviewResult['dictionary']
  try {
    const r = await driver.fetchHistory({
      driverConfig: cfg as Record<string, unknown>,
      fromIso: new Date(fromMs).toISOString(),
      toIso: new Date(toMs).toISOString(),
      maxRows,
      onRows: (batch) => {
        for (const row of batch) {
          if (rows.length >= maxRows) return
          // 像素/大字段不进响应:图像只留 mime 与长度摘要,表格/事件留 JSON 的键名骨架
          if (row.data != null) {
            rows.push({ ts: row.ts, mime: row.mime ?? 'image/png', bytes: Math.round((row.data.length * 3) / 4) })
            return
          }
          if (row.record != null) {
            rows.push({ ts: row.ts, record: row.record })
            return
          }
          rows.push({ ts: row.ts, value: row.value, values: row.values })
        }
      },
    })
    complete = r.complete
    dictionary = (r.dictionary ?? mesDictionaryOfNode(node.id, cfg as Record<string, unknown>))
      .slice(0, 24)
      .map(d => ({ field: d.field, label: d.label || undefined, unit: d.unit || undefined, description: d.description?.slice(0, 160) || undefined }))
  }
  catch (err) {
    return { ok: false, status: 502, code: 'MES_HTTP_ERROR', message: `MES 取数失败:${err instanceof Error ? err.message : String(err)}` }
  }

  // 统计(标量数值面;向量取逐行均值)
  const vals: number[] = []
  for (const r of rows) {
    if (typeof r.value === 'number' && Number.isFinite(r.value)) vals.push(r.value)
    else if (Array.isArray(r.values)) {
      const nums = r.values.filter((v): v is number => typeof v === 'number' && Number.isFinite(v))
      if (nums.length) vals.push(nums.reduce((a, b) => a + b, 0) / nums.length)
    }
  }
  const mean = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null
  const std = vals.length > 1 && mean != null
    ? Math.sqrt(vals.reduce((a, b) => a + (b - mean) ** 2, 0) / vals.length)
    : null
  const sample = rows.slice(0, SAMPLE_ROWS).map((r) => {
    if (r.values != null) {
      const v = r.values as number[]
      return `${String(r.ts).slice(11, 19)} [${v.slice(0, 4).map(x => Number(x.toFixed(3))).join(',')}${v.length > 4 ? `,…(${v.length} 点)` : ''}]`
    }
    if (r.record != null) return `${String(r.ts).slice(11, 19)} ${JSON.stringify(r.record).slice(0, 120)}`
    if (r.bytes != null) return `${String(r.ts).slice(11, 19)} <图像 ${r.mime} ${r.bytes}B>`
    return `${String(r.ts).slice(11, 19)} ${typeof r.value === 'number' ? Number(r.value.toFixed(4)) : '?'}${node.unit ?? ''}`
  })

  // plan1 §5.4 埋点:调试台取数留痕(who/which point/window;不含任何取回数据)
  try {
    recordOps({
      actor: user.id, actorName: user.name, actorKind: 'user',
      action: 'mes.preview', kind: 'daq', targetKind: 'daq', targetId: node.id,
      lineId: node.lineId ?? '', scope: 'line',
      summary: `MES 调试台取数预览:${node.name}(${rows.length} 行,${new Date(fromMs).toISOString().slice(0, 16)} 起)`,
      detail: { nodeId: node.id, rows: rows.length },
    })
  }
  catch { /* 埋点失败不影响取数 */ }
  return {
    ok: true,
    data: {
      nodeId: node.id,
      nodeName: node.name,
      format: historyFormatOf(cfg as Record<string, unknown>),
      window: { from: new Date(fromMs).toISOString(), to: new Date(toMs).toISOString() },
      totalRows: rows.length,
      complete,
      stats: {
        min: vals.length ? Math.min(...vals) : null,
        max: vals.length ? Math.max(...vals) : null,
        mean,
        std,
      },
      sample,
      dictionary,
      requestEcho,
    },
  }
}
