/**
 * HarnessAvailability —— 执行引擎环境可用性探测(单一事实源)。
 *
 * 两个消费面共用本模块:
 *   - 前端选择面:GET /api/workshop/harnesses 的 available 字段(下拉禁用未安装项/仪表盘面板);
 *   - 执行前强校验:manager 的模板增改/克隆入 channel/实例改引擎/任务直发/lead 派发
 *     全部经 assertHarnessUsable,不可用直接 409,任务不再进入「起跑后失败」路径。
 *
 * 探测规则(与真实拉起同源,见 line-spawn.resolveExecutable):
 *   - 进程内引擎(mock/claude SDK):无外部 CLI,恒可用;
 *   - 进程型引擎(omp/opencode/codex/dsh):经 HarnessDef.probe 解析命令
 *     (实例 config.command 覆盖 → 运行时设置缺省),再按 PATH/PATHEXT(unix 加 X_OK)
 *     探测磁盘上的真实可执行文件;找不到 = 未安装。
 * 探测结果按「引擎+命令」缓存 30s(fs 探测廉价但热路径避抖);refresh=1 强制重探。
 */
import { accessSync, constants, existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { AppError } from '../../../utils/errors'
import { resolveOnPath } from './adapters/line-spawn'
import { HARNESS_REGISTRY, knownHarnesses } from './registry'

export interface HarnessAvailability {
  id: string
  available: boolean
  /** 进程内引擎(无外部 CLI,恒可用) */
  inprocess: boolean
  /** 进程型引擎:声明将拉起的命令(config 覆盖/设置缺省后) */
  command: string | null
  /** PATH 解析出的可执行文件绝对路径(未找到为 null) */
  resolvedPath: string | null
  /** 不可用原因(人话,可直接展示) */
  error: string | null
}

const isPlainFile = (p: string): boolean => {
  try {
    return existsSync(p) && statSync(p).isFile()
  }
  catch {
    return false
  }
}

const isExecutableFile = (p: string): boolean => {
  try {
    accessSync(p, constants.X_OK)
    return statSync(p).isFile()
  }
  catch {
    return false
  }
}

/** PATH 探测可执行文件;探测永不抛(坏 PATH 环境按未安装处理) */
function probeExecutable(command: string): string | null {
  if (!command) return null
  // 显式路径(含目录分隔符或盘符)不再走 PATH
  if (command.includes('/') || command.includes('\\') || /^[A-Za-z]:/.test(command)) {
    return isPlainFile(command) ? command : null
  }
  if (process.platform === 'win32') return resolveOnPath(command)
  for (const dir of (process.env.PATH ?? '').split(':').filter(Boolean)) {
    const full = join(dir, command)
    if (isExecutableFile(full)) return full
  }
  return null
}

const PROBE_TTL_MS = 30_000
/** 缓存键 = 引擎+命令(命令不同探测结果不同,不能按引擎 id 独占) */
const probeCache = new Map<string, { at: number, resolvedPath: string | null }>()

export function checkHarnessAvailability(
  harnessId: string,
  config?: Record<string, unknown>,
  opts?: { refresh?: boolean },
): HarnessAvailability {
  const def = HARNESS_REGISTRY[harnessId]
  if (!def) {
    return {
      id: harnessId,
      available: false,
      inprocess: false,
      command: null,
      resolvedPath: null,
      error: `未知 harness: ${harnessId}(可选 ${knownHarnesses().join('/')})`,
    }
  }
  const probe = def.probe
  if (!probe || probe.inprocess || !probe.command) {
    return { id: harnessId, available: true, inprocess: true, command: null, resolvedPath: null, error: null }
  }
  const command = probe.command(config)
  const key = `${harnessId}=${command}`
  const cached = probeCache.get(key)
  let resolvedPath: string | null
  if (!opts?.refresh && cached && Date.now() - cached.at < PROBE_TTL_MS) {
    resolvedPath = cached.resolvedPath
  }
  else {
    resolvedPath = probeExecutable(command)
    probeCache.set(key, { at: Date.now(), resolvedPath })
  }
  return {
    id: harnessId,
    available: resolvedPath !== null,
    inprocess: false,
    command,
    resolvedPath,
    error: resolvedPath ? null : `未找到可执行命令「${command}」:引擎 ${def.label} 未安装或不在 PATH 中`,
  }
}

export function checkAllHarnessAvailability(opts?: { refresh?: boolean }): HarnessAvailability[] {
  return Object.keys(HARNESS_REGISTRY).map(id => checkHarnessAvailability(id, undefined, opts))
}

/** 执行前强校验:未知 → 400 UNKNOWN_HARNESS;未安装 → 409 HARNESS_UNAVAILABLE(人话报错,前端可直接展示) */
export function assertHarnessUsable(harness: string, config?: Record<string, unknown>): void {
  if (!HARNESS_REGISTRY[harness]) {
    throw new AppError(400, 'UNKNOWN_HARNESS', `未知 harness: ${harness}(可选 ${knownHarnesses().join('/')})`)
  }
  const a = checkHarnessAvailability(harness, config)
  if (!a.available) {
    throw new AppError(409, 'HARNESS_UNAVAILABLE', a.error ?? `执行引擎 ${harness} 不可用`)
  }
}
