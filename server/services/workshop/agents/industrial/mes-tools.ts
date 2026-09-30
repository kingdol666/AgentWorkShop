/**
 * MES 数据集工具族(mes_catalog / mes_fetch / mes_dataset_read / mes_datasets)。
 *
 * 面向 Agent 的 MES REST 点位只读面:目录检索、历史取数(护栏在 mes-controller 代码级)、
 * CSV 数据集读取与清单。铁律:MES 行级原文不进 prompt —— 所有回包只给统计摘要 + ≤3 行采样;
 * 全量原文只落 <configRoot>/datasets/<id>.csv(见 services/workshop/mes/mes-datasets.ts)。
 * 权限:fetch 按 dcw 绑线过滤(controller 内代码级);数据集读取/清单按
 * 创建者 ∪ 节点绑定 ∪ 可读产线(agentOpsScope 既有路径)过滤。
 */
import type { MesDatasetRow, MesDatasetRead } from '../../mes/mes-datasets'
import { getMesDatasets } from '../../mes/mes-datasets'
import { createMesController } from '../../mes/mes-controller'
import { agentOpsScope } from './ops-tools'
import { AppError } from '../../../../utils/errors'

/** 控制器单例(护栏依赖真实服务;无状态可安全复用) */
let controller: ReturnType<typeof createMesController> | null = null
function mesController(): ReturnType<typeof createMesController> {
  controller ??= createMesController()
  return controller
}

/** 数据集可见性:创建者 ∪ 节点绑定 ∪ 可读产线(节点授权线 ∪ 频道绑定线) */
function mesDatasetVisible(agentId: string, ds: MesDatasetRow): boolean {
  if (ds.createdBy === agentId) return true
  const scope = agentOpsScope(agentId)
  if (!scope) return false
  if (scope.nodeIds.has(ds.nodeId)) return true
  return !!ds.lineId && (scope.lineIds.includes(ds.lineId) || scope.boundLineIds.includes(ds.lineId))
}

/** 数据集行 → 一行摘要(id | 节点 | 窗口 | 行数 | 状态) */
function dsLine(ds: MesDatasetRow): string {
  const win = ds.fromTs && ds.toTs ? `${ds.fromTs.slice(5, 16).replace('T', ' ')} ~ ${ds.toTs.slice(5, 16).replace('T', ' ')}` : '当前值'
  let state: string
  if (ds.status === 'ready') state = `就绪(${ds.rows} 行,sha256 ${ds.sha256.slice(0, 8)})`
  else if (ds.status === 'running') state = '取数中'
  else state = `失败(${ds.error.slice(0, 80)})`
  return `- ${ds.id} | ${ds.nodeName || ds.nodeId} | ${win} | ${state}`
}

/** 工具:mes_catalog —— MES REST 点位目录(数据驱动;q 子串/产线过滤;按调用者可读产线严格过滤:
 *  跨产线与孤儿(未分配)点位不可见;未绑线的 agent 得到空目录 —— 与 mes_fetch 的授权口径一致)。 */
export async function toolMesCatalog(agentId: string, args: { q?: string, line_id?: string, limit?: number | string } = {}): Promise<{ text: string, isError?: boolean }> {
  try {
    const scope = agentOpsScope(agentId)
    const scopeLineIds = scope ? [...scope.lineIds] : []
    const r = await mesController().catalog({ ...args, scope_line_ids: scopeLineIds })
    if (r.entries.length === 0 && scopeLineIds.length === 0) {
      return { text: '你还没有可读的产线绑定,无可见 MES 点位。先完成产线绑定与节点绑定后再用 mes_catalog。' }
    }
    return { text: r.text }
  }
  catch (err) {
    return { text: `MES 点位目录查询失败:${err instanceof Error ? err.message : String(err)}(服务未就绪时请稍后重试)。`, isError: true }
  }
}

/** 工具:mes_fetch —— MES 历史取数(护栏代码级:绑线授权/窗口≤7天/行数≤5000/每分钟≤6次)。
 *  三模式:无 from/to=当前值快照;小窗口内联统计;大请求异步落 CSV 数据集(回 job_id/dataset_id,
 *  勿轮询,用 mes_datasets 查状态)。回包只含统计摘要 + ≤3 行采样,MES 原文不进对话。 */
export async function toolMesFetch(agentId: string, args: { ids?: unknown, from?: string, to?: string, max_rows?: number | string } = {}): Promise<{ text: string, isError?: boolean }> {
  try {
    const r = await mesController().fetch(agentId, args)
    return { text: r.text, isError: r.isError }
  }
  catch (err) {
    return { text: `MES 取数失败:${err instanceof Error ? err.message : String(err)}(驱动离线或点位配置缺失时常见;可先用 mes_catalog 确认点位)。`, isError: true }
  }
}

/** 工具:mes_dataset_read —— 读 CSV 数据集(head=列名+总行数 / stats=统计 / rows=分页)。
 *  权限:创建者或有该节点/产线可见权;回包同样只带 ≤3 行采样(原文不进 prompt)。 */
export async function toolMesDatasetRead(agentId: string, args: { dataset_id?: string, mode?: string, offset?: number | string } = {}): Promise<{ text: string, isError?: boolean }> {
  const datasetId = String(args.dataset_id ?? '').trim()
  if (!datasetId) return { text: 'dataset_id 必填(mes_fetch 异步回包或 mes_datasets 清单里的 id)。', isError: true }
  const modeArg = String(args.mode ?? 'head').trim()
  const mode = modeArg === 'stats' || modeArg === 'rows' ? modeArg : 'head'
  try {
    const store = getMesDatasets()
    const meta = store.datasetMeta(datasetId)
    if (!meta) return { text: `数据集 ${datasetId} 不存在(用 mes_datasets 列出你可读的数据集)。`, isError: true }
    if (!mesDatasetVisible(agentId, meta)) {
      return { text: `无权读取数据集 ${datasetId}(仅创建者、该节点绑定者或该产线可读者可读)。`, isError: true }
    }
    const r: MesDatasetRead = store.readDataset(datasetId, mode, Number(args.offset) || 0)
    const stateTxt = meta.status === 'ready' ? '' : meta.status === 'running' ? '\n注意:数据集仍在取数中,当前为已写入部分。' : `\n注意:取数已失败:${meta.error.slice(0, 120)}(以下为失败前已写入部分)。`
    if (r.mode === 'stats') {
      const s = r.stats
      const f4 = (v: number | null | undefined): string => v == null || !Number.isFinite(v) ? '-' : String(Number(v.toFixed(4)))
      return {
        text: `数据集 ${datasetId} 统计(${meta.nodeName || meta.nodeId},产线 ${meta.lineId || '未分配'}):\n`
          + `  数值行数 ${s.count} | 首 ${s.firstTs ?? '-'} ~ 末 ${s.lastTs ?? '-'}\n`
          + `  min ${f4(s.min)} / max ${f4(s.max)} / mean ${f4(s.mean)} / stddev ${f4(s.stddev)}\n`
          + `  文件 sha256 ${meta.sha256.slice(0, 16)}${stateTxt}`,
      }
    }
    // head / rows:列名+行数+分页游标,采样 ≤3 行(原文不进 prompt)
    let headTxt: string
    let totalRows: number
    let sample: string[]
    if (r.mode === 'head') {
      headTxt = `数据集 ${datasetId} 概览(${meta.nodeName || meta.nodeId},产线 ${meta.lineId || '未分配'}):\n  列名: ${r.head.columns.join(', ')}\n  总行数: ${r.head.totalRows}\n`
      totalRows = r.head.totalRows
      sample = r.head.preview.slice(0, 3).map(row => row.join(','))
    }
    else {
      headTxt = `数据集 ${datasetId} 第 ${r.rowsView.offset} 行起的分页(每页 20 行,共 ${r.rowsView.total} 行;本页 ${r.rowsView.rows.length} 行):\n`
      totalRows = r.rowsView.total
      sample = r.rowsView.rows.slice(0, 3).map(row => row.join(','))
    }
    return {
      text: `${headTxt}采样(≤3 行,ts,value): ${sample.join(' | ') || '(空)'}${totalRows > 3 ? '(其余行不进对话;统计用 mode=stats,分页翻看用 offset)' : ''}${stateTxt}`,
    }
  }
  catch (err) {
    if (err instanceof AppError && err.status === 404) return { text: err.message, isError: true }
    return { text: `数据集读取失败:${err instanceof Error ? err.message : String(err)}`, isError: true }
  }
}

/** 工具:mes_datasets —— 你可见的 CSV 数据集清单(新→旧;创建者/节点绑定/产线可读过滤)。
 *  用于找回 mes_fetch 异步作业的 dataset_id 与确认取数状态(替代轮询 job)。 */
export async function toolMesDatasets(agentId: string, args: { limit?: number | string } = {}): Promise<{ text: string, isError?: boolean }> {
  try {
    const store = getMesDatasets()
    const limit = Math.min(Math.max(Math.round(Number(args.limit)) || 20, 1), 100)
    const visible = store.listDatasets(100).filter(ds => mesDatasetVisible(agentId, ds)).slice(0, limit)
    if (visible.length === 0) {
      return { text: '你还没有可见的 MES 数据集。用 mes_fetch(带 from/to 与较大 max_rows)创建;或刚创建的作业尚未登记(稍后再查)。' }
    }
    const running = visible.filter(ds => ds.status === 'running').length
    return {
      text: `MES 数据集清单(可见 ${visible.length} 条,新→旧${running > 0 ? `;其中 ${running} 条取数中 —— 勿轮询,未完成先做别的` : ''}):\n${visible.map(dsLine).join('\n')}\n\n说明:读统计用 mes_dataset_read(dataset_id, mode=stats);读分页/概览用 mode=head|rows。`,
    }
  }
  catch (err) {
    return { text: `数据集清单查询失败:${err instanceof Error ? err.message : String(err)}(服务未就绪时请稍后重试)。`, isError: true }
  }
}
