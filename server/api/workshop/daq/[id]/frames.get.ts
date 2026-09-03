/**
 * GET /api/workshop/daq/:id/frames —— 节点帧历史(v2 多形态信号:向量/图像元数据)。
 * query: from?/to?(epoch ms)、kind?(vector|image)、limit?(默认 100,上限 1000)
 * 图像像素经 contentUrl(鉴权流式)按需取,本接口只返回元数据与派生指标。
 */
import { getQuery, getRouterParam } from 'h3'
import { resolveUser } from '@/server/api/workshop/caller'
import { defineApiHandler } from '@/server/utils/response'
import { getDaqController } from '@/server/services/workshop/daq/daq-controller'

export default defineApiHandler(async (event) => {
  resolveUser(event)
  const id = getRouterParam(event, 'id') ?? ''
  const q = getQuery(event)
  const num = (k: string): number | undefined => (q[k] != null && !Number.isNaN(Number(q[k])) ? Number(q[k]) : undefined)
  const kind = q.kind === 'vector' || q.kind === 'image' ? q.kind : undefined
  const frames = await getDaqController().frames(id, {
    fromMs: num('from'),
    toMs: num('to'),
    kind,
    limit: num('limit'),
  })
  return {
    frames: frames.map(f => ({
      at: f.at,
      kind: f.kind,
      points: f.points,
      metrics: f.metrics,
      /** 图像元数据(objectKey/thumbKey/mime/width/height) */
      meta: f.meta,
      deviceBindingId: f.deviceBindingId,
      lineId: f.lineId,
      productId: f.productId,
      recipeId: f.recipeId,
      runId: f.runId,
      contentUrl: f.kind === 'image'
        ? `/api/workshop/daq/${id}/frames/content?ts=${f.at}`
        : undefined,
      thumbUrl: f.kind === 'image'
        ? `/api/workshop/daq/${id}/frames/content?ts=${f.at}&thumb=1`
        : undefined,
    })),
  }
})
