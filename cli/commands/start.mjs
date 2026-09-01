// ============================================================
// 指令:start — 以配置驱动的方式启动生产服务
// ------------------------------------------------------------
// 两种模式（自动判定,见 shared/config/home.mjs）：
//   repo 模式：在项目检出内 → 与 `pnpm start` 同链路,配置/数据在项目根
//   home 模式：全局安装后任意目录 → 跑本包应用载荷,cwd=AW Home,
//              配置/数据/日志全部落在 ~/.AgentWorkShop(路径无关)
// home 模式首启若无构建产物会自动构建一次(需依赖已安装)。
// 子进程统一注入 NO_PROXY（本机代理不再劫持 localhost 回环）。
// ============================================================
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { color } from '../core/logger.mjs'
import { localBypassEnv, preloadDotEnv } from '../core/context.mjs'
import { runBootstrap } from '../../scripts/home-bootstrap.mjs'

export const meta = {
  name: 'start',
  aliases: ['s', 'prod', 'preview'],
  group: '运行',
  summary: '一键启动生产服务（配置驱动端口,项目检出内外皆可）',
  usage: 'aw start [--port <n>] [--host <h>]',
  needsProject: false,
}

export async function run(argv, ctx) {
  const { flags } = argv
  const isRepo = Boolean(ctx.root)
  const appRoot = isRepo ? ctx.root : ctx.packageRoot
  const cwd = isRepo ? ctx.root : ctx.home
  const envExtra = {}

  // home 模式:确保 AW Home 就绪(幂等;postinstall 被跳过时兜底)
  if (!isRepo) runBootstrap({ quiet: true })

  // ---- 构建产物检查（home 模式缺产物则先构建一次） ----
  const outputEntry = join(appRoot, '.output', 'server', 'index.mjs')
  if (!existsSync(outputEntry)) {
    const nuxtBin = ctx.resolveNuxtBin()
    if (!nuxtBin) {
      console.log(`${color.red('✖')} 未找到生产构建且解析不到 nuxt CLI(依赖未安装?)`)
      console.log(`  › 请先执行 ${color.cyan('aw build')} 或在应用目录执行 pnpm install`)
      return 1
    }
    console.log(`${color.cyan('›')} 首次启动:正在构建生产产物(约 2-5 分钟,仅一次) ...`)
    const buildCode = await new Promise((resolve2) => {
      const c = spawn(process.execPath, [nuxtBin, 'build'], { cwd: appRoot, stdio: 'inherit', env: localBypassEnv() })
      c.on('close', code => resolve2(code ?? 1))
      c.on('error', () => resolve2(1))
    })
    if (buildCode !== 0 || !existsSync(outputEntry)) {
      console.log(`${color.red('✖')} 构建失败(exit=${buildCode})`)
      return 1
    }
  }

  // ---- 端口/主机解析（配置引擎:config.yml < runtime-settings < env < CLI） ----
  const eff = ctx.config.load()
  const port = flags.port !== undefined ? Number(flags.port) : Number(eff.effective['server.prod.port'])
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.log(`${color.red('✖')} 无效端口: ${flags.port ?? eff.effective['server.prod.port']}`)
    return 1
  }
  const host = flags.host !== undefined ? String(flags.host) : String(eff.effective['server.host'] ?? '0.0.0.0')
  const portSource = flags.port !== undefined ? 'CLI' : eff.sources['server.prod.port']

  // ---- 密钥预载（repo: 项目 .env;home: AW Home/.env —— 引导时已生成随机密钥） ----
  preloadDotEnv(cwd)

  // home 模式:把 AW_HOME/AW_MODE 传给应用与构建子进程
  // (cwd=home 数据自然落盘;AW_MODE=home 防止包目录被误判为项目检出)
  // prompts 是应用资产(随包升级),注入 AW_PROMPTS_DIR 指向包内唯一事实源
  if (!isRepo) {
    envExtra.AW_HOME = ctx.home
    envExtra.AW_MODE = 'home'
    envExtra.AW_PROMPTS_DIR = join(appRoot, '.AgentWorkShop', 'prompts')
  }
  // HOST 环境变量被 scripts/start.mjs 以最高优先读取(CLI 显式 --host 等效)
  if (flags.host !== undefined) envExtra.HOST = host

  console.log(`${color.cyan('›')} 生产服务(${isRepo ? 'repo' : 'home'} 模式) -> http://${host}:${port}  ${color.dim(`(端口来源: ${portSource})`)}`)
  console.log(`${color.cyan('›')} ${color.dim(`配置: ${ctx.configPath} · 数据: ${ctx.dataDir}`)}`)
  console.log(`${color.cyan('›')} 停止: Ctrl+C`)

  const launcher = join(appRoot, 'scripts', 'start.mjs')
  const args = existsSync(launcher) ? [launcher] : [outputEntry]
  if (flags.port !== undefined) args.push('--port', String(port))

  const child = spawn(process.execPath, args, {
    cwd,
    stdio: 'inherit',
    env: localBypassEnv(envExtra),
  })
  const shutdown = () => child.kill('SIGTERM')
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)

  return await new Promise((resolve2) => {
    child.on('close', code => resolve2(code ?? 0))
    child.on('error', (err) => {
      console.log(`${color.red('✖')} start 进程启动失败: ${err.message}`)
      resolve2(1)
    })
  })
}
