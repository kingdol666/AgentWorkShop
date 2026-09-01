// ============================================================
// AgentWorkShop CLI — 帮助渲染（自动由注册表 meta 生成）
// ============================================================
import { join } from 'node:path'
import { color } from './logger.mjs'

export function renderHelp({ registry, root, version }) {
  const lines = []
  lines.push('')
  lines.push(`${color.bold('AgentWorkShop CLI')}${version ? color.dim(` v${version}`) : ''} — 配置驱动 · 指令系统`)
  lines.push('')
  lines.push(color.dim('用法:') + `  aw ${color.cyan('<command>')} [options] [args]`)
  lines.push(`${color.dim('      agentworkshop <command> [options] [args]   (别名)')}`)
  lines.push('')
  if (root) {
    lines.push(color.dim('项目根:') + `  ${root}  ${color.green('✓')}  ${color.dim('(repo 模式:配置/数据在项目内)')}`)
  }
  else {
    lines.push(`${color.dim('当前目录非项目检出')} → ${color.cyan('home 模式')}${color.dim('(配置/数据在 ~/.AgentWorkShop,任意目录可跑 aw start)')}`)
    lines.push(color.dim('  要开发/调试检出内的项目:') + `  cd <项目> 后运行;  ${color.cyan('aw home')} 查看/初始化配置中枢`)
  }
  lines.push('')

  for (const [group, cmds] of registry.groups()) {
    lines.push(color.bold(`  ${group}`))
    for (const { meta } of cmds) {
      const aliases = meta.aliases?.length ? color.dim(`  (${meta.aliases.join(', ')})`) : ''
      lines.push(`    ${color.cyan(meta.name.padEnd(9))} ${meta.summary ?? ''}${aliases}`)
    }
    lines.push('')
  }

  lines.push(color.bold('  全局参数'))
  lines.push('    --help, -h        显示帮助 / 指定命令的帮助')
  lines.push('    --version, -v     显示版本')
  lines.push('    --json            机器可读输出（config/status 等支持）')
  lines.push('    --root <dir>      指定项目根（默认向上查找 config.yml）')
  lines.push('    --debug           调试日志')
  lines.push('')
  lines.push(color.dim('设置优先级:') + '  config.yml 默认 < data/runtime-settings.json 运行时覆盖 < 环境变量 / CLI 参数')
  lines.push(color.dim('指令注册:') + '    内建(随包) + 用户 ~/.agentworkshop/commands + 项目 .agentworkshop/commands（同名的后者覆盖前者）')
  lines.push(color.dim('新指令:') + `        ${color.cyan('aw register <path|url|npm:pkg>')}  或直接放入上述目录(导出 {meta, run})`)
  lines.push('')
  return lines.join('\n')
}

export function renderCommandHelp(registry, name) {
  const cmd = registry.find(name)
  if (!cmd) return null
  const { meta } = cmd
  const source = typeof cmd.source === 'string'
    ? (cmd.source.includes(join('cli', 'commands')) ? '内建' : cmd.source)
    : '未知'
  const lines = []
  lines.push('')
  lines.push(`${color.cyan(meta.name)} — ${meta.summary ?? ''}  ${color.dim(`(群组: ${meta.group}, 来源: ${source})`)}`)
  if (meta.usage) lines.push(`  ${color.dim('用法:')} ${color.bold(meta.usage)}`)
  if (meta.aliases?.length) lines.push(`  ${color.dim('别名:')} ${meta.aliases.join(', ')}`)
  if (meta.description) {
    lines.push('')
    if (typeof meta.description === 'string') lines.push(`  ${meta.description}`)
    else if (Array.isArray(meta.description)) lines.push(...meta.description.map(l => `  ${l}`))
  }
  lines.push('')
  return lines.join('\n')
}

export default renderHelp
