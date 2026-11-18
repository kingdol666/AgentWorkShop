/**
 * WS-3:诊断完成 → RAG 文档库(aw-docs)一键入库 + 检索自查。
 *
 * 机制(计划裁定):diag-bridge **直连 rag web 层 HTTP**,跨插件不直引代码,
 * 只共享配置与契约:
 *   - web_url/base_url/token 读 `plugins.rag-bridge.*`(系统配置全局命名空间);
 *   - 文档库名读 `plugins.rag-bridge.docs_kb`(缺省 aw-docs);
 *   - 索引走 rag backend `POST /api/v1/search/index-document`(单文档向量+BM25 增量);
 *   - 自查走 web `POST /api/search/two-stage`,可见性窗口 ≤3×5s 重试。
 * 负路径:报告正文为空/取不到 → 可读失败,**不落半截文档**。
 */
import { baseOf, jget, short } from './helpers.mjs'
import { mapV1Error, normalizeResult, v1Result } from './external-v1.mjs'

const DEFAULT_RAG_WEB = 'http://127.0.0.1:6789'
const DEFAULT_RAG_BASE = 'http://127.0.0.1:8770'
const DEFAULT_DOCS_KB = 'aw-docs'

const trimSlash = s => String(s ?? '').replace(/\/+$/, '')

export function ragEndpointsOf(ctx) {
  const get = k => ctx.config?.get?.(k)
  const web = trimSlash(String(get('plugins.rag-bridge.web_url') || get('plugins.diag-bridge.deposit_rag_web') || DEFAULT_RAG_WEB))
  const base = trimSlash(String(get('plugins.rag-bridge.base_url') || get('plugins.diag-bridge.deposit_rag_base') || DEFAULT_RAG_BASE))
  const token = String(get('plugins.rag-bridge.token') || get('plugins.diag-bridge.deposit_rag_token') || '').trim()
  const kb = String(get('plugins.rag-bridge.docs_kb') || DEFAULT_DOCS_KB).trim() || DEFAULT_DOCS_KB
  return { web, base, token, kb }
}

function headersOf(token) {
  return token ? { 'authorization': `Bearer ${token}`, 'x-kb-token': token } : {}
}

/** rag 请求:返回 {ok,status,body,error}(不强制 success 断言,调用方按端点语义判断) */
async function ragReq(ctx, method, url, body, token, timeoutMs = 20000) {
  const opts = { timeoutMs, headers: headersOf(token) }
  try {
    let res
    if (method === 'GET') res = await ctx.http.get(url, opts)
    else if (method === 'PATCH') {
      if (typeof ctx.http.patch !== 'function') return { ok: false, status: 0, error: '宿主不支持 PATCH' }
      res = await ctx.http.patch(url, body ?? {}, opts)
    }
    else res = await ctx.http.post(url, body ?? {}, opts)
    const json = await res.json().catch(() => null)
    if (!res.ok) return { ok: false, status: res.status, body: json, error: `HTTP ${res.status} ${short(json)}` }
    return { ok: true, status: res.status, body: json }
  }
  catch (err) {
    return { ok: false, status: 0, error: String(err?.message ?? err) }
  }
}

/** 报告正文获取:优先 v1 内联,其次 report_md_url(JSON content),最后 legacy workspace 报告 */
async function fetchReportText(ctx, { base, contract, meta, runId, normalized }) {
  if (normalized?.reportMd) return normalized.reportMd
  // v1/legacy 通用:files.report_md_url 指向 /api/files/workspace/report/<ws>(JSON {data:{content}})
  if (normalized?.reportUrl) {
    try {
      const r = await jget(ctx, `${base}${normalized.reportUrl}`, 15000)
      const content = String(r?.data?.content ?? '')
      if (content.trim()) return content
    }
    catch { /* 落到 legacy workspace 查找 */ }
  }
  if (contract !== 'v1') {
    try {
      const ws = (await jget(ctx, `${base}/api/files/workspace`, 8000)).data ?? []
      const names = Array.isArray(ws) ? ws : []
      // 目录命名不统一:<ts>_<scene> / <ts>_<scene>_<runId>;scene 与目录可能 -/_ 混用。
      // 归一化仅保留 [a-z0-9],再按 runId → scene → reportPath 目录名 逐级匹配。
      const norm = s => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '')
      const reportDir = String(normalized?.reportPath ?? '').replace(/\\/g, '/').split('/').slice(-2, -1)[0] ?? ''
      const sceneNorm = norm(meta?.scene)
      const dirNorm = norm(reportDir)
      const hit = names.find(e => String(e?.name ?? '').includes(runId))
        ?? (sceneNorm ? names.find(e => norm(e?.name).includes(sceneNorm)) : null)
        ?? (dirNorm ? names.find(e => norm(e?.name).includes(dirNorm)) : null)
      if (hit?.name) {
        const rep = (await jget(ctx, `${base}/api/files/workspace/report/${encodeURIComponent(hit.name)}`, 15000)).data
        return String(rep?.content ?? '')
      }
    }
    catch { /* 返回空串由调用方报可读失败 */ }
  }
  return ''
}

/** 文件名净化(Windows 非法字符 → '-') */
function safeFileName(raw) {
  const unsafe = '<>:"/\\|?*'
  return Array.from(String(raw))
    .map(ch => (ch.charCodeAt(0) < 32 || unsafe.includes(ch) ? '-' : ch))
    .join('')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * 入库一条已完成的诊断到 rag 文档库,并做检索自查。
 * 返回 { ok, docPath, kbName, hits, verified, error }。
 */
export async function depositRunToRag(ctx, { runId, meta, kb, title }) {
  const base = baseOf(ctx)
  if (!base) return { ok: false, error: 'diag.base_url 非法(仅允许 http/https 且 host 为 127.0.0.1/localhost)。' }
  const contract = String(meta?.contract ?? 'legacy')

  // ① 取终态结果(两个契约分支都会赋值或提前返回)
  let normalized
  let status
  if (contract === 'v1') {
    const q = await v1Result(ctx, meta?.taskId || runId, 15000)
    if (!q.ok) return { ok: false, error: `取诊断结果失败:${mapV1Error(q, { base })}` }
    const data = q.body?.data ?? {}
    status = String(data.status ?? '')
    if (status !== 'completed') return { ok: false, error: `诊断尚未完成(status=${status || 'unknown'}),暂不能入库;先 diag_status 确认。` }
    normalized = normalizeResult(data)
  }
  else {
    try {
      const st = (await jget(ctx, `${base}/api/diagnosis/tasks/${encodeURIComponent(runId)}`, 8000)).data ?? {}
      status = String(st.status ?? '')
      if (status !== 'completed') return { ok: false, error: `诊断尚未完成(status=${status || 'unknown'}),暂不能入库;先 diag_status 确认。` }
      normalized = normalizeResult(st)
    }
    catch (err) {
      return { ok: false, error: `取诊断结果失败:${String(err?.message ?? err)}` }
    }
  }

  const reportMd = await fetchReportText(ctx, { base, contract, meta, runId, normalized })
  if (!reportMd.trim()) {
    return { ok: false, error: '报告正文为空或无法取得(既无内联 report_md,也无法通过 report URL/workspace 读取);未创建任何文档。请确认 run 状态为 completed 且报告工件存在。' }
  }

  // ② 目标库解析
  const { web, base: ragBase, token, kb: defaultKb } = ragEndpointsOf(ctx)
  const kbName = String(kb || defaultKb).trim() || DEFAULT_DOCS_KB
  const cat = await ragReq(ctx, 'GET', `${web}/api/kb/catalog`, undefined, token, 10000)
  if (!cat.ok) return { ok: false, error: `RAG 目录不可达:${cat.error}(检查 plugins.rag-bridge.web_url/token 与 rag web 服务)` }
  const kbs = Array.isArray(cat.body?.knowledgeBases) ? cat.body.knowledgeBases : []
  let hit = kbs.find(k => k?.name === kbName)
  if (!hit) {
    // 文档库按需自愈(与 rag-bridge ensureKB 同语义):建库后再解析
    const created = await ragReq(ctx, 'POST', `${web}/api/kb/create`, { name: kbName, description: 'AgentWorkShop 文档库(诊断报告/规范/协议)' }, token, 20000)
    if (!created.ok) return { ok: false, error: `目标知识库「${kbName}」不存在且创建失败:${created.error}` }
    const again = await ragReq(ctx, 'GET', `${web}/api/kb/catalog`, undefined, token, 10000)
    hit = (again.body?.knowledgeBases ?? []).find(k => k?.name === kbName)
    if (!hit?.kbId) return { ok: false, error: `知识库「${kbName}」创建后仍无法在目录中解析` }
  }
  const kbId = String(hit.kbId)
  const kbPath = String(hit.path ?? kbName).replace(/\\/g, '/')
  const kbSlug = kbPath.split('/').pop() || kbName

  // ③ 文档名(幂等键):<line|scene>_<intent>_<runId>
  const intent = String(meta?.intent ?? 'deep-diagnosis')
  const stem = safeFileName(title || `${meta?.line || 'offline'}_${intent}_${runId}`)
  const fileName = /\.[A-Za-z0-9]+$/.test(stem) ? stem : `${stem}.md`
  const description = `诊断报告自动入库:产线=${meta?.line ?? '?'},意图=${intent},run=${runId},评分=${normalized?.score ?? '-'},结论=${normalized?.verdict ?? '-'}`

  // ④ 幂等预查(服务端 create 对重名是自动改名,不是 409)
  const list = await ragReq(ctx, 'GET', `${web}/api/kb/documents?kbId=${encodeURIComponent(kbId)}`, undefined, token, 15000)
  const findSame = body => (Array.isArray(body?.documents) ? body.documents : [])
    .find(d => String(d?.name ?? '').toLowerCase() === fileName.toLowerCase())
  let docPath
  let docId
  const existing = list.ok ? findSame(list.body) : null
  if (existing?.path) {
    docPath = String(existing.path).replace(/\\/g, '/')
    docId = String(existing.id ?? '')
  }
  else {
    const created = await ragReq(ctx, 'POST', `${web}/api/kb/documents/create`, { kbId, name: fileName, content: reportMd, description }, token, 30000)
    if (!created.ok) return { ok: false, error: `文档创建失败:${created.error}` }
    docPath = String(created.body?.document?.path ?? '').replace(/\\/g, '/')
    docId = String(created.body?.document?.id ?? '')
    if (!docPath) return { ok: false, error: `创建响应缺少 document.path:${short(created.body)}` }
  }

  // ⑤ 单文档索引(向量+图谱+BM25 增量;rag backend)
  let indexState = 'ok'
  const idx = await ragReq(ctx, 'POST', `${ragBase}/api/v1/search/index-document`,
    docId ? { doc_id: docId, doc_name: fileName, description } : { kb_id: kbId, doc_path: docPath, doc_name: fileName, description, content: reportMd },
    token, 30000)
  if (!idx.ok) indexState = `failed(${idx.error})`

  // ⑥ 标签(尽力)
  const tags = ['diag', intent, String(meta?.line ?? 'offline'), runId].filter(Boolean).slice(0, 16)
  const tagRes = await ragReq(ctx, 'PATCH', `${web}/api/kb/documents/tags`, { kbId, docPath, tags }, token, 15000)

  // ⑦ 检索自查(两段检索为主;可见性窗口 ≤3×5s)
  const query = title || `${meta?.line ?? ''} ${intent} ${runId}`.trim()
  let hits = 0
  let verified = false
  let searchMode = 'two-stage'
  for (let i = 0; i < 3 && !verified; i++) {
    if (i > 0) await new Promise(resolve => ctx.timer.setTimeout(resolve, 5000))
    const ts = await ragReq(ctx, 'POST', `${web}/api/search/two-stage`, { query, kb_id: kbId, stage2_top_k: 5 }, token, 15000)
    if (ts.ok && ts.body?.success === true) {
      const results = Array.isArray(ts.body?.stage2?.results) ? ts.body.stage2.results : []
      hits = results.length
      verified = results.some(r => String(r?.doc_path ?? '').replace(/\\/g, '/') === docPath)
      continue
    }
    // 两段检索不可用 → 关键词兜底(仅元数据)
    searchMode = 'keyword-degraded'
    const kw = await ragReq(ctx, 'GET', `${web}/api/kb/search?query=${encodeURIComponent(query)}&top_k=10`, undefined, token, 10000)
    const khits = Array.isArray(kw.body?.hits) ? kw.body.hits : []
    hits = khits.length
    verified = khits.some(h => String(h?.path ?? '').replace(/\\/g, '/') === docPath)
    break
  }

  return {
    ok: true,
    docPath,
    docId,
    kbName,
    kbId,
    kbSlug,
    hits,
    verified,
    searchMode,
    indexState,
    tagsState: tagRes.ok ? 'ok' : `failed(${tagRes.error})`,
    reportChars: reportMd.length,
    score: normalized?.score ?? null,
    verdict: normalized?.verdict ?? null,
  }
}

export { DEFAULT_DOCS_KB, DEFAULT_RAG_WEB, safeFileName }
