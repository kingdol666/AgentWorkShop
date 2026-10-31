/**
 * DaqControllerSweepAlarms —— 巡检 / 运行时同步 / 告警处理与确认
 * (拆分层,承 DaqControllerIngest;方法体与原文件逐行一致)
 */
import { DaqControllerIngest } from './ingest'
import type { DaqRuntimeHost } from '../daq-runtime'
import { AppError } from '../../../../utils/errors'
import type { DaqNode } from '../daq-node'
import { DaqNodeRuntime } from '../daq-runtime'
import { SWEEP_MAX_CONCURRENCY, log } from './helpers'
import { getDaqHostPorts } from '../host-ports'
import { getOps, recordOps } from '../../ops/ops'
import { getActiveLineRun } from '../../dcw/line-run'
import { newAlarmId, notifyAlarm } from '../alarm-notify'
import { resolveDaqDriver } from '../drivers'

export abstract class DaqControllerSweepAlarms extends DaqControllerIngest {
  /** 网关统一调度:250ms 扫描,到期判定与互斥由各运行时私有节拍自治(单节点慢/停不波及邻居)。
   *  产线门控:未选定配方(无活动 LineRun)不执行采集 —— 采样与实时下发均由配方驱动。
   *  推送式协议(MQTT)不走本循环采样:订阅在 syncPushBindings 建立,报文到达即入库;
   *  该循环只负责订阅对账与陈值看门狗。 */
  protected sweep(): void {
    if (!this.pipelineReady || !this.running) return
    // 250ms 定时器回调:任何未捕获异常都会走到进程级 uncaughtException,
    // 而 stability-guard 只豁免 4 类已知噪声,其余一律 exit(1) —— 一处普通 bug 就能打崩生产。
    // 逐段兜底(与 runtime/manager/state.ts 同口径):失败只记日志,绝不抛出,
    // 且保证后面的段仍会执行(此前一拍抛错会跳过同拍剩余逻辑)。
    this.guardStep('syncPushBindings', () => this.syncPushBindings())
    const now = Date.now()
    this.guardStep('checkPushLiveness', () => this.checkPushLiveness(now))
    const host = getDaqHostPorts()
    if (!host || !host.lineRun.hasAnyActiveRun()) return
    // 在飞闸门:上一拍未消化的并发额度不叠加(避免积压 tick 雪崩)
    const budget = SWEEP_MAX_CONCURRENCY - this.samplingInFlight
    if (budget <= 0) return
    let defs: ReturnType<typeof this.runtimeDefaults>
    let rts: typeof this.runtimes extends Map<string, infer V> ? V[] : never
    try {
      defs = this.runtimeDefaults()
      rts = [...this.runtimes.values()]
    }
    catch (err) {
      log.error('[daq] sweep 准备阶段异常(已隔离):', err)
      return
    }
    const total = rts.length
    if (!total) return
    let started = 0
    let examined = 0
    // 轮转游标 + 到期预判:派发额度有限时,固定从表头遍历会让表尾节点永久饿死
    // (新入表节点排在最后 → 永远轮不到)。游标保证有限拍内覆盖全表,isDue 保证
    // 未到期节点不占用额度(否则表头节点每拍吃满额度,即便它们无样本可采)。
    for (let i = 0; i < total && started < budget; i++) {
      const rt = rts[(this.sweepCursor + i) % total]!
      examined = i + 1
      try {
        // 推送式驱动(存在 subscribe)不轮询:否则同一条报文会被采样 tick 重复入库
        if (typeof resolveDaqDriver(rt.node.driver).subscribe === 'function') continue
        // 逐产线门控:节点只在其所属产线的活动批次窗口内采集(lineId 空 = 未分配,不采集)
        if (!host.lineRun.activeRun(rt.node.lineId)) continue
        if (!rt.isDue(now, defs)) continue
      }
      catch (err) {
        // 单节点判定失败不阻断同拍其余节点
        log.error(`[daq] 节点 ${rt.node.id} 到期判定异常(已隔离):`, err)
        continue
      }
      this.samplingInFlight += 1
      started += 1
      void rt.tick(now).catch(() => { /* 单节点采样异常已在 runtime 内隔离 */ })
        .finally(() => { this.samplingInFlight -= 1 })
    }
    this.sweepCursor = (this.sweepCursor + examined) % total
  }

  /** 定时器回调内的安全包裹:异常只记日志,绝不冒泡到进程级 */
  private guardStep(label: string, fn: () => void): void {
    try {
      fn()
    }
    catch (err) {
      log.error(`[daq] sweep ${label} 异常(已隔离):`, err)
    }
  }

  /** 产线停止:该产线全部节点置 offline(开跑后由采样自然恢复) */
  markLineOffline(lineId: string): void {
    for (const n of this.repo.all()) {
      if (n.enabled && n.lineId === lineId) n.state = 'offline'
    }
    this.emitController()
  }

  /** 运行时注册表对账(仓库为权威:增删节点/启动即对齐;返回新建的运行时) */
  protected syncRuntimes(): void {
    const live = new Set<string>()
    for (const node of this.repo.all()) {
      live.add(node.id)
      if (!this.runtimes.has(node.id)) {
        this.runtimes.set(node.id, new DaqNodeRuntime(node, this.host))
      }
    }
    for (const id of [...this.runtimes.keys()]) {
      if (!live.has(id)) this.runtimes.delete(id)
    }
  }

  /** runtime host:网关注入的服务面(采样/入队/管线/告警/全局缺省) */
  protected host: DaqRuntimeHost = {
    defaults: () => this.runtimeDefaults(),
    sample: (node, now) => this.sampleNode(node, now),
    publishSample: env => this.publishSample(env),
    ingest: (node, env, allowPublish) => this.ingestNode(node, env, allowPublish),
    broadcastError: (node, message) => this.broadcastDriverError(node, message),
    onAlarm: (node, value, rule, threshold) => this.handleAlarm(node, value, rule, threshold),
    onAlarmRecover: (node, value) => this.handleAlarmRecover(node, value),
    recipeWindowFor: node => this.recipeDaqWindowFor(node),
  }

  // ---------- S5:报警持久化/外送/确认 ----------

  /** 累计报警次数(R4 指标暴露) */
  alarmsRaised = 0

  /** alarm 进入沿:落库(同节点同量未确认幂等)→ WS 广播 → webhook 外送;失败绝不影响采集。
   *  metricKey:帧派生指标告警的键(模板 metrics 规则;缺省 = 模板 key,标量越限) */
  protected handleAlarm(node: DaqNode, value: number, rule: 'lt-min' | 'gt-max', threshold: number, metricKey?: string): void {
    this.alarmsRaised++
    const repo = getOps()?.alarmEvents
    let id = newAlarmId()
    const createdAt = new Date().toISOString()
    const metric = metricKey ?? node.templateKey
    if (repo) {
      try {
        const raised = repo.raise({
          id, nodeId: node.id, nodeName: node.name, metric,
          value, rule, threshold, createdAt,
        })
        if (!raised) id = '' // 已有同源未确认报警:不重复广播/外送
      }
      catch (err) {
        log.error('[daq-alarm] 报警落库失败(不影响采集):', err instanceof Error ? err.message : err)
      }
    }
    if (!id) return
    const payload = {
      id, nodeId: node.id, nodeName: node.name, metric,
      value, rule, threshold, escalation: 0, createdAt,
      // S14:告警帧必须带产线归属,否则 scene-events 会当作"线无关"广播给所有 peer
      lineId: node.lineId || null,
    }
    this.broadcast?.('daq.alarm', payload)
    notifyAlarm(payload)
    // 运维日志:越限告警入实时事件轨(恢复/详情在告警面板与日志管理);
    // 告警发生在活动批次内时带上该批次的 product/recipe,产线日志才能按配方检索
    const zh = rule === 'gt-max' ? '高于上限' : '低于下限'
    const run = getActiveLineRun(node.lineId)
    recordOps({
      actor: 'system',
      actorName: 'system',
      actorKind: 'system',
      action: 'daq.alarm.raise',
      kind: 'alarm',
      targetKind: 'daq-node',
      targetId: node.id,
      summary: `告警:「${node.name}」${metric} ${zh}阈值 ${threshold}(当前 ${value})`,
      lineId: node.lineId ?? '',
      productId: run?.productId ?? '',
      recipeId: run?.recipeId ?? '',
      detail: { alarmId: id, metric, value, rule, threshold },
    })
  }

  /** alarm 恢复沿:广播恢复(报警保持 open 待人工 ack) */
  protected handleAlarmRecover(node: DaqNode, value: number): void {
    this.broadcast?.('daq.alarm.changed', { nodeId: node.id, nodeName: node.name, recovered: true, value, at: new Date().toISOString(), lineId: node.lineId || null })
  }

  /** 报警确认(HITL 闭环的人为一步;幂等:已确认返回 false) */
  ackAlarm(id: string, byUserId: string, byName: string): boolean {
    const repo = getOps()?.alarmEvents
    if (!repo) throw new AppError(503, 'UNAVAILABLE', '报警持久化未就绪')
    const ok = repo.ack(id, byUserId, byName, new Date().toISOString())
    if (ok) {
      this.broadcast?.('daq.alarm.changed', { id, ackedBy: byName, ackedAt: new Date().toISOString() })
      // 确认是人对产线告警的处置动作:回填报警所属节点/产线/活动批次,避免落成无归属条目
      const nodeId = repo.nodeIdById(id) ?? ''
      const node = nodeId ? this.repo.byId(nodeId) : undefined
      const run = node ? getActiveLineRun(node.lineId) : null
      recordOps({
        actor: byUserId,
        actorName: byName,
        actorKind: 'user',
        action: 'daq.alarm.ack',
        kind: 'alarm',
        targetKind: 'alarm',
        targetId: id,
        lineId: node?.lineId ?? '',
        productId: run?.productId ?? '',
        recipeId: run?.recipeId ?? '',
        summary: `确认报警 ${id}${node ? `(节点「${node.name}」)` : ''}(处理完毕,移出实时告警)`,
      })
    }
    return ok
  }

  listAlarms(scope: 'open' | 'all', limit = 100) {
    const repo = getOps()?.alarmEvents
    if (!repo) return []
    return scope === 'open' ? repo.listOpen(limit) : repo.list(limit)
  }

  // ---------- 消费者:队列帧 → 存储/广播/回写 ----------
}
