// ============================================================
// 指令:update — 检查 npm 远程最新版本并就地更新全局 aw
// ------------------------------------------------------------
// 流程:本地版本(packageVersion) → npm view <pkg> version(尊重用户
// registry 配置,--registry 可覆盖) → semver 比较 → 有新版则
// npm install -g <pkg>@latest → npm ls 复核安装版本。
// 提示:npmmirror 等镜像同步官方源有分钟级延迟,查最新版可加
//   --registry https://registry.npmjs.org
// ============================================================
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { color } from '../core/logger.mjs'
import { CliError } from '../core/errors.mjs'
import { packageVersion } from '../aw.mjs'

export const meta = {
  name: 'update',
  aliases: ['upgrade'],
  group: '其他',
  summary: '检查 npm 远程最新版本,有新版则就地更新',
  usage: 'aw update [--check] [--registry <url>] [--yes]',
  description: [
    '对比当前版本与 npm registry 上的 latest;有新版则 npm install -g 全局更新并复核。',
    '镜像同步延迟时可加 --registry https://registry.npmjs.org 直查官方源。',
  ],
  needsProject: false,
}

const npmBin = () => 'npm'

/** spawnSync npm;Windows 上 .cmd 必须经 shell(CVE-2024-27980 后无 shell 直接 spawn .cmd 报 EINVAL) */
function npmRun(args, { registry, inherit = false } = {}) {
  return spawnSync(npmBin(), registry ? [...args, '--registry', registry] : args, {
    encoding: 'utf8',
    stdio: inherit ? 'inherit' : 'pipe',
    shell: process.platform === 'win32',
  })
}

/** 读取包名(全局安装副本/仓库检出都成立;读不到回退 agentworkshop) */
function pkgName(ctx) {
  try {
    const p = join(ctx.packageRoot, 'package.json')
    if (existsSync(p)) return JSON.parse(readFileSync(p, 'utf8')).name || 'agentworkshop'
  }
  catch { /* 回退 */ }
  return 'agentworkshop'
}

/** semver 比较:1 = a 更新,-1 = b 更新,0 相同(忽略 prerelease 后缀) */
function cmpVersions(a, b) {
  const pa = String(a).split('-')[0].split('.').map(n => Number.parseInt(n, 10) || 0)
  const pb = String(b).split('-')[0].split('.').map(n => Number.parseInt(n, 10) || 0)
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) > (pb[i] ?? 0)) return 1
    if ((pa[i] ?? 0) < (pb[i] ?? 0)) return -1
  }
  return 0
}

export async function run(argv, ctx) {
  const { flags } = argv
  const registry = flags.registry ? String(flags.registry) : undefined
  const name = pkgName(ctx)
  const current = packageVersion()

  console.log(`${color.cyan('›')} 当前版本: ${color.bold(`v${current}`)}`)
  console.log(`${color.cyan('›')} 查询 npm registry${registry ? ` (${registry})` : ''} ...`)

  const view = npmRun(['view', name, 'version'], { registry })
  if (view.error || view.status !== 0) {
    const detail = (view.stderr ?? view.stdout ?? view.error?.message ?? '').trim().split(/\r?\n/).filter(Boolean).pop() ?? 'unknown error'
    throw new CliError('REGISTRY', `无法从 npm 获取 ${name} 的最新版本:\n  ${detail}\n提示: 镜像同步有延迟,可加 --registry https://registry.npmjs.org 直查官方源`)
  }
  const latest = (view.stdout ?? '').trim().split(/\r?\n/).filter(Boolean).pop()?.trim()
  if (!latest) throw new CliError('REGISTRY', 'npm view 返回为空')

  console.log(`${color.cyan('›')} 远端最新: ${color.bold(`v${latest}`)}`)

  if (cmpVersions(latest, current) <= 0) {
    console.log(`${color.green('✔')} 已是最新版本 (${current})`)
    return 0
  }
  console.log(`${color.yellow('⚠')} 发现新版本: ${color.dim(current)} → ${color.bold(latest)}`)

  if (flags.check) {
    console.log(`${color.dim('›')} (--check 仅检查;去掉该参数运行 aw update 即可更新)`)
    return 0
  }

  if (!flags.yes && !flags.y && process.stdin.isTTY) {
    const { createInterface } = await import('node:readline')
    const rl = createInterface({ input: process.stdin, output: process.stdout })
    const answer = await new Promise(resolve => rl.question('立即更新? (Y/n) ', resolve))
    rl.close()
    if (/^n/i.test(answer.trim())) {
      console.log('已取消')
      return 0
    }
  }

  console.log(`${color.cyan('›')} npm install -g ${name}@latest ...`)
  const inst = npmRun(['install', '-g', `${name}@latest`], { registry, inherit: true })
  if (inst.status !== 0) {
    throw new CliError('UPDATE_FAILED', `更新失败 (npm exit ${inst.status ?? '?'})——可手动执行: npm install -g ${name}@latest`)
  }

  // 复核:从全局包清单读回实际安装版本
  const ls = npmRun(['ls', '-g', '--depth=0', name], { registry })
  const installed = new RegExp(`${name}@(\\S+)`).exec(ls.stdout ?? '')?.[1]
  if (installed) console.log(`${color.green('✔')} 更新完成: ${color.dim(current)} → ${color.bold(installed)}`)
  else console.log(`${color.green('✔')} 更新完成 → ${color.bold(latest)}`)
  console.log(`${color.dim('›')} 新开 aw 进程即运行新版本(当前进程仍是旧代码)`)
  return 0
}
