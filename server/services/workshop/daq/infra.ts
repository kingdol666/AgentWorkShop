/**
 * DAQ 基础设施编排 —— 配置驱动的真实 MQTT/Timescale 生命周期。
 *
 * 启动策略(config.yml daq.startInfrastructure):
 *   auto   = 探测配置地址;端口不通且宿主有 Docker → docker compose 自动拉起,
 *            拉起后等待就绪;无 Docker → 直连失败即降级;
 *   always = 仅经 Docker 拉起(不探测直连);
 *   never  = 只按配置直连。
 *
 * 降级语义:任一后端不可达 → 该后端回退 mock 对应物(进程内队列 / SQLite 时序仿真),
 * 控制器停采(在线数采停用),meta 携带 warning,前端横幅 + 一键重连;
 * 后台每 30s 自动重试,恢复后自动重启采集并切回真实后端。
 */
import { execFile } from 'node:child_process'
import { createConnection } from 'node:net'
import { promisify } from 'node:util'
import { join } from 'node:path'

const execFileAsync = promisify(execFile)

export interface DaqInfraConfig {
  startInfrastructure: 'auto' | 'always' | 'never'
  mqtt: { host: string, port: number }
  timescale: { host: string, port: number, user: string, password: string, database: string }
}

export interface DaqInfraStatus {
  /** 真实 MQTT 是否在线(离线 → 进程内队列降级) */
  mqttOnline: boolean
  /** Timescale 是否在线(离线 → SQLite 时序仿真降级) */
  tsdbOnline: boolean
  /** 任一降级 → 在线采集停用,前端横幅警告 */
  degraded: boolean
  warning: string
  /** 基础设施拉起方式:docker / direct / none */
  startedBy: 'docker' | 'direct' | 'none'
  lastCheckAt: string
  lastError?: string
}

const g = globalThis as typeof globalThis & {
  __daqInfra?: { cfg: DaqInfraConfig, status: DaqInfraStatus, retryTimer?: NodeJS.Timeout, projectRoot?: string }
}

function state() {
  return g.__daqInfra ??= {
    cfg: { startInfrastructure: 'auto', mqtt: { host: '127.0.0.1', port: 1883 }, timescale: { host: '127.0.0.1', port: 5432, user: 'postgres', password: 'awshop', database: 'awshop' } },
    status: { mqttOnline: false, tsdbOnline: false, degraded: true, warning: '', startedBy: 'none', lastCheckAt: new Date().toISOString() },
  }
}

/** TCP 端口探测(2s 超时;Docker 端口映射即代表服务可连) */
function probePort(host: string, port: number, timeoutMs = 2000): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = createConnection({ host, port })
    const done = (ok: boolean): void => {
      sock.destroy()
      resolve(ok)
    }
    sock.setTimeout(timeoutMs, () => done(false))
    sock.once('connect', () => done(true))
    sock.once('error', () => done(false))
  })
}

async function dockerAvailable(): Promise<boolean> {
  try {
    await execFileAsync('docker', ['--version'], { timeout: 5000 })
    return true
  }
  catch {
    return false
  }
}

async function dockerComposeUp(projectRoot: string): Promise<{ ok: boolean, error?: string }> {
  try {
    await execFileAsync('docker', ['compose', '-f', join(projectRoot, 'docker-compose.yml'), 'up', '-d', 'daq-mosquitto', 'daq-timescale'], { timeout: 120_000, cwd: projectRoot })
    return { ok: true }
  }
  catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/** 等待两个端口就绪(拉起后服务初始化需要数秒;最长 waitMs) */
async function waitPorts(cfg: DaqInfraConfig, waitMs: number): Promise<{ mqtt: boolean, tsdb: boolean }> {
  const deadline = Date.now() + waitMs
  let mqtt = false
  let tsdb = false
  while (Date.now() < deadline && !(mqtt && tsdb)) {
    mqtt = mqtt || await probePort(cfg.mqtt.host, cfg.mqtt.port, 1200)
    tsdb = tsdb || await probePort(cfg.timescale.host, cfg.timescale.port, 1200)
    if (!(mqtt && tsdb)) await new Promise(r => setTimeout(r, 1500))
  }
  return { mqtt, tsdb }
}

export function daqInfraStatus(): DaqInfraStatus {
  return { ...state().status }
}

/** 运行配置快照(启动插件装配时写入;重连端点复用) */
export function daqInfraConfig(): DaqInfraConfig {
  return state().cfg
}

/** 配置 → 连接 URL(env 显式覆盖优先,便于外部托管 broker/db) */
export function daqUrls(cfg = state().cfg): { mqttUrl: string | null, tsdbUrl: string | null } {
  const mqttUrl = process.env.DAQ_MQTT_URL ?? `mqtt://${cfg.mqtt.host}:${cfg.mqtt.port}`
  const { user, password, database, host, port } = cfg.timescale
  const tsdbUrl = process.env.DAQ_TSDB_URL ?? `postgres://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${host}:${port}/${database}`
  return { mqttUrl, tsdbUrl }
}

/**
 * 探测/拉起/降级判定主流程(幂等;启动插件与重连端点共用)。
 * 返回最终状态;真实后端在线时由调用方(插件)重建 queue/tsdb 单例并恢复采集。
 */
export async function ensureDaqInfrastructure(cfg: DaqInfraConfig, projectRoot: string): Promise<DaqInfraStatus> {
  const st = state()
  st.cfg = cfg
  const s = st.status
  s.lastCheckAt = new Date().toISOString()
  s.lastError = undefined

  // 1) 直接探测配置地址
  let probe = await waitPorts(cfg, 3000)
  s.startedBy = 'none'

  // 2) 不通 → 按策略 Docker 拉起
  if (!(probe.mqtt && probe.tsdb) && cfg.startInfrastructure !== 'never') {
    const canDocker = await dockerAvailable()
    if (canDocker) {
      console.log('[daq-infra] 配置地址未就绪,经 Docker Compose 拉起(daq-mosquitto + daq-timescale)…')
      const up = await dockerComposeUp(projectRoot)
      if (up.ok) {
        probe = await waitPorts(cfg, 60_000)
        if (probe.mqtt || probe.tsdb) s.startedBy = 'docker'
      }
      else {
        s.lastError = `docker compose 拉起失败: ${up.error?.slice(0, 200)}`
        console.error('[daq-infra]', s.lastError)
      }
    }
    else if (cfg.startInfrastructure === 'auto') {
      s.lastError = '宿主机无 Docker,直接连接配置地址'
    }
  }

  if (probe.mqtt && probe.tsdb) {
    if (s.startedBy === 'none') s.startedBy = 'direct'
  }

  s.mqttOnline = probe.mqtt
  s.tsdbOnline = probe.tsdb
  s.degraded = !(probe.mqtt && probe.tsdb)

  if (s.degraded) {
    const missing: string[] = []
    if (!probe.mqtt) missing.push(`MQTT ${cfg.mqtt.host}:${cfg.mqtt.port}`)
    if (!probe.tsdb) missing.push(`Timescale ${cfg.timescale.host}:${cfg.timescale.port}`)
    s.warning = `数采基础设施不可达:${missing.join('、')}${s.lastError ? `(${s.lastError})` : ''}。已降级:队列→进程内 / 时序库→SQLite 仿真,在线采集已停用;修复后可重连。`
    console.warn(`[daq-infra] 降级运行 — ${s.warning}`)
  }
  else {
    s.warning = ''
    console.log(`[daq-infra] 真实链路就绪(mqtt=${cfg.mqtt.host}:${cfg.mqtt.port}, timescale=${cfg.timescale.host}:${cfg.timescale.port}, 来源=${s.startedBy})`)
  }
  return daqInfraStatus()
}

/** 后台自动重连(降级期间每 30s 重试;恢复后 rebuild + 恢复采集) */
export function scheduleAutoReconnect(onRestored: () => void): void {
  const st = state()
  if (st.retryTimer) return
  st.retryTimer = setInterval(() => {
    const s = st.status
    if (!s.degraded) return
    void ensureDaqInfrastructure(st.cfg, st.projectRoot ?? process.cwd()).then((fresh) => {
      if (!fresh.degraded) {
        console.log('[daq-infra] 自动重连成功,恢复真实链路')
        onRestored()
      }
    }).catch(() => { /* 下个周期再试 */ })
  }, 30_000)
  st.retryTimer.unref?.()
}
