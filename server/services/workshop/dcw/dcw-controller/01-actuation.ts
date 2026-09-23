/**
 * DcwControllerLayer01 —— 写执行 / 读执行 / 变更广播
 * (分层 2/10,承 DcwControllerLayer00;方法体与原文件逐行一致)
 */
import { DcwControllerLayer00 } from './00-state'
import type { AepDcwNodeChange } from '../../../../../shared/dcw-protocol'
import type { DcwWriteHistoryEntry } from '../dcw-recipe.repo'
import { AppError, ErrorCodes } from '../../../../utils/errors'
import type { DcwNode } from '../dcw-node'
import { applyTransform, inverseTransform } from '../../../../../shared/dcw-protocol'
import { findDcwTemplate } from '../dcw-templates'
import { getDcwRecipeRepo } from '../dcw-recipe.repo'
import { randomUUID } from 'node:crypto'
import { resolveDcwDriver } from '../drivers'

export abstract class DcwControllerLayer01 extends DcwControllerLayer00 {
  /**
   * 核心写执行:驱动写(工程量→原始值换算 + 回读校验在驱动内)
   * → ACK 记账(节点状态/写历史)→ WS 直推。真实/模拟驱动同一路径。
   */
  protected async executeWrite(node: DcwNode, eng: number, tolerance: number, recipeRunId: string | null): Promise<{ ok: boolean, message: string, raw: number | null, readback: number | null }> {
    const at = new Date().toISOString()
    // 数据语义标定钩子(encode):物理值 → PLC 设定值。
    // 回读值再经 decoder 换算回物理量做死区校验(容差按标定比例同步缩放)。
    const t = node.transform
    const plcValue = inverseTransform(eng, t)
    const plcTolerance = Math.max(tolerance, 1e-9) / (t?.kind === 'linear' && Math.abs(t.scale ?? 1) > 0 ? Math.abs(t.scale!) : 1)
    let outcome: { ok: boolean, message: string, raw: number | null, readback: number | null }
    try {
      outcome = await resolveDcwDriver(node.driver).write({
        eng: plcValue,
        tolerance: plcTolerance,
        domain: { min: node.min, max: node.max },
        driverConfig: node.driverConfig,
      })
      // 回读换算回物理量(message 保留 PLC 域数值供排查)
      if (outcome.readback != null) outcome.readback = applyTransform(outcome.readback, t)
      if (outcome.ok) outcome.message = `${outcome.message}(标定后物理值 ${Number((outcome.readback ?? eng).toFixed(node.decimals))})`
    }
    catch (err) {
      outcome = { ok: false, message: err instanceof Error ? err.message : String(err), raw: null, readback: null }
    }
    this.writesTotal++
    if (!outcome.ok) this.writesFailed++
    // set 后 hook:节点暴露值 = PLC 回读经 decoder 解码的**真实物理值**(而非指令值);
    // 回读缺失(驱动不支持)才回退指令值。节点对外呈现的始终是处理后的工艺参数。
    node.applyWriteResult(outcome.readback ?? eng, outcome.ok, outcome.message, at)
    // 写值走防抖落盘:保写心跳按 holdIntervalMs 周期触发本方法,同步全量重写
    // dcws.json 会随节点数放大成周期性 fs 抖动;防抖窗内崩溃丢失的设定值可从 PLC 回读恢复
    this.repo.flushDebounced()
    const repo = getDcwRecipeRepo()
    const entry: DcwWriteHistoryEntry = {
      id: `wh-${randomUUID().slice(0, 8)}`,
      nodeId: node.id,
      nodeName: node.name,
      param: findDcwTemplate(node.templateKey)?.ch ?? node.templateKey,
      eng: node.value ?? eng,
      raw: outcome.raw,
      ok: outcome.ok,
      message: outcome.message,
      recipeRunId,
      at,
    }
    repo.appendHistory(entry)
    this.broadcast?.('dcw.written', {
      nodeId: node.id,
      templateRef: node.templateRef,
      lineId: node.lineId ?? null,
      value: node.value ?? eng,
      raw: outcome.raw,
      ok: outcome.ok,
      message: outcome.message,
      recipeRunId,
      at,
    })
    this.emitNodeChanged('updated', node)
    return outcome
  }

  protected emitNodeChanged(op: AepDcwNodeChange['op'], node: DcwNode | null): void {
    const payload: AepDcwNodeChange = { op, node: node ? node.toView() : null }
    this.broadcast?.('dcw.node.changed', payload)
  }

  /**
   * 核心读执行:驱动读(寄存器解码 + 工程量映射在驱动内)→ 标定 decode(PLC 值 → 物理值)
   * → 读状态记账(节点 readValue/lastReadAt,失败记 lastReadError 不动写状态机)→ WS dcw.read 直推。
   * 不支持读的驱动(mock 外的 mqtt/http)不产生节点状态噪音,直接返回说明。
   */
  protected async executeRead(node: DcwNode): Promise<{ ok: boolean, value: number | null, raw: number | null, message: string, at: string }> {
    const at = new Date().toISOString()
    const driver = resolveDcwDriver(node.driver)
    if (!driver.read) {
      return { ok: false, value: null, raw: null, message: `驱动 ${node.driver} 不支持读取(仅观测型通道)`, at }
    }
    let r: { ok: boolean, message: string, eng: number | null, raw: number | null }
    try {
      r = await driver.read({ domain: { min: node.min, max: node.max }, driverConfig: node.driverConfig })
    }
    catch (err) {
      r = { ok: false, eng: null, raw: null, message: err instanceof Error ? err.message : String(err) }
    }
    // 读回的是 PLC 设定值域 → 经标定 decode 换算物理量(与写链路 inverse 互逆)
    const value = r.ok && r.eng != null ? applyTransform(r.eng, node.transform) : null
    node.applyReadResult(value, r.raw, r.ok, r.message, at)
    this.repo.flushDebounced()
    this.broadcast?.('dcw.read', {
      nodeId: node.id,
      templateRef: node.templateRef,
      lineId: node.lineId ?? null,
      value,
      raw: r.raw,
      ok: r.ok,
      message: r.message,
      at,
    })
    return { ok: r.ok, value, raw: r.raw, message: r.message, at }
  }

  /** 手动读取(REST/前端「读取」按钮/Agent 工具;走运行时在飞互斥) */
  async readNow(id: string): Promise<{ ok: boolean, value: number | null, raw: number | null, message: string, at: string }> {
    this.ensureLoop()
    const rt = this.runtimes.get(id)
    if (!rt) throw new AppError(404, ErrorCodes.NOT_FOUND, `控制节点不存在: ${id}`)
    return rt.readNow()
  }
}
