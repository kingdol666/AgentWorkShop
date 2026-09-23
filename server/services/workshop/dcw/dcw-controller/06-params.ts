/**
 * DcwControllerLayer06 —— 工艺参数映射与读写
 * (分层 7/10,承 DcwControllerLayer05;方法体与原文件逐行一致)
 */
import { DcwControllerLayer05 } from './05-write'
import type { DcwParamInput, DcwParamView, DcwWriteMeta } from '../../../../../shared/dcw-protocol'
import { AppError, ErrorCodes } from '../../../../utils/errors'
import { deriveAccess } from '../param-conversion'
import { getDcwLineRepo } from '../dcw-line.repo'
import { getDcwParamRepo } from '../param-map.repo'
import { limitsBreakdownOf } from '../param-limits'

export abstract class DcwControllerLayer06 extends DcwControllerLayer05 {
  /**
   * 创建工艺参数映射。两条路径:
   *  - nodeId 绑定路径:映射指向既有执行节点;
   *  - access 接入路径:设备连接 + 寄存器 + **标准转换模式**一键建映射 —— 系统
   *    按转换模式展开驱动配置并自动创建执行节点(float32 直写 / int16·int32 线性
   *    标定),配置期一次性选定,运行期双向换算全自动。
   */
  createParamMapping(input: DcwParamInput): DcwParamView {
    const access = input.access
    if (!access) {
      const row = getDcwParamRepo().create(input)
      return this.paramById(row.id)
    }
    if (input.nodeId) {
      throw new AppError(400, ErrorCodes.VALIDATION_ERROR, 'access 与 nodeId 互斥:access 路径由系统自动创建执行节点')
    }
    if (!input.templateRef) {
      throw new AppError(400, ErrorCodes.VALIDATION_ERROR, 'templateRef 必填:工艺参数需绑定语义模板(单位/量程/语义)')
    }
    const lineId = String(input.lineId ?? '')
    if (lineId && !getDcwLineRepo().byId(lineId)) throw new AppError(404, ErrorCodes.NOT_FOUND, `产线不存在: ${lineId}`)
    const derived = deriveAccess(access)
    // 执行节点:驱动配置由转换模式展开(单一事实源);标定工程量程即节点安全量程
    const node = this.create({
      templateRef: input.templateRef,
      name: input.name,
      driver: derived.driver,
      driverConfig: derived.driverConfig,
      min: derived.engMin,
      max: derived.engMax,
      lineId,
    })
    // this.create() 已自动生成参数面;覆盖语义面(key/名称/基准限界)并留存转换模式
    const auto = getDcwParamRepo().byNode(node.id)
    const row = getDcwParamRepo().update(auto!.id, {
      key: input.key,
      name: input.name,
      min: input.min ?? null,
      max: input.max ?? null,
      conversion: access.conversion,
    })
    return this.paramById(row.id)
  }

  listParamViews(): DcwParamView[] {
    return getDcwParamRepo().listViews()
  }

  paramById(id: string): DcwParamView {
    const row = getDcwParamRepo().byId(id)
    if (!row) throw new AppError(404, ErrorCodes.NOT_FOUND, `工艺参数不存在: ${id}`)
    const view = getDcwParamRepo().viewOf(row)
    if (!view) throw new AppError(404, ErrorCodes.NOT_FOUND, `工艺参数 ${id} 的执行节点已不存在(映射悬空)`)
    return view
  }

  /** 参数寻址写命令:工程量直写,限界联锁在 write() 咽喉点统一生效 */
  async writeParam(id: string, value: number, meta?: DcwWriteMeta, recipeRunId: string | null = null) {
    const row = getDcwParamRepo().byId(id)
    const node = row ? this.repo.byId(row.nodeId) : undefined
    if (!row || !node) throw new AppError(404, ErrorCodes.NOT_FOUND, `工艺参数不存在(或执行节点已删除): ${id}`)
    const outcome = await this.write(node.id, value, recipeRunId, meta)
    return { ...outcome, param: getDcwParamRepo().viewOf(row) }
  }

  /** 参数寻址读命令(读执行节点 PLC 值,标定解码为物理量) */
  async readParam(id: string) {
    const row = getDcwParamRepo().byId(id)
    const node = row ? this.repo.byId(row.nodeId) : undefined
    if (!row || !node) throw new AppError(404, ErrorCodes.NOT_FOUND, `工艺参数不存在(或执行节点已删除): ${id}`)
    const read = await this.readNow(node.id)
    return { ...read, param: getDcwParamRepo().viewOf(row) }
  }

  /** 参数当前有效写入限界剖面(分层 + 交集;展示/工具回包共用) */
  paramLimitsOf(id: string) {
    const row = getDcwParamRepo().byId(id)
    const node = row ? this.repo.byId(row.nodeId) : undefined
    if (!row || !node) throw new AppError(404, ErrorCodes.NOT_FOUND, `工艺参数不存在(或执行节点已删除): ${id}`)
    return limitsBreakdownOf(node)
  }

  // ---------- Recipe 配方 ----------
}
