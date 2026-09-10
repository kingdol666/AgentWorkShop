/**
 * diag-bridge —— industrial-deep-diagnostic 深度诊断服务桥接插件。
 *
 * 把诊断服务(http://127.0.0.1:3210)接入 AgentWorkShop:导出 DAQ 时序快照 CSV →
 * 上传并发起深度诊断 → 轮询状态 → 完成后报告自动入知识库(文档/索引/经验三步)。
 * 工具对 lead/worker 全体 agent 生效;3210 不可达时一律 isError 文本,绝不抛异常。
 */
const MIN = 60 * 1000
const DEFAULT_BASE = 'http://127.0.0.1:3210'
const SNAPSHOT_BUCKET_MS = 5000 // 快照降采样桶宽
const SNAPSHOT_LIMIT = 10000 // 与 ctx.daq.query limit 一致(截断断言阈值)
const UPLOAD_FOLDER = 'aw-snapshots'
const AUTO_COOLDOWN_MS = 30 * MIN // 自动诊断同产线冷却

/** 每产线「启动中」互斥(进程内同步集合,堵住 kv 检查与远端落库之间的并发窗口) */
const startingLines = new Set()

// ── 基础工具 ──────────────────────────────────────────────────────────────

/** 诊断服务 base(kv diag.base_url;只允许 http/https 且 host 为 127.0.0.1/localhost) */
function baseOf(ctx) {
  const raw = String(ctx.config?.get?.('plugins.diag-bridge.base_url') || ctx.kv.get('diag.base_url') || DEFAULT_BASE).trim()
  try {
    const u = new URL(raw)
    const okProto = u.protocol === 'http:' || u.protocol === 'https:'
    const okHost = u.hostname === '127.0.0.1' || u.hostname === 'localhost'
    if (!okProto || !okHost) return null
    return raw.replace(/\/+$/, '')
  }
  catch {
    return null
  }
}

/** 诊断服务鉴权 token(系统配置 plugins.diag-bridge.token 优先,kv diag.token 兜底;空=匿名)。
 *  诊断服务 v4 起默认强制 Bearer(AUTH_ENABLED!==0),401 AUTH_REQUIRED 时先查这里。 */
function diagTokenOf(ctx) {
  return String(ctx.config?.get?.('plugins.diag-bridge.token') || ctx.kv.get('diag.token') || '').trim()
}

function authHeadersOf(ctx) {
  const t = diagTokenOf(ctx)
  return t ? { authorization: `Bearer ${t}` } : {}
}

/** rag-knowledge 出站鉴权(系统配置 plugins.rag-bridge.token 优先,kv kb.token;与 rag-bridge 同源。
 *  入库管线要打 web 6789 / api 8770,服务端开启鉴权时缺头会 401 → catalog 查不到库 → 跳过入库) */
function kbHeadersOf(ctx) {
  const t = String(ctx.config?.get?.('plugins.rag-bridge.token') || ctx.kv.get('kb.token') || '').trim()
  return t ? { 'authorization': `Bearer ${t}`, 'x-kb-token': t } : {}
}

// ── 配置读取(系统配置优先,kv 兜底;前端全局设置→运行配置→插件组可改,保存即热生效) ──

const harnessOf = ctx => String(ctx.config?.get?.('plugins.diag-bridge.harness') || ctx.kv.get('diag.harness') || 'omp')
const maxTurnsOf = ctx => Number(ctx.config?.get?.('plugins.diag-bridge.max_turns')) || Number(ctx.kv.get('diag.max_turns')) || 220
const maxMinutesOf = ctx => Number(ctx.config?.get?.('plugins.diag-bridge.max_minutes')) || Number(ctx.kv.get('diag.max_minutes')) || 40
/** 自动诊断开关:系统配置布尔或 kv 'true'(kv 为历史字符串语义) */
const autoEnabledOf = ctx => ctx.config?.get?.('plugins.diag-bridge.auto_enabled') === true || ctx.kv.get('auto_diag_enabled') === 'true'
const autoRulesOf = ctx => String(ctx.config?.get?.('plugins.diag-bridge.auto_rules') || ctx.kv.get('auto_rules') || '')

const runKey = id => `run:${id}`

/** kv 中全部 run 记录 → [{ id, meta }] */
function kvRuns(ctx) {
  const out = []
  for (const [k, v] of Object.entries(ctx.kv.all())) {
    if (k.startsWith('run:') && v && typeof v === 'object') out.push({ id: k.slice(4), meta: v })
  }
  return out
}

/** 该产线是否有运行中的诊断 */
function runningOfLine(ctx, line) {
  return kvRuns(ctx).find(r => r.meta?.status === 'running' && r.meta?.line === line) ?? null
}

/** 短 JSON 摘要(错误信息用) */
function short(body) {
  try {
    return JSON.stringify(body).slice(0, 200)
  }
  catch {
    return String(body)
  }
}

/** 401 时给可操作的修复指引(生产最常见故障:会话 token 随诊断服务重启失效) */
function authHint(status, msg) {
  if (status !== 401) return msg
  return `${msg};修复:在 系统设置→运行配置→插件 更新「诊断 API Token」(推荐使用诊断服务侧的持久化 API Token,idd_ 前缀,服务重启不失效)`
}

/** JSON GET:断言 HTTP ok 且 body.success===true,返回 body */
async function jget(ctx, url, timeoutMs = 8000) {
  const res = await ctx.http.get(url, { timeoutMs, headers: authHeadersOf(ctx) })
  const body = await res.json().catch(() => null)
  if (!res.ok) throw new Error(authHint(res.status, `HTTP ${res.status} ${short(body)}`))
  if (!body || body.success !== true) throw new Error(`success!=true ${short(body)}`)
  return body
}

/** JSON POST:断言 HTTP ok 且 body.success===true,返回 body(extraHeaders 供 KB 端点叠加鉴权) */
async function jpost(ctx, url, body, timeoutMs = 15000, extraHeaders = {}) {
  const res = await ctx.http.post(url, body, { timeoutMs, headers: { ...authHeadersOf(ctx), ...extraHeaders } })
  const out = await res.json().catch(() => null)
  if (!res.ok) throw new Error(authHint(res.status, `HTTP ${res.status} ${short(out)}`))
  if (!out || out.success !== true) throw new Error(`success!=true ${short(out)}`)
  return out
}

/** 解析 auto_rules(kv 存 JSON 字符串 {nodeId:{op:'gt'|'lt',value}}) */
function parseAutoRules(raw) {
  if (!raw) return {}
  try {
    const obj = typeof raw === 'string' ? JSON.parse(raw) : raw
    return obj && typeof obj === 'object' ? obj : {}
  }
  catch {
    return {}
  }
}

/** CSV 单元格转义(含逗号/引号/换行时加引号) */
function csvCell(v) {
  const s = String(v)
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

/** 数值格式化(保留 6 位小数,去尾零;非有限值 → 空) */
function fmtNum(v) {
  if (typeof v !== 'number' || !Number.isFinite(v)) return ''
  return String(Math.round(v * 1e6) / 1e6)
}

/** 快照文件名(ASCII 安全,避免 multipart filename 编码问题) */
function safeName(line, toMs) {
  const s = String(line).replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'line'
  return `snap-${s}-${toMs}.csv`
}

// ── 快照导出器 ───────────────────────────────────────────────────────────

/**
 * 导出产线时窗快照:daq 节点过滤 → 时序查询 → 时间戳 pivot → CSV → multipart 上传。
 * 成功返回 { ok:true, csvPath, rows, nodes, fromMs, toMs };失败返回 { ok:false, error }。
 */
async function snapshotCore(ctx, line, fromMs, toMs) {
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

async function startDiagnosis(ctx, { line, fromMs, toMs, question, scene, source }) {
  const base = baseOf(ctx)
  if (!base) return { ok: false, error: 'diag.base_url 非法(仅允许 http/https 且 host 为 127.0.0.1/localhost)。' }
  if (startingLines.has(line)) return { ok: false, error: `产线 ${line} 已有诊断正在启动,请稍后再试。` }
  const existing = runningOfLine(ctx, line)
  if (existing) return { ok: false, error: `产线 ${line} 已有运行中的诊断(run_id=${existing.id}),请稍后用 diag_status 查询。` }
  startingLines.add(line)
  try {
    const snap = await snapshotCore(ctx, line, fromMs, toMs)
    if (!snap.ok) return { ok: false, error: snap.error }
    const q = question || `${line} 产线该时窗数据深度根因诊断`
    const sceneName = scene || `${line}_diag`
    const started = await jpost(ctx, `${base}/api/diagnosis/start`, {
      dataPath: snap.csvPath,
      sceneName,
      userQuestion: q,
      harness: harnessOf(ctx), // 缺省落 claude 引擎会因无 key 失败,必须显式(系统配置 plugins.diag-bridge.harness → kv → omp)
      enhancement: 'off',
      reportLanguage: 'zh',
      maxTurns: maxTurnsOf(ctx), // 修复循环会加转数;150 不够走完全管线
      timeoutMinutes: maxMinutesOf(ctx),
    })
    const runId = String(started.data?.runId ?? '')
    const name = String(started.data?.name ?? '')
    if (!runId) return { ok: false, error: `start 响应缺少 data.runId: ${short(started)}` }
    await jpost(ctx, `${base}/api/diagnosis/execute/${encodeURIComponent(runId)}`, {})
    ctx.kv.set(runKey(runId), {
      line, fromMs, toMs, question: q, scene: sceneName,
      status: 'running', createdAt: Date.now(), source, csvPath: snap.csvPath, name,
    })
    return { ok: true, runId, name, csvPath: snap.csvPath, rows: snap.rows, nodes: snap.nodes }
  }
  catch (err) {
    return { ok: false, error: `发起诊断失败: ${err?.message ?? err}` }
  }
  finally {
    startingLines.delete(line)
  }
}

// ── 入库管线(web 建文档 → backend 索引 → backend 经验;每步断言 success) ───

async function ingestCompleted(ctx, runId, meta, st) {
  try {
    // kv 按插件命名空间隔离:rag-bridge 建的库不在本插件 kv 里,需自行从 catalog 幂等解析
    const webBase = String(ctx.config?.get?.('plugins.rag-bridge.web_url') || ctx.kv.get('kb.web_url') || 'http://127.0.0.1:6789').replace(/\/+$/, '')
    let kbId = String(ctx.kv.get('kb.id') || '').trim()
    if (!kbId) {
      const cat = await ctx.http.get(`${webBase}/api/kb/catalog`, { timeoutMs: 15000, headers: kbHeadersOf(ctx) })
        .then(r => r.json()).catch(() => null)
      const hit = (Array.isArray(cat?.knowledgeBases) ? cat.knowledgeBases : [])
        .find(kb => kb?.name === 'aw-industrial')
      if (hit?.kbId) {
        ctx.kv.set('kb.id', String(hit.kbId))
        kbId = String(hit.kbId)
      }
    }
    if (!kbId) {
      ctx.logger.warn(`诊断 ${runId} 已完成但找不到知识库 aw-industrial(rag-bridge 未初始化?),跳过入库`)
      return
    }
    const base = baseOf(ctx)
    const runName = String(st.name || meta.name || '')
    if (!base || !runName) throw new Error(`缺少诊断服务 base 或 run name(${runName})`)

    // 1) 报告全文。报告端点按「目录名」索引(时间戳_scene),而 status.name 是显示名
    //    (scene_runId)——优先用 report_path 反推目录名,缺失时回退显示名。
    const rp = String(st.report_path || meta.reportPath || '')
    const repDir = rp.split(/[\\/]/).filter(Boolean).slice(-2, -1)[0] || runName
    const rep = await jget(ctx, `${base}/api/files/workspace/report/${encodeURIComponent(repDir)}`, 10000)
    const content = String(rep.data?.content ?? '')
    if (!content) throw new Error('报告内容为空')

    const apiBase = String(ctx.config?.get?.('plugins.rag-bridge.base_url') || ctx.kv.get('kb.base_url') || 'http://127.0.0.1:8770').replace(/\/+$/, '')

    // 2) web 建文档(响应 {success, document:{path,…}},path 供索引用)
    const doc = await jpost(ctx, `${webBase}/api/kb/documents/create`, { kbId, name: `${runName}.md`, content }, 15000, kbHeadersOf(ctx))
    const docPath = String(doc.document?.path ?? '')
    if (!docPath) throw new Error(`documents/create 响应缺少 document.path: ${short(doc)}`)

    // 3) backend 向量/图谱索引
    await jpost(ctx, `${apiBase}/api/v1/search/index-document`, {
      kb_id: kbId,
      doc_path: docPath,
      content,
      tags: [meta.line, '诊断', 'source:diag-bridge'].filter(Boolean),
    }, 30000, kbHeadersOf(ctx))

    // 4) backend 经验沉淀
    const q = String(meta.question || '')
    await jpost(ctx, `${apiBase}/api/v1/experience/${encodeURIComponent(kbId)}`, {
      title: `诊断:${q ? q.slice(0, 50) : runName}`,
      category: 'troubleshooting',
      problem: q,
      solution: content.slice(0, 800),
      result: 'success',
      tags: [meta.line, meta.scene].filter(Boolean),
    }, 30000, kbHeadersOf(ctx))

    ctx.kv.set(runKey(runId), { ...ctx.kv.get(runKey(runId)), stored: true, storedAt: Date.now() })
    ctx.logger.info(`诊断 ${runId}(产线 ${meta.line})报告已入库: ${docPath}`)
  }
  catch (err) {
    ctx.logger.warn(`诊断 ${runId} 入库失败(不重试): ${err?.message ?? err}`)
  }
}

// ── 轮询器:15s 扫描 kv 中 running 的 run → 更新状态 → 完成则入库 ──────────

async function sweepOnce(ctx) {
  // running:常规轮询;completed 未入库:30 分钟内重试入库(入库管线曾失败时自愈)
  const running = kvRuns(ctx).filter(r =>
    r.meta?.status === 'running'
    || (r.meta?.status === 'completed' && r.meta?.stored !== true
      && Date.now() - (r.meta?.completedAt ?? 0) < 120 * MIN))
  if (!running.length) return
  const base = baseOf(ctx)
  if (!base) {
    ctx.logger.warn('diag.base_url 非法,本轮跳过诊断轮询')
    return
  }
  for (const { id, meta } of running) {
    try {
      const st = (await jget(ctx, `${base}/api/diagnosis/status/${encodeURIComponent(id)}`, 8000)).data ?? {}
      const status = st.engineStatus || st.status || meta.status
      if (status === 'completed') {
        ctx.kv.set(runKey(id), {
          ...meta,
          status: 'completed',
          completedAt: meta.completedAt ?? Date.now(), // 重试路径不续期,保证重试窗口会收敛
          name: st.name ?? meta.name,
          score: st.score ?? null,
          verdict: st.judge_verdict ?? null,
          reportPath: st.report_path ?? null,
        })
        // 入库为独立异步管线,失败仅 warn,不影响轮询(未入库的下轮重试)
        if (ctx.kv.get(runKey(id))?.stored !== true) {
          ingestCompleted(ctx, id, ctx.kv.get(runKey(id)), st).catch(() => {})
        }
      }
      else if (status === 'failed' || status === 'stopped') {
        ctx.kv.set(runKey(id), {
          ...meta,
          status,
          completedAt: Date.now(),
          name: st.name ?? meta.name,
          error: st.error_message ?? null,
        })
        ctx.logger.warn(`诊断 ${id}(产线 ${meta.line})结束: ${status}${st.error_message ? `(${st.error_message})` : ''}`)
      }
      else if (status !== meta.status) {
        ctx.kv.set(runKey(id), { ...meta, status, name: st.name ?? meta.name })
      }
    }
    catch (err) {
      ctx.logger.warn(`轮询诊断 ${id} 失败(下轮继续): ${err?.message ?? err}`)
    }
  }
}

// ── 插件入口 ─────────────────────────────────────────────────────────────

export default {
  name: 'diag-bridge',
  version: '1.1.0',
  description: '深度诊断桥接:导出 DAQ 时序快照 CSV,发起 industrial-deep-diagnostic 深度诊断并跟踪状态,完成后报告自动入知识库。',
  auth: 'user',
  client: './client.mjs', // 前端面板(插件页注入;i18n 见 i18n.json)
  // 插件设置声明(key 编址 plugins.diag-bridge.<key>;labelKey 解析 i18n.json)
  settings: [
    { key: 'base_url', type: 'string', default: DEFAULT_BASE, labelKey: 'plugin.diag-bridge.settings.base_url', label: '诊断服务地址', description: 'industrial-deep-diagnostic 后端(http/https,host 限 127.0.0.1/localhost);保存即热生效' },
    { key: 'token', type: 'string', default: '', labelKey: 'plugin.diag-bridge.settings.token', label: '诊断 API Token', description: '诊断服务开启鉴权时(v4 起默认强制)的 API Token(Authorization: Bearer);空=匿名;保存即热生效' },
    { key: 'harness', type: 'string', default: '', labelKey: 'plugin.diag-bridge.settings.harness', label: '诊断引擎', description: 'diag_run 用的引擎 id(omp/claude/mock 等;空=取 kv/omp);无 Anthropic key 的机器请用 omp' },
    { key: 'max_turns', type: 'number', default: 0, min: 0, max: 2000, labelKey: 'plugin.diag-bridge.settings.max_turns', label: '诊断最大轮数', description: 'diagnosis/start 的 maxTurns(0=取 kv/内置默认 220)' },
    { key: 'max_minutes', type: 'number', default: 0, min: 0, max: 720, labelKey: 'plugin.diag-bridge.settings.max_minutes', label: '诊断超时(分钟)', description: 'diagnosis/start 的 timeoutMinutes(0=取 kv/内置默认 40)' },
    { key: 'auto_enabled', type: 'boolean', default: false, labelKey: 'plugin.diag-bridge.settings.auto_enabled', label: '自动诊断', description: 'daq:sample 越限命中规则时自动发起深度诊断(每产线冷却 30 分钟)' },
    { key: 'auto_rules', type: 'string', default: '', labelKey: 'plugin.diag-bridge.settings.auto_rules', label: '自动诊断规则', description: 'JSON: {"节点id":{"op":"gt|lt","value":数值}};命中即触发自动诊断(空=无规则)' },
  ],
  setup(ctx) {
    // 轮询器(15s)+ setup 重水化:恢复对 kv 中 running run 的跟踪(热重载安全)
    const sweep = () => sweepOnce(ctx).catch(err => ctx.logger.warn(`诊断轮询异常(继续): ${err?.message ?? err}`))
    ctx.timer.setInterval(sweep, 15000)
    sweep()

    // 自动诊断(默认关):daq:sample 命中规则 → 冷却 30min → 同管线发起(source:'auto')
    ctx.hooks.on('daq:sample', (s) => {
      try {
        if (!autoEnabledOf(ctx)) return
        if (!s || typeof s.value !== 'number' || !s.nodeId || !s.lineId) return
        const rule = parseAutoRules(autoRulesOf(ctx))[s.nodeId]
        if (!rule || typeof rule?.value !== 'number' || !['gt', 'lt'].includes(rule.op)) return
        const hit = rule.op === 'lt' ? s.value < rule.value : s.value > rule.value
        if (!hit) return
        const line = s.lineId
        const last = Number(ctx.kv.get(`cooldown:${line}`)) || 0
        if (Date.now() - last < AUTO_COOLDOWN_MS) return
        const now = Date.now()
        ctx.kv.set(`cooldown:${line}`, now) // 先占冷却,防同窗连发
        startDiagnosis(ctx, {
          line,
          fromMs: now - 60 * MIN,
          toMs: now,
          question: `${line} 产线该时窗数据深度根因诊断(自动触发:节点 ${s.nodeId} 采样值 ${s.value} ${rule.op === 'lt' ? '<' : '>'} ${rule.value})`,
          scene: `${line}_auto`,
          source: 'auto',
        }).then((r) => {
          if (r.ok) ctx.logger.warn(`自动诊断已发起:产线 ${line} runId=${r.runId}(节点 ${s.nodeId}=${s.value} 越限)`)
          else ctx.logger.warn(`自动诊断发起失败(产线 ${line}): ${r.error}`)
        }).catch(() => {})
      }
      catch { /* 钩子内绝不抛 */ }
    })

    // 工具 ×2
    ctx.omp.registerTool({
      name: 'diag_run',
      label: '深度诊断',
      description: '导出产线指定时窗的 DAQ 快照 CSV 并发起深度根因诊断(异步)。返回 runId 后需数分钟,请稍后用 diag_status 查询进度与结论。',
      parameters: {
        type: 'object',
        properties: {
          line: { type: 'string', description: '产线 id(必填)' },
          from_ms: { type: 'number', description: '窗口起点(epoch 毫秒;缺省 now-60min)' },
          to_ms: { type: 'number', description: '窗口终点(epoch 毫秒;缺省 now)' },
          question: { type: 'string', description: '诊断问题(缺省为该产线时窗数据深度根因诊断)' },
          scene: { type: 'string', description: '场景名(缺省 <line>_diag)' },
        },
        required: ['line'],
      },
      roles: ['lead', 'worker'],
      handler: async (args) => {
        try {
          const line = String(args.line ?? '').trim()
          if (!line) return { text: 'line 必填(产线 id)。', isError: true }
          const toMs = Number(args.to_ms) > 0 ? Number(args.to_ms) : Date.now()
          const fromMs = Number(args.from_ms) > 0 ? Number(args.from_ms) : toMs - 60 * MIN
          if (fromMs >= toMs) return { text: 'from_ms 必须小于 to_ms。', isError: true }
          const r = await startDiagnosis(ctx, {
            line, fromMs, toMs,
            question: args.question ? String(args.question) : '',
            scene: args.scene ? String(args.scene) : '',
            source: 'agent',
          })
          if (!r.ok) return { text: r.error, isError: true }
          return {
            text: `已发起深度诊断 runId=${r.runId}(产线 ${line},窗口 ${new Date(fromMs).toISOString()} ~ ${new Date(toMs).toISOString()},快照 ${r.rows} 行 × ${r.nodes} 节点 → ${r.csvPath})。诊断需数分钟,稍后用 diag_status 查询(run_id=${r.runId});完成后报告自动入知识库。`,
          }
        }
        catch (err) {
          return { text: `diag_run 异常: ${err?.message ?? err}`, isError: true }
        }
      },
    })

    ctx.omp.registerTool({
      name: 'diag_status',
      label: '诊断状态',
      description: '查询深度诊断进度:传 run_id 看单条实时状态(完成时含评分/结论/报告路径),不传看最近 5 条概要。',
      parameters: {
        type: 'object',
        properties: {
          run_id: { type: 'string', description: '诊断 runId(缺省列最近 5 条概要)' },
        },
      },
      roles: ['lead', 'worker'],
      handler: async (args) => {
        try {
          const id = String(args.run_id ?? '').trim()
          if (!id) {
            const runs = kvRuns(ctx)
              .sort((a, b) => (b.meta?.createdAt ?? 0) - (a.meta?.createdAt ?? 0))
              .slice(0, 5)
            if (!runs.length) return { text: '暂无诊断记录。用 diag_run 发起一次深度诊断。' }
            const lines = runs.map(({ id: rid, meta }) =>
              `- ${rid} | ${meta.line} | ${meta.status}${meta.stored ? '(已入库)' : ''} | ${meta.source ?? 'agent'} | ${meta.createdAt ? new Date(meta.createdAt).toISOString() : '?'} | ${meta.question ?? ''}`)
            return { text: `最近 ${runs.length} 条诊断:\n${lines.join('\n')}` }
          }
          const meta = ctx.kv.get(runKey(id))
          const base = baseOf(ctx)
          let st = null
          if (base) {
            try {
              st = (await jget(ctx, `${base}/api/diagnosis/status/${encodeURIComponent(id)}`, 8000)).data ?? null
            }
            catch { /* 3210 不可达时回退 kv 元数据 */ }
          }
          if (!st && !meta) return { text: `诊断 ${id} 不存在或诊断服务不可达。`, isError: true }
          const status = st?.engineStatus || st?.status || meta?.status || 'unknown'
          const parts = [
            `run_id=${id}`,
            `name=${st?.name ?? meta?.name ?? '?'}`,
            `产线=${meta?.line ?? st?.scene_name ?? '?'}`,
            `状态=${status}`,
            `来源=${meta?.source ?? '?'}`,
          ]
          if (meta?.fromMs && meta?.toMs) parts.push(`窗口=${new Date(meta.fromMs).toISOString()} ~ ${new Date(meta.toMs).toISOString()}`)
          if (meta?.question) parts.push(`问题=${meta.question}`)
          if (status === 'completed') {
            parts.push(`评分=${st?.score ?? meta?.score ?? '-'}`)
            parts.push(`结论=${st?.judge_verdict ?? meta?.verdict ?? '-'}`)
            parts.push(`report_path=${st?.report_path ?? meta?.reportPath ?? '-'}`)
            parts.push(`入库=${meta?.stored ? '是' : meta && st ? '否/进行中' : '?'}`)
          }
          if (status === 'failed' || status === 'stopped') parts.push(`错误=${st?.error_message ?? meta?.error ?? '-'}`)
          if (!st) parts.push('(诊断服务不可达,以上为本地记录)')
          return { text: parts.join('\n') }
        }
        catch (err) {
          return { text: `diag_status 异常: ${err?.message ?? err}`, isError: true }
        }
      },
    })

    // 路由 ×3(挂 /api/plugins/diag-bridge/*)
    ctx.route('GET', '/health', async () => {
      const runs = kvRuns(ctx)
      const byStatus = {}
      for (const { meta } of runs) byStatus[meta?.status ?? 'unknown'] = (byStatus[meta?.status ?? 'unknown'] ?? 0) + 1
      const base = baseOf(ctx)
      let remote
      if (base) {
        try {
          // /api/health 响应无 success 字段,单独取(不套 jget 断言)
          const res = await ctx.http.get(`${base}/api/health`, { timeoutMs: 5000 })
          const body = await res.json().catch(() => null)
          remote = res.ok && body
            ? { status: body.status ?? 'ok', activeRuns: body.checks?.activeRuns ?? null }
            : { status: `HTTP ${res.status}`, activeRuns: null }
        }
        catch (err) {
          remote = { status: 'unreachable', error: String(err?.message ?? err) }
        }
      }
      else {
        remote = { status: 'bad_base_url' }
      }
      return {
        plugin: ctx.name,
        base: base ?? String(ctx.kv.get('diag.base_url') || DEFAULT_BASE),
        harness: harnessOf(ctx),
        auth: diagTokenOf(ctx) ? 'bearer' : 'anonymous',
        remote,
        runs: { total: runs.length, byStatus },
      }
    })

    ctx.route('GET', '/runs', () => ({
      success: true,
      runs: kvRuns(ctx)
        .sort((a, b) => (b.meta?.createdAt ?? 0) - (a.meta?.createdAt ?? 0))
        .map(({ id, meta }) => ({ runId: id, ...meta })),
    }))

    ctx.route('POST', '/snapshot', async (event) => {
      try {
        const b = event?.awBody ?? {}
        const line = String(b.line ?? '').trim()
        if (!line) return { success: false, error: 'line 必填(产线 id)' }
        const toMs = Number(b.to_ms) > 0 ? Number(b.to_ms) : Date.now()
        const fromMs = Number(b.from_ms) > 0 ? Number(b.from_ms) : toMs - 60 * MIN
        if (fromMs >= toMs) return { success: false, error: 'from_ms 必须小于 to_ms' }
        const snap = await snapshotCore(ctx, line, fromMs, toMs)
        if (!snap.ok) return { success: false, error: snap.error }
        return { success: true, csvPath: snap.csvPath, rows: snap.rows, nodes: snap.nodes, fromMs: snap.fromMs, toMs: snap.toMs }
      }
      catch (err) {
        return { success: false, error: String(err?.message ?? err) }
      }
    })

    ctx.logger.info('diag-bridge 就绪:工具 diag_run/diag_status + 路由 health/runs/snapshot,轮询 15s 已启动')
  },
}
