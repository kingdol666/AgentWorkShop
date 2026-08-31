/**
 * DAQ 启动插件 —— 数采基础设施编排入口(config.yml daq → runtimeConfig)。
 *
 * 启动时:探测配置地址(MQTT/Timescale)→ 不通且策略允许则 docker compose 自动拉起
 * → 依判定结果装配真实/降级后端 → 降级则停采并警告;后台 30s 自动重连,
 * 恢复后重建真实后端 + 重挂消费者 + 恢复采集。
 */
import { useRuntimeConfig } from '#imports'
import { daqUrls, ensureDaqInfrastructure, scheduleAutoReconnect, type DaqInfraConfig } from '../services/workshop/daq/infra'
import { rebuildTsdb } from '../services/workshop/daq/storage'
import { rebuildDaqQueue } from '../services/workshop/daq/bus'
import { getDaqController } from '../services/workshop/daq/daq-controller'

/** 按最新 infra 状态装配后端 + 控制器(启动/重连共用) */
async function applyInfra(cfg: DaqInfraConfig): Promise<void> {
  const status = await ensureDaqInfrastructure(cfg, process.cwd())
  const urls = daqUrls(cfg)
  await rebuildTsdb(status.tsdbOnline, urls.tsdbUrl)
  await rebuildDaqQueue(status.mqttOnline, urls.mqttUrl)
  const ctrl = getDaqController()
  await ctrl.reattachQueue()
  if (status.degraded) {
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
  }
  try {
    await applyInfra(cfg)
  }
  catch (err) {
    console.error('[daq-infra] 启动装配失败(保持降级,重连可恢复):', err instanceof Error ? err.message : err)
  }
  // 后台自动重连:恢复后重走装配路径
  scheduleAutoReconnect(() => {
    void applyInfra(cfg).catch(() => {})
  })
  // 重连端点复用同一装配函数
  ;(globalThis as unknown as { __daqApplyInfra?: (c: DaqInfraConfig) => Promise<void> }).__daqApplyInfra = applyInfra
}
