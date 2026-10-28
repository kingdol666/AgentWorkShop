/**
 * DAQ 启动插件 —— 数采基础设施编排入口(config.yml daq → runtimeConfig)。
 *
 * 启动时:探测配置地址(MQTT/Timescale)→ 不通且策略允许则 docker compose 自动拉起
 * → 依判定结果装配真实/降级后端 → 降级则停采并警告;后台 30s 自动重连,
 * 恢复后重建真实后端 + 重挂消费者 + 恢复采集。
 *
 * 2026-10-28(S10):启动屏障 —— 后端装配完成前不 resolve `__daqInfraReady`,
 * workshop 插件的 resumeAll 必须等待它,避免采样先落到占位 SQLite/进程内队列;
 * 后端初始化失败时显式置 degraded 并停采(不再"端口通=健康")。
 */
import { useRuntimeConfig } from '#imports'
import { daqInfraStatus, daqUrls, ensureDaqInfrastructure, markDaqInfraFailure, scheduleAutoReconnect, type DaqInfraConfig } from '../services/workshop/daq/infra'
import { rebuildTsdb } from '../services/workshop/daq/storage'
import { rebuildObjectStore } from '../services/workshop/daq/objectstore'
import { startDaqObjectGc } from '../services/workshop/daq/objectstore/gc'
import { rebuildDaqQueue } from '../services/workshop/daq/bus'
import { getDaqController } from '../services/workshop/daq/daq-controller'

interface DaqBootState {
  __daqInfraReady?: Promise<void>
  __daqInfraStatus?: () => ReturnType<typeof daqInfraStatus>
}

/** 按最新 infra 状态装配后端 + 控制器(启动/重连共用) */
async function applyInfra(cfg: DaqInfraConfig): Promise<void> {
  const status = await ensureDaqInfrastructure(cfg, process.cwd())
  const urls = daqUrls(cfg)
  try {
    await rebuildTsdb(status.tsdbOnline, urls.tsdbUrl)
    await rebuildObjectStore(status.objectStoreOnline, urls.objectStoreUrl)
    await rebuildDaqQueue(status.mqttOnline, urls.mqttUrl)
  }
  catch (err) {
    // 端口可达 ≠ 后端可用(密码错/库缺失/扩展未装)。装配失败一律降级并停采,
    // 由 30s 重连继续尝试;绝不让采样写进占位后端后"看起来正常"。
    markDaqInfraFailure(err)
    getDaqController().stopAll()
    return
  }
  const ctrl = getDaqController()
  await ctrl.reattachQueue()
  if (daqInfraStatus().degraded) {
    ctrl.stopAll() // 在线数采停用(降级可见)
  }
  else {
    ctrl.startAll()
  }
}

// defineNitroPlugin 为恒等包装:default 直接导出 async 函数(与 workshop.ts 同风格)。
// useRuntimeConfig 静态取自 #imports(与 utils/config.ts 同源模式)。
export default async function daqPlugin() {
  const raw = useRuntimeConfig().daq as DaqInfraConfig
  const cfg: DaqInfraConfig = {
    startInfrastructure: raw?.startInfrastructure ?? 'auto',
    mqtt: {
      host: raw?.mqtt?.host ?? '127.0.0.1',
      port: Number(raw?.mqtt?.port ?? 1883),
      // S1:生产 broker 鉴权/TLS 可选项(缺省 = dev 零配置 no-auth,行为不变)
      username: raw?.mqtt?.username || undefined,
      password: raw?.mqtt?.password || undefined,
      secure: raw?.mqtt?.secure === true,
      caFile: raw?.mqtt?.caFile || undefined,
    },
    timescale: {
      host: raw?.timescale?.host ?? '127.0.0.1',
      port: Number(raw?.timescale?.port ?? 5432),
      user: raw?.timescale?.user ?? 'postgres',
      password: raw?.timescale?.password ?? 'awshop',
      database: raw?.timescale?.database ?? 'awshop',
    },
    objectstore: raw?.objectstore
      ? {
          host: raw.objectstore.host ?? '127.0.0.1',
          port: raw.objectstore.port ?? 9000,
          accessKey: raw.objectstore.accessKey ?? 'awshop',
          secretKey: raw.objectstore.secretKey ?? 'awshop-secret',
          bucket: raw.objectstore.bucket ?? 'daq',
        }
      : undefined,
  }
  // 启动屏障:先挂 promise,再执行装配;失败也 resolve(状态里 degraded=true),由消费方决定是否停采
  const g = globalThis as unknown as DaqBootState
  let resolveReady!: () => void
  g.__daqInfraReady = new Promise<void>((resolve) => {
    resolveReady = resolve
  })
  g.__daqInfraStatus = daqInfraStatus
  try {
    await applyInfra(cfg)
  }
  catch (err) {
    markDaqInfraFailure(err)
    try {
      getDaqController().stopAll()
    }
    catch { /* 控制器未就绪 */ }
  }
  finally {
    resolveReady()
  }
  // 后台自动重连:恢复后重走装配路径
  scheduleAutoReconnect(() => {
    void applyInfra(cfg).catch(markDaqInfraFailure)
  })
  // P0-2 对象存储 GC:帧行出清后像素文件孤儿回收(90s 首轮 + 24h 周期;disk 后端)
  startDaqObjectGc()
  // 重连端点复用同一装配函数
  ;(globalThis as unknown as { __daqApplyInfra?: (c: DaqInfraConfig) => Promise<void> }).__daqApplyInfra = applyInfra
}
