/**
 * AML Python 运行时:探测 uv / python → 一键安装 uv → 用 uv 供给 <amlRoot>/.venv
 * → 给作业运行器提供受控子进程与杀树。
 *
 * uv 优先(与平台的设计前提一致):
 *  - uv 存在 → `uv venv <amlRoot>/.venv` + `uv pip install --python <venv> -r requirements.txt`;
 *  - uv 缺失 → 走 python -m venv 兜底(功能可用但慢),同时 UI 提供「一键安装 uv」;
 *  - 一键安装把 uv 落到 <amlRoot>/tools/ 并写 <amlRoot>/runtime/uv.json ——
 *    **不写系统 PATH、不需要管理员**;整份 ./aml 可删可搬。
 *
 * 供给纪律:环境供给阶段可联网;项目本地 uv 从固定的官方发布资产安装,先验哈希再解包。
 */
import { execFile, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { devNull } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { AppError } from '../../../utils/errors'
import { resolveOnPath, spawnLineProcess } from '../agents/adapters/line-spawn'
import { killHarnessProcess } from '../agents/harness-process'
import { createLogger } from '../logger'
import { fetchPublicBuffer, validatePublicUrl } from '../net/public-egress'
import { amlSettings } from '../settings'
import { assertEnvIdleForMaintenance } from './env-lease'
import type { AmlRuntime } from './runtime'

const log = createLogger('aml.py')

const UV_PYTHON_TIMEOUT_MS = 10 * 60_000
const VENV_CREATE_TIMEOUT_MS = 300_000
const PIP_INSTALL_TIMEOUT_MS = 600_000
const UV_RELEASE_VERSION = '0.11.29'
const UV_RELEASE_HOSTS = new Set(['github.com', 'release-assets.githubusercontent.com'])
const execFileAsync = promisify(execFile)

// Archive sizes and SHA-256 from `gh api repos/astral-sh/uv/releases/tags/0.11.29`.
// Executable hashes are from the exact member in each archive, after verifying its archive hash.
const UV_RELEASE_ASSETS = {
  'aarch64-apple-darwin': [22496145, '61c04acc52a33ef0f331e494bdfbedcdb6c26c6970c022ed3699e5860f8930e3', '3ac242bb6bca0841cad65b877e21a3e9f65c97141712b5c8438cc8a8c89ead54'],
  'aarch64-pc-windows-msvc': [23766948, '55b597ae81bc29531a7c352a1431a8a73cc2755d7a5b9ec454580cbe02e5154f', 'bbafdd69166bdc7038b7362c0aacd44fc5a25a5e505bb7a86bdde388590197b2'],
  'aarch64-unknown-linux-gnu': [24438519, '94500fb064ae3c971a873cba64d94694c50677e0a4dbf78735c80509e7429919', '40de8760ec3d368ae7a19d06392a071b761dddbe1b926d23f736ce65befe131c'],
  'aarch64-unknown-linux-musl': [24292339, '593d79a797ece3f1dfaaf3e0a973263422a135d9262c7dbc6cd75d9c11acc0b4', '1d2c8d3736513607b3a5ae47861cb507827dc1ff1e6909e342c9e23302398472'],
  'x86_64-apple-darwin': [24120839, 'c4c4de482da9ccdd076dc4fb5cfe7b740609029385c72f58606be3153602387d', '3fcfeb23eb951da9c2db2ebdde52b7f83cafe3bf90f1d6225519b6d0db43c04b'],
  'x86_64-pc-windows-msvc': [25534683, 'a047d55651bc3e0ca24595b25ec4cfcb10f9dca9fb56514e661269b37d4fae68', '6d40479cd1d0d5db7fc0fe68ad703fc8acbd84bba50d864bb97461f6af9d9561'],
  'x86_64-unknown-linux-gnu': [26200011, '04f8b82f5d47f0512dcd32c67a4a6f16a0ea27c81537c338fd0ad6b23cebe829', '4f26786f798cce6e9f467fe917d4305b9600ef8bf14994aa016fbb32523e5ca5'],
  'x86_64-unknown-linux-musl': [26396567, '46711858adb2a3acaa9cee00f9060688ad1fd5706aecc005b96a6a7f285a00b7', 'aa58db25cf3ea824b7d0d694df313ff769282f2c5acb48084a831d40258fa98c'],
} as const

function uvReleaseAsset() {
  const cpu = process.arch === 'x64' ? 'x86_64' : process.arch === 'arm64' ? 'aarch64' : null
  if (!cpu) return null
  let target: keyof typeof UV_RELEASE_ASSETS
  if (process.platform === 'win32') target = `${cpu}-pc-windows-msvc`
  else if (process.platform === 'darwin') target = `${cpu}-apple-darwin`
  else if (process.platform === 'linux') {
    // Node's report identifies glibc; absence on Linux selects the official musl build.
    const report = process.report.getReport() as { header?: { glibcVersionRuntime?: string } }
    target = `${cpu}-unknown-linux-${report.header?.glibcVersionRuntime ? 'gnu' : 'musl'}`
  }
  else return null
  const [size, archiveSha256, binSha256] = UV_RELEASE_ASSETS[target]
  const stem = `uv-${target}`
  const windows = process.platform === 'win32'
  return {
    target,
    filename: `${stem}.${windows ? 'zip' : 'tar.gz'}`,
    member: windows ? 'uv.exe' : `${stem}/uv`,
    size,
    archiveSha256,
    binSha256,
  }
}

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
  source?: 'config' | 'project' | 'path'
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
  env?: Record<string, string>,
): Promise<{ code: number, out: string, err: string }> {
  return new Promise((resolve) => {
    const child = env
      ? spawn(cmd, args, { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, shell: false })
      : spawnLineProcess(cmd, args)
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
  let stage: string | undefined
  try {
    mkdirSync(rt.runtimeDir, { recursive: true })
    stage = mkdtempSync(join(rt.runtimeDir, '.uv-record-'))
    const record = join(stage, 'uv.json')
    writeFileSync(record, JSON.stringify(rec, null, 2), { flag: 'wx', mode: 0o600 })
    renameSync(record, join(rt.runtimeDir, 'uv.json'))
  }
  catch {
    log.warn('[aml-uv] 安装记录落盘失败')
  }
  finally {
    if (stage) cleanupUvStage(stage)
  }
}

function uvInstallPath(rt: AmlRuntime, asset: NonNullable<ReturnType<typeof uvReleaseAsset>>): string {
  return resolve(rt.toolsDir, `uv-${UV_RELEASE_VERSION}-${asset.target}`, uvBinName())
}

async function isVerifiedUv(path: string, sha256: string): Promise<boolean> {
  try {
    if (!lstatSync(dirname(path)).isDirectory()) return false
    const file = lstatSync(path)
    if (!file.isFile() || file.size > 128 * 1024 * 1024) return false
    const hash = createHash('sha256')
    for await (const chunk of createReadStream(path)) hash.update(chunk)
    return hash.digest('hex') === sha256
  }
  catch {
    return false
  }
}

function cleanupUvStage(stage: string): void {
  try {
    rmSync(stage, { recursive: true, force: true, maxRetries: 2 })
  }
  catch {
    log.warn('[aml-uv] 无法清理安装暂存目录')
  }
}

/** Resolve complete AML assets from the application payload, not the writable home. */
export function platformPythonDir(): string {
  const root = process.env.AW_PACKAGE_ROOT || process.cwd()
  const override = process.env.AML_PYHOME
  const candidates = override
    ? [override]
    : [
        join(root, '.output', '.AgentWorkShop', 'aml-python'),
        join(root, 'server', 'services', 'workshop', 'aml', 'python'),
      ]
  const required = ['amlkit.py', 'aml_eval.py', 'requirements.txt', 'train-example.py', 'train-hybrid-example.py']
  for (const dir of candidates) {
    if (required.every(file => existsSync(join(dir, file)))) return dir
  }
  throw new AppError(503, 'AML_PYTHON_ASSETS_MISSING', 'AML Python 资产不完整;请重新构建/安装应用或检查 AML_PYHOME')
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
  const resolved = source === 'project'
    ? candidate
    : resolveOnPath(candidate) ?? (looksLikePath(candidate) || existsSync(candidate) ? candidate : undefined)
  if (!resolved || !existsSync(resolved)) return null
  const r = await runCapture(resolved, ['--version'], 15_000, undefined, provisionSystemEnv())
  if (r.code !== 0) return null
  return { ok: true, path: resolved, version: (r.out || r.err).trim().split('\n')[0], source }
}

/**
 * 探测 uv。优先级:
 *   ① aml.python.uvBin 配置(显式指定)
 *   ② 固定路径且哈希匹配的项目本地官方 uv
 *   ③ 系统 PATH
 * uv.json 仅用于状态记录,不作为可执行文件来源。
 */
export async function probeUv(rt?: AmlRuntime): Promise<UvProbe> {
  if (g.__amlUvProbe) return g.__amlUvProbe
  const s = amlSettings()
  const attempts: Array<[string, UvProbe['source']]> = []
  if (s.python.uvBin) attempts.push([s.python.uvBin, 'config'])
  const asset = uvReleaseAsset()
  if (rt && asset) {
    const path = uvInstallPath(rt, asset)
    if (await isVerifiedUv(path, asset.binSha256)) attempts.push([path, 'project'])
  }
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
  // uv 托管解释器兜底(2026-10-05 uv 优先):uv python install 之后(甚至之前主动装),
  // 用 uv python find 解析托管解释器路径 —— 它不在系统 PATH 上,常规候选探测不到
  if (uv?.ok && uv.path) {
    const ver = process.env.AML_UV_PYTHON || '3.11'
    const find = await runCapture(uv.path, ['--no-config', '--no-python-downloads', 'python', 'find', '--', ver], 30_000, undefined, rt ? provisionEnv(rt) : provisionSystemEnv())
    const managed = find.code === 0 ? find.out.trim().split(/\r?\n/).pop()?.trim() : ''
    if (find.code === 0 && managed && existsSync(managed)) {
      const probe2 = await runCapture(managed, ['--version'], 10_000)
      if (probe2.code === 0) {
        const result: PythonProbe = {
          ok: true,
          pythonPath: managed,
          version: `uv-managed ${probe2.out.trim() || probe2.err.trim()}`,
          uvPath: uv.path,
        }
        g.__amlPyProbe = result
        log.info(`[aml-python] 探测成功(uv 托管):${result.version} @ ${managed}`)
        return result
      }
    }
  }
  const result: PythonProbe = {
    ok: false,
    uvPath: uv?.ok ? uv.path : undefined,
    // uv 优先(2026-10-05 用户需求):无 uv 才引导安装 uv;有 uv 时由平台自举托管解释器
    reason: uv?.ok
      ? '系统无 Python,但已检测到 uv —— 直接点「创建训练环境」,平台将用 uv 自动安装托管解释器并配置依赖(uv 优先,无需预装 Python)'
      : '未检测到 uv 与可用的 Python:推荐安装 uv(https://docs.astral.sh/uv/ 一条命令、免管理员),或点击「一键安装 uv」由平台装入 ./aml/tools;也可设置 aml.python.pythonBin 指向已有解释器',
  }
  g.__amlPyProbe = result
  return result
}

/**
 * uv 优先的自举解释器(2026-10-05 用户需求):系统无 Python 时,由 uv 直接安装
 * 托管解释器(uv python install)并解析路径(uv python find)—— 用户无需预装 Python。
 * 版本偏好:env AML_UV_PYTHON > 默认 3.11;幂等(uv 对已装版本直接命中)。
 */
export async function ensurePythonViaUv(rt: AmlRuntime, uvPath: string, onLog?: ProgressFn): Promise<string> {
  const ver = process.env.AML_UV_PYTHON || '3.11'
  const env = provisionEnv(rt)
  emitLog(onLog, `系统无 Python —— uv 优先自举:uv python install ${ver}(首次会下载托管解释器,数十秒到数分钟)…`)
  const inst = await runCapture(uvPath, ['--no-config', 'python', 'install', '--no-bin', '--no-registry', '--', ver], UV_PYTHON_TIMEOUT_MS, onLog, env)
  if (inst.code !== 0) throw new AppError(500, 'AML_UV_PYTHON_FAILED', `uv python install 失败:${(inst.err || inst.out).slice(-400)}`)
  const find = await runCapture(uvPath, ['--no-config', '--no-python-downloads', 'python', 'find', '--', ver], 30_000, undefined, env)
  if (find.code !== 0) throw new AppError(500, 'AML_UV_PYTHON_FAILED', `uv python find 失败:${(find.err || find.out).slice(-400)}`)
  const pyPath = find.out.trim().split(/\r?\n/).pop()?.trim() ?? ''
  if (!pyPath) throw new AppError(500, 'AML_UV_PYTHON_FAILED', 'uv python find 未返回解释器路径')
  emitLog(onLog, `托管解释器就绪:${pyPath}`)
  return pyPath
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

/** Install only the pinned official asset. Never run an installer or search a staging tree for an executable. */
export async function installUv(rt: AmlRuntime, onLog?: ProgressFn): Promise<{ ok: boolean, uvPath?: string, version?: string, method: string, log: string }> {
  const lines: string[] = []
  const emit: ProgressFn = (line) => {
    lines.push(line)
    onLog?.(line)
  }
  let stage: string | undefined
  try {
    const asset = uvReleaseAsset()
    if (!asset) throw new AppError(400, 'AML_UV_PLATFORM_UNSUPPORTED', `未提供此平台的 uv 发布资产(${process.platform}-${process.arch});请手动安装并设置 aml.python.uvBin`)
    const uvPath = uvInstallPath(rt, asset)
    const version = `uv ${UV_RELEASE_VERSION}`
    if (await isVerifiedUv(uvPath, asset.binSha256)) {
      emit(`已存在通过校验的 ${version} @ ${uvPath}`)
      return { ok: true, uvPath, version, method: 'existing', log: lines.join('\n') }
    }
    const installDir = dirname(uvPath)
    if (lstatSync(installDir, { throwIfNoEntry: false })) {
      throw new AppError(500, 'AML_UV_EXISTING_INVALID', `现有 uv 安装未通过完整性校验;请先移除 ${installDir},再重试`)
    }

    emit(`正在下载官方 ${version} (${asset.filename})…`)
    const url = `https://github.com/astral-sh/uv/releases/download/${UV_RELEASE_VERSION}/${asset.filename}`
    const archive = await fetchPublicBuffer(url, { allowedHosts: UV_RELEASE_HOSTS, maxBytes: asset.size, label: 'uv 发布资产' })
    if (archive.length !== asset.size || createHash('sha256').update(archive).digest('hex') !== asset.archiveSha256) {
      throw new AppError(502, 'AML_UV_ARCHIVE_INVALID', 'uv 发布资产大小或 SHA-256 不匹配;未解包')
    }

    mkdirSync(rt.toolsDir, { recursive: true })
    if (!lstatSync(rt.toolsDir).isDirectory()) throw new AppError(500, 'AML_UV_TOOLS_INVALID', 'AML tools 必须是真实目录')
    stage = mkdtempSync(join(rt.toolsDir, '.uv-stage-'))
    const archivePath = join(stage, asset.filename)
    writeFileSync(archivePath, archive, { flag: 'wx', mode: 0o600 })
    const bin = await extractUvMember(archivePath, asset.member)
    if (createHash('sha256').update(bin).digest('hex') !== asset.binSha256) {
      throw new AppError(502, 'AML_UV_BINARY_INVALID', '解包的 uv 二进制 SHA-256 不匹配;未安装')
    }
    const publishDir = join(stage, 'install')
    mkdirSync(publishDir, { mode: 0o700 })
    writeFileSync(join(publishDir, uvBinName()), bin, { flag: 'wx', mode: 0o700 })
    renameSync(publishDir, installDir)

    const method = 'official-release'
    writeUvRecord(rt, { uvPath, version, installedAt: new Date().toISOString(), installDir, method })
    resetProbeCache()
    emit(`安装成功:${version} @ ${uvPath}`)
    return { ok: true, uvPath, version, method, log: lines.join('\n') }
  }
  catch (err) {
    // Never expose upstream redirect URLs, extractor commands, or raw response content.
    emit(err instanceof AppError ? err.message : 'uv 安装失败;请检查 AML tools 目录权限和磁盘空间')
    return { ok: false, method: 'none', log: lines.join('\n') }
  }
  finally {
    if (stage) cleanupUvStage(stage)
  }
}

async function extractUvMember(archive: string, member: string): Promise<Buffer> {
  const systemRoot = process.env.SystemRoot ?? ''
  const candidates = process.platform === 'win32'
    ? isAbsolute(systemRoot) ? [join(systemRoot, 'System32', 'tar.exe')] : []
    : ['/usr/bin/tar', '/bin/tar']
  const tar = candidates.find(existsSync)
  if (!tar) throw new AppError(503, 'AML_UV_EXTRACTOR_MISSING', '未找到系统 tar;请安装系统解包工具或手动配置 aml.python.uvBin')
  try {
    // stdout only: the archive never controls the written path, mode, links or metadata.
    const { stdout } = await execFileAsync(tar, ['-xOf', archive, '--', member], {
      encoding: 'buffer',
      maxBuffer: 128 * 1024 * 1024,
      timeout: 60_000,
      cwd: dirname(tar),
      windowsHide: true,
      env: provisionSystemEnv(), // no TAR_OPTIONS, proxy settings, or credentials
    })
    return stdout
  }
  catch {
    throw new AppError(500, 'AML_UV_EXTRACT_FAILED', '无法使用系统 tar 解包已验证的 uv 资产')
  }
}

// ---------- venv 供给 ----------

const PYPI_INDEX = 'https://pypi.org/simple/'

/** The package manager owns its own DNS and redirects. Use only explicitly trusted starting endpoints. */
export async function validateAmlIndex(raw: string): Promise<string> {
  const candidate = raw || PYPI_INDEX
  const allowed = new Set([PYPI_INDEX, PYPI_INDEX.slice(0, -1),
    ...(process.env.AML_PYTHON_INDEX_ALLOWLIST ?? '').split(',').map(url => url.trim()).filter(Boolean)])
  if (!allowed.has(candidate)) {
    throw new AppError(400, 'AML_PYTHON_INDEX_DENIED', 'aml.python.indexUrl 默认仅允许 PyPI;公开镜像须在 AML_PYTHON_INDEX_ALLOWLIST 中显式批准')
  }
  // No credentials (including empty URL userinfo), query/fragment or parser-ambiguous spelling.
  if (!/^https:\/\/[a-z\d.-]+(?:\/[a-z\d._~/-]*)?$/i.test(candidate) || candidate !== candidate.trim()) {
    throw new AppError(400, 'AML_PYTHON_INDEX_DENIED', 'Python 索引必须为不含凭据、端口、查询或片段的 HTTPS URL')
  }
  const checked = await validatePublicUrl(candidate, { timeoutMs: 10_000, label: 'Python 软件包索引' })
  return checked.href
}

function provisionSystemEnv(): Record<string, string> {
  const names = ['PATH', 'PATHEXT', 'SYSTEMROOT', 'SYSTEMDRIVE', 'WINDIR', 'TEMP', 'TMP', 'TMPDIR', 'LANG', 'LC_ALL']
  const values = new Map(Object.entries(process.env).map(([key, value]) => [process.platform === 'win32' ? key.toUpperCase() : key, value]))
  const env: Record<string, string> = {}
  for (const name of names) {
    const value = values.get(name)
    if (value) env[name] = value
  }
  return env
}

function provisionEnv(rt: AmlRuntime): Record<string, string> {
  // Explicitly disable credential discovery and inherited proxy/config settings.
  return {
    ...provisionSystemEnv(),
    NO_PROXY: '*',
    NETRC: devNull,
    PIP_CONFIG_FILE: process.platform === 'win32' ? 'nul' : devNull,
    UV_CREDENTIALS_DIR: devNull,
    UV_PYTHON_INSTALL_DIR: resolve(rt.toolsDir, 'python'),
    UV_CACHE_DIR: resolve(rt.toolsDir, 'uv-cache'),
    UV_KEYRING_PROVIDER: 'disabled',
    PYTHONNOUSERSITE: '1',
  }
}

export function requirementsHash(): string {
  const reqPath = join(platformPythonDir(), 'requirements.txt')
  const content = existsSync(reqPath) ? readFileSync(reqPath, 'utf8') : ''
  const idx = amlSettings().python.indexUrl
  return createHash('sha256').update(content).update(idx).digest('hex').slice(0, 12)
}

/** 完整依赖锁摘要(与 marker 同源,单独暴露给 A7/A22 的"同一 lock hash"断言)。 */
export function requirementsLockHash(): string {
  return requirementsHash()
}

/** venv 就绪标记路径(内容摘要变更即视为需重建) */
export function venvMarkerPath(rt: AmlRuntime): string {
  return join(venvDir(rt), `.aml-ok-${requirementsHash()}`)
}

export function isVenvReady(rt: AmlRuntime): boolean {
  return existsSync(venvMarkerPath(rt)) && existsSync(venvPythonPath(rt))
}

/**
 * 环境身份(AML 训练与 Optimizer Solver 必须是同一解释器/同一 lock):
 * 供 `/api/.../env` 与 `optimizer_capabilities` 报告,不参与就绪判定。
 */
export function venvIdentity(rt: AmlRuntime): {
  pythonPath: string
  marker: string
  requirementsHash: string
  platform: string
  pythonVersion: string | null
  ready: boolean
} {
  return {
    pythonPath: venvPythonPath(rt),
    marker: venvMarkerPath(rt),
    requirementsHash: requirementsHash(),
    platform: `${process.platform}-${process.arch}`,
    pythonVersion: null,
    ready: isVenvReady(rt),
  }
}

/**
 * 共享 venv 供给(幂等):marker 文件校验 requirements+indexUrl 摘要;并发调用共享同一 Promise。
 * 返回 venv 内 python 绝对路径。force=true 时删掉旧 venv 重建(UI「重建环境」)。
 */
export async function ensureVenv(rt: AmlRuntime, opts: { force?: boolean, onLog?: ProgressFn, leaseHolder?: string } = {}): Promise<string> {
  let indexUrl: string | undefined
  if (opts.force) {
    // 重建必须独占:有训练/求解读者时拒绝(不 rmSync 他们正在用的目录)
    assertEnvIdleForMaintenance(opts.leaseHolder ?? 'ensure-venv-force')
    // Refuse unsafe configuration without deleting a working environment.
    indexUrl = await validateAmlIndex(amlSettings().python.indexUrl)
    assertEnvIdleForMaintenance(opts.leaseHolder ?? 'ensure-venv-force')
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
  // 未就绪 = 本次调用会安装依赖(改环境),同样要求在途读者为 0。
  if (!opts.force && !isVenvReady(rt)) assertEnvIdleForMaintenance(opts.leaseHolder ?? 'ensure-venv-install')
  const task = (async () => {
    const vdir = venvDir(rt)
    const vpy = venvPythonPath(rt)
    if (isVenvReady(rt)) {
      emitLog(opts.onLog, `环境已就绪(标记 ${requirementsHash()}):${vdir}`)
      return vpy
    }
    indexUrl ??= await validateAmlIndex(amlSettings().python.indexUrl)
    const idxArgs = ['--index-url', indexUrl, '--only-binary', ':all:']
    const env = provisionEnv(rt)
    const probe = await probePython()
    let basePython = probe.ok ? probe.pythonPath : undefined
    // uv 优先自举(2026-10-05 用户需求):系统无 Python 但有 uv → uv 安装托管解释器,
    // 用户无需预装 Python(uv python install 幂等,已装版本直接命中)。
    if (!basePython && probe.uvPath) {
      basePython = await ensurePythonViaUv(rt, probe.uvPath, opts.onLog)
    }
    if (!basePython) {
      throw new AppError(503, 'AML_PYTHON_MISSING', `训练运行时不可用:${probe.reason ?? '未检测到 uv 且无系统 Python;推荐安装 uv'}`)
    }
    const reqPath = join(platformPythonDir(), 'requirements.txt')
    mkdirSync(rt.root, { recursive: true })
    emitLog(opts.onLog, `开始供给 Python 环境(首次可能需数分钟下载依赖)…`)

    if (probe.uvPath) {
      // 目录已存在时不要重复 `uv venv`(uv 会以 "already exists" 失败):只补依赖。
      const uvFlags = ['--no-config', '--no-python-downloads']
      if (!existsSync(vpy)) {
        emitLog(opts.onLog, `uv venv ${vdir} --python ${basePython}`)
        const mk = await runCapture(probe.uvPath, [...uvFlags, 'venv', vdir, '--python', basePython], VENV_CREATE_TIMEOUT_MS, opts.onLog, env)
        if (mk.code !== 0) throw new AppError(500, 'AML_VENV_FAILED', `uv venv 失败:${mk.err.slice(-400)}`)
      }
      emitLog(opts.onLog, `uv pip install -r requirements.txt`)
      const inst = await runCapture(probe.uvPath, [...uvFlags, 'pip', 'install', '--python', vpy, '-r', reqPath, ...idxArgs], PIP_INSTALL_TIMEOUT_MS, opts.onLog, env)
      if (inst.code !== 0) throw new AppError(500, 'AML_VENV_FAILED', `依赖安装失败:${(inst.err || inst.out).slice(-400)}`)
    }
    else {
      emitLog(opts.onLog, `未检测到 uv,回退 python -m venv(较慢)`)
      const mk = await runCapture(basePython, ['-I', '-m', 'venv', vdir], VENV_CREATE_TIMEOUT_MS, opts.onLog, env)
      if (mk.code !== 0) throw new AppError(500, 'AML_VENV_FAILED', `python -m venv 失败:${mk.err.slice(-400)}`)
      const inst = await runCapture(vpy, ['-I', '-m', 'pip', '--isolated', '--disable-pip-version-check', '--no-input', 'install', '--keyring-provider', 'disabled', '-r', reqPath, ...idxArgs], PIP_INSTALL_TIMEOUT_MS, opts.onLog, env)
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
