/**
 * AML Python 运行时:探测 python/uv → 共享 venv 供给(幂等,marker 校验)→
 * 给作业运行器提供受控子进程(复用 line-spawn 的 Windows 引号纪律与杀树)。
 *
 * 供给纪律:仅 venv 创建阶段联网(pip/uv install,依赖锁定在 requirements.txt,
 * 可配镜像);训练/评估进程不联网。探测结果与 venv 供给进程内缓存。
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { AppError } from '../../../utils/errors'
import { resolveOnPath, spawnLineProcess } from '../agents/adapters/line-spawn'
import { killHarnessProcess } from '../agents/harness-process'
import { createLogger } from '../logger'
import { amlSettings } from '../settings'
import type { AmlRuntime } from './runtime'

const log = createLogger('aml.py')

const g = globalThis as typeof globalThis & {
  __amlPyProbe?: PythonProbe
  __amlVenvPromise?: Promise<string>
}

export interface PythonProbe {
  ok: boolean
  pythonPath?: string
  version?: string
  uvPath?: string
  reason?: string
}

function runCapture(cmd: string, args: string[], timeoutMs: number): Promise<{ code: number, out: string, err: string }> {
  return new Promise((resolve) => {
    const child = spawnLineProcess(cmd, args)
    let out = ''
    let err = ''
    const timer = setTimeout(() => {
      void killHarnessProcess(child.pid ?? 0)
      resolve({ code: -1, out, err: `${err}\n[timeout ${timeoutMs}ms]` })
    }, timeoutMs)
    child.stdout?.on('data', (d) => {
      out += String(d)
    })
    child.stderr?.on('data', (d) => {
      err += String(d)
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

/** 探测 python 与 uv(进程内缓存;settings 变更靠重启生效) */
export async function probePython(): Promise<PythonProbe> {
  if (g.__amlPyProbe) return g.__amlPyProbe
  const s = amlSettings()
  const candidates = s.python.pythonBin
    ? [s.python.pythonBin]
    : process.platform === 'win32'
      ? ['python', 'py']
      : ['python3', 'python']
  let uvPath: string | undefined
  const uvName = s.python.uvBin || 'uv'
  const uvResolved = resolveOnPath(uvName)
  if (uvResolved) uvPath = uvResolved
  else if (!s.python.uvBin && process.platform !== 'win32') {
    // 非 Windows resolveOnPath 不解析;用 which 语义兜底一次
    const r = await runCapture('which', [uvName], 5000)
    if (r.code === 0 && r.out.trim()) uvPath = r.out.trim().split('\n')[0]
  }

  for (const name of candidates) {
    const resolved = resolveOnPath(name) ?? (name.includes('/') || name.includes('\\') || /^[A-Za-z]:/.test(name) ? name : undefined)
    if (!resolved || !existsSync(resolved)) continue
    const probe = await runCapture(resolved, ['--version'], 10_000)
    if (probe.code === 0) {
      const version = probe.out.trim() || probe.err.trim()
      // `py -3` 需要 -3 参数才指向 Python3(Windows 启动器);其余直接用
      const result: PythonProbe = {
        ok: true,
        pythonPath: resolved,
        version,
        uvPath,
      }
      g.__amlPyProbe = result
      log.info(`[aml-python] 探测成功:${version} @ ${resolved}${uvPath ? ` (uv: ${uvPath})` : ''}`)
      return result
    }
  }
  // py 启动器特有:裸 `py --version` 可能成功但需要 -3 才是 py3
  const result: PythonProbe = {
    ok: false,
    uvPath,
    reason: '未找到可用的 Python 3 解释器:安装 Python 3.10+ 或 uv,或设置 aml.python.pythonBin 指向解释器绝对路径',
  }
  g.__amlPyProbe = result
  return result
}

export function requirementsHash(): string {
  const reqPath = join(platformPythonDir(), 'requirements.txt')
  const content = existsSync(reqPath) ? readFileSync(reqPath, 'utf8') : ''
  const idx = amlSettings().python.indexUrl
  return createHash('sha256').update(content).update(idx).digest('hex').slice(0, 12)
}

/**
 * 平台 python 资产目录解析(amlkit.py/aml_eval.py/requirements.txt 所在):
 * dev=cwd 源码树;打包产物经 AW_PACKAGE_ROOT 或用户配置根兜底(与 schema.json 的
 * cwd 兜底同范式 —— nitro 打包后 import.meta.dirname 不可靠)。
 */
export function platformPythonDir(): string {
  const fallback = join(process.cwd(), 'server', 'services', 'workshop', 'aml', 'python')
  const candidates = [
    process.env.AML_PYHOME ?? '',
    fallback,
    join(process.env.AW_PACKAGE_ROOT ?? process.cwd(), 'server', 'services', 'workshop', 'aml', 'python'),
  ]
  for (const c of candidates) {
    if (c && existsSync(join(c, 'amlkit.py'))) return c
  }
  return fallback
}

export function venvDir(rt: AmlRuntime): string {
  return join(rt.root, 'runtime', 'venv')
}

export function venvPythonPath(rt: AmlRuntime): string {
  return process.platform === 'win32'
    ? join(venvDir(rt), 'Scripts', 'python.exe')
    : join(venvDir(rt), 'bin', 'python')
}

/**
 * 共享 venv 供给(幂等):marker 文件校验 requirements+indexUrl 摘要;并发调用共享同一 Promise。
 * 返回 venv 内 python 绝对路径。
 */
export async function ensureVenv(rt: AmlRuntime): Promise<string> {
  if (g.__amlVenvPromise) return g.__amlVenvPromise
  g.__amlVenvPromise = (async () => {
    const probe = await probePython()
    if (!probe.ok || !probe.pythonPath) {
      throw new AppError(503, 'AML_PYTHON_MISSING', `训练运行时不可用:${probe.reason}`)
    }
    const vdir = venvDir(rt)
    const vpy = venvPythonPath(rt)
    const marker = join(vdir, `.aml-ok-${requirementsHash()}`)
    if (existsSync(marker) && existsSync(vpy)) return vpy

    const s = amlSettings()
    const idxArgs = s.python.indexUrl ? ['--index-url', s.python.indexUrl] : []
    const reqPath = join(platformPythonDir(), 'requirements.txt')
    log.info('[aml-python] 开始 venv 供给(首次可能需数分钟下载依赖)…')
    if (probe.uvPath) {
      const mk = await runCapture(probe.uvPath, ['venv', vdir, '--python', probe.pythonPath], 120_000)
      if (mk.code !== 0) throw new AppError(500, 'AML_VENV_FAILED', `uv venv 失败:${mk.err.slice(-400)}`)
      const inst = await runCapture(probe.uvPath, ['pip', 'install', '--python', vpy, '-r', reqPath, ...idxArgs], 20 * 60_000)
      if (inst.code !== 0) throw new AppError(500, 'AML_VENV_FAILED', `依赖安装失败:${(inst.err || inst.out).slice(-400)}`)
    }
    else {
      const mk = await runCapture(probe.pythonPath, ['-m', 'venv', vdir], 120_000)
      if (mk.code !== 0) throw new AppError(500, 'AML_VENV_FAILED', `python -m venv 失败:${mk.err.slice(-400)}`)
      const inst = await runCapture(vpy, ['-m', 'pip', 'install', '-r', reqPath, ...idxArgs], 20 * 60_000)
      if (inst.code !== 0) throw new AppError(500, 'AML_VENV_FAILED', `pip install 失败:${(inst.err || inst.out).slice(-400)}`)
    }
    writeFileSync(marker, new Date().toISOString())
    log.info('[aml-python] venv 供给完成')
    return vpy
  })()
  try {
    return await g.__amlVenvPromise
  }
  catch (err) {
    g.__amlVenvPromise = undefined // 失败不缓存,下次重试
    throw err
  }
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
