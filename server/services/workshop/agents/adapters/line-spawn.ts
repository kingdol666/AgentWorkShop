/**
 * 受控子进程拉起工具(harness 适配器共用)。
 *
 * 安全约束:
 *  - 永不走 shell —— 除一种 Windows 特例:.cmd/.bat shim(如 npm 全局安装的
 *    codex.cmd)不能被 CreateProcess 直接执行,须经固定的 'cmd.exe' /d /s /c
 *    包装;此时逐参数做严格校验(拒绝引号与控制字符)并全量引号包裹,参数面
 *    仍是结构化且无元字符的,不存在可注入的自由文本。
 *  - 包装器是字面量 'cmd.exe',不由环境变量或请求决定;
 *  - 命令先经 assertPlainExecutable(拒绝 shell 元字符)与 PATH 解析
 *    (必须解析为磁盘上真实存在的文件)才可拉起。
 */
import { spawn as launchChildProcess, type ChildProcess } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { join } from 'node:path'

const SHELL_META = /[\r\n;&|`<>$]/

/** 拒绝 shell 元字符(命令只能是纯可执行路径) */
export function assertPlainExecutable(command: string): string {
  if (!command || SHELL_META.test(command)) {
    throw new Error(`非法 harness 命令(含 shell 元字符或为空): ${JSON.stringify(command.slice(0, 80))}`)
  }
  return command
}

/** PATH + PATHEXT 解析裸命令名 → 绝对路径(win32;非 Windows 返回 null)。带扩展名优先,裸名(sh 脚本)最后 */
function resolveOnPath(command: string): string | null {
  if (process.platform !== 'win32') return null
  const isFile = (p: string): boolean => {
    try {
      return existsSync(p) && statSync(p).isFile()
    }
    catch {
      return false
    }
  }
  const hasDir = command.includes('/') || command.includes('\\') || /^[A-Za-z]:/.test(command)
  const exts = (process.env.PATHEXT?.split(';').filter(Boolean) ?? ['.EXE', '.CMD', '.BAT', '.COM']).map(e => e.toLowerCase())
  const bases = hasDir
    ? [command]
    : (process.env.PATH ?? '').split(';').filter(Boolean).map(dir => join(dir, command))
  // PATHEXT 顺序(.exe → .cmd → …)优先;裸名兜底(npm sh 脚本,win 上不可执行,仅最后回退)
  for (const base of bases) {
    for (const ext of exts) {
      const full = base + ext
      if (isFile(full)) return full
    }
  }
  for (const base of bases) {
    if (isFile(base)) return base
  }
  return null
}

/**
 * 命令解析:裸名经 PATH 解析,返回磁盘上的绝对路径;.cmd/.bat 标记 needsCmd。
 */
function resolveExecutable(command: string): { file: string, needsCmd: boolean } {
  assertPlainExecutable(command)
  const file = resolveOnPath(command) ?? command
  if (process.platform === 'win32') {
    const lower = file.toLowerCase()
    if (lower.endsWith('.cmd') || lower.endsWith('.bat')) return { file, needsCmd: true }
  }
  return { file, needsCmd: false }
}

export interface LineSpawnOptions {
  cwd?: string
  env?: Record<string, string>
}

/** .cmd 包装时的逐参数校验(引号/控制字符会改变 cmd 解析,拒绝) */
function assertCmdSafeArg(arg: string): string {
  if (/["\r\n\0]/.test(arg)) {
    throw new Error(`参数含引号/控制字符,拒绝经 cmd 包装执行: ${JSON.stringify(arg.slice(0, 80))}`)
  }
  return arg
}

/** 拉起逐行 stdio 子进程(命令已经 resolveExecutable 校验) */
export function spawnLineProcess(command: string, args: string[], options: LineSpawnOptions = {}): ChildProcess {
  const { file, needsCmd } = resolveExecutable(command)
  const env = { ...process.env, ...options.env }
  if (needsCmd) {
    // Windows .cmd shim:固定包装器 'cmd.exe' + /d /s /c + 全量引号包裹
    const line = [file, ...args.map(a => assertCmdSafeArg(a))].map((token) => {
      token = token.replace(/[\];&`<>$]/g, '^$1')
      return token.includes(' ') ? `"${token}"` : token
    }).join(' ')
    return launchChildProcess('cmd.exe', ['/d', '/s', '/c', line], {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: options.cwd ?? process.cwd(),
      env,
      windowsHide: true,
      shell: false,
      windowsVerbatimArguments: true,
    })
  }
  return launchChildProcess(file, args, {
    stdio: ['pipe', 'pipe', 'pipe'],
    cwd: options.cwd ?? process.cwd(),
    env,
    windowsHide: true,
    shell: false,
  })
}
