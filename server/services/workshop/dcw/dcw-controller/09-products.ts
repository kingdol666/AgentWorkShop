/**
 * DcwControllerLayer09 —— 产品 CRUD 与运行数据
 * (分层 10/10,承 DcwControllerLayer08;方法体与原文件逐行一致)
 */
import { DcwControllerLayer08 } from './08-lines'
import type { ProductInput, ProductView } from '../../../../../shared/dcw-protocol'
import { AppError, ErrorCodes } from '../../../../utils/errors'
import { assertProductParamLimits } from './helpers'
import { getActiveLineRun } from '../line-run'
import { getDcwLineRepo } from '../dcw-line.repo'
import { getDcwProductRepo } from '../dcw-product.repo'
import { getDcwRecipeRepo } from '../dcw-recipe.repo'

export abstract class DcwControllerLayer09 extends DcwControllerLayer08 {
  listProducts(): ProductView[] {
    return getDcwProductRepo().all()
  }

  createProduct(input: ProductInput): ProductView {
    const lineId = String(input.lineId ?? '')
    if (lineId && !getDcwLineRepo().byId(lineId)) throw new AppError(404, ErrorCodes.NOT_FOUND, `产线不存在: ${lineId}`)
    assertProductParamLimits(lineId, input.paramLimits)
    return getDcwProductRepo().create({ ...input, lineId })
  }

  updateProduct(id: string, patch: Partial<ProductInput>): ProductView {
    if (patch.lineId) {
      const lid = String(patch.lineId)
      if (!getDcwLineRepo().byId(lid)) throw new AppError(404, ErrorCodes.NOT_FOUND, `产线不存在: ${lid}`)
    }
    const prev = getDcwProductRepo().byId(id)
    const targetLine = String(patch.lineId ?? prev?.lineId ?? '')
    assertProductParamLimits(targetLine, patch.paramLimits)
    const updated = getDcwProductRepo().update(id, patch)
    // 产品换线 → 旗下配方产线归属级联(开跑校验按 recipe.lineId)
    if (prev && prev.lineId !== updated.lineId) {
      const recipeRepo = getDcwRecipeRepo()
      for (const r of recipeRepo.list()) {
        if (r.productId === id) recipeRepo.setRecipeLine(r.id, updated.lineId)
      }
    }
    return updated
  }

  removeProduct(id: string): void {
    const product = getDcwProductRepo().byId(id)
    if (!product) throw new AppError(404, ErrorCodes.NOT_FOUND, `产品不存在: ${id}`)
    if (product.lineId && getActiveLineRun(product.lineId)?.productId === id) {
      throw new AppError(409, ErrorCodes.CONFLICT, '产品正在产线运行中,不可删除(请先停止数据采集)')
    }
    getDcwProductRepo().remove(id)
  }

  /**
   * 批次数据视图(产品隔离):批次窗口内的写历史 + 全部数采节点的窗口内汇总
   * (latest/avg/min/max/cnt,窗口 > 60s 时按窗口/100 自动降采样)。
   */
  async runData(id: string) {
    const repo = getDcwRecipeRepo()
    const run = repo.runById(id)
    if (!run) throw new AppError(404, ErrorCodes.NOT_FOUND, `批次不存在: ${id}`)
    const endMs = run.endedAt ? Date.parse(run.endedAt) : Date.now()
    const startMs = Date.parse(run.startedAt)
    const writes = repo.historyInWindow(run.startedAt, run.endedAt, id)
    const { getDaqNodeRepo } = await import('../../daq/daq-node.repo')
    const { getTsdb, tsdbReady } = await import('../../daq/storage')
    const { findDaqTemplate } = await import('../../daq/daq-templates')
    await tsdbReady
    const bucketMs = endMs - startMs > 60_000 ? Math.max(1000, Math.round((endMs - startMs) / 200)) : undefined
    const daq = [] as Array<{ templateRef: string, nodeId: string, nodeName: string, ch: string, unit: string, latest: number | null, avg: number | null, min: number | null, max: number | null, cnt: number }>
    // 并行查询(tsdb 往返一次/节点,互不依赖):N+1 串行会让 50 节点产线的批次视图放大 50 倍时延。
    // 只查本批次产线的节点:批次归属单线,跨线节点的 tsdb 往返是纯浪费(节点数增长线性放大)
    const lineNodes = getDaqNodeRepo().all().filter(n => !run.lineId || n.lineId === run.lineId)
    const results = await Promise.all(lineNodes.map(async (node) => {
      try {
        const points = await getTsdb().query(node.id, { fromMs: startMs, toMs: endMs, bucketMs, limit: 500 })
        return { node, points }
      }
      catch { return { node, points: [] } } // 单节点查询失败不阻塞整体
    }))
    for (const { node, points } of results) {
      {
        if (points.length === 0) continue
        const values = points.map(p => p.value ?? p.avg ?? 0).filter(v => Number.isFinite(v))
        if (values.length === 0) continue
        const tpl = findDaqTemplate(node.templateKey)
        daq.push({
          templateRef: node.templateRef,
          nodeId: node.id,
          nodeName: node.name,
          ch: tpl?.ch ?? node.templateKey,
          unit: node.unit,
          latest: values[values.length - 1]!,
          avg: Number((values.reduce((a, b) => a + b, 0) / values.length).toFixed(node.decimals)),
          min: Number(Math.min(...values).toFixed(node.decimals)),
          max: Number(Math.max(...values).toFixed(node.decimals)),
          cnt: values.length,
        })
      }
    }
    return { run, daq, writes }
  }
}
