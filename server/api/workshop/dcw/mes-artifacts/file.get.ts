/**
 * GET /api/workshop/dcw/mes-artifacts/file?node_id=&name= —— 读单个 MES 产物文件。
 * 目录遍历防护:name 只取 basename,拼出的路径必须仍解析回该节点产物目录内;
 * 图像/SVG 以 inline 呈现(UI 弹窗预览),其余文本按 text/plain 返回。
 * 注意:二进制路由不走 defineApiHandler(JSON 信封会把 Buffer 序列化成
 * {type:'Buffer',data:[…]} 文本),与 daq 帧内容路由同纪律。
 */
import { createError, defineEventHandler, getQuery, setResponseHeader } from 'h3'
import { readFileSync, statSync } from 'node:fs'
import { basename, join, resolve, sep } from 'node:path'
import { resolveUser } from '@/server/api/workshop/caller'
import { mesArtifactsRoot } from '@/server/services/workshop/mes/mes-hook'

const MIME_OF = (name: string): string => {
  const n = name.toLowerCase()
  if (n.endsWith('.png')) return 'image/png'
  if (n.endsWith('.jpg') || n.endsWith('.jpeg')) return 'image/jpeg'
  if (n.endsWith('.svg')) return 'image/svg+xml'
  if (n.endsWith('.json')) return 'application/json'
  if (n.endsWith('.csv')) return 'text/csv'
  return 'text/plain; charset=utf-8'
}

export default defineEventHandler(async (event) => {
  resolveUser(event)
  const q = getQuery(event)
  const nodeId = String(q.node_id ?? '').trim().slice(0, 64)
  const name = basename(String(q.name ?? '').trim())
  if (!nodeId || !name) {
    throw createError({ statusCode: 400, statusMessage: 'node_id 与 name 必填' })
  }
  const root = resolve(join(mesArtifactsRoot(), nodeId))
  const file = resolve(join(root, name))
  if (file !== root && !file.startsWith(root + sep)) {
    throw createError({ statusCode: 403, statusMessage: '路径越界:只允许读取该点位产物目录内的文件' })
  }
  let buf: Buffer
  try {
    const st = statSync(file)
    if (!st.isFile()) throw new Error('not a file')
    buf = readFileSync(file)
  }
  catch {
    throw createError({ statusCode: 404, statusMessage: `产物不存在:${nodeId}/${name}` })
  }
  setResponseHeader(event, 'content-type', MIME_OF(name))
  setResponseHeader(event, 'content-disposition', `inline; filename="${encodeURIComponent(name)}"`)
  setResponseHeader(event, 'cache-control', 'no-store')
  return buf
})
