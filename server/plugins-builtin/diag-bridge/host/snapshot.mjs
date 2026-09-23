/**
 * 快照抽取(降采样 + 截断 + 上传附件)
 * (由 server/plugins-builtin/diag-bridge/index.mjs 按职责拆出;内容逐行原文搬运)
 */
import { SNAPSHOT_BUCKET_MS, SNAPSHOT_LIMIT, UPLOAD_FOLDER } from './constants.mjs'
import { authHeadersOf, baseOf, csvCell, fmtNum, safeName, short } from './helpers.mjs'

export async function snapshotCore(ctx, line, fromMs, toMs) {
  if (!ctx.daq || typeof ctx.daq.nodes !== 'function' || typeof ctx.daq.query !== 'function') {
    return { ok: false, error: '平台 ctx.daq 扩展未就绪(需宿主提供 daq.nodes / daq.query)。' }
  }
  // 1) 产线节点过滤(节点产线归属字段为 lineId,daq-node.repo snapshot 同构)
  const all = await ctx.daq.nodes()
  const lineNodes = (Array.isArray(all) ? all : []).filter(n => n && n.lineId === line)
  if (!lineNodes.length) return { ok: false, error: `产线 ${line} 下无数采节点。` }

  // 2) 时序查询(bucket 点含 {at,avg,min,max,cnt},raw 点含 {at,value});
  //    打标查询空窗(LineRun 未开跑/空闲段样本无 line_id)时降级为按节点查询
  let map = await ctx.daq.query({
    lineId: line,
    nodeIds: lineNodes.map(n => n.id),
    fromMs,
    toMs,
    bucketMs: SNAPSHOT_BUCKET_MS,
    limit: SNAPSHOT_LIMIT,
  })
  if (!(map instanceof Map) || map.size === 0) {
    map = await ctx.daq.query({
      nodeIds: lineNodes.map(n => n.id),
      fromMs,
      toMs,
      bucketMs: SNAPSHOT_BUCKET_MS,
      limit: SNAPSHOT_LIMIT,
    })
  }

  // 3) pivot:收集全部时间戳排序去重;行=时间戳,列=每节点(bucket 取 avg,raw 取 value)
  const tsSet = new Set()
  const perNode = new Map() // nodeId → Map(at → value)
  for (const [nodeId, points] of (map instanceof Map ? map : [])) {
    if (!Array.isArray(points)) continue
    const m = new Map()
    for (const p of points) {
      if (!p || typeof p.at !== 'number') continue
      const v = typeof p.avg === 'number' ? p.avg : (typeof p.value === 'number' ? p.value : null)
      if (v == null) continue
      m.set(p.at, v)
      tsSet.add(p.at)
    }
    if (m.size) perNode.set(nodeId, m)
  }
  const stamps = [...tsSet].sort((a, b) => a - b)
  if (!stamps.length) return { ok: false, error: `产线 ${line} 在该时窗内无数采样本,请调整时间窗口。` }
  if (stamps.length >= SNAPSHOT_LIMIT) {
    return { ok: false, error: `唯一时间戳数(${stamps.length})≥ 上限 ${SNAPSHOT_LIMIT},数据可能被 limit 截断,请缩小时间窗口后重试。` }
  }

  // 4) 组 CSV(timestamp 用平台本地时区 ISO;缺值留空)
  const cols = lineNodes.map(n => n.id)
  const rowsCsv = ['timestamp,' + cols.map(csvCell).join(',')]
  for (const ts of stamps) {
    const row = [new Date(ts).toISOString()]
    for (const id of cols) row.push(fmtNum(perNode.get(id)?.get(ts)))
    rowsCsv.push(row.map(csvCell).join(','))
  }
  const csv = rowsCsv.join('\r\n')

  // 5) 原生 fetch + AbortController(60s)multipart 上传(ctx.http 仅 JSON,传文件必须原生)
  const base = baseOf(ctx)
  if (!base) return { ok: false, error: 'diag.base_url 非法(仅允许 http/https 且 host 为 127.0.0.1/localhost)。' }
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), 60000)
  try {
    const fd = new FormData()
    fd.append('folder', UPLOAD_FOLDER)
    fd.append('files', new Blob([csv], { type: 'text/csv' }), safeName(line, toMs))
    const res = await fetch(`${base}/api/files/data/upload`, { method: 'POST', body: fd, signal: ac.signal, headers: authHeadersOf(ctx) })
    const body = await res.json().catch(() => null)
    if (!res.ok) throw new Error(`HTTP ${res.status} ${short(body)}`)
    if (!body || body.success !== true) throw new Error(`success!=true ${short(body)}`)
    const csvPath = String(body.data?.[0]?.path ?? '')
    if (!csvPath) throw new Error('上传响应缺少 data[0].path')
    return { ok: true, csvPath, rows: stamps.length, nodes: lineNodes.length, fromMs, toMs }
  }
  catch (err) {
    return { ok: false, error: `快照上传失败: ${err?.message ?? err}` }
  }
  finally {
    clearTimeout(timer)
  }
}

// ── 发起诊断(快照 → start → execute → kv 登记;异步,绝不等待) ────────────
