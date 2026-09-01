// ============================================================
// 指令:home — 查看/初始化 .AgentWorkShop 配置根
// ------------------------------------------------------------
// .AgentWorkShop 是配置与数据中枢（类比 Claude Code 的 ~/.claude）：
//   repo 模式：<检出>/.AgentWorkShop（运行时覆盖/数据/日志/项目级指令）
//   home 模式：~/.AgentWorkShop（AW_HOME 可重定向;另种子 config.yml/.env/compose）
// 本指令幂等：缺什么补什么，绝不覆盖已有文件。
// ============================================================
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { color } from '../core/logger.mjs'
import { runBootstrap } from '../../scripts/home-bootstrap.mjs'

export const meta = {
  name: 'home',
  aliases: ['hw'],
  group: '配置',
  summary: '查看/初始化 .AgentWorkShop 配置根（双模式）',
  usage: 'aw home [--json]',
  needsProject: false,
}

export async function run(argv, ctx) {
  // home 模式引导（幂等）：种子 config.yml/.env/docker-compose 到用户级根
  const { home: bootHome } = runBootstrap({ quiet: ctx.json })
  const userRoot = ctx.home
  const configRoot = ctx.configRoot
  const isRepo = ctx.mode === 'repo'

  if (ctx.json) {
    const files = ['runtime-settings.json', 'data']
    const status = Object.fromEntries(files.map(f => [f, existsSync(join(configRoot, f))]))
    console.log(JSON.stringify({
      ok: true,
      mode: ctx.mode,
      userRoot,
      configRoot,
      files: status,
      homeBootstrapped: bootHome,
    }))
    return 0
  }

  console.log('')
  console.log(`${color.bold('.AgentWorkShop 配置根')}  ${color.dim('— 配置与数据中枢(与环境和路径无关)')}`)
  console.log('')
  console.log(`  ${color.cyan('运行模式')}   ${isRepo ? color.green('repo') + color.dim(' (项目检出内)') : color.cyan('home') + color.dim(' (全局安装)')}`)
  console.log(`  ${color.cyan('配置根')}     ${configRoot}`)
  console.log(`  ${color.cyan('用户级根')}   ${color.dim(userRoot)}${userRoot === configRoot ? color.dim(' (同配置根)') : ''}`)
  console.log('')
  console.log(color.bold('  当前生效配置根内容'))
  const files = [
    ['runtime-settings.json', '运行时覆盖(aw config set 写入)'],
    ['data/', '运行数据(sqlite/JSON 仓库/备份)'],
    ['commands/', isRepo ? '项目级自定义指令(覆盖内建)' : '用户级自定义指令'],
  ]
  for (const [f, desc] of files) {
    const ok = existsSync(join(configRoot, f.replace(/\/$/, '')))
    const mark = ok ? color.green('✓') : color.yellow('—')
    console.log(`  ${mark} ${f.padEnd(24)}${color.dim(desc)}`)
  }
  if (isRepo) {
    console.log(`  ${existsSync(join(ctx.root, '.AgentWorkShop', 'prompts')) ? color.green('✓') : color.yellow('—')} prompts/                ${color.dim('Agent 提示词(唯一事实源,随包分发)')}`)
  }
  else {
    console.log(`  ${existsSync(join(userRoot, 'config.yml')) ? color.green('✓') : color.yellow('—')} config.yml              ${color.dim('主配置(工厂默认种子)')}`)
    console.log(`  ${existsSync(join(userRoot, '.env')) ? color.green('✓') : color.yellow('—')} .env                    ${color.dim('密钥(随机 NUXT_SESSION_PASSWORD)')}`)
    console.log(`  ${existsSync(join(userRoot, 'docker-compose.yml')) ? color.green('✓') : color.yellow('—')} docker-compose.yml      ${color.dim('数采基础设施自拉起')}`)
  }
  console.log('')
  console.log(color.dim('重定向: 设置环境变量 AW_HOME 即可改变用户级根(默认 ~/.AgentWorkShop)'))
  console.log(color.dim('层级:   项目级(检出内) > 用户级(~/.AgentWorkShop) > 内建;同名指令/覆盖前者生效'))
  console.log('')
  return 0
}
