/**
 * IDD external v1 契约层(WS-2)。
 *
 * - 契约定轨:显式 settings `contract` ∈ auto|v1|legacy;auto 时**提交前**探测
 *   `GET /capabilities` 并缓存(5min,按 base+token 指纹)——不是"失败后回退",
 *   因为 v1 /analyze 无幂等键,202 后重提交有双跑风险。
 * - 请求层:不复用 jget/jpost 的 success 断言 —— v1 202 信封无 success 字段;
 *   一律按 HTTP 状态码分支,错误码统一映射为中文可读指引(手册 §9)。
 * - 结果归一:v1 task/result → 既有内部形状(score/verdict/summary/reportPath/...),
 *   下游(回执/结果库/面板)零形状断裂。
 */
import { authHeadersOf, baseOf, diagTokenOf } from './helpers.mjs'

export const V1_PREFIX = '/api/external/v1'
export const CONTRACT_TTL_MS = 5 * 60_000

/** 契约开关(系统配置优先,kv 兜底;auto=探测) */
export function contractModeOf(ctx) {
  const v = String(ctx.config?.get?.('plugins.diag-bridge.contract') || ctx.kv.get('diag.contract') || 'auto').trim().toLowerCase()
  return ['v1', 'legacy', 'auto'].includes(v) ? v : 'auto'
}

/** 等待人工介入(run=awaiting_input)的老化上限(分钟;到期转 expired 并提示) */
export function awaitingMaxMinutesOf(ctx) {
  const n = Number(ctx.config?.get?.('plugins.diag-bridge.awaiting_max_minutes')) || Number(ctx.kv.get('diag.awaiting_max_minutes')) || 30
  return Math.min(24 * 60, Math.max(1, Math.round(n)))
}

/** 缓存指纹:base_url + token 变化必须使探测缓存失效 */
function probeKeyOf(ctx) {
  const base = baseOf(ctx) ?? ''
  const token = diagTokenOf(ctx)
  let h = 0
  for (let i = 0; i < token.length; i += 1) h = (h * 31 + token.charCodeAt(i)) | 0
  return `diag.contract_probe:${base}:${h}`
}

/**
 * v1 请求:返回 { ok, status, body } 或 { ok:false, status, body, error }。
 * 不使用 success 断言(202 无 success;部分端点成功信封只有 data/status)。
 */
export async function v1Request(ctx, method, path, body, timeoutMs = 10000) {
  const base = baseOf(ctx)
  if (!base) return { ok: false, status: 0, error: 'base_url 非法(仅允许 http/https 且 host 为 127.0.0.1/localhost)' }
  const url = `${base}${V1_PREFIX}${path}`
  const opts = { timeoutMs, headers: authHeadersOf(ctx) }
  try {
    const res = method === 'GET'
      ? await ctx.http.get(url, opts)
      : await ctx.http.post(url, body ?? {}, opts)
    const json = await res.json().catch(() => null)
    if (!res.ok) {
      return { ok: false, status: res.status, body: json, error: `HTTP ${res.status}${json?.code ? ` ${json.code}` : ''}${json?.error ? `:${json.error}` : ''}` }
    }
    return { ok: true, status: res.status, body: json }
  }
  catch (err) {
    return { ok: false, status: 0, error: String(err?.message ?? err) }
  }
}

/** capabilities(缓存 5min;force=true 强制刷新) */
export async function getCapabilities(ctx, { force = false } = {}) {
  const key = probeKeyOf(ctx)
  if (!force) {
    const cached = ctx.kv.get(key)
    if (cached) {
      try {
        const p = JSON.parse(cached)
        if (Date.now() - p.at < CONTRACT_TTL_MS && p.capabilities) return { ok: true, cached: true, data: p.capabilities }
      }
      catch { /* 缓存损坏则重探 */ }
    }
  }
  const r = await v1Request(ctx, 'GET', '/capabilities', undefined, 5000)
  if (r.ok && r.body?.success === true && r.body?.data) {
    try {
      ctx.kv.set(key, JSON.stringify({ at: Date.now(), capabilities: r.body.data }))
    }
    catch { /* kv 不可写不影响主流程 */ }
    return { ok: true, data: r.body.data }
  }
  // HTTP 200 但不是 v1 能力信封(常见于反向代理 catch-all/旧后端兜底)→ 标记 shape,
  // 由 resolveContract 按 legacy 处理(而不是把"200"误当 v1 能力)。
  const shape = Boolean(r.ok) && !(r.body?.success === true && r.body?.data)
  return { ok: false, status: r.status ?? 0, shape, error: r.error ?? (shape ? 'capabilities 响应形状不符(非 v1 信封)' : 'capabilities 不可达') }
}

/**
 * 契约定轨。返回 { contract:'v1'|'legacy', mode, cached? } 或 { contract:null, error }。
 * 铁律:401/403 与 5xx 不钉 legacy(token/服务故障时 legacy 同样不可用,静默回退会掩盖问题)。
 */
export async function resolveContract(ctx, { force = false } = {}) {
  const mode = contractModeOf(ctx)
  if (mode === 'v1' || mode === 'legacy') return { contract: mode, mode, pinned: true }
  const cap = await getCapabilities(ctx, { force })
  if (cap.ok) return { contract: 'v1', mode, cached: Boolean(cap.cached) }
  const status = Number(cap.status ?? 0)
  if (status === 404 || status === 400) return { contract: 'legacy', mode }
  if (status === 0) return { contract: 'legacy', mode } // 老后端/不可达:legacy 路径会给出更具体的网络错误
  if (cap.shape) return { contract: 'legacy', mode } // 200 非 v1 信封(代理兜底/旧后端)
  if (status === 401 || status === 403) {
    return {
      contract: null,
      mode,
      error: `IDD Token 无效或过期(HTTP ${status}):请到 系统设置→运行配置→插件 更新「诊断 API Token」(idd_ 前缀持久 Token)。契约定轨不会回退 legacy —— token 错误时两条路径都不可用。`,
    }
  }
  return { contract: null, mode, error: `capabilities 探测失败(HTTP ${status},${cap.error});服务可能暂时不可用,请稍后重试或将 contract 显式设为 v1/legacy。` }
}

/** v1 任务状态(GET /tasks/:id;/tasks 接受 task_id 或 run_id) */
export function v1Task(ctx, id, timeoutMs = 8000) {
  return v1Request(ctx, 'GET', `/tasks/${encodeURIComponent(id)}`, undefined, timeoutMs)
}

/** v1 终态结果(GET /tasks/:id/result;运行中 409 EXTERNAL_TASK_RUNNING) */
export function v1Result(ctx, id, timeoutMs = 15000) {
  return v1Request(ctx, 'GET', `/tasks/${encodeURIComponent(id)}/result`, undefined, timeoutMs)
}

/** v1 续聊(POST /chat) */
export function v1Chat(ctx, runId, message, timeoutMs = 20000) {
  return v1Request(ctx, 'POST', '/chat', { run_id: runId, message }, timeoutMs)
}

/** v1 停止(POST /analyze/:runId/stop) */
export function v1Stop(ctx, runId, timeoutMs = 15000) {
  return v1Request(ctx, 'POST', `/analyze/${encodeURIComponent(runId)}/stop`, {}, timeoutMs)
}

/** 手册 §9 错误码 → 中文可读 + 处方 */
export function mapV1Error(r, { base = '' } = {}) {
  const code = String(r?.body?.code ?? '')
  const status = Number(r?.status ?? 0)
  const raw = String(r?.body?.error ?? r?.error ?? '')
  if (/^AUTH_/.test(code) || status === 401 || status === 403) {
    return `IDD Token 无效/过期(${code || `HTTP ${status}`}):在 系统设置→运行配置→插件 更新「诊断 API Token」(idd_ 持久 Token),保存即热生效。`
  }
  if (code === 'EXTERNAL_INTENT_UNKNOWN') {
    const supported = Array.isArray(r?.body?.supported) ? r.body.supported.join('/') : 'deep-diagnosis/stability-report/quick-screen/doe-analysis/experience-mining/optimizer-campaign/improvement-advisory'
    return `未知分析意图(${raw})。支持:${supported}。`
  }
  if (code === 'HARNESS_UNKNOWN') {
    return `诊断引擎名不存在(${raw})。可用引擎以 GET /api/external/v1/capabilities 的 harnesses 为准(当前推荐 omp)。`
  }
  if (code === 'HARNESS_UNAVAILABLE') {
    return `诊断引擎不可用(${raw})。该引擎未安装或健康探测失败;换用 capabilities 中 runs_capable=true 的引擎(如 omp),或先在 IDD 侧修复引擎环境。`
  }
  if (code === 'EXTERNAL_DATA_REQUIRED') {
    return '缺少数据来源:line(平台快照)/data_path(诊断服务内文件)/export_id(daq_export 数据集)至少给一个。'
  }
  if (code === 'DATA_NOT_FOUND') return `数据路径不存在(${raw}):确认 data_path 相对 data/ 或 workspace 白名单;export 数据集请先用 daq_export 导出。`
  if (code === 'PATH_TRAVERSAL') return `数据路径越界被拒(${raw}):只允许 data/ 或 workspace 白名单内的路径。`
  if (code === 'INTENT_UNSUPPORTED_ON_HARNESS') return `该引擎不支持此分析意图(${raw});换引擎或换意图(capabilities 的 supported_intents 为准)。`
  if (code === 'PREPROCESSING_MODE_UNSUPPORTED_INTENT') return 'preprocessing_mode 仅 stability-report 支持;其它意图请去掉该参数。'
  if (code === 'ONTOLOGY_UNSUPPORTED_INTENT') return 'ontology 字段仅 deep-diagnosis/stability-report/quick-screen/doe-analysis 支持;其它意图请去掉。'
  if (code === 'RUN_NOT_IDLE') {
    return `该 run 正在运行,不能续聊(RUN_NOT_IDLE):先 diag_stop 停止,或等终态后再 diag_chat。`
  }
  if (code === 'RUN_TERMINAL') return `该 run 已结束(${raw}),无需再 stop;如需追问用 diag_chat(终态 run 可续聊)。`
  if (code === 'EXTERNAL_TASK_RUNNING') return `任务仍在运行(HTTP 409):先把任务跑到终态再取结果;进度用 diag_status 查询。`
  if (code === 'RUN_NOT_FOUND') return `run 不存在(${raw}):可能已被 IDD 清理或服务重启丢失;用 diag_status 查本地记录。`
  if (code === 'RESULT_FORBIDDEN') return '结果不属于当前 Token 属主;换创建它的账号 Token 或由 IDD 管理员操作。'
  if (status === 404) return `任务/资源不存在(HTTP 404):可能已过期(2h)或 IDD 重启丢失;重新 diag_run 或 diag_status 查本地记录。`
  if (status >= 500) return `IDD 服务端错误(HTTP ${status}):${raw || '请查看 IDD 日志'};稍后重试。`
  if (status === 0) return `诊断服务不可达${base ? `(${base})` : ''}:${raw || '检查 base_url、IDD 服务状态与网络'}。`
  return raw || `请求失败(HTTP ${status || '?'})`
}

/**
 * v1 / legacy 结果 → 内部统一形状。
 * data 可为:task entry(refreshTask)、tasks/:id/result 信封(data.result/files)、
 * legacy tasks/:id 的 data(result 内嵌)。
 */
export function normalizeResult(data) {
  const result = data?.result ?? {}
  const files = data?.files ?? result?.files ?? null
  return {
    score: result.score ?? null,
    verdict: result.verdict ?? null,
    summary: String(result.summary ?? ''),
    reportPath: files?.report_md_path ?? result.report_md_path ?? null,
    reportUrl: files?.report_md_url ?? result.report_md_url ?? null,
    reportMd: typeof result.report_md === 'string' && result.report_md.length ? result.report_md : null,
    html: Array.isArray(files?.html) ? files.html : [],
    files,
    error: result.error ?? data?.error ?? null,
    artifacts: result.artifacts ?? null,
  }
}

/** 能力预检(软拒绝):intent/harness 不在 capabilities 清单时给出可读原因 */
export function preflightCapabilities(cap, { intent, harness }) {
  if (!cap?.ok || !cap.data) return null // 探测失败不阻断提交(服务端仍会校验)
  const intents = (Array.isArray(cap.data.intents) ? cap.data.intents : []).map(i => i?.intent).filter(Boolean)
  if (intent && intents.length && !intents.includes(intent)) {
    return `未知分析意图「${intent}」。支持:${intents.join('/')}。`
  }
  const list = Array.isArray(cap.data.harnesses) ? cap.data.harnesses : []
  const hit = list.find(h => String(h?.id ?? '').toLowerCase() === String(harness ?? '').toLowerCase())
  if (!hit) {
    const ids = list.map(h => h?.id).filter(Boolean)
    return `诊断引擎「${harness}」不在 capabilities 清单。可用:${ids.join('/') || '(空)'}。`
  }
  if (hit.runs_capable === false) {
    return `诊断引擎「${harness}」不具备 runs 能力(可执行分析),提交必失败。请换用 runs_capable=true 的引擎(如 omp)。`
  }
  if (intent && Array.isArray(hit.supported_intents) && !hit.supported_intents.includes(intent)) {
    return `引擎「${harness}」不支持分析意图「${intent}」。该引擎支持:${hit.supported_intents.join('/')}。`
  }
  return null
}
