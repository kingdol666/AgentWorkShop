/**
 * GET /api/workshop/aml/datasets/:id/preview —— 目标/特征序列预览(≤512 窗,画图用)。
 * query: node?(缺省第一个 target;可为 target/feature/control 节点)、limit?
 */
import { getQuery, getRouterParam } from 'h3'
import { existsSync, closeSync, openSync, readSync } from 'node:fs'
import { join } from 'node:path'
import { defineApiHandler } from '@/server/utils/response'
import { resolveUser } from '@/server/api/workshop/caller'
import { requireLineMode } from '@/server/services/workshop/permissions'
import { AppError } from '@/server/utils/errors'
import { getAmlRuntime } from '@/server/services/workshop/aml/runtime'
import { loadManifest } from '@/server/services/workshop/aml/dataset-builder'

export default defineApiHandler(async (event) => {
  const user = resolveUser(event)
  const id = getRouterParam(event, 'id') ?? ''
  const rt = getAmlRuntime()
  const ds = rt.repo.dataset.get(id)
  if (!ds) throw new AppError(404, 'AML_DATASET_MISSING', `数据集 ${id} 不存在`)
  requireLineMode(user, ds.lineId, 'readonly')

  const manifest = loadManifest(ds)
  const q = getQuery(event)
  const node = (typeof q.node === 'string' && q.node) || manifest.targetNodes[0] || ''
  if (!node || !manifest.allNodes.includes(node)) {
    throw new AppError(422, 'AML_NODE_NOT_IN_DATASET', `节点 ${node || '(缺省)'} 不在该数据集中(可用:${manifest.targetNodes.join(',')})`)
  }
  const limit = Math.min(512, Math.max(16, Number(q.limit) || 256))

  const total = manifest.shapes.x[0]
  const stride = Math.max(1, Math.floor(total / limit))
  const series: { w: number, values: (number | null)[] }[] = []
  const j = manifest.allNodes.indexOf(node)
  const ti = manifest.targetNodes.indexOf(node)

  // 目标节点读 y(窗口未来段);其余读 x 历史末拍
  const buf = Buffer.alloc(4)
  const readF32 = (file: string, index: number): number => {
    if (!existsSync(file)) return Number.NaN
    const f = openSync(file, 'r')
    try {
      readSync(f, buf, 0, 4, index * 4)
      return buf.readFloatLE(0)
    }
    finally { closeSync(f) }
  }
  const yFile = join(ds.path, 'arrays', 'y.f32')
  const xFile = join(ds.path, 'arrays', 'x.f32')
  const F = manifest.shapes.y[1]
  const nTgt = manifest.shapes.y[2]
  const nAll = manifest.shapes.x[2]
  for (let w = 0; w < total; w += stride) {
    if (ti >= 0) {
      const values: (number | null)[] = []
      for (let k = 0; k < F; k++) {
        const v = readF32(yFile, (w * F + k) * nTgt + ti)
        values.push(Number.isFinite(v) ? v : null)
      }
      series.push({ w, values })
    }
    else {
      const v = readF32(xFile, (w * manifest.shapes.x[1] + manifest.shapes.x[1] - 1) * nAll + j)
      series.push({ w, values: [Number.isFinite(v) ? v : null] })
    }
  }
  return { node, role: ti >= 0 ? 'target' : manifest.controlNodes.includes(node) ? 'control' : 'feature', stride, total, series, norm: manifest.norm.y }
})
