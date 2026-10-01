/**
 * POST /api/workshop/dcw/mes-hook-test —— MES 数据钩子试运行(body: { driverConfig, param? })。
 * 供驱动表单调试 historyMap 格式映射 + dataHook:
 *   ① 用 historyMap 实拉最近 30min 的 ≤50 行样本(格式感知);
 *   ② 已配 dataHook 则真实执行一次(产物落盘),回传 summary/context/产物清单。
 * 另回 requestHook 的请求构造覆盖(已配时),不触达网络。
 */
import { readBody } from 'h3'
import { resolveUser } from '@/server/api/workshop/caller'
import { defineApiHandler } from '@/server/utils/response'
import { AppError } from '@/server/utils/errors'
import { historyFormatOf } from '@/server/services/workshop/dcw/drivers/mes-rest'
import { resolveDcwDriver } from '@/server/services/workshop/dcw/drivers'
import { mesDataHookCode, mesRequestHookCode, runMesDataHook, runMesRequestHook } from '@/server/services/workshop/mes/mes-hook'

/** 试运行行数上限(护栏:试运行绝不大批量拉数;窗口由 window_minutes 参数控制,缺省 30 分钟) */
const TEST_MAX_ROWS = 50

export default defineApiHandler(async (event) => {
  resolveUser(event)
  const body = await readBody<{
    driverConfig?: Record<string, unknown>
    param?: unknown
    /** 试运行用的节点 id(产物目录隔离;缺省 test-node) */
    node_id?: string
    /** 试拉窗口分钟(缺省 30,上限 1440;批次/事件类建议 ≥2h) */
    window_minutes?: number
  }>(event) ?? {}
  const windowMs = Math.max(1, Math.min(Number(body.window_minutes) || 30, 1440)) * 60_000
  const cfg = body.driverConfig ?? {}
  const nodeId = String(body.node_id ?? 'test-node').slice(0, 64)

  // ① 格式解析(坏 historyMap 在此报配置错)
  const format = historyFormatOf(cfg)
  if (!cfg.historyMap) {
    throw new AppError(400, 'BAD_REQUEST', '未配置 historyMap(历史映射);钩子试运行以历史取数为前提')
  }

  // ② requestHook 请求构造覆盖(不触网,纯校验执行)
  let requestOverrides: Record<string, unknown> | null = null
  const reqCode = mesRequestHookCode(cfg)
  if (reqCode) {
    const o = await runMesRequestHook(reqCode, body.param, { nodeId })
    requestOverrides = { ...o }
  }

  // ③ 小窗口实拉样本
  const to = new Date()
  const from = new Date(to.getTime() - windowMs)
  const driver = resolveDcwDriver('mes-rest')
  if (typeof driver.fetchHistory !== 'function') throw new AppError(500, 'INTERNAL_ERROR', 'mes-rest 驱动未提供历史原语')
  const rows: Array<Record<string, unknown>> = []
  const hookRows: Array<Record<string, unknown>> = []
  await driver.fetchHistory({
    driverConfig: cfg,
    fromIso: from.toISOString(),
    toIso: to.toISOString(),
    maxRows: TEST_MAX_ROWS,
    onRows: (batch) => {
      for (const r of batch ?? []) {
        hookRows.push(r as unknown as Record<string, unknown>)
        rows.push({
          ts: r.ts,
          ...(r.value !== undefined ? { value: r.value } : {}),
          ...(r.values !== undefined ? { values: r.values } : {}),
          ...(r.data !== undefined ? { data: `${String(r.data).slice(0, 48)}…(${String(r.data).length}b64字符)` } : {}),
          ...(r.mime !== undefined ? { mime: r.mime } : {}),
          ...(r.record !== undefined ? { record: r.record } : {}),
        })
        if (rows.length >= TEST_MAX_ROWS) break
      }
    },
  })

  // ④ dataHook 真实执行(产物落盘;无钩子则跳过)。行数据给完整原文(hook 是数据的主人)
  let hook: Record<string, unknown> | null = null
  const hookCode = mesDataHookCode(cfg)
  if (hookCode) {
    const outcome = await runMesDataHook(hookCode, body.param, {
      node: { id: nodeId, name: String(cfg.desc ?? nodeId), lineId: '', unit: '' },
      format,
      rows: hookRows,
      window: { from: from.toISOString(), to: to.toISOString() },
    }, { nodeId })
    hook = {
      ok: outcome.ok,
      summary: outcome.summary ?? null,
      context: outcome.context ?? null,
      stats: outcome.stats ?? null,
      logs: outcome.logs,
      error: outcome.error ?? null,
      artifacts: outcome.artifacts.map(a => ({ name: a.name, bytes: a.bytes, mime: a.mime })),
    }
  }

  return {
    ok: true,
    format,
    rows: rows.length,
    sample: rows.slice(0, 3),
    requestOverrides,
    hook,
    message: `试拉 ${rows.length} 行(格式 ${format},窗口最近 ${Math.round(windowMs / 60000)} 分钟)${hook ? ';dataHook 已真实执行,产物落盘' : ''}`,
  }
})
