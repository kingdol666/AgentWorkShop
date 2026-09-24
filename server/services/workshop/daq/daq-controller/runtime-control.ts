/**
 * DaqControllerRuntimeControl —— 后端与运行时总控(启停/暂停/配置)
 * (拆分层,承 DaqControllerFrames;方法体与原文件逐行一致)
 */
import { DaqControllerFrames } from './frames'
import type { AepDaqControllerState } from '../../../../../shared/daq-protocol'
import { DAQ_DRIVERS } from '../../../../../shared/daq-protocol'
import { getQueueBackend } from './helpers'
import { getObjectStore } from '../objectstore'
import { getTsdb } from '../storage'
import { listPluginDrivers } from '../drivers'
import { startAlarmEscalator } from '../alarm-notify'

export abstract class DaqControllerRuntimeControl extends DaqControllerFrames {
  /** 后端能力自描述(meta 用) */
  backends(): { tsdb: string, queue: string, objectstore: string, pluginDrivers: string[], drivers: typeof DAQ_DRIVERS } {
    return { tsdb: getTsdb().backend, queue: getQueueBackend(), objectstore: getObjectStore().backend, pluginDrivers: listPluginDrivers(), drivers: DAQ_DRIVERS }
  }

  // ---------- 控制器全局 ----------

  startAll(): AepDaqControllerState {
    this.running = true
    this.ensureLoop()
    startAlarmEscalator() // S5:升级通知扫描器(懒启动,进程内单例)
    this.emitController()
    return this.controllerState()
  }

  stopAll(): AepDaqControllerState {
    this.running = false
    for (const n of this.repo.all()) {
      if (n.enabled) n.state = 'offline'
    }
    this.emitController()
    return this.controllerState()
  }

  /**
   * 暂停全部采集 → 网关停止;恢复全部采集 → 网关启动。
   * 节点启停与网关暂停完全独立:enabled 标志是唯一采集资格,暂停期间节点
   * 的 enabled 不被改动,恢复后只有 enabled=true(即暂停时刻在采集的那批)
   * 的节点恢复采样;暂停前/暂停期间手动停用的节点保持停用,不会被自动拉起。
   */
  pauseAll(): AepDaqControllerState {
    return this.stopAll()
  }

  resumeAll(): AepDaqControllerState {
    return this.startAll()
  }

  configure(opts: { defaultIntervalMs?: number, defaultPublishIntervalMs?: number }): AepDaqControllerState {
    let changed = false
    if (typeof opts.defaultIntervalMs === 'number' && opts.defaultIntervalMs >= this.minIntervalMs) {
      this.defaultIntervalMs = Math.min(60_000, Math.round(opts.defaultIntervalMs))
      changed = true
    }
    if (typeof opts.defaultPublishIntervalMs === 'number' && opts.defaultPublishIntervalMs >= this.minPublishIntervalMs) {
      this.defaultPublishIntervalMs = Math.min(60_000, Math.round(opts.defaultPublishIntervalMs))
      changed = true
    }
    if (changed) {
      // 网关缺省变更即刻生效:全部运行时重置节拍(元数据 null 的节点跟随新缺省)
      for (const rt of this.runtimes.values()) rt.rearm()
    }
    this.emitController()
    return this.controllerState()
  }

  // ---------- 节点 CRUD(单点控制入口)----------
}
