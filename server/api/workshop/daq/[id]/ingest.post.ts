/**
 * POST /api/workshop/daq/:id/ingest —— 外部 API 推送多源异构数采样本。
 *
 * 适用:第三方/边缘系统每次调用返回一张图片或一个数组(如膜厚模头点位数组),
 * 由调用方主动推入本平台,走与网关采样完全相同的队列/入库/打标/告警链路。
 *
 * body:
 *   { at?: ISO, value?: number, points?: number[], metrics?: {k:number},
 *     state?: 'ok'|'warn'|'alarm'|'offline',
 *     image?: { base64|data: string, mime?: string, width?: number, height?: number } | string }
 *
 * 鉴权:
 *   - 配置了 AW_DAQ_INGEST_TOKEN 时,要求 x-aw-daq-token 头匹配(外部系统接入);
 *   - 未配置时退回仪表盘用户会话(resolveUser),且**必须对该节点所属产线有 operate 权限**(WP2)。
 * 约束:
 *   - 节点必须存在且启用;载荷形态必须与模板 signalKind 一致(scalar/vector/image);
 *   - 向量 1..4096 个有限数;图像 ≤10MB 且 MIME image/*;
 *   - at 缺省=当前时间,回填窗默认 ±1h(env AW_DAQ_INGEST_BACKFILL_MS 可调,上限 7 天)。
 */
import { getHeader, getRouterParam, readBody } from 'h3'
import { resolveUser } from '@/server/api/workshop/caller'
import { defineApiHandler } from '@/server/utils/response'
import { getDaqController } from '@/server/services/workshop/daq/daq-controller'
import { findDaqTemplate } from '@/server/services/workshop/daq/daq-templates'
import { getDaqQueue } from '@/server/services/workshop/daq/bus'
import type { DaqSampleEnvelope } from '@/server/services/workshop/daq/bus/queue-port'
import { ingestAuthMode, ingestBackfillWindowMs, ingestFutureSkewMs, ingestTimeVerdict, isWideBackfillWindow } from '@/server/services/workshop/daq/ingest-policy'
import { recordOps } from '@/server/services/workshop/ops/ops'
import { AppError } from '@/server/utils/errors'

const IMAGE_MAX_BYTES = 10 * 1024 * 1024
const VECTOR_MAX_POINTS = 4096
/** 超宽回填窗告警只发一次(模块级;启动/首请求可见) */
let wideWindowWarned = false

interface IngestBody {
  at?: string
  value?: number | string
  points?: unknown
  values?: unknown
  metrics?: Record<string, unknown>
  state?: string
  image?: { base64?: string, data?: string, mime?: string, width?: number, height?: number } | string
}

function finiteList(raw: unknown): number[] | null {
  if (!Array.isArray(raw)) return null
  const out: number[] = []
  for (const x of raw) {
    const n = Number(x)
    if (!Number.isFinite(n)) return null
    out.push(n)
  }
  return out
}

function metricsOf(raw: unknown): Record<string, number> {
  if (raw === null || raw === undefined || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const out: Record<string, number> = {}
  for (const [k, v] of Object.entries(raw as Record<string, unknown>).slice(0, 64)) {
    const n = Number(v)
    if (Number.isFinite(n) && k.trim()) out[k.trim().slice(0, 80)] = n
  }
  return out
}

export default defineApiHandler(async (event) => {
  const id = getRouterParam(event, 'id') ?? ''
  const node = getDaqController().byId(id)
  if (!node) throw new AppError(404, 'NOT_FOUND', `数采节点不存在: ${id}`)

  // ── 鉴权(WP2)────────────────────────────────────────────────────────────
  // token 路径:边缘系统全局凭据(AW_DAQ_INGEST_TOKEN),语义不变;
  // 兜底会话路径:必须对该节点所属产线有 operate 权限 —— 此前仅 resolveUser,
  // 任意注册用户可向任意节点注入(含回填)伪造样本污染训练链。
  {
    const mode = ingestAuthMode({
      configuredToken: process.env.AW_DAQ_INGEST_TOKEN,
      providedToken: String(getHeader(event, 'x-aw-daq-token') ?? ''),
    })
    if (mode === 'token-mismatch') {
      throw new AppError(401, 'UNAUTHORIZED', '数采推送鉴权失败:请提供正确的 x-aw-daq-token(AW_DAQ_INGEST_TOKEN)。')
    }
    if (mode === 'session') {
      const user = resolveUser(event)
      const { requireLineMode } = await import('@/server/services/workshop/permissions')
      requireLineMode(user, node.lineId, 'operate')
    }
    if (isWideBackfillWindow() && !wideWindowWarned) {
      wideWindowWarned = true
      console.warn(`[daq.ingest] AW_DAQ_INGEST_BACKFILL_MS=${ingestBackfillWindowMs()} 超过默认 1h 安全窗(回填投毒面扩大)`)
      recordOps({
        actor: 'system', actorName: 'daq.ingest', actorKind: 'system',
        action: 'policy.degrade.warn', kind: 'system', level: 'warn',
        targetKind: 'system', targetId: 'daq.ingest.backfill',
        summary: `数采推送回填窗被配置为 ${Math.round(ingestBackfillWindowMs() / 3600_000)}h(默认 1h,上限 7d)`,
      })
    }
  }

  if (!node.enabled) throw new AppError(409, 'CONFLICT', `数采节点「${node.name}」已停用,不接受推送。`)
  // 网关停止时消费侧会丢弃队列帧(采集暂停):必须在解析/上传任何载荷**之前**拒绝,
  // 否则图像会先落对象存储再返回 503,留下无引用对象。
  if (!getDaqController().running) {
    throw new AppError(503, 'UNAVAILABLE', 'DAQ 网关已停止,外部入库暂停;请先启动采集网关(POST /api/workshop/daq/controller action=start)')
  }
  const tpl = findDaqTemplate(node.templateKey)
  const kind = tpl?.signalKind ?? 'scalar'
  const body = await readBody<IngestBody>(event) ?? {}

  const now = Date.now()
  const atRaw = String(body.at ?? '').trim()
  const atMs = atRaw ? Date.parse(atRaw) : now
  if (!Number.isFinite(atMs)) throw new AppError(400, 'VALIDATION_ERROR', `at 不是合法时间: ${atRaw}(示例 2026-10-19T12:00:00+08:00)`)
  const windowMs = ingestBackfillWindowMs()
  const verdict = ingestTimeVerdict(atMs, now, windowMs, ingestFutureSkewMs())
  if (verdict === 'future') {
    throw new AppError(400, 'FUTURE_TIMESTAMP', `at 超出当前时间允许的前瞻偏差(最多 ${Math.round(ingestFutureSkewMs() / 1000)}s);请校准上游时钟后重试。`)
  }
  if (verdict === 'out-of-window') {
    throw new AppError(400, 'VALIDATION_ERROR', `at 超出允许的回填范围(${Math.round(windowMs / 60_000)} 分钟),请检查时区/时钟。`)
  }
  const at = new Date(atMs).toISOString()
  const state = ['ok', 'warn', 'alarm', 'offline'].includes(String(body.state ?? '')) ? String(body.state) : 'ok'
  const metrics = metricsOf(body.metrics)
  let env: DaqSampleEnvelope

  if (kind === 'image') {
    const img = body.image
    const base64 = typeof img === 'string'
      ? img
      : String(img?.base64 ?? img?.data ?? '').trim()
    if (!base64) throw new AppError(400, 'VALIDATION_ERROR', '图像节点的载荷必须提供 image.base64(或 image.data)。')
    const mime = typeof img === 'object' && img?.mime ? String(img.mime) : 'image/png'
    if (!/^image\//i.test(mime)) throw new AppError(400, 'VALIDATION_ERROR', `image.mime 必须是 image/*(收到 ${mime})`)
    let buf: Buffer
    try {
      buf = Buffer.from(base64.replace(/^data:[^,]+,/, ''), 'base64')
    }
    catch {
      throw new AppError(400, 'VALIDATION_ERROR', 'image.base64 解码失败。')
    }
    if (buf.length === 0) throw new AppError(400, 'VALIDATION_ERROR', '图像内容为空。')
    if (buf.length > IMAGE_MAX_BYTES) throw new AppError(413, 'PAYLOAD_TOO_LARGE', `图像超过 ${IMAGE_MAX_BYTES / 1024 / 1024}MB 上限。`)
    const width = Number(body.image && typeof body.image === 'object' ? body.image.width : NaN)
    const height = Number(body.image && typeof body.image === 'object' ? body.image.height : NaN)
    // A-P1-3(2026-10-28 审查):外部推送与驱动采样/推送订阅走**同一个** processFrameSample
    // —— 模板 sink 管线(thumbnail/deriveMetric/qualityGate)与落对象存储、sha256/size
    // 计算都在服务端完成,绝不信任调用方自报的指标/指纹,也不绕过质量门。
    const processed = await getDaqController().processExternalFrame(node, {
      kind: 'image',
      blob: buf,
      mime,
      width: Number.isFinite(width) ? width : undefined,
      height: Number.isFinite(height) ? height : undefined,
      metrics,
    }, atMs)
    if (!processed) throw new AppError(400, 'VALIDATION_ERROR', '图像帧被 sink 管线拒绝(模板/处理器配置不支持该帧)。')
    env = {
      nodeId: node.id,
      templateRef: node.templateRef,
      value: Number((processed.frame.metrics?.avg ?? metrics.avg ?? 0).toFixed(node.decimals)),
      state,
      at,
      frame: processed.frame,
    }
  }
  else if (kind === 'vector') {
    const points = finiteList(body.points ?? body.values)
    if (!points || points.length === 0) throw new AppError(400, 'VALIDATION_ERROR', '向量节点的载荷必须提供 points 数组。')
    if (points.length > VECTOR_MAX_POINTS) throw new AppError(413, 'PAYLOAD_TOO_LARGE', `向量点数 ${points.length} 超过 ${VECTOR_MAX_POINTS} 上限。`)
    const avg = points.reduce((a, b) => a + b, 0) / points.length
    // 同上:派生指标由模板 sink 处理器产生(调用方只提供原始点列/可选初值)
    const processed = await getDaqController().processExternalFrame(node, { kind: 'vector', points, metrics }, atMs)
    if (!processed) throw new AppError(400, 'VALIDATION_ERROR', '向量帧被 sink 管线拒绝(模板/处理器配置不支持该帧)。')
    env = {
      nodeId: node.id,
      templateRef: node.templateRef,
      value: Number((processed.frame.metrics?.avg ?? metrics.avg ?? avg).toFixed(node.decimals)),
      state,
      at,
      frame: processed.frame,
    }
  }
  else {
    const value = Number(body.value)
    if (!Number.isFinite(value)) throw new AppError(400, 'VALIDATION_ERROR', '标量节点的载荷必须提供数值 value。')
    env = { nodeId: node.id, templateRef: node.templateRef, value, state, at }
  }

  await getDaqQueue().then(q => q.publish(env))
  return {
    accepted: true,
    nodeId: node.id,
    kind,
    at,
    lineId: node.lineId ?? null,
    ...(env.frame?.kind === 'image' ? { objectKey: env.frame.objectKey, bytes: env.frame.size } : {}),
    ...(env.frame?.kind === 'vector' ? { points: env.frame.points?.length } : {}),
  }
})
