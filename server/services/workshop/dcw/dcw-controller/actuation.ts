/**
 * DcwControllerActuation —— 写执行 / 读执行 / 变更广播
 * (拆分层,承 DcwControllerState;方法体与原文件逐行一致)
 */
import { DcwControllerState } from './state'
import type { AepDcwNodeChange, WriteAckLevel } from '../../../../../shared/dcw-protocol'
import type { DcwWriteHistoryEntry } from '../dcw-recipe.repo'
import { AppError, ErrorCodes } from '../../../../utils/errors'
import type { DcwNode } from '../dcw-node'
import { applyTransform, inverseTransform } from '../../../../../shared/dcw-protocol'
import { findDcwTemplate } from '../dcw-templates'
import { getDcwRecipeRepo } from '../dcw-recipe.repo'
import { randomUUID } from 'node:crypto'
import { resolveDcwDriver } from '../drivers'
import { beginGovernanceDriverCall, endGovernanceDriverCall } from '../../agents/governance-harness-audit'
import type { ExecutionScope } from '../../agents/execution-scope'
import type { DcwWriteOutcome } from '../dcw-runtime'
import { writeTolerance } from '../dcw-runtime'
import { getTsdb } from '../../daq/storage'

/** 驱动未显式上报 ack 时的旧口径归一(ok+回读→设备证实;ok 无回读→链路受理;失败→未证实) */
function normalizeAck(outcome: { ok: boolean, readback: number | null, ack?: WriteAckLevel }): WriteAckLevel {
  if (outcome.ack) return outcome.ack
  if (!outcome.ok) return 'unverified'
  return outcome.readback != null ? 'readback-verified' : 'transport-ack'
}

export abstract class DcwControllerActuation extends DcwControllerState {
  /**
   * 核心写执行:驱动写(工程量→原始值换算 + 回读校验在驱动内)
   * → ACK 记账(节点状态/写历史)→ WS 直推。真实/模拟驱动同一路径。
   */
  protected async executeWrite(node: DcwNode, eng: number, tolerance: number, recipeRunId: string | null, executionScope?: ExecutionScope, onDriverStart?: () => void): Promise<DcwWriteOutcome> {
    const at = new Date().toISOString()
    // 数据语义标定钩子(encode):物理值 → PLC 设定值。
    // 回读值再经 decoder 换算回物理量做死区校验(容差按标定比例同步缩放)。
    const t = node.transform
    const plcValue = inverseTransform(eng, t)
    const plcTolerance = Math.max(tolerance, 1e-9) / (t?.kind === 'linear' && Math.abs(t.scale ?? 1) > 0 ? Math.abs(t.scale!) : 1)
    executionScope?.assertActive()
    const driver = resolveDcwDriver(node.driver)
    const driverAudit = beginGovernanceDriverCall({
      node_id: node.id, line_id: node.lineId ?? null, driver: node.driver,
      requested_value: eng, plc_value: plcValue, tolerance: plcTolerance,
      recipe_run_id: recipeRunId, driver_config: node.driverConfig,
    })
    let outcome: { ok: boolean, message: string, raw: number | null, readback: number | null, ack?: WriteAckLevel }
    // Do not turn a revoked lease into an ordinary driver failure.
    executionScope?.assertActive()
    node.holdBlocked = true
    // 保写锁持久化失败 = 驱动绝不下发(503 外抛,不得进 try 被 catch 吞成失败 outcome);
    // 治理审计同步收口(driver_start↔end 配对),避免留下无 end 的悬挂 driver_call(审查 P2)。
    if (!this.repo.flushNow()) {
      endGovernanceDriverCall(driverAudit, { ok: false, message: '保写锁持久化失败,驱动未调用', raw: null, readback: null })
      throw new AppError(503, ErrorCodes.CONFLICT, '无法持久化保写安全锁,拒绝驱动下发')
    }
    executionScope?.assertActive()
    onDriverStart?.()
    try {
      outcome = await driver.write({
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
    outcome.ack = normalizeAck(outcome)
    let reported: DcwWriteOutcome = outcome
    try {
      executionScope?.assertActive()
    }
    catch {
      reported = { ...outcome, ok: false, ack: 'unverified', message: `执行租约失效:写入已进入驱动,设备状态不确定,须核实。驱动返回:${outcome.message}`, driverOutcome: { ...outcome } }
    }
    this.writesTotal++
    if (!outcome.ok) this.writesFailed++
    // set 后 hook:节点暴露值 = PLC 回读经 decoder 解码的**真实物理值**(而非指令值);
    // 回读缺失(驱动不支持)才回退指令值。节点对外呈现的始终是处理后的工艺参数。
    node.applyWriteResult(outcome.readback ?? eng, outcome.ok, outcome.message, at)
    // A transport acknowledgement is not evidence that the physical value is safe to hold.
    if (reported.ok && outcome.ok && outcome.ack === 'readback-verified' && outcome.readback != null && Number.isFinite(outcome.readback)
      && Math.abs(outcome.readback - eng) <= writeTolerance(node)) {
      node.holdBlocked = false
    }
    else if (reported.ok && outcome.ok && outcome.ack === 'transport-ack') {
      // transport-ack = 链路受理,不是设备生效证据。声明了观测通道的节点以独立
      // DAQ 跟随作为生效证据(与 V3 验收 ACK 口径同源)异步证实;证实通过才解除
      // 保写锁。未声明的节点保写保持挂起并显式提示 —— 不再静默禁用心跳。
      if (node.holdObserve?.daqId) {
        this.beginHoldObserve(node, eng, Date.parse(at))
      }
      else {
        node.lastError = `写入已受理(broker ACK);节点未配置观测证实(holdObserve.daqId),保写挂起待设备生效证据`
      }
    }
    else if (!outcome.ok) {
      node.lastError = `${outcome.message};保写已暂停,需重新下发并由设备回读证实`
    }
    // 写值走防抖落盘:保写心跳按 holdIntervalMs 周期触发本方法,同步全量重写
    // dcws.json 会随节点数放大成周期性 fs 抖动;防抖窗内崩溃丢失的设定值可从 PLC 回读恢复
    this.repo.flushDebounced()
    const repo = getDcwRecipeRepo()
    // P0-1 审计保真:eng 记「本次尝试值」—— 失败写不再占位 node.value(P0-1),
    // 旧写法 `node.value ?? eng` 在失败行会记成旧确认值,丢失失败尝试的证据。
    const attemptEng = outcome.ok ? (node.value ?? eng) : eng
    const entry: DcwWriteHistoryEntry = {
      id: `wh-${randomUUID().slice(0, 8)}`,
      nodeId: node.id,
      nodeName: node.name,
      param: findDcwTemplate(node.templateKey)?.ch ?? node.templateKey,
      eng: attemptEng,
      raw: outcome.raw,
      ok: reported.ok,
      ack: reported.ack,
      message: reported.message,
      recipeRunId,
      at,
    }
    repo.appendHistory(entry)
    this.broadcast?.('dcw.written', {
      nodeId: node.id,
      templateRef: node.templateRef,
      lineId: node.lineId ?? null,
      value: attemptEng,
      raw: outcome.raw,
      ok: reported.ok,
      ack: reported.ack,
      message: reported.message,
      recipeRunId,
      at,
    })
    this.emitNodeChanged('updated', node)
    endGovernanceDriverCall(driverAudit, outcome)
    return reported
  }

  protected emitNodeChanged(op: AepDcwNodeChange['op'], node: DcwNode | null): void {
    const payload: AepDcwNodeChange = { op, node: node ? node.toView() : null }
    this.broadcast?.('dcw.node.changed', payload)
  }

  /**
   * transport-ack 保写观测证实:写被 broker 受理后,轮询独立 DAQ 观测节点,
   * 物理量在超时窗内**跟随到本次写目标**(±容差,点时间不早于写发起)即解除保写
   * 锁;超时保持挂起并把原因写入 lastError。新写会用新目标取代在飞观测
   * (代际号失效旧轮询),已回读证实的写同样使观测自然退出。
   */
  private readonly holdObserveSeq = new Map<string, number>()

  private beginHoldObserve(node: DcwNode, target: number, atMs: number): void {
    const observe = node.holdObserve
    if (!observe?.daqId) return
    const seq = (this.holdObserveSeq.get(node.id) ?? 0) + 1
    this.holdObserveSeq.set(node.id, seq)
    const timeoutMs = Math.max(250, observe.timeoutMs ?? 45_000)
    const pollMs = Math.min(3_000, Math.max(250, Math.floor(timeoutMs / 10)))
    const tolerance = Math.max(0, observe.tolerance ?? Math.max(0.5, Math.abs(target) * 0.02))
    const deadline = Date.now() + timeoutMs
    const poll = async (): Promise<void> => {
      // 已被更新一次写取代(seq 变化)或保写锁已被回读证实解除:本次观测退出。
      if (this.holdObserveSeq.get(node.id) !== seq || !node.holdBlocked) return
      try {
        const points = await getTsdb().query(observe.daqId, { fromMs: atMs - 1_000, toMs: Date.now(), limit: 50 })
        const latest = points[points.length - 1]
        const value = latest?.avg ?? latest?.value
        if (latest && latest.at >= atMs && value != null && Number.isFinite(value) && Math.abs(value - target) <= tolerance) {
          if (this.holdObserveSeq.get(node.id) !== seq || !node.holdBlocked) return
          node.holdBlocked = false
          if (node.lastError?.startsWith('观测证实超时') || node.lastError?.startsWith('写入已受理')) node.lastError = null
          this.repo.flushDebounced()
          this.emitNodeChanged('updated', node)
          console.log(`[dcw] 保写观测证实:${node.name}(${node.id}) DAQ ${observe.daqId} 跟随到 ${value},保写恢复`)
          return
        }
        if (Date.now() >= deadline) {
          if (this.holdObserveSeq.get(node.id) !== seq) return
          node.lastError = `观测证实超时:DAQ ${observe.daqId} ${timeoutMs}ms 内未跟随到 ${target}(±${tolerance});保写保持挂起`
          this.repo.flushDebounced()
          this.emitNodeChanged('updated', node)
          return
        }
      }
      catch { /* 单拍查询失败按未证实处理,下一拍重试;进程内观测状态不外抛 */ }
      if (this.holdObserveSeq.get(node.id) === seq && node.holdBlocked && Date.now() < deadline) {
        const timer = setTimeout(() => void poll(), pollMs)
        // unref:观测不得阻止进程自然退出(测试/关机路径不被拖住)
        timer.unref?.()
      }
    }
    const first = setTimeout(() => void poll(), pollMs)
    first.unref?.()
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
    // 驱动具备 read 原语 ≠ 该节点配置了读通道(如 MQTT 需要 readTopic)。
    // 未配置时直接返回说明,不进入 applyReadResult —— 否则周期读会每 5s 给节点记一条
    // lastReadError 噪音,把"仅下行写控节点"误显示成读取故障。
    if (driver.canRead && !driver.canRead(node.driverConfig)) {
      return { ok: false, value: null, raw: null, message: `驱动 ${node.driver} 未配置回读通道(readTopic),不支持读取回读`, at }
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
