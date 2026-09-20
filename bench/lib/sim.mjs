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
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { join, relative, resolve, dirname } from 'node:path'
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
// 模拟器专用端口：自举 spawn 时以 SIM_PORT 传给 tsx(index.ts 监听该端口)。
// 基准惯例 SIM_BASE=:4011(专用实例)——4010 常是其他会话的共享 dev 模拟器,
// 被外部 preset/重启会把 SP 清掉,曾致 P10 「每写必断膜」(2026-09-20 sr8 实测根因)。
export const SIM_PORT = (() => {
  try { return Number(new URL(SIM_BASE).port) || Number(process.env.SIM_PORT ?? 4010) }
  catch { return Number(process.env.SIM_PORT ?? 4010) }
})()
// 专用实例(端口 ≠ 4010)用影子目录:源码拷贝 + node_modules junction + **私有 data/**。
// 动机:模拟器的 truth.jsonl / config.json 固定写在 <sim>/data 下,共享 4010 实例的
// preset 重置/真值轮转会 truncate 同一文件,readTruth 逐行 JSON.parse 一遇坏行即崩
// → P4「真值样本 0」(2026-09-20 R2 实测)。影子目录让两个实例彻底不共文件。
export const SIM_SHADOW = SIM_PORT !== 4010
  ? process.env.SIM_SHADOW_DIR ?? resolve(REPO, '..', 'plc-node-simulator-bench')
  : null

/** 源码树(src/**)最新 mtime——影子副本过期判定 */
function simSrcStamp(dir) {
  let latest = 0
  const walk = (d) => {
    let entries
    try { entries = readdirSync(d, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      const p = join(d, e.name)
      if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p) }
      else { try { latest = Math.max(latest, statSync(p).mtimeMs) } catch {} }
    }
  }
  walk(join(dir, 'src'))
  return latest
}

/** 准备影子目录(幂等;源码 stamp 或端口变化即重拷),返回实际 spawn 用的目录。
 *  拷贝后做**传输端口重映射**:预设里的 modbus/rtu/opcua 端口是硬编码(16040/15041/5840…),
 *  与 4010 共享实例并行时会互相抢占端口(opcua 5840 被占 → 该协议全部读写落到别的进程,
 *  2026-09-20 R2-R4「port-2-opcua 0 采样」根因)。偏移 = (SIM_PORT-4010)×1000:
 *  5840→6840、16040→17040、15041→16041;MQTT broker(18830,外部 docker)不映射。 */
function ensureShadowSim() {
  if (!SIM_SHADOW) return SIM_DIR
  const stampFile = join(SIM_SHADOW, '.bench-stamp')
  const stamp = String(simSrcStamp(SIM_DIR)) + ':' + SIM_PORT
  const fresh = existsSync(stampFile)
    && existsSync(join(SIM_SHADOW, 'node_modules'))
    && readFileSync(stampFile, 'utf8') === stamp
  if (!fresh) {
    const offset = (SIM_PORT - 4010) * 1000
    mkdirSync(SIM_SHADOW, { recursive: true })
    cpSync(SIM_DIR, SIM_SHADOW, {
      recursive: true,
      filter: (s) => {
        if (s === SIM_DIR) return true
        const top = relative(SIM_DIR, s).split(/[\\/]/)[0]
        return top !== 'node_modules' && top !== '.git' && top !== 'data'
      },
    })
    // 端口重映射:仅 shadow/src 下 .ts 文件;仅 58xx( opcua )与 15xxx/16xxx(modbus/rtu)段
    const remap = (d) => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const p = join(d, e.name)
        if (e.isDirectory()) remap(p)
        else if (e.name.endsWith('.ts')) {
          const src = readFileSync(p, 'utf8')
          const out = src.replace(/(port:\s*)(5[89]\d{2}|1[56]\d{3})\b/g, (_, a, n) => a + (Number(n) + offset))
          if (out !== src) writeFileSync(p, out)
        }
      }
    }
    remap(join(SIM_SHADOW, 'src'))
    try { symlinkSync(join(SIM_DIR, 'node_modules'), join(SIM_SHADOW, 'node_modules'), 'junction') }
    catch { /* 已存在或平台不支持:首次拷贝失败会在 spawn 后就绪探测处显式失败 */ }
    writeFileSync(stampFile, stamp)
  }
  return SIM_SHADOW
}

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

  const cwd = ensureShadowSim()
  log(`  · 模拟器未在线 → 自动启动 (cwd=${cwd}, port=${SIM_PORT}${cwd !== SIM_DIR ? ', 影子私有数据目录' : ''}, 无 watch 常驻)`)
  // ⚠️ 严禁用 `npm run dev`(= tsx watch):watch 进程会因文件事件自动重启,
  // 而预设装置只存内存不落盘 → 重启即丢整条产线 → 表现为「 biax 每写必断膜 /
  // DAQ 0 采样 / 真值 0」(2026-09-20 R2-R5 全部假象的共同根因)。直跑 tsx 常驻。
  const child = spawn('npx', ['tsx', 'src/server/index.ts'], {
    cwd,
    shell: true,
    env: { ...process.env, NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost', SIM_PORT: String(SIM_PORT) },
    stdio: 'ignore',
    detached: false,
  })
  child.unref?.()
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    await sleep(1500)
    if (await simUp()) break
  }
  if (!(await simUp())) {
    return { started: false, pid: child.pid, dir: cwd, reason: `启动后 ${timeoutMs}ms 内未就绪（检查 ${SIM_DIR}/npm 日志与依赖安装）` }
  }
  // 空库冷启会播种 5 台默认演示设备(dev-*):其中默认 opcua 与 cast 预设的 opcua
  // 同端口(重映射后同为 6840)→ 预设 opcua 服务端 EADDRINUSE 绑不上 → screw 写全落空
  // (2026-09-20 R6「P6 不收敛/port-2 无采样」根因)。拉起后立即清场,产线由预设重建。
  try {
    const nodes = (await simApi('GET', '/api/nodes')).data ?? []
    for (const n of nodes) await simApi('DELETE', `/api/nodes/${n.id}`)
    log(`  · 冷启默认设备已清场(${nodes.length} 台) → 产线由预设从零重建`)
  } catch { /* 清场失败不阻塞:预设 apply 仍会尽量覆盖 */ }
  return { started: true, pid: child.pid, dir: cwd, reason: 'spawned' }
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
