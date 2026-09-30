/**
 * MES 集成(REST API 映射)写驱动:用声明式 readMap/writeMap/historyMap 把任意
 * MES REST 端点映射成 DCW 的 读/写/历史 三个原语(映射为 text 表单的 JSON 字符串)。
 *
 * 设计边界:
 *   - 坏映射在配置期拒绝(safeParse + 形状校验),不进请求链路。
 *   - 凭据零明文:secretRef 只存引用名,token 从 env AW_MES_<REF>_TOKEN 或
 *     运行时设置 mes.secret.<ref> 解析;401 文案直接指向该链路。
 *   - SSRF 防护:baseUrl 强制 http/https;DNS 解析后任一 IP 落私有/环回段且未
 *     显式 allowPrivateHost='true' 一律拒绝(生产 MES 在内网属预期,白名单须显式)。
 *   - 限速:同驱动实例令牌桶(默认 5 req/s),防把 MES 打挂。
 */
import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import { AppError } from '../../../../utils/errors'
import type { DcwFetchHistoryInput, DcwFetchHistoryResult, DcwHistoryRow, DcwReadInput, DcwReadResult, DcwWriteDriver, DcwWriteInput, DcwWriteResult } from './shared'
import { num, readbackAck } from './shared'

// ============================================================
// 映射配置形状(safeParse 目标)
// ============================================================

interface MesReadMap {
  method: string
  path: string
  query: Record<string, string>
  headers: Record<string, string>
  response: { valuePath: string, tsPath?: string, tsFormat?: 'epoch_s' | 'epoch_ms' | 'iso' }
}

interface MesWriteMap {
  method: string
  path: string
  query: Record<string, string>
  headers: Record<string, string>
  /** {{value}} 为治理后工程值的插值模板(缺省 {"value":"{{value}}"});字符串/对象均可 */
  bodyTemplate?: unknown
  /** 受理状态码(缺省 [200,201]) */
  successOn: number[]
  response?: { ackPath?: string }
}

interface MesHistoryMap {
  method: string
  path: string
  query: Record<string, string>
  headers: Record<string, string>
  response: { rowsPath: string, valuePath: string, tsPath: string, nextCursorPath?: string }
  pageSize?: number
  maxPages: number
}

// ============================================================
// 映射解析(text 字段 JSON 字符串 → 结构;坏映射配置期拒绝)
// ============================================================

function parseJsonField(cfg: Record<string, unknown>, key: string): unknown {
  const raw = cfg[key]
  if (raw === null || raw === undefined || String(raw).trim() === '') return undefined
  try {
    return JSON.parse(String(raw)) as unknown
  }
  catch (err) {
    throw new AppError(400, 'BAD_REQUEST', `${key} 不是合法 JSON:${err instanceof Error ? err.message : String(err)}`)
  }
}

function asRecord(v: unknown, what: string): Record<string, unknown> {
  if (v === null || v === undefined || typeof v !== 'object' || Array.isArray(v)) {
    throw new AppError(400, 'BAD_REQUEST', `${what} 应为 JSON 对象`)
  }
  return v as Record<string, unknown>
}

function stringRecord(v: unknown, what: string): Record<string, string> {
  if (v === null || v === undefined) return {}
  const rec = asRecord(v, what)
  return Object.fromEntries(Object.entries(rec).map(([k, x]): [string, string] => [k, String(x)]))
}

function reqString(rec: Record<string, unknown>, key: string, what: string): string {
  const v = rec[key]
  if (typeof v !== 'string' || v.trim() === '') throw new AppError(400, 'BAD_REQUEST', `${what} 缺少必填字符串字段 ${key}`)
  return v
}

const optString = (v: unknown): string | undefined => (v === null || v === undefined ? undefined : String(v))

function parseReadMap(cfg: Record<string, unknown>): MesReadMap | null {
  const v = parseJsonField(cfg, 'readMap')
  if (v === undefined) return null
  const rec = asRecord(v, 'readMap')
  const resp = asRecord(rec.response, 'readMap.response')
  const fmt = optString(resp.tsFormat)
  if (fmt !== undefined && fmt !== 'epoch_s' && fmt !== 'epoch_ms' && fmt !== 'iso') {
    throw new AppError(400, 'BAD_REQUEST', `readMap.response.tsFormat 仅支持 epoch_s/epoch_ms/iso(当前 ${fmt})`)
  }
  return {
    method: optString(rec.method) ?? 'GET',
    path: reqString(rec, 'path', 'readMap'),
    query: stringRecord(rec.query, 'readMap.query'),
    headers: stringRecord(rec.headers, 'readMap.headers'),
    response: { valuePath: reqString(resp, 'valuePath', 'readMap.response'), tsPath: optString(resp.tsPath), tsFormat: fmt },
  }
}

function parseWriteMap(cfg: Record<string, unknown>): MesWriteMap | null {
  const v = parseJsonField(cfg, 'writeMap')
  if (v === undefined) return null
  const rec = asRecord(v, 'writeMap')
  const successOnRaw = rec.successOn === undefined ? [200, 201] : rec.successOn
  if (!Array.isArray(successOnRaw)) throw new AppError(400, 'BAD_REQUEST', 'writeMap.successOn 应为状态码数组(如 [200,201])')
  const successOn = successOnRaw.map(Number).filter(n => Number.isFinite(n))
  if (successOn.length === 0) throw new AppError(400, 'BAD_REQUEST', 'writeMap.successOn 未包含任何有效状态码')
  const response = rec.response === undefined ? undefined : asRecord(rec.response, 'writeMap.response')
  return {
    method: optString(rec.method) ?? 'POST',
    path: reqString(rec, 'path', 'writeMap'),
    query: stringRecord(rec.query, 'writeMap.query'),
    headers: stringRecord(rec.headers, 'writeMap.headers'),
    bodyTemplate: rec.bodyTemplate,
    successOn,
    response: response ? { ackPath: optString(response.ackPath) } : undefined,
  }
}

function parseHistoryMap(cfg: Record<string, unknown>): MesHistoryMap | null {
  const v = parseJsonField(cfg, 'historyMap')
  if (v === undefined) return null
  const rec = asRecord(v, 'historyMap')
  const resp = asRecord(rec.response, 'historyMap.response')
  const pageSize = rec.pageSize === undefined ? undefined : Number(rec.pageSize)
  const maxPages = rec.maxPages === undefined ? 40 : Number(rec.maxPages)
  return {
    method: optString(rec.method) ?? 'GET',
    path: reqString(rec, 'path', 'historyMap'),
    query: stringRecord(rec.query, 'historyMap.query'),
    headers: stringRecord(rec.headers, 'historyMap.headers'),
    response: {
      rowsPath: reqString(resp, 'rowsPath', 'historyMap.response'),
      valuePath: reqString(resp, 'valuePath', 'historyMap.response'),
      tsPath: reqString(resp, 'tsPath', 'historyMap.response'),
      nextCursorPath: optString(resp.nextCursorPath),
    },
    pageSize: pageSize !== undefined && Number.isFinite(pageSize) && pageSize > 0 ? pageSize : undefined,
    maxPages: Number.isFinite(maxPages) && maxPages > 0 ? maxPages : 40,
  }
}

// ============================================================
// SSRF 防护:协议白名单 + DNS 解析后私网/环回段判定
// ============================================================

/** 私有/环回段:IPv4 127/8 · 10/8 · 172.16/12 · 192.168/16 · 169.254/16;IPv6 ::1 · :: · fc00::/7 · fe80::/10 */
function isPrivateIp(ip: string): boolean {
  const v4 = ip.toLowerCase().startsWith('::ffff:') ? ip.slice(7) : ip // IPv4-mapped IPv6 按 IPv4 判
  if (isIP(v4) === 4) {
    const seg = v4.split('.').map(Number)
    const a = seg[0]!
    const b = seg[1]!
    return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254)
  }
  const h16 = Number.parseInt(v4.split(':')[0] ?? '', 16)
  if (!Number.isFinite(h16)) return true // 解析不了按保守拒绝
  return h16 === 0x0001 || h16 === 0 || (h16 & 0xfe00) === 0xfc00 || (h16 & 0xffc0) === 0xfe80
}

/** 主机名 → IP 列表(字面 IP 直判不经 DNS;域名全量解析,任一内网地址即整批拒绝) */
async function resolveTargetIps(hostname: string): Promise<string[]> {
  if (isIP(hostname)) return [hostname]
  try {
    const recs = await lookup(hostname, { all: true, verbatim: true })
    return recs.map(r => r.address)
  }
  catch (err) {
    throw new AppError(400, 'BAD_REQUEST', `MES 主机 DNS 解析失败:${hostname}(${err instanceof Error ? err.message : String(err)})`)
  }
}

/** 校验 baseUrl 并返回归一 origin;未显式开白名单时解析目标并拒绝内网/环回地址 */
async function assertPublicOrigin(cfg: Record<string, unknown>): Promise<string> {
  const raw = cfg.baseUrl
  if (raw === null || raw === undefined || String(raw).trim() === '') {
    throw new AppError(400, 'BAD_REQUEST', '缺少 MES 服务地址 baseUrl')
  }
  let u: URL
  try {
    u = new URL(String(raw))
  }
  catch {
    throw new AppError(400, 'BAD_REQUEST', `baseUrl 不是合法 URL:${String(raw)}`)
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new AppError(400, 'BAD_REQUEST', `baseUrl 仅支持 http/https 协议(当前 ${u.protocol});请改填 http:// 或 https:// 的 MES 地址`)
  }
  if (String(cfg.allowPrivateHost ?? 'false') !== 'true') {
    const ips = await resolveTargetIps(u.hostname)
    const privateHits = [...new Set(ips.filter(a => isPrivateIp(a)))]
    if (privateHits.length > 0) {
      throw new AppError(400, 'BAD_REQUEST', `目标 ${u.hostname} 解析到内网/环回地址(${privateHits.join(', ')}),已按 SSRF 防护拒绝;生产 MES 通常在内网——确认安全后把驱动配置 allowPrivateHost 显式设为 'true' 开启白名单`)
    }
  }
  return u.origin
}

// ============================================================
// 凭据解析(零明文:配置只存引用名,token 运行时解析)
// ============================================================

/** secretRef → env 键:大写、非字母数字折叠为下划线(如 line1.mes → AW_MES_LINE1_MES_TOKEN) */
function secretEnvKey(ref: string): string {
  return `AW_MES_${ref.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_TOKEN`
}

async function resolveMesSecret(ref: unknown): Promise<string | null> {
  const name = String(ref ?? '').trim()
  if (name === '') return null
  const fromEnv = process.env[secretEnvKey(name)]
  if (fromEnv) return fromEnv
  // TODO(运行时设置):mes.secret.<ref> 为自由键,尚未注册进 shared/config/schema.json
  // 描述符,loadEffective 只回传已注册键 → settingOf 通常 undefined;此处仍按链路试探,
  // 待自由键/专用凭据仓落地即成完整实现。设置服务不可用(单测/极早期)静默回落 env。
  try {
    const { settingOf } = await import('../../settings')
    const v = settingOf(`mes.secret.${name}`)
    if (typeof v === 'string' && v !== '') return v
  }
  catch { /* 设置服务不可用 → env-only */ }
  return null
}

function applyAuth(headers: Record<string, string>, cfg: Record<string, unknown>, token: string | null): void {
  const authType = String(cfg.authType ?? 'bearer')
  if (token === null || authType === 'none') return // 无凭据/明示不认证 → 裸请求
  if (authType === 'header') headers[String(cfg.authHeaderName ?? '') || 'X-Api-Token'] = token
  else headers.authorization = `Bearer ${token}`
}

/** 头值插值:{{SECRET:REF}} → 凭据解析(env/runtime-settings);含未解析占位符 → null(整头省略,避免明文外泄) */
async function interpolateHeaderValue(value: string): Promise<string | null> {
  const placeholder = /\{\{SECRET:([^}]+)\}\}/g
  if (!placeholder.test(value)) return value
  placeholder.lastIndex = 0
  let out = ''
  let last = 0
  for (const m of value.matchAll(placeholder)) {
    out += value.slice(last, m.index)
    const secret = await resolveMesSecret(m[1])
    if (secret === null || secret === undefined || secret === '') return null
    out += secret
    last = m.index + m[0].length
  }
  out += value.slice(last)
  return out
}

/** 节点级默认请求头(cfg.headers JSON)——随所有请求携带;映射级 headers 与认证头可覆盖 */
async function applyDefaultHeaders(headers: Record<string, string>, cfg: Record<string, unknown>): Promise<void> {
  const raw = String(cfg.headers ?? '').trim()
  if (!raw) return
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  }
  catch {
    return
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof v !== 'string' || !k.trim()) continue
    const interpolated = await interpolateHeaderValue(v)
    if (interpolated !== null) headers[k.trim()] = interpolated
  }
}

// ============================================================
// 令牌桶限速(同驱动实例;默认 5 req/s,桶容 = 速率 的短突发)
// ============================================================

class TokenBucket {
  private tokens: number
  private last: number

  constructor(private readonly ratePerSec = 5) {
    this.tokens = ratePerSec
    this.last = Date.now()
  }

  async take(): Promise<void> {
    for (;;) {
      const now = Date.now()
      this.tokens = Math.min(this.ratePerSec, this.tokens + ((now - this.last) / 1000) * this.ratePerSec)
      this.last = now
      if (this.tokens >= 1) {
        this.tokens -= 1
        return
      }
      await new Promise(r => setTimeout(r, Math.ceil(((1 - this.tokens) / this.ratePerSec) * 1000)))
    }
  }
}

const limiter = new TokenBucket(5)

// ============================================================
// 请求核心(fetch + 超时 + 限速 + 认证注入)与 HTTP 状态分类
// ============================================================

interface MesReply {
  status: number
  /** JSON 响应体(非 JSON 响应为 null,状态码判定兜底) */
  json: unknown
}

async function mesRequest(
  cfg: Record<string, unknown>,
  req: { method?: string, path: string, query?: Record<string, string>, headers?: Record<string, string>, body?: unknown },
): Promise<MesReply> {
  const origin = await assertPublicOrigin(cfg)
  await limiter.take()
  const path = req.path.startsWith('/') ? req.path : `/${req.path}`
  const url = new URL(origin + path)
  for (const [k, v] of Object.entries(req.query ?? {})) url.searchParams.set(k, v)
  const headers: Record<string, string> = { accept: 'application/json' }
  await applyDefaultHeaders(headers, cfg)
  for (const [k, v] of Object.entries(req.headers ?? {})) {
    const interpolated = await interpolateHeaderValue(v, cfg)
    if (interpolated !== null) headers[k] = interpolated
  }
  if (req.body !== undefined) headers['content-type'] = 'application/json'
  applyAuth(headers, cfg, await resolveMesSecret(cfg.secretRef))
  const res = await fetch(url, {
    method: (req.method ?? 'GET').toUpperCase(),
    headers,
    body: req.body === undefined ? undefined : JSON.stringify(req.body),
    // 表单值是字符串,num 归一;缺省 10s
    signal: AbortSignal.timeout(num(cfg.requestTimeoutMs) ?? 10_000),
  })
  let json: unknown = null
  try {
    json = await res.json() as unknown
  }
  catch { /* 非 JSON 响应忽略,由状态码判定 */ }
  return { status: res.status, json }
}

/** HTTP 状态 → 分类错误文案(401 指向凭据链路;429/5xx 各自语义) */
function classifyHttpFail(status: number): string {
  if (status === 401 || status === 403) return `MES 鉴权失败(HTTP ${status}):凭据失效,请检查 secretRef 对应的 token(env AW_MES_<REF>_TOKEN 或运行时设置 mes.secret.<ref>)`
  if (status === 404) return `MES 接口不存在(HTTP 404):请检查映射 path 与 {name} 占位符取值`
  if (status === 429) return `MES 限流(HTTP 429):请求过于频繁,请调低节点读写节拍或提升 MES 侧配额`
  if (status >= 500) return `MES 服务端错误(HTTP ${status}):MES 侧异常,可稍后重试并优先排查 MES 服务日志`
  return `MES 返回 HTTP ${status},未按成功语义受理`
}

// ============================================================
// 模板渲染:{name} 路径占位符 + {{value}} 深度插值
// ============================================================

/**
 * path 模板:{name} 从 query 同名键取值(URL 编码)替换,该键随即从 querystring
 * 移除(避免同名参数重复出现在查询串);无同名键的占位符原样保留。
 */
function applyPathTemplate(path: string, query: Record<string, string>): { path: string, query: Record<string, string> } {
  const consumed = new Set<string>()
  const resolved = path.replace(/\{(\w+)\}/g, (m0, key: string) => {
    const v = query[key]
    if (v === undefined) return m0
    consumed.add(key)
    return encodeURIComponent(v)
  })
  const rest: Record<string, string> = {}
  for (const [k, v] of Object.entries(query)) if (!consumed.has(k)) rest[k] = v
  return { path: resolved, query: rest }
}

/** bodyTemplate 深度渲染:{{value}} → 治理后工程值(整串恰为占位符时保持 number 类型) */
function renderBodyTemplate(tpl: unknown, eng: number): unknown {
  if (typeof tpl === 'string') {
    if (tpl.trim() === '{{value}}') return eng
    return tpl.replace(/\{\{\s*value\s*\}\}/g, String(eng))
  }
  if (Array.isArray(tpl)) return tpl.map(x => renderBodyTemplate(x, eng))
  if (tpl !== null && typeof tpl === 'object') {
    return Object.fromEntries(Object.entries(tpl as Record<string, unknown>).map(([k, x]) => [k, renderBodyTemplate(x, eng)]))
  }
  return tpl
}

// ============================================================
// 响应提取:dotted-path + [*] 数组段 + 时间戳归一
// ============================================================

const pickKey = (base: unknown, key: string): unknown =>
  base !== null && typeof base === 'object' ? (base as Record<string, unknown>)[key] : undefined

/**
 * dotted-path 取值:'data.value';数组段写作 'data.rows[*]'(historyMap.rowsPath 用),
 * [*] 把该层展平逐元素继续下沉 —— 以 [*] 结尾时返回数组,其余返回单值。
 */
function extract(root: unknown, dotted: string): unknown {
  let level: unknown[] = [root]
  let expanded = false
  for (const segRaw of dotted.split('.')) {
    const seg = segRaw.trim()
    if (seg === '') continue
    const star = seg.match(/^(.*)\[\*\]$/)
    const next: unknown[] = []
    for (const base of level) {
      if (star) {
        expanded = true
        const arr = star[1] !== '' ? pickKey(base, star[1]!) : base
        if (Array.isArray(arr)) next.push(...arr)
      }
      else {
        next.push(pickKey(base, seg))
      }
    }
    level = next
  }
  return expanded ? level : level[0]
}

/** 数值归一(数值/数值字符串 → 有限数,其余 undefined) */
function toFinite(v: unknown): number | undefined {
  if (v === null || v === undefined || v === '') return undefined
  const n = Number(v)
  return Number.isFinite(n) ? n : undefined
}

/**
 * 时间戳 → ISO。tsFormat 显式 epoch_s/epoch_ms 按指定换算;缺省自动:
 * 字符串先试 ISO 解析,纯数字按量级判秒/毫秒(≥1e12 视为 ms;1e12 ms ≈ 2001-09)。
 */
function tsToIso(raw: unknown, fmt?: 'epoch_s' | 'epoch_ms' | 'iso'): string | null {
  if (raw === null || raw === undefined || raw === '') return null
  if (fmt === 'epoch_s' || fmt === 'epoch_ms') {
    const n = Number(raw)
    return Number.isFinite(n) ? new Date(fmt === 'epoch_s' ? n * 1000 : n).toISOString() : null
  }
  if (typeof raw === 'string') {
    const t = Date.parse(raw)
    if (Number.isFinite(t)) return new Date(t).toISOString()
  }
  const n = Number(raw)
  if (Number.isFinite(n) && n > 0) return new Date(n >= 1e12 ? n : n * 1000).toISOString()
  return String(raw)
}

/** readMap 一次取数:valuePath 数值 + tsPath 归一 ISO(HTTP 非 2xx 抛分类错误) */
async function readOnce(cfg: Record<string, unknown>, map: MesReadMap): Promise<{ value: number | null, tsIso: string | null }> {
  const { path, query } = applyPathTemplate(map.path, map.query)
  const { status, json } = await mesRequest(cfg, { method: map.method, path, query, headers: map.headers })
  if (status < 200 || status >= 300) throw new AppError(502, 'MES_HTTP_ERROR', classifyHttpFail(status))
  const value = toFinite(extract(json, map.response.valuePath))
  const tsIso = map.response.tsPath ? tsToIso(extract(json, map.response.tsPath), map.response.tsFormat) : null
  return { value: value === undefined ? null : value, tsIso }
}

// ============================================================
// 驱动本体
// ============================================================

export const mesRestDcwDriver: DcwWriteDriver = {
  kind: 'mes-rest',
  async available() {
    return true // Node 18+ 全局 fetch
  },

  async write(input: DcwWriteInput): Promise<DcwWriteResult> {
    try {
      const cfg = input.driverConfig
      const map = parseWriteMap(cfg)
      if (!map) throw new AppError(400, 'BAD_REQUEST', '未配置 writeMap(写映射),无法写入 MES')
      const { path, query } = applyPathTemplate(map.path, map.query)
      const body = renderBodyTemplate(map.bodyTemplate ?? { value: '{{value}}' }, input.eng)
      const { status, json } = await mesRequest(cfg, { method: map.method, path, query, headers: map.headers, body })
      if (!map.successOn.includes(status)) {
        return { ok: false, message: classifyHttpFail(status), raw: null, readback: null }
      }
      // ackPath:MES 业务受理语义(如 {ack:true});配置了就必须真值才算受理
      const ackPath = map.response?.ackPath
      if (ackPath && !extract(json, ackPath)) {
        return { ok: false, message: `MES 返回 HTTP ${status},但 ack(${ackPath})为假值,视为未受理`, raw: null, readback: null }
      }
      const readMap = parseReadMap(cfg)
      if (readMap) {
        // 有回读映射:再读一次,|回读-设定| ≤ 容差 才 ACK(readback 填实值)
        try {
          const back = await readOnce(cfg, readMap)
          return readbackAck(input, back.value, { raw: input.eng })
        }
        catch (backErr) {
          const why = backErr instanceof Error ? backErr.message : String(backErr)
          return { ok: false, message: `MES 已受理写入(HTTP ${status}),但回读失败,无法确认:${why}`, raw: input.eng, readback: null }
        }
      }
      return {
        ok: true,
        message: `MES 写入受理(HTTP ${status}${ackPath ? ',ack 已确认' : ''});无回读映射,以 MES ack 为准`,
        raw: input.eng,
        readback: null,
      }
    }
    catch (err) {
      // 配置类错误(坏映射/协议/内网)原样上抛,网关会收敛为写失败;运行时错误收敛为 ok=false
      if (err instanceof AppError) throw err
      return { ok: false, message: `MES 写入失败:${err instanceof Error ? err.message : String(err)}`, raw: null, readback: null }
    }
  },

  async read(input: DcwReadInput): Promise<DcwReadResult> {
    try {
      const cfg = input.driverConfig
      const map = parseReadMap(cfg)
      if (!map) return { ok: false, message: '未配置 readMap(当前值映射),无法读取', eng: null, raw: null }
      const { value, tsIso } = await readOnce(cfg, map)
      if (value === null) return { ok: false, message: `MES 响应中 valuePath(${map.response.valuePath})未提取到数值`, eng: null, raw: null }
      return { ok: true, message: `MES 读数 ${Number(value.toFixed(4))},ts=${tsIso ?? '未提供'}`, eng: value, raw: value }
    }
    catch (err) {
      // 读是调度周期原语:一切失败(含配置错)收敛为 ok=false,不打断网关节拍
      return { ok: false, message: err instanceof Error ? err.message : String(err), eng: null, raw: null }
    }
  },

  async fetchHistory(input: DcwFetchHistoryInput): Promise<DcwFetchHistoryResult> {
    const cfg = input.driverConfig
    const map = parseHistoryMap(cfg)
    if (!map) throw new AppError(400, 'BAD_REQUEST', '未配置 historyMap(历史映射),无法拉取 MES 历史')
    let cursor: string | null = null
    let rows = 0
    let pages = 0
    let complete = false
    // 声明式分页:终止 = nextCursor 缺失/空(取完)或 rows>=maxRows 或 pages>maxPages
    while (rows < input.maxRows && pages < map.maxPages) {
      const query: Record<string, string> = { ...map.query, from: input.fromIso, to: input.toIso }
      if (map.pageSize !== undefined && query.pageSize === undefined) query.pageSize = String(map.pageSize)
      if (cursor !== null) query.cursor = cursor
      const { path, query: qs } = applyPathTemplate(map.path, query)
      const { status, json } = await mesRequest(cfg, { method: map.method, path, query: qs, headers: map.headers })
      if (status < 200 || status >= 300) throw new AppError(502, 'MES_HTTP_ERROR', classifyHttpFail(status))
      const rawRows = extract(json, map.response.rowsPath)
      if (!Array.isArray(rawRows)) throw new AppError(502, 'MES_HTTP_ERROR', `historyMap.response.rowsPath(${map.response.rowsPath})未提取到数组`)
      const batch: DcwHistoryRow[] = []
      for (const row of rawRows) {
        if (rows + batch.length >= input.maxRows) break
        const value = toFinite(extract(row, map.response.valuePath))
        const ts = tsToIso(extract(row, map.response.tsPath))
        if (value !== undefined && ts !== null) batch.push({ ts, value })
      }
      if (batch.length > 0) await input.onRows(batch)
      rows += batch.length
      pages += 1
      const next = map.response.nextCursorPath ? extract(json, map.response.nextCursorPath) : undefined
      const nextStr = next === null || next === undefined || next === '' ? null : String(next)
      if (nextStr === null) {
        complete = true // nextCursor 缺失/空 = 数据自然耗尽
        break
      }
      cursor = nextStr
    }
    return { rows, complete }
  },

  async test(driverConfig: Record<string, unknown>): Promise<{ ok: boolean, message: string }> {
    try {
      const cfg = driverConfig
      const readMap = parseReadMap(cfg)
      parseWriteMap(cfg)
      parseHistoryMap(cfg) // 已配置的映射全部过一遍形状校验(可选映射缺省跳过)
      if (readMap) {
        const t0 = Date.now()
        const { value } = await readOnce(cfg, readMap)
        const ms = Date.now() - t0
        if (value === null) return { ok: false, message: `试读失败:readMap.response.valuePath(${readMap.response.valuePath})未提取到数值` }
        return { ok: true, message: `试读 ${Number(value.toFixed(4))} (${ms}ms)` }
      }
      return { ok: true, message: '配置校验通过(未配置 readMap,跳过试读)' }
    }
    catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) }
    }
  },
}
