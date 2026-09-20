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

async function startDiagnosis(ctx, { line, fromMs, toMs, question, scene, source, dataPath }) {
  const base = baseOf(ctx)
  if (!base) return { ok: false, error: 'diag.base_url 非法(仅允许 http/https 且 host 为 127.0.0.1/localhost)。' }
  if (startingLines.has(line)) return { ok: false, error: `产线 ${line} 已有诊断正在启动,请稍后再试。` }
  const existing = runningOfLine(ctx, line)
  if (existing) return { ok: false, error: `产线 ${line} 已有运行中的诊断(run_id=${existing.id}),请稍后用 diag_status 查询。` }
  startingLines.add(line)
  try {
    let snap = { ok: true, csvPath: '', rows: 0, nodes: 0 }
    if (!dataPath) {
      snap = await snapshotCore(ctx, line, fromMs, toMs)
      if (!snap.ok) return { ok: false, error: snap.error }
    }
    const q = question || `${line} 产线该时窗数据深度根因诊断`
    const sceneName = scene || `${line}_diag`
    // v2.1:统一走 IDD 任务管理面 /api/diagnosis/tasks——接收即返 task_id,
    // 诊断在 IDD 后台线程执行(内部 start+execute),Channel 绝不等待。
    const started = await jpost(ctx, `${base}/api/diagnosis/tasks`, {
      dataPath: dataPath || snap.csvPath,
      sceneName,
      userQuestion: q,
      harness: harnessOf(ctx), // 缺省落 claude 引擎会因无 key 失败,必须显式(系统配置 plugins.diag-bridge.harness → kv → omp)
      enhancement: 'off',
      reportLanguage: 'zh',
      maxTurns: maxTurnsOf(ctx), // 修复循环会加转数;150 不够走完全管线
      timeoutMinutes: maxMinutesOf(ctx),
    })
    const runId = String(started.data?.task_id ?? started.data?.runId ?? '')
    const name = String(started.data?.name ?? '')
    if (!runId) return { ok: false, error: `tasks 响应缺少 data.task_id: ${short(started)}` }
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

// ── 轮询器:15s 扫描 kv 中 running 的 run → 更新状态 ──────────────────────
// v2.1:入库不再由本插件自动执行(web documents/create 旧两步管线已移除)。
// 完成后的协调契约:Channel 空闲时用 diag_status 查询 → 拿到 诊断总结+报告 md
// 路径 → 由 Agent 调用 rag-bridge 的 kb_agent(mode=async) 把报告入库知识库。

async function sweepOnce(ctx) {
  const running = kvRuns(ctx).filter(r => r.meta?.status === 'running')
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
          completedAt: meta.completedAt ?? Date.now(),
          name: st.name ?? meta.name,
          score: st.score ?? null,
          verdict: st.judge_verdict ?? null,
          reportPath: st.report_path ?? null,
        })
        ctx.logger.info(`诊断 ${id}(产线 ${meta.line})完成——待 Channel 空闲时 diag_status 查询,经 kb_agent 入库知识库`)
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
  version: '2.1.0',
  description: '深度诊断桥接 v2.1:异步任务式深度诊断(提交即返 task_id,Channel 免等待);完成后 diag_status 给出报告 md 路径,由 Agent 调 rag-bridge 的 kb_agent 入库知识库(插件协同)。',
  auth: 'user',
  client: './client.mjs', // 前端面板(插件页注入;i18n 见 i18n.json)
  // 插件配置分组(声明式):连接 / 执行 / 自动化 三个独立分区
  configGroups: [
    { id: 'default', labelKey: 'plugin.diag-bridge.group.conn', label: '诊断服务连接', description: '后端地址与鉴权 Token', order: 420 },
    { id: 'run', labelKey: 'plugin.diag-bridge.group.run', label: '诊断执行参数', description: 'diag_run 的引擎与预算', order: 430 },
    { id: 'auto', labelKey: 'plugin.diag-bridge.group.auto', label: '自动诊断', description: '越限自动发起诊断(DAQ 采样事件驱动)', order: 440, collapsed: true },
  ],
  // 插件设置声明(key 编址 plugins.diag-bridge.<key>;labelKey 解析 i18n.json)
  settings: [
    { key: 'base_url', type: 'string', default: DEFAULT_BASE, group: 'default', labelKey: 'plugin.diag-bridge.settings.base_url', label: '诊断服务地址', description: 'industrial-deep-diagnostic 后端(http/https,host 限 127.0.0.1/localhost);保存即热生效' },
    { key: 'token', type: 'string', default: '', group: 'default', labelKey: 'plugin.diag-bridge.settings.token', label: '诊断 API Token', description: '诊断服务开启鉴权时(v4 起默认强制)的 API Token(Authorization: Bearer);空=匿名;保存即热生效' },
    { key: 'harness', type: 'string', default: '', group: 'run', labelKey: 'plugin.diag-bridge.settings.harness', label: '诊断引擎', description: 'diag_run 用的引擎 id(omp/claude/mock 等;空=取 kv/omp);无 Anthropic key 的机器请用 omp' },
    { key: 'max_turns', type: 'number', default: 0, min: 0, max: 2000, group: 'run', labelKey: 'plugin.diag-bridge.settings.max_turns', label: '诊断最大轮数', description: 'diagnosis/start 的 maxTurns(0=取 kv/内置默认 220)' },
    { key: 'max_minutes', type: 'number', default: 0, min: 0, max: 720, group: 'run', labelKey: 'plugin.diag-bridge.settings.max_minutes', label: '诊断超时(分钟)', description: 'diagnosis/start 的 timeoutMinutes(0=取 kv/内置默认 40)' },
    { key: 'auto_enabled', type: 'boolean', default: false, group: 'auto', labelKey: 'plugin.diag-bridge.settings.auto_enabled', label: '自动诊断', description: 'daq:sample 越限命中规则时自动发起深度诊断(每产线冷却 30 分钟)' },
  ],
  setup(ctx) {
    // 运行时追加分区与字段(ctx.config.defineGroup / defineField):
    // 字段 key 与声明式完全等价(plugins.diag-bridge.auto_rules),已保存的值不丢;
    // 这里演示「插件在 setup 里按条件调用平台 API 扩展自己的配置面」。
    ctx.config.defineGroup({
      id: 'rules',
      labelKey: 'plugin.diag-bridge.group.rules',
      label: '自动诊断规则',
      description: 'JSON 规则;命中即触发自动诊断(仅 auto_enabled=true 时生效)',
      order: 450,
    })
    ctx.config.defineField({
      key: 'auto_rules',
      type: 'string',
      default: '',
      group: 'rules',
      labelKey: 'plugin.diag-bridge.settings.auto_rules',
      label: '自动诊断规则',
      description: 'JSON: {"节点id":{"op":"gt|lt","value":数值}};命中即触发自动诊断(空=无规则)',
    })
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
      description: '导出产线指定时窗的 DAQ 快照 CSV 并发起深度根因诊断(异步任务,提交即返 task_id,无需等待)。Channel 可继续其他任务,空闲时用 diag_status 查询;完成后按其给出的指引调 kb_agent 入库知识库。',
      parameters: {
        type: 'object',
        properties: {
          line: { type: 'string', description: '产线 id(与 data_path 二选一)' },
          data_path: { type: 'string', description: '可选:直接指定诊断数据 CSV 绝对路径(跳过 DAQ 快照导出,适合离线数据分析);给了 data_path 则 line 可填 any' },
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
          const dataPathDirect = String(args.data_path ?? '').trim()
          if (!line && !dataPathDirect) return { text: 'line 与 data_path 至少给一个(产线 id 或诊断数据 CSV 绝对路径)。', isError: true }
          const toMs = Number(args.to_ms) > 0 ? Number(args.to_ms) : Date.now()
          const fromMs = Number(args.from_ms) > 0 ? Number(args.from_ms) : toMs - 60 * MIN
          if (fromMs >= toMs) return { text: 'from_ms 必须小于 to_ms。', isError: true }
          const r = await startDiagnosis(ctx, {
            line: line || 'offline-data',
            fromMs, toMs,
            question: args.question ? String(args.question) : '',
            scene: args.scene ? String(args.scene) : '',
            source: 'agent',
            dataPath: dataPathDirect || '',
          })
          if (!r.ok) return { text: r.error, isError: true }
          const via = dataPathDirect ? `离线数据 ${r.csvPath}` : `产线 ${line} 窗口 ${new Date(fromMs).toISOString()} ~ ${new Date(toMs).toISOString()} 快照 ${r.rows} 行 × ${r.nodes} 节点`
          return {
            text: `已发起深度诊断异步任务 task_id=${r.runId}(${via})。知识库 IDD 在后台执行,Channel 无需等待——可继续其他任务,空闲时用 diag_status(run_id=${r.runId}) 查询;完成后按 diag_status 给出的指引调用 kb_agent 把报告 md 入库知识库。`,
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
              // v2.1:走任务管理面 /tasks/:id——result.report_md_path 是绝对路径,
              // 可直接交给 kb_agent 读取入库(旧 /status 的相对路径会让 kb_agent 找不到文件)
              st = (await jget(ctx, `${base}/api/diagnosis/tasks/${encodeURIComponent(id)}`, 8000)).data ?? null
              if (st && st.result) {
                st = {
                  ...st,
                  engineStatus: st.status,
                  score: st.result.score ?? null,
                  judge_verdict: st.result.verdict ?? null,
                  report_path: st.result.report_md_path ?? st.report_path ?? null,
                  error_message: st.result.error ?? st.error_message ?? null,
                }
              }
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
            const reportPath = st?.report_path ?? meta?.reportPath ?? '-'
            parts.push(`评分=${st?.score ?? meta?.score ?? '-'}`)
            parts.push(`结论=${st?.judge_verdict ?? meta?.verdict ?? '-'}`)
            parts.push(`report_md_path=${reportPath}`)
            parts.push('')
            parts.push('✅ 诊断完成,报告已就绪。入库知识库请调用 rag-bridge 的 kb_agent 工具:')
            parts.push(`  mode=async, prompt=「请把这份深度诊断报告入库到 aw-industrial 知识库:读取文件 ${reportPath} 的全文内容并入库(写盘+索引),完成后报告 doc_path 与分块数。标签:诊断、深度诊断。」`)
            parts.push('提交后频道无需等待,空闲时用 kb_agent_status(task_id) 查询入库结果。')
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
      let tokenState = { configured: Boolean(diagTokenOf(ctx)), accepted: null }
      if (base) {
        try {
          // 连通性:/api/health 是公开端点(无鉴权),只回答「服务在不在」。
          const res = await ctx.http.get(`${base}/api/health`, { timeoutMs: 5000 })
          const body = await res.json().catch(() => null)
          remote = res.ok && body
            ? { status: body.status ?? 'ok', activeRuns: body.checks?.activeRuns ?? null }
            : { status: `HTTP ${res.status}`, activeRuns: null }
          // Token 有效性:/api/health 不校验鉴权,必须另打一个受保护端点,
          // 否则 token 配错时健康面依旧 ok —— 配置错误完全不可见(实测踩过)。
          if (tokenState.configured) {
            try {
              const auth = await ctx.http.get(`${base}/api/files/workspace`, {
                timeoutMs: 5000,
                headers: authHeadersOf(ctx),
              })
              if (auth.status === 401 || auth.status === 403) {
                tokenState = { configured: true, accepted: false, hint: authHint(auth.status, 'Token 被上游拒绝') }
                remote = { ...remote, auth: `HTTP ${auth.status}(鉴权被拒)`, hint: tokenState.hint }
              }
              else if (auth.ok) {
                tokenState = { configured: true, accepted: true }
                remote = { ...remote, auth: 'ok' }
              }
              else {
                remote = { ...remote, auth: `HTTP ${auth.status}` }
              }
            }
            catch (err) {
              remote = { ...remote, auth: 'unreachable', authError: String(err?.message ?? err) }
            }
          }
          else {
            tokenState = { configured: false, accepted: null }
          }
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
        /** Token 配置态 + 实测是否被上游接受(401/403 → false;网络不通 → null) */
        token: tokenState,
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
