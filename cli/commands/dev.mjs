// ============================================================
// 指令:dev — 以配置驱动的方式启动开发服务器
// ------------------------------------------------------------
// 实际执行 scripts/dev-guard.mjs（与 `pnpm dev` 完全同链路）：
//   · --unhandled-rejections=warn 重入守卫（陈旧 socket ECONNRESET 免疫,
//     且 nitro fork 的 worker 经 execArgv 继承同享保护）
//   · .env 预载（NUXT_SESSION_PASSWORD 等密钥只经环境注入）
//   · 端口/主机取自有效配置（config.yml < runtime-settings < env < CLI 参数）
// 子进程统一注入 NO_PROXY（本机代理不再劫持 localhost 回环）。
// ============================================================
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { color } from '../core/logger.mjs'
import { localBypassEnv } from '../core/context.mjs'

export const meta = {
  name: 'dev',
  aliases: ['d'],
  group: '运行',
  summary: '启动开发服务器（配置驱动端口，含断连守卫）',
  usage: 'aw dev [--port <n>] [--host <h>]',
  needsProject: true,
}

export async function run(argv, ctx) {
  const { flags } = argv
  const { root, config } = ctx

  const eff = config.load()
  const port = flags.port !== undefined ? Number(flags.port) : Number(eff.effective['server.dev.port'])
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.log(`${color.red('✖')} 无效端口: ${flags.port ?? eff.effective['server.dev.port']}`)
    return 1
  }
  const host = flags.host !== undefined ? String(flags.host) : String(eff.effective['server.host'] ?? '0.0.0.0')
  const portSource = flags.port !== undefined ? 'CLI' : eff.sources['server.dev.port']

  // 走 dev-guard 启动链(与 pnpm dev 等效);脚本缺失时退回直连 nuxt(仍带守卫标志)
  const guard = join(root, 'scripts', 'dev-guard.mjs')
  const nuxtBin = ctx.resolveNuxtBin()
  let cmd = process.execPath
  let args
  if (existsSync(guard)) {
    args = [guard, 'dev', '--port', String(port), '--host', host]
  }
  else if (nuxtBin) {
    args = ['--unhandled-rejections=warn', nuxtBin, 'dev', '--port', String(port), '--host', host]
  }
  else {
    console.log(`${color.red('✖')} 未找到 scripts/dev-guard.mjs 且解析不到 nuxt CLI —— 请在项目根安装依赖(pnpm install)`)
    return 1
  }

  console.log(`${color.cyan('›')} 开发服务器 -> http://${host}:${port}  ${color.dim(`(端口来源: ${portSource})`)}`)
  console.log(`${color.cyan('›')} 停止: Ctrl+C`)

  const child = spawn(cmd, args, {
    cwd: root,
    stdio: 'inherit',
    env: localBypassEnv(),
  })
  const shutdown = () => child.kill('SIGTERM')
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)

  return await new Promise((resolve2) => {
    child.on('close', code => resolve2(code ?? 0))
    child.on('error', (err) => {
      console.log(`${color.red('✖')} dev 进程启动失败: ${err.message}`)
      resolve2(1)
    })
  })
}
