/**
 * MQTT 结构化载荷解码(声明式) —— JSON/文本/二进制 → scalar | vector | image。
 *
 * 节点 driverConfig 约定(与 MQTT 模板形态配合;全部可选):
 *  scalar:  jsonPath                  例 data.temperature;纯数字报文留空
 *  vector:  pointsPath(缺省 points)  JSON 数值数组路径;1~4096 个有限数
 *           metricsPath              可选,指标对象路径({avg,min,...})
 *  image:   imageFormat=json|binary   json=JSON 内 base64 字段;binary=报文字节即图像
 *           imagePath(缺省 png)      base64 字段路径(兼容 image/base64/blob)
 *           imageMime / mimePath       MIME(缺省 image/png)
 *           imageWidthPath/imageHeightPath 可选(非 PNG 且无尺寸时)
 *  decoder: 自定义解码器名(插件 ctx.daq.registerDecoder;优先于声明式)
 *
 * 解码结果必须与节点模板 signalKind 一致;不一致按配置错误报出(节点 lastError 可见)。
 * 不解析 XML/HTML,不做任何动态求值 —— 结构化解析只有 JSONPath 与受控的插件函数。
 */
import type { DaqDecoded, DaqDecodeInput } from '../decoders'
import { listDecoders, resolveDecoder } from '../decoders'

const MAX_POINTS = 4096
const MAX_IMAGE_BYTES = 10 * 1024 * 1024
const MAX_IMAGE_PIXELS = 16_000_000
const MAX_IMAGE_SIDE = 16384
const MAX_METRIC_KEYS = 64
/** 允许的图像类型(禁止 SVG 等可执行内容;内容端点也不做外链解析) */
const RASTER_MIMES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/bmp', 'image/gif', 'image/tiff'])

function pick(root: unknown, path: string): unknown {
  if (!path) return root
  return path.split('.').reduce<unknown>((acc, key) => {
    if (acc == null) return undefined
    if (Array.isArray(acc) && /^\d+$/.test(key)) return acc[Number(key)]
    return (acc as Record<string, unknown>)[key]
  }, root)
}

/** 严格数值:number 或非空数字字符串;null/boolean/空串/数组/对象一律 NaN(不静默变 0) */
function asNumber(v: unknown): number {
  if (typeof v === 'number') return Number.isFinite(v) ? v : Number.NaN
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v)
    return Number.isFinite(n) ? n : Number.NaN
  }
  return Number.NaN
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw)
  }
  catch {
    return undefined
  }
}

function metricsOf(root: unknown, path: string): Record<string, number> | undefined {
  if (!path) return undefined
  const target = pick(root, path)
  if (target == null || typeof target !== 'object' || Array.isArray(target)) return undefined
  const out: Record<string, number> = {}
  for (const [k, v] of Object.entries(target as Record<string, unknown>).slice(0, MAX_METRIC_KEYS)) {
    const n = asNumber(v)
    if (Number.isFinite(n) && k.trim()) out[k.trim().slice(0, 80)] = n
  }
  return Object.keys(out).length > 0 ? out : undefined
}

/** PNG IHDR 尺寸(校验 PNG 签名;非 PNG 返回 0,可显式配置 width/height) */
function pngSize(blob: Buffer): { width: number, height: number } {
  const isPng = blob.length >= 24
    && blob[0] === 0x89 && blob[1] === 0x50 && blob[2] === 0x4E && blob[3] === 0x47
  if (isPng && blob.readUInt32BE(12) === 0x49484452) {
    return { width: blob.readUInt32BE(16), height: blob.readUInt32BE(20) }
  }
  return { width: 0, height: 0 }
}

function assertRasterMime(mime: unknown): void {
  if (typeof mime !== 'string' || !mime.trim()) throw new Error(`图像 MIME 必须是字符串(收到 ${String(mime)})`)
  if (!RASTER_MIMES.has(mime.toLowerCase())) {
    throw new Error(`图像 MIME 不受支持: ${mime}(允许 ${[...RASTER_MIMES].join('/')};不接受 SVG/HTML)`)
  }
}

function assertImageSize(width: number, height: number): void {
  // 0/0 表示未知(非 PNG 且未显式给尺寸);负数非法;显式非正数由调用方单独拒绝
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 0 || height < 0) throw new Error('图像宽高非法')
  if (width > MAX_IMAGE_SIDE || height > MAX_IMAGE_SIDE || width * height > MAX_IMAGE_PIXELS) {
    throw new Error(`图像尺寸 ${width}x${height} 超过上限(${MAX_IMAGE_SIDE}/边,${MAX_IMAGE_PIXELS} 像素)`)
  }
}

/** 显式配置的尺寸必须是正数;未配置返回 NaN 以回落 IHDR/未知 */
function explicitDim(cfg: Record<string, unknown>, key: 'width' | 'height'): number {
  if (cfg[key] == null) return Number.NaN
  const n = asNumber(cfg[key])
  if (!Number.isFinite(n) || n <= 0) throw new Error(`image ${key} 必须是正数(收到 ${String(cfg[key])})`)
  return n
}

function mimeOf(cfg: Record<string, unknown>, json: unknown, fallback: string): string {
  // mimePath(载荷内字段)优先于静态 imageMime:UI 的 imageMime 有缺省值,不能盖住载荷自带 MIME
  const mimePath = cfg.mimePath != null ? String(cfg.mimePath) : ''
  if (mimePath) {
    const v = pick(json, mimePath)
    if (typeof v === 'string' && v.trim()) return v.trim()
  }
  const configured = cfg.imageMime
  if (configured != null && String(configured).trim()) return String(configured).trim()
  return fallback
}

function decodeBase64Image(cfg: Record<string, unknown>, json: unknown): DaqDecoded {
  const explicitPath = cfg.imagePath != null ? String(cfg.imagePath) : ''
  const candidates = explicitPath ? [explicitPath] : ['png', 'image', 'base64', 'blob']
  const isBase64ish = (v: string): boolean => v.startsWith('data:') || /^[A-Za-z0-9+/=\s]+$/.test(v)
  let b64 = ''
  let dataUrlMime = ''
  let sourcePath = ''
  for (const p of candidates) {
    const v = pick(json, p)
    if (typeof v !== 'string' || !v.trim()) continue
    // 未显式指定 imagePath 时只接受 base64/data URL;普通 URL/文本字段跳过,避免遮住真正的 base64 字段
    if (!explicitPath && !isBase64ish(v.trim())) continue
    b64 = v.trim()
    sourcePath = p
    break
  }
  if (!b64) throw new Error(`image 载荷缺少 base64 字段(imagePath=${explicitPath || candidates.join('/')})`)
  // 兼容 data:image/png;base64,<data>(不用正则 exec,避免与命令执行模式混淆)
  if (b64.startsWith('data:')) {
    const comma = b64.indexOf(',')
    const header = comma > 0 ? b64.slice(5, comma) : ''
    const semi = header.indexOf(';')
    const headMime = semi > 0 ? header.slice(0, semi) : header
    if (/^image\//i.test(headMime)) dataUrlMime = headMime
    if (comma > 0) b64 = b64.slice(comma + 1)
  }
  if (!/^[A-Za-z0-9+/=\s]+$/.test(b64)) throw new Error(`image 字段 ${sourcePath} 不是合法 base64`)
  const blob = Buffer.from(b64, 'base64')
  if (blob.length === 0) throw new Error('image 载荷 base64 解码后为空')
  const maxBytes = Number(cfg.imageMaxBytes ?? MAX_IMAGE_BYTES) || MAX_IMAGE_BYTES
  if (blob.length > maxBytes) throw new Error(`image 载荷 ${blob.length}B 超过上限 ${maxBytes}B`)
  // data URL 自带 MIME 优先于 UI 缺省值(避免 jpeg 被默认 image/png 标错)
  const mime = dataUrlMime || mimeOf(cfg, json, 'image/png')
  assertRasterMime(mime)
  const ihdr = pngSize(blob)
  const widthCfg = explicitDim(cfg, 'width')
  const heightCfg = explicitDim(cfg, 'height')
  const widthPath = cfg.imageWidthPath != null ? String(cfg.imageWidthPath) : ''
  const heightPath = cfg.imageHeightPath != null ? String(cfg.imageHeightPath) : ''
  const widthRaw = widthPath ? asNumber(pick(json, widthPath)) : Number.NaN
  const heightRaw = heightPath ? asNumber(pick(json, heightPath)) : Number.NaN
  if (widthPath && (!Number.isFinite(widthRaw) || widthRaw <= 0)) throw new Error(`imageWidthPath=${widthPath} 必须是正数`)
  if (heightPath && (!Number.isFinite(heightRaw) || heightRaw <= 0)) throw new Error(`imageHeightPath=${heightPath} 必须是正数`)
  const width = widthPath ? widthRaw : (Number.isFinite(widthCfg) ? widthCfg : ihdr.width)
  const height = heightPath ? heightRaw : (Number.isFinite(heightCfg) ? heightCfg : ihdr.height)
  assertImageSize(width, height)
  const metrics = metricsOf(json, cfg.metricsPath != null ? String(cfg.metricsPath) : '')
  return { kind: 'image', blob, mime, width, height, ...(metrics ? { metrics } : {}) }
}

function decodeDeclarative(input: DaqDecodeInput): DaqDecoded {
  const { raw, bytes, signalKind, config: cfg } = input
  const json = input.json == null ? parseJson(raw) : input.json
  if (signalKind === 'scalar') {
    const path = cfg.jsonPath != null ? String(cfg.jsonPath) : (cfg.valuePath != null ? String(cfg.valuePath) : '')
    let target: unknown
    if (path) {
      if (json === undefined) throw new Error(`payload 不是合法 JSON(无法按 jsonPath=${path} 取值)`)
      target = pick(json, path)
    }
    else if (typeof json === 'number' || typeof json === 'string') {
      // JSON 数字或数字字符串("42")兼容;null/boolean/对象/数组落到 raw 后严格校验
      target = json
    }
    else {
      target = raw.trim()
    }
    const value = asNumber(target)
    if (!Number.isFinite(value)) throw new Error(`无法得到单个数值(jsonPath=${path || '未配置'};payload=${raw.slice(0, 80)})`)
    return { kind: 'scalar', value }
  }
  if (signalKind === 'vector') {
    if (json === undefined) throw new Error('vector 载荷必须是 JSON')
    const path = cfg.pointsPath != null ? String(cfg.pointsPath) : 'points'
    let target: unknown = pick(json, path)
    if (!Array.isArray(target) && !cfg.pointsPath && Array.isArray(json)) target = json
    if (!Array.isArray(target)) throw new Error(`vector 载荷缺少点列数组(pointsPath=${path || 'root'})`)
    const arr = target
    if (arr.length < 1 || arr.length > MAX_POINTS) throw new Error(`vector 点列长度 ${arr.length} 非法(1~${MAX_POINTS})`)
    const points = arr.map(asNumber)
    if (!points.every(Number.isFinite)) throw new Error('vector 点列含非数值元素(null/boolean/空串按非法处理)')
    const metrics = metricsOf(json, cfg.metricsPath != null ? String(cfg.metricsPath) : '')
    return { kind: 'vector', points, ...(metrics ? { metrics } : {}) }
  }
  const format = String(cfg.imageFormat ?? cfg.payloadFormat ?? 'json').toLowerCase()
  if (format === 'binary') {
    const blob = bytes
    if (blob.length === 0) throw new Error('image 二进制载荷为空')
    const maxBytes = Number(cfg.imageMaxBytes ?? MAX_IMAGE_BYTES) || MAX_IMAGE_BYTES
    if (blob.length > maxBytes) throw new Error(`image 载荷 ${blob.length}B 超过上限 ${maxBytes}B`)
    const mime = String(cfg.imageMime ?? cfg.mime ?? 'image/png')
    assertRasterMime(mime)
    const ihdr = pngSize(blob)
    // 非 PNG 二进制(JPEG 等)用显式 width/height;PNG 自动 IHDR
    const widthCfg = explicitDim(cfg, 'width')
    const heightCfg = explicitDim(cfg, 'height')
    const width = Number.isFinite(widthCfg) ? widthCfg : ihdr.width
    const height = Number.isFinite(heightCfg) ? heightCfg : ihdr.height
    assertImageSize(width, height)
    return { kind: 'image', blob, mime, width, height }
  }
  if (json === undefined) throw new Error('image 载荷必须是 JSON(或使用 imageFormat=binary)')
  return decodeBase64Image(cfg, json)
}

function assertKind(decoded: DaqDecoded, signalKind: DaqDecodeInput['signalKind'], source: string): DaqDecoded {
  if (!decoded || typeof decoded !== 'object' || !('kind' in decoded)) {
    throw new Error(`${source} 未返回类型化样本(必须是同步返回 {kind:...})`)
  }
  if (decoded.kind !== signalKind) {
    throw new Error(`${source} 解码结果 ${decoded.kind} 与节点模板信号形态 ${signalKind} 不一致`)
  }
  if (decoded.kind === 'scalar' && !Number.isFinite(decoded.value)) throw new Error('解码结果不是有限数值')
  if (decoded.kind === 'vector') {
    if (!Array.isArray(decoded.points) || decoded.points.length < 1 || decoded.points.length > MAX_POINTS || !decoded.points.every(Number.isFinite)) {
      throw new Error(`解码点列非法(1~${MAX_POINTS} 个有限数值)`)
    }
    if (decoded.metrics != null) {
      if (typeof decoded.metrics !== 'object' || Array.isArray(decoded.metrics)) throw new Error('解码 metrics 必须是对象')
      const entries = Object.entries(decoded.metrics)
      if (entries.length > MAX_METRIC_KEYS || entries.some(([, v]) => !Number.isFinite(v))) throw new Error('解码 metrics 含非有限数值或条目过多')
    }
  }
  if (decoded.kind === 'image') {
    if (!Buffer.isBuffer(decoded.blob) || decoded.blob.length === 0) throw new Error('解码图像 blob 必须是非空 Buffer')
    if (decoded.blob.length > MAX_IMAGE_BYTES) throw new Error(`解码图像 ${decoded.blob.length}B 超过上限 ${MAX_IMAGE_BYTES}B`)
    assertRasterMime(decoded.mime)
    assertImageSize(decoded.width ?? 0, decoded.height ?? 0)
    if (decoded.metrics != null) {
      if (typeof decoded.metrics !== 'object' || Array.isArray(decoded.metrics)) throw new Error('解码 metrics 必须是对象')
      const entries = Object.entries(decoded.metrics)
      if (entries.length > MAX_METRIC_KEYS || entries.some(([, v]) => !Number.isFinite(v))) throw new Error('解码 metrics 含非有限数值或条目过多')
    }
  }
  return decoded
}

/** 解码一条 MQTT 报文(自定义解码器优先,其次声明式)。
 *  json 字段统一归一:调用方传 null/undefined 时在这里解析一次,自定义解码器可直接使用。 */
export function decodeMqttPayload(input: DaqDecodeInput): DaqDecoded {
  const normalized: DaqDecodeInput = {
    ...input,
    json: input.json == null ? (parseJson(input.raw) ?? null) : input.json,
  }
  const decoderName = String(input.config.decoder ?? '').trim()
  if (decoderName) {
    const custom = resolveDecoder(decoderName)
    if (!custom) throw new Error(`未知解码器「${decoderName}」(可用:${listDecoders().join(', ') || '无'})`)
    const result = custom(normalized)
    if (result && typeof (result as { then?: unknown }).then === 'function') {
      throw new Error(`自定义解码器「${decoderName}」返回了 Promise:解码器必须是同步纯函数`)
    }
    return assertKind(result, input.signalKind, `自定义解码器「${decoderName}」`)
  }
  return assertKind(decodeDeclarative(normalized), input.signalKind, '声明式解析')
}

/** 连接测试用:自动识别载荷形态并给出摘要(不依赖节点模板) */
export function describeMqttPayload(raw: string, _bytes: Buffer, cfg: Record<string, unknown>): { kind: 'scalar' | 'vector' | 'image', summary: string } {
  const json = parseJson(raw)
  if (json !== undefined) {
    const pointsPath = cfg.pointsPath != null ? String(cfg.pointsPath) : 'points'
    const points = pick(json, pointsPath)
    if (Array.isArray(points) && points.length > 0) {
      return { kind: 'vector', summary: `vector ${points.length} 点(pointsPath=${pointsPath})` }
    }
    if (!cfg.pointsPath && Array.isArray(json) && json.length > 0) {
      return { kind: 'vector', summary: `vector ${json.length} 点(根数组)` }
    }
    const imgPath = cfg.imagePath != null ? String(cfg.imagePath) : ''
    const img = imgPath ? pick(json, imgPath) : (pick(json, 'png') ?? pick(json, 'image') ?? pick(json, 'base64') ?? pick(json, 'blob'))
    if (typeof img === 'string' && img.trim().length > 0) {
      return { kind: 'image', summary: `image base64 ${img.length} chars(imagePath=${imgPath || 'png/image'})` }
    }
  }
  const path = cfg.jsonPath != null ? String(cfg.jsonPath) : ''
  const v = path && json !== undefined ? pick(json, path) : raw.trim()
  const n = asNumber(v)
  return { kind: 'scalar', summary: `scalar ${Number.isFinite(n) ? n : '(无法提取数值)'}(jsonPath=${path || '未配置'})` }
}
