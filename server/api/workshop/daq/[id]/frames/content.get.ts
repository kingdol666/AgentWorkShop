/**
 * GET /api/workshop/daq/:id/frames/content —— 帧图像内容(对象存储流式输出)。
 * query: ts(epoch ms,必填)、thumb?(1=缩略图,缺省主图)
 * 像素不落 Timescale(元数据分离,plan D1);此处经 DaqObjectStore 读取后直出。
 * 注意:二进制路由不走 defineApiHandler(JSON 信封会把 Buffer 序列化成
 * {type:'Buffer',data:[…]} 文本,84 字节 500 事故实录),h3 对 Buffer 原生二进制响应。
 */
import { createError, defineEventHandler, getQuery, getRouterParam, setResponseHeader } from 'h3'
import { resolveUser } from '@/server/api/workshop/caller'
import { getDaqController } from '@/server/services/workshop/daq/daq-controller'

export default defineEventHandler(async (event) => {
  resolveUser(event)
  const id = getRouterParam(event, 'id') ?? ''
  const q = getQuery(event)
  const ts = Number(q.ts)
  if (!Number.isFinite(ts) || ts <= 0) {
    throw createError({ statusCode: 400, statusMessage: '参数 ts(epoch ms)必填' })
  }
  const { data, mime } = await getDaqController().frameContent(id, ts, q.thumb === '1')
  setResponseHeader(event, 'content-type', mime)
  setResponseHeader(event, 'cache-control', 'private, max-age=86400')
  return data
})
