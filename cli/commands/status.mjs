// ============================================================
// 指令:status — 项目运行态总览（配置源 / 服务健康 / 指令表）
// ============================================================
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { color } from '../core/logger.mjs'
import { findRunningServer } from '../core/context.mjs'

export const meta = {
  name: 'status',
  aliases: ['st', 'info'],
  group: '诊断',
  summary: '项目运行态总览（模式 / 配置源 / 服务健康 / 指令表）',
  usage: 'aw status [--json]',
  needsProject: false,
}

export async function run(argv, ctx) {
  const { config } = ctx
  const { effective, sources } = config.load()

  const server = await findRunningServer(config, { timeoutMs: 600 })

  const runtimeOverrides = Object.fromEntries(
    Object.entries(ctx.config.load().overrides).map(([k, v]) => [k, v]),
  )

  const commands = ctx.registry.list().map(c => ({
    name: c.meta.name,
    group: c.meta.group,
    aliases: c.meta.aliases ?? [],
    source: typeof c.source === 'string' && c.source.includes(join('cli', 'commands')) ? 'builtin' : c.source,
  }))

  if (ctx.json) {
    console.log(JSON.stringify({
      ok: true,
      mode: ctx.mode,
      root: ctx.root,
      home: ctx.home,
      package: { version: (await import('../aw.mjs')).packageVersion() },
      config: { path: ctx.configPath, effective, sources, runtimeOverrides },
      server: server ? { running: true, port: server.port } : { running: false },
      build: { outputExists: ctx.root ? existsSync(join(ctx.root, '.output', 'server', 'index.mjs')) : existsSync(join(ctx.packageRoot, '.output', 'server', 'index.mjs')) },
      commands,
    }, null, 2))
    return 0
  }

  console.log('')
  console.log(`${color.bold('运行状态')}  ${color.dim(`${ctx.mode} 模式 · ${ctx.root ?? ctx.home}`)}`)
  console.log('')
  console.log(`  ${color.cyan('运行中服务')}   ${server ? color.green(`在线 · ${server.port} 端口 /api/system/config 响应`) : color.yellow('离线（无 dev/prod 服务在跑）')}`)
  console.log(`  ${color.cyan('配置中枢')}     ${ctx.configPath}`)
  console.log(`  ${color.cyan('生产构建')}     ${(ctx.root ?? ctx.packageRoot) && existsSync(join(ctx.root ?? ctx.packageRoot, '.output', 'server', 'index.mjs')) ? color.green('存在 (.output/)') : color.yellow('缺失（aw build 后可用 aw start）')}`)
  console.log(`  ${color.cyan('运行时覆盖')}   ${Object.keys(runtimeOverrides).length ? Object.keys(runtimeOverrides).join(', ') : color.dim('无（全部为 config.yml/env 决定）')}`)
  console.log(`  ${color.cyan('指令')}         ${commands.length} 条（内建 + 用户 + 项目）`)
  console.log('')
  console.log(color.bold('有效配置（关键项）'))
  for (const key of ['server.host', 'server.dev.port', 'server.prod.port', 'theme.primaryColor', 'theme.mode', 'api.timeout']) {
    const src = sources[key] === 'env' ? color.yellow(sources[key]) : sources[key] === 'runtime' ? color.green(sources[key]) : color.dim(sources[key])
    console.log(`  ${key.padEnd(24)} = ${String(effective[key]).padEnd(14)} ${src}`)
  }
  console.log('')
  console.log(color.dim('查看全部设置: aw config list · 服务细分: aw doctor'))
  return 0
}
