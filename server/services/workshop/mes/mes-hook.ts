/**
 * MES 数据下沉 Hook 运行时 —— 用户在节点驱动配置里自写代码,处理拉取到的 MES 数据。
 *
 * 语义(agent 只传 param,其余交给配置):
 *   requestHook(param, ctx) => { path?, query?, headers? }        请求构造覆盖(可选)
 *   dataHook(param, data, ctx) => { summary?, context?, stats? }  取数后处理(可选)
 *     param:Agent mes_fetch 传入的任意 JSON 对象
 *     data:{ node:{id,name,lineId,unit}, format, rows, window:{from,to} }
 *     ctx:能力句柄 saveCsv/saveJson/saveText/savePng/plot/log/now —— 产物只落
 *          <configRoot>/data/mes-artifacts/<nodeId>/
 *
 * 隔离模型(与插件 SDK / AML 训练器同级信任):hook 是管理员配置的代码,运行在
 * **独立 node 子进程**(运行时生成的一次性模块,import 后即弃),父进程-wall 超时
 * 击杀 —— hook 里的同步死循环只死子进程,绝不卡主进程事件循环。子进程内代码具备
 * node 能力(同插件),防的是误用与停摆,不是恶意边界;产物写入按数量/字节限额,
 * 目录按 nodeId 隔离 + 保留上限。
 */
import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { AppError } from '../../../utils/errors'
import { spawnLineProcess } from '../agents/adapters/line-spawn'

// ============================================================
// 限额(单一事实源;测试直接引用)
// ============================================================

/** hook 源码长度上限 */
export const MES_HOOK_CODE_MAX = 32 * 1024
/** 子进程 wall 超时(含 node 启动;超时杀进程) */
export const MES_HOOK_TIMEOUT_MS = 4000
/** 单次 hook 运行的并发上限(防 fork 风暴) */
export const MES_HOOK_MAX_CONCURRENT = 2
/** 单次运行产物文件数上限 */
export const MES_HOOK_MAX_FILES = 20
/** 单个产物字节上限 */
export const MES_HOOK_MAX_FILE_BYTES = 10 * 1024 * 1024
/** 单次运行产物总字节上限 */
export const MES_HOOK_MAX_TOTAL_BYTES = 30 * 1024 * 1024
/** 每节点产物保留数(超出删最旧) */
export const MES_HOOK_ARTIFACT_RETAIN = 200

// ============================================================
// 产物根(配置期接线;缺省 ensureDataDir()/mes-artifacts)
// ============================================================

let artifactsRoot = ''
let workerDir = ''
export function configureMesHooks(dataDir: string): void {
  artifactsRoot = join(dataDir, 'mes-artifacts')
  workerDir = join(artifactsRoot, '.worker')
  mkdirSync(workerDir, { recursive: true })
}
export function defaultMesArtifactsDir(dataDir: string): string {
  return join(dataDir, 'mes-artifacts')
}
async function rootOf(): Promise<string> {
  if (!artifactsRoot) {
    // 惰性兜底:插件未接线(单测/早期)时按默认派生,保持功能可用
    const { ensureDataDir } = await import('@/shared/config/home.mjs') as { ensureDataDir: () => string }
    configureMesHooks(ensureDataDir())
  }
  return artifactsRoot
}

// ============================================================
// 形状
// ============================================================

export interface MesHookArtifact { name: string, file: string, bytes: number, mime: string }

export interface MesHookOutcome {
  ok: boolean
  /** hook 返回的摘要(进工具回包正文) */
  summary?: string
  /** hook 返回的处理情况说明(给 Agent 的上下文注入) */
  context?: string
  /** hook 返回的结构化统计(JSON 对象) */
  stats?: Record<string, unknown>
  /** 本次运行产物清单 */
  artifacts: MesHookArtifact[]
  /** ctx.log 收集的日志行 */
  logs: string[]
  /** 失败原因(hook 抛错/超时/返回形状不对) */
  error?: string
}

/** dataHook 收到的数据包(rows 为驱动泛化行:标量/vector/图像 base64/记录) */
export interface MesHookData {
  node: { id: string, name: string, lineId: string, unit: string }
  format: string
  rows: unknown[]
  window: { from: string, to: string }
}

// ============================================================
// 代码清洗(hook 源码取自 driverConfig text 字段)
// ============================================================

function safeHookCode(cfg: Record<string, unknown>, key: 'dataHook' | 'requestHook'): string | null {
  const raw = cfg[key]
  if (raw === null || raw === undefined) return null
  const code = String(raw).trim()
  if (code === '') return null
  if (code.length > MES_HOOK_CODE_MAX) {
    throw new AppError(400, 'BAD_REQUEST', `${key} 代码过长(${code.length} > ${MES_HOOK_CODE_MAX} 字符)`)
  }
  return code
}

/** 取出已配置的 hook 源码(无配置 null;坏长度抛 400) */
export function mesDataHookCode(cfg: Record<string, unknown>): string | null {
  return safeHookCode(cfg, 'dataHook')
}
export function mesRequestHookCode(cfg: Record<string, unknown>): string | null {
  return safeHookCode(cfg, 'requestHook')
}

// ============================================================
// 一次性 worker 模块(静态模板;运行时写入 workerDir 后 import 即弃)
// 协议:stdin 收 JSON 行请求 → stdout 写单行 JSON 结果;代码内嵌为模块尾部的 __aw_hook。
// worker 代码不用模板字面量(纯拼接),便于以 TS 模板字符串承载。
// ============================================================

const WORKER_SOURCE = [
  'import { readFileSync, writeFileSync, mkdirSync, rmSync } from \'node:fs\'',
  'import { basename, join } from \'node:path\'',
  'const req = JSON.parse(readFileSync(0, \'utf-8\'))',
  'const logs = []',
  'const artifacts = []',
  'const clip = function (v, max) { return v.length > max ? v.slice(0, max) + "…(截断)" : v }',
  'const cleanName = function (raw, fallbackExt) {',
  '  const base = basename(String(raw === null || raw === undefined ? "artifact" : raw)).replace(/[^\\w.\\-\\u4e00-\\u9fa5]+/g, "_").slice(0, 64) || "artifact"',
  '  return /\\.[A-Za-z0-9]{1,6}$/.test(base) ? base : base + fallbackExt',
  '}',
  'const esc = function (s) { return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;") }',
  'const PALETTE = ["#35e0a0", "#41c8f4", "#f4a941", "#e06060", "#b58cf0", "#f0e05d"]',
  'const fmtTick = function (v) { return String(Number(v.toPrecision(5))) }',
  'const renderSvgLineChart = function (input) {',
  '  const list = Array.isArray(input.series) ? input.series.slice(0, 6) : []',
  '  const pts = list.filter(function (s) { return Array.isArray(s.points) && s.points.length >= 2 }).map(function (s) {',
  '    return { name: String(s.name === undefined || s.name === null ? "series" : s.name), points: s.points.filter(function (p) { return Array.isArray(p) && isFinite(Number(p[0])) && isFinite(Number(p[1])) }).map(function (p) { return [Number(p[0]), Number(p[1])] }) }',
  '  }).filter(function (s) { return s.points.length >= 2 })',
  '  if (pts.length === 0) return null',
  '  const W = 860, H = 320, PL = 62, PR = 18, PT = 34, PB = 40',
  '  const all = []',
  '  for (const s of pts) for (const p of s.points) all.push(p)',
  '  const xMin = Math.min.apply(null, all.map(function (p) { return p[0] })), xMax = Math.max.apply(null, all.map(function (p) { return p[0] }))',
  '  const yMin = Math.min.apply(null, all.map(function (p) { return p[1] })), yMax = Math.max.apply(null, all.map(function (p) { return p[1] }))',
  '  const sx = function (x) { return PL + (xMax === xMin ? (W - PL - PR) / 2 : (x - xMin) / (xMax - xMin) * (W - PL - PR)) }',
  '  const sy = function (y) { return H - PB - (yMax === yMin ? (H - PT - PB) / 2 : (y - yMin) / (yMax - yMin) * (H - PT - PB)) }',
  '  const parts = [\'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 \' + W + \' \' + H + \'" font-family="ui-monospace,Consolas,monospace">\']',
  '  parts.push(\'<rect width="\' + W + \'" height="\' + H + \'" fill="#0d1b2a"/>\')',
  '  for (let i = 0; i <= 4; i++) {',
  '    const y = PT + (H - PT - PB) * i / 4, v = yMax - (yMax - yMin) * i / 4',
  '    parts.push(\'<line x1="\' + PL + \'" y1="\' + y + \'" x2="\' + (W - PR) + \'" y2="\' + y + \'" stroke="#1c3a52" stroke-width="1"/>\')',
  '    parts.push(\'<text x="\' + (PL - 8) + \'" y="\' + (y + 4) + \'" fill="#7fa3bd" font-size="11" text-anchor="end">\' + esc(fmtTick(v)) + "</text>")',
  '  }',
  '  if (input.title) parts.push(\'<text x="\' + PL + \'" y="20" fill="#d7e6f2" font-size="14">\' + esc(input.title) + "</text>")',
  '  parts.push(\'<line x1="\' + PL + \'" y1="\' + (H - PB) + \'" x2="\' + (W - PR) + \'" y2="\' + (H - PB) + \'" stroke="#2c5878" stroke-width="1"/>\')',
  '  for (let i = 0; i < pts.length; i++) {',
  '    const color = PALETTE[i % PALETTE.length]',
  '    let d = ""',
  '    for (let j = 0; j < pts[i].points.length; j++) {',
  '      d += (j === 0 ? "M" : "L") + sx(pts[i].points[j][0]).toFixed(1) + "," + sy(pts[i].points[j][1]).toFixed(1)',
  '    }',
  '    parts.push(\'<path d="\' + d + \'" fill="none" stroke="\' + color + \'" stroke-width="1.6"/>\')',
  '    if (input.xLabel) parts.push(\'<text x="\' + (W - PR) + \'" y="\' + (H - 8) + \'" fill="#7fa3bd" font-size="11" text-anchor="end">\' + esc(input.xLabel) + "</text>")',
  '    if (input.yLabel) parts.push(\'<text x="\' + (PL - 46) + \'" y="\' + (PT - 8) + \'" fill="#7fa3bd" font-size="11">\' + esc(input.yLabel) + "</text>")',
  '    const lx = PL + 8 + i * 130',
  '    parts.push(\'<rect x="\' + lx + \'" y="\' + (H - 16) + \'" width="10" height="3" fill="\' + color + \'"/><text x="\' + (lx + 15) + \'" y="\' + (H - 9) + \'" fill="#a9c4d8" font-size="11">\' + esc(clip(pts[i].name, 16)) + "</text>")',
  '  }',
  '  parts.push("</svg>")',
  '  return parts.join("")',
  '}',
  'let fileCount = 0, totalBytes = 0',
  'mkdirSync(req.artifactsDir, { recursive: true })',
  'const writeArtifact = function (name, ext, mime, payload) {',
  '  if (fileCount >= req.maxFiles) throw new Error("产物数量超限(单次最多 " + req.maxFiles + " 个文件)")',
  '  const buf = typeof payload === "string" ? Buffer.from(payload, "utf-8") : payload',
  '  if (buf.byteLength > req.maxFileBytes) throw new Error("产物 " + name + " 超过单文件上限 " + Math.round(req.maxFileBytes / 1048576) + "MB")',
  '  if (totalBytes + buf.byteLength > req.maxTotalBytes) throw new Error("产物总字节超限(单次最多 " + Math.round(req.maxTotalBytes / 1048576) + "MB)")',
  '  const file = join(req.artifactsDir, req.runPrefix + cleanName(name, ext))',
  '  writeFileSync(file, buf)',
  '  fileCount++; totalBytes += buf.byteLength',
  '  const entry = { name: basename(file), file: file, bytes: buf.byteLength, mime: mime }',
  '  artifacts.push(entry)',
  '  return entry',
  '}',
  'const csvCell = function (v) {',
  '  if (v === null || v === undefined) return ""',
  '  const s = typeof v === "object" ? JSON.stringify(v) : String(v)',
  '  return /[",\\r\\n]/.test(s) ? \'"\' + s.replace(/"/g, \'""\') + \'"\' : s',
  '}',
  'const plain = function (v, what) {',
  '  if (v === null || typeof v !== "object" || Array.isArray(v)) throw new Error(what + " 必须是对象字面量")',
  '  return v',
  '}',
  'const ctx = {',
  '  now: function () { return new Date().toISOString() },',
  '  log: function () {',
  '    if (logs.length >= 50) return',
  '    const parts2 = []',
  '    for (const a of arguments) parts2.push(typeof a === "string" ? a : JSON.stringify(a))',
  '    logs.push(clip(parts2.join(" "), 200))',
  '  },',
  '  saveCsv: function (arg) {',
  '    const o = plain(arg, "ctx.saveCsv 参数")',
  '    if (!Array.isArray(o.rows)) throw new Error("saveCsv 的 rows 必须是二维数组")',
  '    const lines = []',
  '    for (const r of o.rows) lines.push(Array.isArray(r) ? r.map(csvCell).join(",") : csvCell(r))',
  '    const hit = writeArtifact(o.name, ".csv", "text/csv", lines.join("\\r\\n") + "\\r\\n")',
  '    return { name: hit.name, file: hit.file, bytes: hit.bytes }',
  '  },',
  '  saveJson: function (arg) {',
  '    const o = plain(arg, "ctx.saveJson 参数")',
  '    if (!("obj" in o)) throw new Error("saveJson 缺少 obj 字段")',
  '    const hit = writeArtifact(o.name, ".json", "application/json", JSON.stringify(o.obj, null, 1))',
  '    return { name: hit.name, file: hit.file, bytes: hit.bytes }',
  '  },',
  '  saveText: function (arg) {',
  '    const o = plain(arg, "ctx.saveText 参数")',
  '    const hit = writeArtifact(o.name, ".txt", "text/plain", String(o.text === undefined || o.text === null ? "" : o.text))',
  '    return { name: hit.name, file: hit.file, bytes: hit.bytes }',
  '  },',
  '  savePng: function (arg) {',
  '    const o = plain(arg, "ctx.savePng 参数")',
  '    const b64 = String(o.base64 === undefined || o.base64 === null ? "" : o.base64).replace(/^data:[^;]+;base64,/, "")',
  '    if (b64 === "") throw new Error("savePng 缺少 base64 字段")',
  '    const buf = Buffer.from(b64, "base64")',
  '    if (buf.byteLength === 0) throw new Error("savePng 的 base64 解码为空")',
  '    const mime = String(o.mime === undefined || o.mime === null ? "image/png" : o.mime)',
  '    const hit = writeArtifact(o.name, mime.indexOf("svg") >= 0 ? ".svg" : ".png", mime, buf)',
  '    return { name: hit.name, file: hit.file, bytes: hit.bytes }',
  '  },',
  '  plot: function (arg) {',
  '    const o = plain(arg, "ctx.plot 参数")',
  '    const svg = renderSvgLineChart({',
  '      title: o.title === undefined ? undefined : String(o.title),',
  '      xLabel: o.xLabel === undefined ? undefined : String(o.xLabel),',
  '      yLabel: o.yLabel === undefined ? undefined : String(o.yLabel),',
  '      series: o.series,',
  '    })',
  '    if (svg === null) throw new Error("plot 序列不合法:每个 series 需 ≥2 个 [x,y] 有限数值点")',
  '    const hit = writeArtifact(o.name, ".svg", "image/svg+xml", svg)',
  '    return { name: hit.name, file: hit.file, bytes: hit.bytes }',
  '  },',
  '}',
  'const emit = function (out) { process.stdout.write(JSON.stringify(out) + "\\n") }',
  'try {',
  '  const fn = __aw_hook',
  '  if (typeof fn !== "function") throw new Error("hook 必须求值为函数(如 function(param, data, ctx){...} 或 (param, data, ctx) => {...})")',
  '  const args = req.kind === "request" ? [req.param, ctx] : [req.param, req.data, ctx]',
  '  const raw = fn.apply(null, args)',
  '  let summary, context, stats',
  '  if (raw === null || raw === undefined) {',
  '    context = "hook 已执行(无返回值);产物见 artifacts。"',
  '  } else if (typeof raw !== "object" || Array.isArray(raw)) {',
  '    context = "hook 返回了 " + typeof raw + "(非对象),已忽略;产物见 artifacts。"',
  '  } else {',
  '    if (typeof raw.summary === "string" && raw.summary.trim()) summary = clip(raw.summary.trim(), 2000)',
  '    if (typeof raw.context === "string" && raw.context.trim()) context = clip(raw.context.trim(), 2000)',
  '    if (raw.stats !== null && typeof raw.stats === "object" && !Array.isArray(raw.stats)) stats = raw.stats',
  '    if (!summary && !context) context = "hook 已执行但未返回 summary/context;产物见 artifacts。"',
  '  }',
  '  emit({ ok: true, summary: summary, context: context, stats: stats === undefined ? null : stats, artifacts: artifacts, logs: logs, raw: req.kind === "request" ? raw : undefined })',
  '} catch (err) {',
  '  emit({ ok: false, error: String(err && err.message ? err.message : err), artifacts: artifacts, logs: logs })',
  '} finally {',
  '  try { rmSync(__filename, { force: true }) } catch (e2) { /* 文件占用忽略 */ }',
  '}',
  'process.exit(0)',
].join('\n')

// __aw_hook 由运行时拼接的模块尾部定义 —— 与上方模板分离,避免用户代码影响 worker 协议
const WORKER_MODULE_OF = (code: string): string =>
  `const __aw_hook = (\n${code}\n);\n${WORKER_SOURCE}\n`

// ============================================================
// 子进程执行(并发上限 + wall 超时击杀 + 结果清洗)
// ============================================================

let active = 0

interface WorkerReply {
  ok: boolean
  summary?: string
  context?: string
  stats?: unknown
  /** request 类调用:hook 的原始返回({path,query,headers}) */
  raw?: unknown
  artifacts?: MesHookArtifact[]
  logs?: string[]
  error?: string
}

async function runHookModule(kind: 'data' | 'request', code: string, payload: {
  param: unknown
  data?: MesHookData
  nodeId: string
}): Promise<{ reply: WorkerReply, moduleFile: string }> {
  const root = await rootOf()
  if (active >= MES_HOOK_MAX_CONCURRENT) {
    throw new AppError(429, 'MES_HOOK_BUSY', `hook 执行并发已达上限(${MES_HOOK_MAX_CONCURRENT});请稍后重试`)
  }
  const moduleFile = join(workerDir || join(root, '.worker'), `hook-${kind}-${randomUUID().slice(0, 8)}.mjs`)
  writeFileSync(moduleFile, WORKER_MODULE_OF(code), 'utf-8')
  active += 1
  try {
    const child = spawnLineProcess(process.execPath, [moduleFile])
    const request = JSON.stringify({
      kind,
      param: payload.param,
      data: payload.data ?? null,
      artifactsDir: join(root, payload.nodeId),
      runPrefix: `run-${Date.now().toString(36)}-`,
      maxFiles: MES_HOOK_MAX_FILES,
      maxFileBytes: MES_HOOK_MAX_FILE_BYTES,
      maxTotalBytes: MES_HOOK_MAX_TOTAL_BYTES,
    })
    const outChunks: Buffer[] = []
    let errTail = ''
    let settled = false
    return await new Promise((resolve) => {
      const timer = setTimeout(() => {
        settled = true
        try {
          child.kill()
        }
        catch { /* 已退出 */ }
        resolve({
          reply: { ok: false, error: `hook 执行超时(>${MES_HOOK_TIMEOUT_MS}ms),子进程已被强制终止;hook 必须同步且轻量` },
          moduleFile,
        })
      }, MES_HOOK_TIMEOUT_MS)
      child.stdout?.on('data', (c: Buffer) => outChunks.push(c))
      child.stderr?.on('data', (c: Buffer) => {
        errTail = (errTail + String(c)).slice(-400)
      })
      child.on('error', (err) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve({ reply: { ok: false, error: `hook 子进程拉起失败:${err.message}` }, moduleFile })
      })
      child.on('close', (exitCode) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        const text = Buffer.concat(outChunks).toString('utf-8').trim()
        const lastLine = text.split('\n').filter(Boolean).pop() ?? ''
        try {
          const parsed = JSON.parse(lastLine) as WorkerReply
          resolve({ reply: parsed, moduleFile })
        }
        catch {
          const why = errTail.trim() || text.slice(0, 200) || `exit=${exitCode}`
          resolve({ reply: { ok: false, error: `hook 子进程未返回结果(代码语法错误或崩溃):${why}` }, moduleFile })
        }
      })
      child.stdin?.on('error', () => { /* 子进程早退时 stdin EPIPE,由 close 分支收敛 */ })
      child.stdin?.end(request)
    })
  }
  finally {
    active -= 1
    // 模块文件即弃(worker 正常路径自删;此处兜底清残留;Windows 文件占用时留给磁盘保留策略)
    setTimeout(() => {
      try {
        rmSync(moduleFile, { force: true })
      }
      catch { /* 占用忽略 */ }
    }, 1500).unref?.()
  }
}

function clip(v: string, max: number): string {
  return v.length > max ? `${v.slice(0, max)}…(截断)` : v
}

/** worker 回复 → 面向调用方的结果(诚实失败:ok=false 时 error 必有) */
function sanitizeReply(reply: WorkerReply): MesHookOutcome {
  const base: MesHookOutcome = {
    ok: reply.ok === true,
    artifacts: Array.isArray(reply.artifacts) ? reply.artifacts.slice(0, MES_HOOK_MAX_FILES) : [],
    logs: Array.isArray(reply.logs) ? reply.logs.slice(0, 50) : [],
  }
  if (!base.ok) {
    base.error = clip(String(reply.error ?? 'hook 执行失败'), 500)
    return base
  }
  if (typeof reply.summary === 'string' && reply.summary) base.summary = clip(reply.summary, 2000)
  if (typeof reply.context === 'string' && reply.context) base.context = clip(reply.context, 2000)
  if (reply.stats !== null && typeof reply.stats === 'object' && !Array.isArray(reply.stats)) {
    try {
      base.stats = JSON.parse(JSON.stringify(reply.stats)) as Record<string, unknown>
    }
    catch { /* 不可序列化 stats 忽略 */ }
  }
  return base
}

/** 清点目录产物并按保留上限裁剪(删最旧) */
function retainArtifacts(dir: string): void {
  let entries: string[]
  try {
    entries = readdirSync(dir)
  }
  catch {
    return
  }
  if (entries.length <= MES_HOOK_ARTIFACT_RETAIN) return
  const withStat = entries.map((name) => {
    try {
      return { name, mtime: statSync(join(dir, name)).mtimeMs }
    }
    catch {
      return { name, mtime: 0 }
    }
  }).sort((a, b) => a.mtime - b.mtime)
  for (const e of withStat.slice(0, entries.length - MES_HOOK_ARTIFACT_RETAIN)) {
    try {
      rmSync(join(dir, e.name), { force: true })
    }
    catch { /* 占用/竞态忽略,下轮再清 */ }
  }
}

/**
 * 主进程直存一帧图像产物(image 格式 inline 取数自动落盘;base64 永不进 prompt)。
 * 失败返回 null(落盘失败不阻断取数,回包按未落盘呈现)。
 */
export function saveMesImageArtifact(nodeId: string, name: string, base64: string, mime: string): MesHookArtifact | null {
  try {
    const dir = join(artifactsRoot || defaultMesArtifactsDirSafe(), nodeId)
    mkdirSync(dir, { recursive: true })
    const buf = Buffer.from(base64.replace(/^data:[^;]+;base64,/, ''), 'base64')
    if (buf.byteLength === 0 || buf.byteLength > MES_HOOK_MAX_FILE_BYTES) return null
    const clean = basename(String(name || 'frame')).replace(/[^\w.\-\u4e00-\u9fa5]+/g, '_').slice(0, 64) || 'frame'
    const ext = mime.includes('jpeg') || mime.includes('jpg') ? '.jpg' : mime.includes('svg') ? '.svg' : '.png'
    const file = join(dir, `run-${Date.now().toString(36)}-${clean}${/\.[A-Za-z0-9]{1,6}$/.test(clean) ? '' : ext}`)
    writeFileSync(file, buf)
    return { name: basename(file), file, bytes: buf.byteLength, mime }
  }
  catch {
    return null
  }
}

function defaultMesArtifactsDirSafe(): string {
  // 同步兜底:配置未接线时退化为进程 cwd 下 data 目录(仅影响单测/早期路径)
  return join(process.cwd(), 'data', 'mes-artifacts')
}

/** 列节点产物目录(mtime 新→旧;≤limit 条) */
export function listMesArtifacts(nodeId: string, limit = 50): MesHookArtifact[] {
  const dir = join(artifactsRoot || defaultMesArtifactsDirSafe(), nodeId)
  let entries: string[]
  try {
    entries = readdirSync(dir)
  }
  catch {
    return []
  }
  return entries
    .map((name) => {
      try {
        const st = statSync(join(dir, name))
        if (!st.isFile()) return null
        const mime = name.endsWith('.png')
          ? 'image/png'
          : name.endsWith('.jpg') || name.endsWith('.jpeg')
            ? 'image/jpeg'
            : name.endsWith('.svg')
              ? 'image/svg+xml'
              : name.endsWith('.json')
                ? 'application/json'
                : name.endsWith('.csv')
                  ? 'text/csv'
                  : 'text/plain'
        return { name, file: join(dir, name), bytes: st.size, mime }
      }
      catch {
        return null
      }
    })
    .filter((x): x is MesHookArtifact => x !== null)
    .sort((a, b) => b.name.localeCompare(a.name))
    .slice(0, Math.max(1, Math.min(limit, 200)))
}

/** 产物目录根(供文件服务路由做前缀校验) */
export function mesArtifactsRoot(): string {
  return artifactsRoot || defaultMesArtifactsDirSafe()
}

/** 执行节点的 dataHook(取数后处理);失败也是结果(ok=false + error),不抛 */
export async function runMesDataHook(code: string, param: unknown, data: MesHookData, opts: { nodeId: string }): Promise<MesHookOutcome> {
  const { reply } = await runHookModule('data', code, { param, data, nodeId: opts.nodeId })
  const outcome = sanitizeReply(reply)
  try {
    retainArtifacts(join(await rootOf(), opts.nodeId))
  }
  catch { /* 清理失败不影响结果 */ }
  return outcome
}

/** 执行节点的 requestHook(请求构造覆盖;返回 path/query/headers 白名单键);配置/协议错误抛 AppError */
export async function runMesRequestHook(code: string, param: unknown, opts: { nodeId: string }): Promise<{ path?: string, query?: Record<string, string>, headers?: Record<string, string> }> {
  const { reply } = await runHookModule('request', code, { param, nodeId: opts.nodeId })
  if (!reply.ok) throw new AppError(422, 'MES_HOOK_FAILED', `requestHook 执行失败:${reply.error ?? '未知原因'}`)
  const o = reply.raw !== null && typeof reply.raw === 'object' && !Array.isArray(reply.raw)
    ? reply.raw as Record<string, unknown>
    : {}
  if (reply.raw !== null && typeof reply.raw !== 'object') {
    throw new AppError(422, 'MES_HOOK_FAILED', `requestHook 必须返回对象(可含 path/query/headers),实际返回 ${typeof reply.raw}`)
  }
  const out: { path?: string, query?: Record<string, string>, headers?: Record<string, string> } = {}
  if (typeof o.path === 'string' && o.path.trim()) out.path = o.path.trim()
  if (o.query !== null && typeof o.query === 'object' && !Array.isArray(o.query)) {
    out.query = Object.fromEntries(Object.entries(o.query as Record<string, unknown>).map(([k, v]) => [k, String(v)]))
  }
  if (o.headers !== null && typeof o.headers === 'object' && !Array.isArray(o.headers)) {
    out.headers = Object.fromEntries(Object.entries(o.headers as Record<string, unknown>).map(([k, v]) => [k, String(v)]))
  }
  return out
}
