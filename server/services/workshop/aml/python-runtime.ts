/**
 * AML Python 运行时:探测 uv / python → 一键安装 uv → 用 uv 供给 <amlRoot>/.venv
 * → 给作业运行器提供受控子进程(复用 line-spawn 的 Windows 引号纪律与杀树)。
 *
 * uv 优先(与平台的设计前提一致):
 *  - uv 存在 → `uv venv <amlRoot>/.venv` + `uv pip install --python <venv> -r requirements.txt`;
 *  - uv 缺失 → 走 python -m venv 兜底(功能可用但慢),同时 UI 提供「一键安装 uv」;
 *  - 一键安装把 uv 落到 <amlRoot>/tools/ 并写 <amlRoot>/runtime/uv.json ——
 *    **不写系统 PATH、不需要管理员**;整份 ./aml 可删可搬。
 *
 * 供给纪律:仅 venv 创建阶段联网(pip/uv install,依赖锁定在 requirements.txt,
 * 可配镜像);训练/评估进程不联网。
 */
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { AppError } from '../../../utils/errors'
import { resolveOnPath, spawnLineProcess } from '../agents/adapters/line-spawn'
import { killHarnessProcess } from '../agents/harness-process'
import { createLogger } from '../logger'
import { amlSettings } from '../settings'
import type { AmlRuntime } from './runtime'

const log = createLogger('aml.py')

/** uv 安装/venv 供给的硬超时(下载 40MB 二进制 + 装依赖,给足但必须有上限) */
const UV_INSTALL_TIMEOUT_MS = 10 * 60_000
const VENV_CREATE_TIMEOUT_MS = 5 * 60_000
const PIP_INSTALL_TIMEOUT_MS = 20 * 60_000

const g = globalThis as typeof globalThis & {
  __amlPyProbe?: PythonProbe
  __amlUvProbe?: UvProbe
  __amlVenvPromise?: Promise<string>
}

export interface PythonProbe {
  ok: boolean
  pythonPath?: string
  version?: string
  uvPath?: string
  reason?: string
}

/** uv 探测结果(source 说明来源,便于排障:配置/项目本地/PATH) */
export interface UvProbe {
  ok: boolean
  path?: string
  version?: string
  source?: 'config' | 'project' | 'state' | 'path'
  reason?: string
}

/** 安装记录(<amlRoot>/runtime/uv.json):记录一键安装的产物路径与时间 */
export interface UvInstallRecord {
  uvPath: string
  version: string
  installedAt: string
  installDir: string
  method: string
}

export type ProgressFn = (line: string) => void

function runCapture(
  cmd: string,
  args: string[],
  timeoutMs: number,
  onData?: ProgressFn,
): Promise<{ code: number, out: string, err: string }> {
  return new Promise((resolve) => {
    const child = spawnLineProcess(cmd, args)
    let out = ''
    let err = ''
    const timer = setTimeout(() => {
      void killHarnessProcess(child.pid ?? 0)
      resolve({ code: -1, out, err: `${err}\n[timeout ${timeoutMs}ms]` })
    }, timeoutMs)
    child.stdout?.on('data', (d) => {
      const s = String(d)
      out += s
      onData?.(s)
    })
    child.stderr?.on('data', (d) => {
      const s = String(d)
      err += s
      onData?.(s)
    })
    child.on('error', (e) => {
      clearTimeout(timer)
      resolve({ code: -1, out, err: String(e) })
    })
    child.on('exit', (code) => {
      clearTimeout(timer)
      resolve({ code: code ?? -1, out, err })
    })
  })
}

// ---------- 路径 ----------

/** uv 二进制候选文件名(Windows 带 .exe) */
function uvBinName(): string {
  return process.platform === 'win32' ? 'uv.exe' : 'uv'
}

/** 判断是否像绝对/相对路径(而非 PATH 上的名字) */
function looksLikePath(name: string): boolean {
  return name.includes('/') || name.includes('\\') || /^[A-Za-z]:/.test(name)
}

/** <amlRoot>/runtime/uv.json 读取(损坏/缺失返回 null) */
export function readUvRecord(rt: AmlRuntime): UvInstallRecord | null {
  try {
    const p = join(rt.runtimeDir, 'uv.json')
    if (!existsSync(p)) return null
    const parsed = JSON.parse(readFileSync(p, 'utf8')) as UvInstallRecord
    return parsed && typeof parsed.uvPath === 'string' ? parsed : null
  }
  catch {
    return null
  }
}

function writeUvRecord(rt: AmlRuntime, rec: UvInstallRecord): void {
  try {
    mkdirSync(rt.runtimeDir, { recursive: true })
    writeFileSync(join(rt.runtimeDir, 'uv.json'), JSON.stringify(rec, null, 2))
  }
  catch (err) {
    log.warn('[aml-uv] 安装记录落盘失败:', (err as Error)?.message)
  }
}

/** 在目录里递归找 uv 可执行(一键安装产物定位;深度受限防误扫) */
function findUvInDir(dir: string, depth = 3): string | null {
  if (depth < 0 || !existsSync(dir)) return null
  let entries: string[]
  try {
    entries = readdirSync(dir)
  }
  catch {
    return null
  }
  const want = uvBinName()
  // 先扫当前层的直接命中(`<dir>/uv.exe`、`<dir>/bin/uv`)
  for (const e of entries) {
    if (e === want) {
      const p = join(dir, e)
      try {
        if (statSync(p).isFile()) return p
      }
      catch { /* 忽略 */ }
    }
  }
  for (const e of entries) {
    if (e === 'bin' || e === 'Scripts' || e === 'tools') {
      const p = join(dir, e, want)
      try {
        if (existsSync(p) && statSync(p).isFile()) return p
      }
      catch { /* 忽略 */ }
    }
  }
  for (const e of entries) {
    const p = join(dir, e)
    try {
      if (!statSync(p).isDirectory()) continue
    }
    catch {
      continue
    }
    const hit = findUvInDir(p, depth - 1)
    if (hit) return hit
  }
  return null
}

/**
 * 平台 python 资产目录解析(amlkit.py/aml_eval.py/requirements.txt 所在)。
 *
 * 这些是**运行时经 fs 读取**的资产(requirementsHash 读 requirements.txt、jobEnv 把
 * 本目录塞进 PYTHONPATH),nitro 不会打包它们,所以发布产物必须自带一份:
 * 构建期由 nuxt.config.ts 复制到 .output/.AgentWorkShop/aml-python。
 * 解析顺序:AML_PYHOME 覆盖 > cwd 源码树 > 产物自带副本 > AW_PACKAGE_ROOT 包根。
 * 缺了它们的后果不是启动失败,而是训练作业在供给 venv 时才炸(且报错指向空摘要)。
 */
export function platformPythonDir(): string {
  const rel = join('server', 'services', 'workshop', 'aml', 'python')
  const fallback = join(process.cwd(), rel)
  const candidates = [
    process.env.AML_PYHOME ?? '',
    fallback,
    join(process.cwd(), '.output', '.AgentWorkShop', 'aml-python'),
    join(process.env.AW_PACKAGE_ROOT ?? process.cwd(), rel),
    join(process.env.AW_PACKAGE_ROOT ?? process.cwd(), '.output', '.AgentWorkShop', 'aml-python'),
  ]
  for (const c of candidates) {
    if (c && existsSync(join(c, 'amlkit.py'))) return c
  }
  return fallback
}

/** venv 落点:<amlRoot>/.venv(与数据集/模型同级,整份 ./aml 可整体删除重建) */
export function venvDir(rt: AmlRuntime): string {
  return rt.venvDir || join(rt.root, '.venv')
}

export function venvPythonPath(rt: AmlRuntime): string {
  return process.platform === 'win32'
    ? join(venvDir(rt), 'Scripts', 'python.exe')
    : join(venvDir(rt), 'bin', 'python')
}

// ---------- 探测 ----------

/** 清空探测缓存(一键安装 uv / 创建 venv 后必须调用,否则旧结论被缓存住) */
export function resetProbeCache(): void {
  g.__amlPyProbe = undefined
  g.__amlUvProbe = undefined
  g.__amlVenvPromise = undefined
}

async function probeUvBinary(candidate: string, source: UvProbe['source']): Promise<UvProbe | null> {
  const resolved = resolveOnPath(candidate)
    ?? (looksLikePath(candidate) || existsSync(candidate) ? candidate : undefined)
  if (!resolved) return null
  if (!existsSync(resolved)) return null
  const r = await runCapture(resolved, ['--version'], 15_000)
  if (r.code !== 0) return null
  return { ok: true, path: resolved, version: (r.out || r.err).trim().split('\n')[0], source }
}

/**
 * 探测 uv。优先级:
 *   ① aml.python.uvBin 配置(显式指定)
 *   ② <amlRoot>/tools/**(一键安装的产物)
 *   ③ <amlRoot>/runtime/uv.json 记录路径(用户搬过目录时容错)
 *   ④ 系统 PATH
 */
export async function probeUv(rt?: AmlRuntime): Promise<UvProbe> {
  if (g.__amlUvProbe) return g.__amlUvProbe
  const s = amlSettings()
  const attempts: Array<[string, UvProbe['source']]> = []
  if (s.python.uvBin) attempts.push([s.python.uvBin, 'config'])
  const record = rt ? readUvRecord(rt) : null
  if (rt) {
    const projectHit = findUvInDir(rt.toolsDir)
    if (projectHit) attempts.push([projectHit, 'project'])
  }
  if (record?.uvPath) attempts.push([record.uvPath, 'state'])
  if (!s.python.uvBin) attempts.push(['uv', 'path'])

  for (const [candidate, source] of attempts) {
    const hit = await probeUvBinary(candidate, source)
    if (hit) {
      g.__amlUvProbe = hit
      log.info(`[aml-uv] 探测到 uv ${hit.version} @ ${hit.path} (来源=${source})`)
      return hit
    }
  }
  // 非 Windows:resolveOnPath 不解析,用 which 语义兜底一次
  if (process.platform !== 'win32' && !s.python.uvBin) {
    const r = await runCapture('which', ['uv'], 5000)
    const p = r.out.trim().split('\n')[0]
    if (r.code === 0 && p) {
      const hit = await probeUvBinary(p, 'path')
      if (hit) {
        g.__amlUvProbe = hit
        return hit
      }
    }
  }
  const miss: UvProbe = {
    ok: false,
    reason: '未检测到 uv。可点击「一键安装 uv」由平台自动安装到 ./aml/tools(免管理员、不改系统 PATH),或在设置中指定 aml.python.uvBin。',
  }
  g.__amlUvProbe = miss
  return miss
}

/** 探测 python 与 uv(进程内缓存;settings 变更靠重启生效) */
export async function probePython(): Promise<PythonProbe> {
  if (g.__amlPyProbe) return g.__amlPyProbe
  const s = amlSettings()
  const rt = safeRuntime()
  const uv = rt ? await probeUv(rt) : undefined
  const candidates = s.python.pythonBin
    ? [s.python.pythonBin]
    : process.platform === 'win32'
      ? ['python', 'py']
      : ['python3', 'python']

  for (const name of candidates) {
    const resolved = resolveOnPath(name) ?? (looksLikePath(name) ? name : undefined)
    if (!resolved || !existsSync(resolved)) continue
    const probe = await runCapture(resolved, ['--version'], 10_000)
    if (probe.code === 0) {
      const version = probe.out.trim() || probe.err.trim()
      const result: PythonProbe = {
        ok: true,
        pythonPath: resolved,
        version,
        uvPath: uv?.ok ? uv.path : undefined,
      }
      g.__amlPyProbe = result
      log.info(`[aml-python] 探测成功:${version} @ ${resolved}${uv?.ok ? ` (uv: ${uv.path})` : ' (无 uv,将用 python -m venv 兜底)'}`)
      return result
    }
  }
  const result: PythonProbe = {
    ok: false,
    uvPath: uv?.ok ? uv.path : undefined,
    reason: '未找到可用的 Python 3 解释器:安装 Python 3.10+ 或 uv,或设置 aml.python.pythonBin 指向解释器绝对路径',
  }
  g.__amlPyProbe = result
  return result
}

/** 探测时 runtime 可能尚未装配(CLI/测试路径);缺失返回 null 而非抛错 */
function safeRuntime(): AmlRuntime | null {
  try {
    // 延迟 require 避免与 runtime.ts 形成加载期循环依赖
    return (g as typeof globalThis & { __amlRuntime?: AmlRuntime }).__amlRuntime ?? null
  }
  catch {
    return null
  }
}

// ---------- 一键安装 uv ----------

/**
 * 一键安装 uv 到 <amlRoot>/tools(免管理员、不改系统 PATH)。
 *  - 首选官方安装脚本:UV_INSTALL_DIR 指向 tools 目录,UV_NO_MODIFY_PATH=1 禁止改 PATH;
 *  - 兜底 python -m pip install --target tools uv;
 *  - 安装后探测校验并写 <amlRoot>/runtime/uv.json。
 * 幂等:已装且可执行则直接返回现状。
 */
export async function installUv(rt: AmlRuntime, onLog?: ProgressFn): Promise<{ ok: boolean, uvPath?: string, version?: string, method: string, log: string }> {
  const lines: string[] = []
  const emit: ProgressFn = (s) => {
    const t = s.trimEnd()
    if (t) {
      lines.push(t)
      onLog?.(t)
    }
  }
  const existing = await probeUvBinary(findUvInDir(rt.toolsDir) ?? '', 'project')
  if (existing?.ok && existing.path) {
    emit(`已存在可用 uv:${existing.version} @ ${existing.path}`)
    return { ok: true, uvPath: existing.path, version: existing.version, method: 'existing', log: lines.join('\n') }
  }

  mkdirSync(rt.toolsDir, { recursive: true })
  const errors: string[] = []

  // ① 官方安装脚本
  emit(`[1/2] 使用官方安装脚本安装 uv 到 ${rt.toolsDir} …`)
  const script = await runOfficialInstaller(rt, emit)
  if (script.ok) {
    const hit = findUvInDir(rt.toolsDir)
    if (hit) {
      const v = await runCapture(hit, ['--version'], 15_000)
      const version = (v.out || v.err).trim().split('\n')[0]
      writeUvRecord(rt, { uvPath: hit, version, installedAt: new Date().toISOString(), installDir: rt.toolsDir, method: 'official-script' })
      resetProbeCache()
      emit(`安装成功:${version} @ ${hit}`)
      return { ok: true, uvPath: hit, version, method: 'official-script', log: lines.join('\n') }
    }
    errors.push('官方脚本执行完成但未在 tools 目录找到 uv 可执行文件')
  }
  else {
    errors.push(script.err)
  }

  // ② pip --target 兜底
  emit('[2/2] 回退方案:python -m pip install --target tools uv')
  const probe = await probePython()
  if (probe.ok && probe.pythonPath) {
    const pipArgs = ['-m', 'pip', 'install', '--upgrade', '--target', rt.toolsDir, 'uv']
    const idx = amlSettings().python.indexUrl
    if (idx) pipArgs.push('--index-url', idx)
    const r = await runCapture(probe.pythonPath, pipArgs, UV_INSTALL_TIMEOUT_MS, emit)
    if (r.code === 0) {
      const hit = findUvInDir(rt.toolsDir)
      if (hit) {
        try {
          chmodSync(hit, 0o755)
        }
        catch { /* Windows 无 x 位 */ }
        const v = await runCapture(hit, ['--version'], 15_000)
        const version = (v.out || v.err).trim().split('\n')[0]
        writeUvRecord(rt, { uvPath: hit, version, installedAt: new Date().toISOString(), installDir: rt.toolsDir, method: 'pip-target' })
        resetProbeCache()
        emit(`安装成功:${version} @ ${hit}`)
        return { ok: true, uvPath: hit, version, method: 'pip-target', log: lines.join('\n') }
      }
      errors.push('pip 安装成功但未找到 uv 可执行文件')
    }
    else {
      errors.push(`pip 安装失败:${(r.err || r.out).slice(-400)}`)
    }
  }
  else {
    errors.push(`无可用 Python 解释器:${probe.reason}`)
  }

  emit('安装失败。')
  return { ok: false, method: 'none', log: `${lines.join('\n')}\n\n--- 失败原因 ---\n${errors.join('\n')}` }
}

/** 调用官方安装脚本(逐平台);成功判据 = 进程退出码 0 */
/** PowerShell 单引号字面量转义:字面量内的单引号写成两个单引号 */
const PS_QUOTE_ESC = '\'\''

/** 调用官方安装脚本(逐平台);成功判据 = 进程退出码 0 */
async function runOfficialInstaller(rt: AmlRuntime, emit: ProgressFn): Promise<{ ok: boolean, err: string }> {
  if (process.platform === 'win32') {
    const ps = [
      `$env:UV_INSTALL_DIR='${rt.toolsDir.replace(/'/g, PS_QUOTE_ESC)}'`,
      `$env:UV_NO_MODIFY_PATH='1'`,
      'irm https://astral.sh/uv/install.ps1 | iex',
    ].join('; ')
    const r = await runCapture('powershell', ['-ExecutionPolicy', 'Bypass', '-NoProfile', '-NonInteractive', '-Command', ps], UV_INSTALL_TIMEOUT_MS, emit)
    return { ok: r.code === 0, err: `官方脚本失败(exit=${r.code}):${(r.err || r.out).slice(-400)}` }
  }
  const sh = `curl -LsSf https://astral.sh/uv/install.sh | env UV_INSTALL_DIR='${rt.toolsDir.replace(/'/g, `'\\''`)}' UV_NO_MODIFY_PATH=1 sh`
  const r = await runCapture('sh', ['-c', sh], UV_INSTALL_TIMEOUT_MS, emit)
  return { ok: r.code === 0, err: `官方脚本失败(exit=${r.code}):${(r.err || r.out).slice(-400)}` }
}

// ---------- venv 供给 ----------

export function requirementsHash(): string {
  const reqPath = join(platformPythonDir(), 'requirements.txt')
  const content = existsSync(reqPath) ? readFileSync(reqPath, 'utf8') : ''
  const idx = amlSettings().python.indexUrl
  return createHash('sha256').update(content).update(idx).digest('hex').slice(0, 12)
}

/** venv 就绪标记路径(内容摘要变更即视为需重建) */
export function venvMarkerPath(rt: AmlRuntime): string {
  return join(venvDir(rt), `.aml-ok-${requirementsHash()}`)
}

export function isVenvReady(rt: AmlRuntime): boolean {
  return existsSync(venvMarkerPath(rt)) && existsSync(venvPythonPath(rt))
}

/**
 * 共享 venv 供给(幂等):marker 文件校验 requirements+indexUrl 摘要;并发调用共享同一 Promise。
 * 返回 venv 内 python 绝对路径。force=true 时删掉旧 venv 重建(UI「重建环境」)。
 */
export async function ensureVenv(rt: AmlRuntime, opts: { force?: boolean, onLog?: ProgressFn } = {}): Promise<string> {
  if (opts.force) {
    try {
      rmSync(venvDir(rt), { recursive: true, force: true })
      emitLog(opts.onLog, `已清理旧环境:${venvDir(rt)}`)
    }
    catch (err) {
      throw new AppError(500, 'AML_VENV_FAILED', `清理旧环境失败(可能仍被进程占用):${(err as Error).message}`)
    }
    g.__amlVenvPromise = undefined
  }
  if (g.__amlVenvPromise && !opts.force) return g.__amlVenvPromise
  const task = (async () => {
    const vdir = venvDir(rt)
    const vpy = venvPythonPath(rt)
    if (isVenvReady(rt)) {
      emitLog(opts.onLog, `环境已就绪(标记 ${requirementsHash()}):${vdir}`)
      return vpy
    }
    const probe = await probePython()
    if (!probe.ok || !probe.pythonPath) {
      throw new AppError(503, 'AML_PYTHON_MISSING', `训练运行时不可用:${probe.reason}`)
    }
    const s = amlSettings()
    const idxArgs = s.python.indexUrl ? ['--index-url', s.python.indexUrl] : []
    const reqPath = join(platformPythonDir(), 'requirements.txt')
    mkdirSync(rt.root, { recursive: true })
    emitLog(opts.onLog, `开始供给 Python 环境(首次可能需数分钟下载依赖)…`)

    if (probe.uvPath) {
      emitLog(opts.onLog, `uv venv ${vdir} --python ${probe.pythonPath}`)
      const mk = await runCapture(probe.uvPath, ['venv', vdir, '--python', probe.pythonPath], VENV_CREATE_TIMEOUT_MS, opts.onLog)
      if (mk.code !== 0) throw new AppError(500, 'AML_VENV_FAILED', `uv venv 失败:${mk.err.slice(-400)}`)
      emitLog(opts.onLog, `uv pip install -r requirements.txt`)
      const inst = await runCapture(probe.uvPath, ['pip', 'install', '--python', vpy, '-r', reqPath, ...idxArgs], PIP_INSTALL_TIMEOUT_MS, opts.onLog)
      if (inst.code !== 0) throw new AppError(500, 'AML_VENV_FAILED', `依赖安装失败:${(inst.err || inst.out).slice(-400)}`)
    }
    else {
      emitLog(opts.onLog, `未检测到 uv,回退 python -m venv(较慢)`)
      const mk = await runCapture(probe.pythonPath, ['-m', 'venv', vdir], VENV_CREATE_TIMEOUT_MS, opts.onLog)
      if (mk.code !== 0) throw new AppError(500, 'AML_VENV_FAILED', `python -m venv 失败:${mk.err.slice(-400)}`)
      const inst = await runCapture(vpy, ['-m', 'pip', 'install', '-r', reqPath, ...idxArgs], PIP_INSTALL_TIMEOUT_MS, opts.onLog)
      if (inst.code !== 0) throw new AppError(500, 'AML_VENV_FAILED', `pip install 失败:${(inst.err || inst.out).slice(-400)}`)
    }
    writeFileSync(venvMarkerPath(rt), new Date().toISOString())
    emitLog(opts.onLog, '环境供给完成。')
    log.info('[aml-python] venv 供给完成')
    return vpy
  })()
  g.__amlVenvPromise = task
  try {
    return await task
  }
  catch (err) {
    g.__amlVenvPromise = undefined // 失败不缓存,下次重试
    throw err
  }
}

function emitLog(onLog: ProgressFn | undefined, line: string): void {
  onLog?.(line)
}

/**
 * 作业子进程环境:白名单语义(cleanEnv,不继承 process.env)。
 * Agent 编写的 train.py 运行在此环境中 —— 服务器 secrets(引擎 API key、
 * DAQ_TSDB_URL、MinIO 凭据等)一律不可见;仅保留 Python 运行所需系统键。
 */
export function jobEnv(rt: AmlRuntime, jobDir: string): Record<string, string> {
  const platformPyDir = platformPythonDir()
  const pick = (k: string): string => (process.env[k] ? `${k}=${process.env[k] as string}` : '')
  const sysEnv = ['PATH', 'PATHEXT', 'SYSTEMROOT', 'SYSTEMDRIVE', 'COMSPEC', 'WINDIR', 'TEMP', 'TMP', 'PROGRAMFILES', 'LANG', 'LC_ALL']
    .map(pick)
    .filter(s => s !== '')
    .reduce<Record<string, string>>((acc, kv) => {
      const eq = kv.indexOf('=')
      acc[kv.slice(0, eq)] = kv.slice(eq + 1)
      return acc
    }, {})
  return {
    ...sysEnv,
    AML_JOB_DIR: jobDir,
    // 资产根暴露给训练脚本:模型/数据集实体都在 ./aml 下,脚本按相对路径读取
    AML_ROOT: rt.root,
    PYTHONPATH: platformPyDir,
    PYTHONUNBUFFERED: '1',
    PYTHONDONTWRITEBYTECODE: '1',
    PYTHONIOENCODING: 'utf-8',
    // 显式置空代理(白名单下本就不继承,双保险防止系统级 sitecustomize 注入)
    HTTP_PROXY: '',
    HTTPS_PROXY: '',
    http_proxy: '',
    https_proxy: '',
  }
}

export { killHarnessProcess }
