// ============================================================
// AgentWorkShop CLI — 数采基础设施前置检查(Docker 编排)
// ------------------------------------------------------------
// aw start 启动服务前的引导层:
//   1. 探测 MQTT / TimescaleDB 端口连通(按有效配置的 host/port)
//   2. 已连通 → 依赖就绪,直接通过
//   3. 未连通且本机 Docker 可用且策略允许 → docker compose up -d 拉起并等待端口
//   4. 无 Docker → 打印回退引导:安装 Docker,或在 config.yml 按需配置外部依赖地址
// 真正的容器编排与降级重连在服务进程内(server/plugins/daq.ts → ensureDaqInfrastructure);
// 本模块只做启动前置探测与引导,失败不阻断服务启动(平台降级可用)。
// ============================================================
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { connect } from 'node:net'
import { join } from 'node:path'
import { color } from './core/logger.mjs'

/** 本机 Docker 可用性(docker -v) */
export function detectDocker() {
  const r = spawnSync('docker', ['-v'], { encoding: 'utf8', shell: process.platform === 'win32' })
  if (r.status === 0) return { ok: true, version: (r.stdout ?? '').trim().replace(/^Docker version\s*/i, '') }
  return { ok: false, version: null }
}

/** TCP 端口连通探测(毫秒级超时;resolve('online'|'offline')) */
export function probeTcp(port, host = '127.0.0.1', timeoutMs = 1200) {
  return new Promise((resolveState) => {
    const sock = connect({ port: Number(port), host })
    const done = (state) => {
      sock.destroy()
      resolveState(state)
    }
    sock.setTimeout(timeoutMs)
    sock.on('connect', () => done('online'))
    sock.on('timeout', () => done('offline'))
    sock.on('error', () => done('offline'))
  })
}

/** 在 compose 目录执行 docker compose up -d(阻塞至命令结束) */
export function composeUp(composeDir) {
  const r = spawnSync('docker', ['compose', 'up', '-d'], {
    cwd: composeDir,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  })
  return r.status === 0
}

/**
 * 数采基础设施前置检查。
 * @param {{ daq: any, configRoot: string }} opts ctx.config 片段与配置根(daQ compose 种子所在)
 * @returns {{ ok: boolean, mqtt: object, timescale: object, docker: object }}
 */
export async function daqPreflight({ daq, configRoot }) {
  const mqtt = {
    host: String(daq?.['daq.mqtt.host'] ?? '127.0.0.1'),
    port: Number(daq?.['daq.mqtt.port'] ?? 1883),
    online: null,
  }
  const timescale = {
    host: String(daq?.['daq.timescale.host'] ?? '127.0.0.1'),
    port: Number(daq?.['daq.timescale.port'] ?? 5432),
    online: null,
  }
  const policy = String(daq?.['daq.startInfrastructure'] ?? 'auto')

  const docker = detectDocker()
  mqtt.online = (await probeTcp(mqtt.port, mqtt.host)) === 'online'
  timescale.online = (await probeTcp(timescale.port, timescale.host)) === 'online'
  const allOnline = mqtt.online && timescale.online
  const composeDir = existsSync(join(configRoot, 'docker-compose.yml')) ? configRoot : null

  const result = { ok: allOnline, mqtt, timescale, docker, policy, composeDir }

  if (allOnline) return result

  // 未全连通:
  //  · Docker 可用 + 策略允许(auto/always)+ 本地有 compose 定义 → 拉起并等待端口上线
  if (docker.ok && policy !== 'never' && composeDir) {
    console.log(`${color.cyan('›')} 数采依赖未就绪(MQTT ${mqtt.online ? '✓' : '✗'} / Timescale ${timescale.online ? '✓' : '✗'})——docker compose up -d 拉起 ...`)
    const up = composeUp(composeDir)
    // 等待端口上线(最长 30s;Timescale 首启初始化较慢)
    for (let i = 0; i < 15; i++) {
      await new Promise(r => setTimeout(r, 2000))
      mqtt.online = (await probeTcp(mqtt.port, mqtt.host)) === 'online'
      timescale.online = (await probeTcp(timescale.port, timescale.host)) === 'online'
      if (mqtt.online && timescale.online) break
    }
    result.ok = mqtt.online && timescale.online
    result.pulled = up
    return result
  }

  return result
}

/** 打印回退引导(无 Docker 且依赖不可达时) */
export function printInfraGuidance({ mqtt, timescale, docker }) {
  console.log('')
  console.log(color.yellow('⚠ 数采基础设施不可达(MQTT/TimescaleDB)——服务将继续启动,数采功能降级并每 30s 自动重连。'))
  console.log(color.dim('  解决方式(二选一):'))
  console.log(`  ${color.cyan('1.')} 安装 Docker Desktop 后重启本命令,依赖容器将自动拉起`)
  console.log(`  ${color.cyan('2.')} 在 config.yml 的 daq 段按需配置外部依赖:`)
  console.log(color.dim(`       daq.mqtt.host/port       (当前 ${mqtt.host}:${mqtt.port} ✗)`))
  console.log(color.dim(`       daq.timescale.host/port  (当前 ${timescale.host}:${timescale.port} ✗)`))
  if (!docker.ok) console.log(color.dim('       (本机未检测到 Docker)'))
  console.log('')
}
