/**
 * DcwNodeRuntime —— 单节点边缘控制运行时(与 DaqNodeRuntime 对称)。
 *
 * 私有状态:写入在飞互斥、保写心跳节拍。用户/Recipe 设定的是工程量;
 * PLC 底层(换算/编码/写/回读校验)由网关 executeWrite 封装,运行时只做
 * 门控与调度:手动写命令 + 保写周期心跳重下发(上位机 SPS 保活语义)。
 */

import { AppError, ErrorCodes } from '../../../utils/errors'
import type { DcwNode } from './dcw-node'

/** 回读死区容差:max(0.5×10^-小数位, 量程 0.5%) */
export function writeTolerance(node: DcwNode): number {
  return Math.max(0.5 * 10 ** -node.decimals, (node.max - node.min) * 0.005)
}

export interface DcwWriteOutcome {
  ok: boolean
  message: string
  raw: number | null
  readback: number | null
  /** 调控闭环:本次写产生的参数锚(入册成功时) */
  anchorId?: string
  /** 调控闭环:Agent/回退路径开出的优化记录 id(manual/recipe 路径无) */
  recordId?: string
}

export interface DcwRuntimeHost {
  running(): boolean
  defaults(): { holdIntervalMs: number, readIntervalMs: number }
  /** 网关执行写命令(驱动写 + ACK 记账 + 写历史 + WS 广播) */
  executeWrite(node: DcwNode, eng: number, tolerance: number, recipeRunId: string | null): Promise<DcwWriteOutcome>
  /** 网关执行读数(驱动读 + 读状态记账 + WS 广播;返回物理值) */
  executeRead(node: DcwNode): Promise<{ ok: boolean, value: number | null, raw: number | null, message: string, at: string }>
}

export interface DcwReadOutcome {
  ok: boolean
  value: number | null
  raw: number | null
  message: string
  at: string
}

export class DcwNodeRuntime {
  private writing = false
  private lastHoldAt = 0
  /** 周期读节拍 + 在飞互斥(读事务不与写事务互斥,但同节点读不重入) */
  private lastReadTick = 0
  private reading = false

  constructor(
    public readonly node: DcwNode,
    private readonly host: DcwRuntimeHost,
  ) {}

  /** 元数据变更后重置保写/周期读节拍 */
  rearm(): void {
    this.lastHoldAt = 0
    this.lastReadTick = 0
  }

  /**
   * 用户/Recipe 设定值(核心写命令入口)。
   * 工艺安全量程硬校验(越界拒绝)+ 在飞互斥(同一通道同时只允许一个写事务)。
   */
  async write(eng: number, recipeRunId: string | null = null): Promise<DcwWriteOutcome> {
    const node = this.node
    const invalid = node.validateEng(eng)
    if (invalid) throw new AppError(400, ErrorCodes.VALIDATION_ERROR, invalid)
    if (this.writing || node.state === 'writing') {
      throw new AppError(409, ErrorCodes.CONFLICT, `通道「${node.name}」写入进行中,请稍后重试`)
    }
    this.writing = true
    node.state = 'writing'
    node.lastWriteAt = new Date().toISOString()
    try {
      return await this.host.executeWrite(node, eng, writeTolerance(node), recipeRunId)
    }
    catch (err) {
      // 执行链抛错(异常不流向 outcome):状态机必须离开 writing,否则通道永久 409
      if (node.state === 'writing') node.state = 'error'
      throw err
    }
    finally {
      this.writing = false
    }
  }

  /** 网关 tick:保写心跳(元数据 holdIntervalMs;null = 仅手动下发)。
   *  对当前设定值周期性重下发(PLC 掉电重启后的设定恢复语义)。
   *  周期读(元数据 readIntervalMs):读是被动观测,不受产线运行/写在飞限制
   *  (仅与在飞读互斥),failures 只记 lastReadError 不改写状态机。 */
  tick(now: number): void {
    const node = this.node
    // 保写心跳:仅对已设定过的节点生效(尚无设定值无可保持)
    if (!this.writing && node.enabled && node.value != null && node.state !== 'writing') {
      const hold = node.holdIntervalMs ?? this.host.defaults().holdIntervalMs
      if (hold && hold > 0 && now - this.lastHoldAt >= hold) {
        this.lastHoldAt = now
        void this.host.executeWrite(node, node.value, writeTolerance(node), null).catch(() => {})
      }
    }
    // 周期读:被动观测,不依赖写过、不与写在飞互斥(仅同节点读串行)
    if (this.reading || !node.enabled) return
    const readInt = node.readIntervalMs ?? this.host.defaults().readIntervalMs
    if (!readInt || readInt <= 0) return
    if (now - this.lastReadTick < readInt) return
    this.lastReadTick = now
    void this.host.executeRead(node).catch(() => {})
  }

  /** 手动读取(on-demand;REST/Agent 工具共用;与周期读同一在飞互斥) */
  async readNow(): Promise<DcwReadOutcome> {
    if (this.reading) throw new AppError(409, ErrorCodes.CONFLICT, `通道「${this.node.name}」读取进行中,请稍后重试`)
    this.reading = true
    try {
      return await this.host.executeRead(this.node)
    }
    finally {
      this.reading = false
    }
  }
}
