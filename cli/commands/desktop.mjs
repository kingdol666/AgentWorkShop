// Desktop can use the Windows installer or the optional npm Electron runtime.
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { outputAssetsReady } from '../core/post-build.mjs'
import { runChild } from '../core/child-lifecycle.mjs'
import { localBypassEnv } from '../core/context.mjs'

const require = createRequire(import.meta.url)

export const meta = {
  name: 'desktop',
  group: '运行',
  summary: '启动桌面工作台（独立本机后端）',
  usage: 'aw desktop [--executable <path>]',
  needsProject: false,
}

export async function run({ flags }, ctx) {
  const explicit = flags.executable ?? process.env.AW_DESKTOP_EXECUTABLE
  const installed = process.platform === 'win32' && process.env.LOCALAPPDATA
    ? join(process.env.LOCALAPPDATA, 'Programs', 'AgentWorkShop', 'AgentWorkShop.exe')
    : undefined
  const executable = explicit ?? (installed && existsSync(installed) ? installed : undefined)
  if (executable) {
    if (typeof executable !== 'string' || !existsSync(resolve(executable))) throw new Error('指定的桌面程序不存在')
    return runChild(resolve(executable), [], { env: localBypassEnv(), forwardSignals: false })
  }
  const root = ctx.root ?? ctx.packageRoot
  const shell = join(root, 'desktop')
  const localElectron = createRequire(join(shell, 'package.json'))
  let entry
  for (const loader of [localElectron, require]) {
    try {
      entry = loader.resolve('electron/package.json')
      break
    }
    catch { /* optional runtime not installed */ }
  }
  if (!entry) throw new Error('缺少可选的 Electron 运行时。请重新安装 npm 包（不要省略 optional 依赖），或安装桌面版并用 --executable 指定。')
  if (!outputAssetsReady(root)) throw new Error('桌面后端产物不完整。源码检出请先运行 aw build，npm 安装请重新安装完整发布包。')
  const env = localBypassEnv({ AW_DESKTOP_NODE_BIN: process.execPath })
  delete env.ELECTRON_RUN_AS_NODE
  return runChild(process.execPath, [join(dirname(entry), 'cli.js'), shell], { env, forwardSignals: false })
}
