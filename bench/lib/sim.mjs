/**
 * bench/lib/sim.mjs —— PLC 模拟器客户端 + 自动拉起 + 就绪等待。
 *
 * 现状痛点（本模块解决）：原 bench/run.mjs 假定模拟器与平台"已经在跑"，
 * 人工按 PIPELINE.md 阶段 B 启；一体化流水线要求在单一命令内自举。
 *
 * 能做的事：探测 → 不在则 spawn（cwd=../plc-node-simulator, npm run dev）→
 * 轮询 /api/nodes 就绪 → 应用预设 → 设备/信号/工艺模型操作。
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { sleep } from './util.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
export const REPO = resolve(HERE, '..', '..')
// 模拟器位置：仓库内子模块 plc-node-simulator/ 优先，回退到同级检出 ../plc-node-simulator
// （SIM_DIR 环境变量仍为最高优先，兼容旧布局）。
export const SIM_DIR = process.env.SIM_DIR
  ?? (existsSync(join(REPO, 'plc-node-simulator', 'package.json'))
    ? join(REPO, 'plc-node-simulator')
    : resolve(REPO, '..', 'plc-node-simulator'))
export const SIM_BASE = process.env.SIM_BASE ?? 'http://127.0.0.1:4010'

export const simApi = async (method, path, body) => {
  // 与 makeApi 同一套网络层韧性：瞬断(进程重启窗/积压拒连)退避重试，
  // HTTP 状态错误照常返回给调用方判定。
  let lastErr
  for (let attempt = 1; attempt <= 8; attempt++) {
    try {
      const res = await fetch(`${SIM_BASE}${path}`, {
        method,
        headers: { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      })
      const json = await res.json().catch(() => null)
      return { status: res.status, data: json?.data ?? json, message: json?.message ?? '' }
    } catch (err) {
      lastErr = err
      if (attempt < 8) await sleep(Math.min(800 * 2 ** (attempt - 1), 8000))
    }
  }
  throw lastErr
}

export const simUp = async () => {
  try {
    const r = await simApi('GET', '/api/nodes')
    return r.status === 200 && Array.isArray(r.data)
  } catch { return false }
}

/**
 * 确保模拟器在线：在线即复用；离线则 spawn `npm run dev` 并等待就绪。
 * @returns {{started:boolean, pid?:number, dir:string, reason?:string}}
 */
export async function ensureSimulator({ timeoutMs = 90_000, log = console.log } = {}) {
  if (await simUp()) return { started: false, dir: SIM_DIR, reason: 'already-up' }
  if (!existsSync(SIM_DIR)) return { started: false, dir: SIM_DIR, reason: `目录不存在: ${SIM_DIR}` }
  // 依赖未安装时 npm run dev 必然秒死（tsx 缺失）——fail fast 给出可执行处置，
  // 而不是空转 90s 后给一个无行动信息的 "未就绪"（实测踩过：子模块未 npm install）。
  if (!existsSync(join(SIM_DIR, 'node_modules'))) {
    return { started: false, dir: SIM_DIR, reason: `依赖未安装: ${SIM_DIR}/node_modules 不存在 → cd ${SIM_DIR} && npm install` }
  }

  log(`  · 模拟器未在线 → 自动启动 (cwd=${SIM_DIR})`)
  const child = spawn('npm', ['run', 'dev'], {
    cwd: SIM_DIR,
    shell: true,
    env: { ...process.env, NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost' },
    stdio: 'ignore',
    detached: false,
  })
  child.unref?.()
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    await sleep(1500)
    if (await simUp()) return { started: true, pid: child.pid, dir: SIM_DIR, reason: 'spawned' }
  }
  return { started: false, pid: child.pid, dir: SIM_DIR, reason: `启动后 ${timeoutMs}ms 内未就绪（检查 ${SIM_DIR}/npm 日志与依赖安装）` }
}

/** 应用命名预设（film-line / cast-film-physics），幂等 */
export async function applyPreset(key) {
  const r = await simApi('POST', `/api/presets/${key}`)
  if (r.status >= 400) throw new Error(`预设 ${key} 应用失败: ${r.message}`)
  await sleep(2500) // 等设备端点 boot + 首拍信号
  return (await simApi('GET', '/api/nodes')).data ?? []
}

/** 当前设备列表（已启用） */
export const simNodes = async () => (await simApi('GET', '/api/nodes')).data ?? []

/**
 * 混合信号语义：把一个模拟器设备拆成 (DCW 写点, DAQ 读点)。
 * 约定：id 以 -sp 结尾 = 可写设定值(DCW)；其余取第一个标量信号 = 过程量(DAQ)。
 */
export function splitSignals(device) {
  const sigs = device?.signals ?? []
  const isDcw = s => /-sp$|SP$/.test(s.id) || /SP/.test(s.id)
  const dcw = sigs.find(isDcw) ?? null
  const daq = sigs.find(s => !isDcw(s) && (s.format ?? 'scalar') === 'scalar') ?? null
  return { dcw, daq }
}

/** 拉取设备对接导出（driverConfig 由模拟器生成，杜绝手抄） */
export const simExport = async (deviceId) => (await simApi('GET', `/api/nodes/${deviceId}/export`)).data

/** 工艺模型：状态 / 真值流 / 离线最优窗口 W* / 工况相位 */
export const plantState = async () => (await simApi('GET', '/api/plant/state')).data
export const plantTruth = async (limit = 500) => (await simApi('GET', `/api/plant/truth?limit=${limit}`)).data
export const plantOptimum = async () => (await simApi('GET', '/api/plant/optimum')).data
export const plantPhase = async (phase, disturbances) => (await simApi('POST', '/api/plant/phase', { phase, ...(disturbances ? { disturbances } : {}) })).data
/** 物理模型复位（多 seed 复现的前提）：重置 RNG/初始状态并按 seed 重开真值流。
 *  warm=true → 热态复位（tz=标称工艺温度），免去冷态预热。 */
export const plantReset = async ({ seed, phase, disturbances, params, warm } = {}) =>
  (await simApi('POST', '/api/plant/reset', {
    ...(seed != null ? { seed } : {}), ...(phase ? { phase } : {}),
    ...(disturbances ? { disturbances } : {}), ...(params ? { params } : {}),
    ...(warm ? { warm: true } : {}),
  })).data
export const simManual = (deviceId, signalId, value) => simApi('POST', `/api/nodes/${deviceId}/signals/${signalId}/manual`, { value })
