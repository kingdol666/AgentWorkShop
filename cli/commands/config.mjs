// ============================================================
// 指令:config — 读取 / 写入 / 校验运行配置（配置系统的心脏）
// ------------------------------------------------------------
// 用法:
//   aw config                      # 列出全部设置项（有效值 + 来源 + 生效方式）
//   aw config list [--json]
//   aw config get <key> [--json]   # 如 aw config get server.prod.port
//   aw config set <key> <value>    # 写入 data/runtime-settings.json（schema 校验）
//   aw config unset <key>          # 移除覆盖，回落到 config.yml
//   aw config reset [--yes]        # 清空全部运行时覆盖
//   aw config validate             # 校验 config.yml + 运行时覆盖
// 写入即持久化；生效时机见 list 输出的 applies 列（restart=重启对应模式）。
// ============================================================
import { color } from '../core/logger.mjs'
import { CliError } from '../core/errors.mjs'

export const meta = {
  name: 'config',
  aliases: ['cfg', 'c'],
  group: '配置',
  summary: '读取 / 写入 / 校验运行配置',
  usage: 'aw config [list|get|set|unset|reset|validate] [key] [value] [--json]',
  description: [
    '以 config.yml 为默认、runtime-settings.json 为运行时覆盖、环境变量为最高优先级。',
    '双模式:项目检出内写 <项目>/data/runtime-settings.json;全局安装(任意目录)写 ~/.AgentWorkShop/runtime-settings.json。',
    'set 走 schema 校验并原子写入;重启对应模式后生效(端口键重启 dev/prod,其余键重启服务重新构建配置)。',
  ],
  needsProject: false,
}

export async function run(argv, ctx) {
  const { flags, positionals } = argv
  const sub = positionals[0] ?? 'list'
  const key = positionals[1]
  const value = positionals[2]

  switch (sub) {
    case 'list':
    case 'ls':
      return list(ctx)
    case 'get':
      return get(ctx, key)
    case 'set':
      return set(ctx, key, value)
    case 'unset':
      return unset(ctx, key)
    case 'reset':
      return reset(ctx, flags)
    case 'validate':
    case 'check':
      return validate(ctx)
    default:
      throw new CliError('USAGE', `未知子命令 "${sub}"（list|get|set|unset|reset|validate）`)
  }
}

function emit(ctx, obj) {
  if (ctx.json) console.log(JSON.stringify(obj))
  return obj
}

function list(ctx) {
  const { effective, sources, descriptors } = ctx.config.load()
  if (ctx.json) {
    return emit(ctx, {
      ok: true,
      effective,
      sources,
      settings: descriptors.map(d => ({ ...d, value: effective[d.key], source: sources[d.key] })),
    })
  }
  const rows = []
  let lastGroup = null
  for (const d of descriptors) {
    const group = d.group
    if (lastGroup !== group) {
      rows.push([`${color.bold(`[${group}]`)}`, '', ''])
      lastGroup = group
    }
    const value = String(effective[d.key])
    const source = sources[d.key] === 'env'
      ? color.yellow('env')
      : sources[d.key] === 'runtime'
        ? color.green('runtime')
        : color.dim('config.yml')
    const applies = d.applies === 'live' ? color.green('live') : color.yellow('restart')
    rows.push([`  ${d.key}`, `= ${value}`, `${source} ${applies}`])
  }
  for (const row of rows) console.log(`  ${row[0].padEnd(38)} ${row[1].padEnd(18)} ${row[2]}`)
  console.log('')
  console.log(color.dim('来源优先级: config.yml < runtime(运行时覆盖) < env。live=保存即生效，restart=重启对应模式后生效。'))
  return 0
}

function get(ctx, key) {
  if (!key) throw new CliError('USAGE', '用法: aw config get <key>')
  const eff = ctx.config.load()
  if (!(key in eff.effective)) throw new CliError('USAGE', `未知设置项 "${key}"（aw config list 查看全部）`)
  if (ctx.json) return emit(ctx, { ok: true, key, value: eff.effective[key], source: eff.sources[key] })
  console.log(`${color.cyan(key)} = ${color.bold(eff.effective[key])}  ${color.dim(`(来源: ${eff.sources[key]})`)}`)
  return 0
}

async function set(ctx, key, value) {
  if (!key || value === undefined) throw new CliError('USAGE', '用法: aw config set <key> <value>，如 aw config set theme.primaryColor #35e0a0')
  const result = ctx.config.set(key, value)
  if (ctx.json) return emit(ctx, { ok: true, ...result })
  console.log(`${color.green('✔')} ${result.key} = ${color.green(String(result.value))}  ${color.dim(`(原值: ${result.effectiveBefore}, 原 ${result.previousSource === 'env' ? '被环境变量遮蔽' : `来源: ${result.previousSource}`})`)}`)
  console.log(`  › 写入 ${ctx.settingsPath}  ·  ${color.yellow(result.applies === 'live' ? '实时生效' : '重启对应模式后生效')}`)
  if (result.previousSource === 'env')
    console.log(`  ${color.yellow('⚠')} 当前有同名环境变量(AW_${key.toUpperCase().replace(/\./g, '_')})在起作用,运行时优先级高于本写入`)
  return 0
}

async function unset(ctx, key) {
  if (!key) throw new CliError('USAGE', '用法: aw config unset <key>')
  const result = ctx.config.unset(key)
  if (ctx.json) return emit(ctx, { ok: true, ...result })
  if (result.removed) {
    console.log(`${color.green('✔')} ${key} 已清除覆盖，回落 config.yml 默认（重启对应模式后生效）`)
  }
  else {
    console.log(`${color.dim('›')} ${key} 没有运行时覆盖（当前为 config.yml/env 值），无需清除`)
  }
  return 0
}

async function reset(ctx, flags) {
  const confirmed = flags.force || flags.yes || flags.y
  if (!confirmed && !ctx.json) {
    const { createInterface } = await import('node:readline')
    const rl = createInterface({ input: process.stdin, output: process.stdout })
    const answer = await new Promise(resolve2 => rl.question('确定清空全部运行时覆盖？(y/N) ', resolve2))
    rl.close()
    if (!/^y(es)?$/i.test(answer.trim())) {
      console.log('已取消')
      return 0
    }
  }
  ctx.config.reset()
  if (ctx.json) return emit(ctx, { ok: true, action: 'reset' })
  console.log(`${color.green('✔')} 全部运行时覆盖已清空（恢复 config.yml 默认 + 环境变量）`)
  return 0
}

function validate(ctx) {
  const result = ctx.config.validate()
  if (ctx.json) return emit(ctx, { ok: result.ok, keys: result.keys, overridesChecked: result.overridesChecked })
  if (result.ok) {
    const count = ctx.config.load().descriptors.length
    console.log(`${color.green('✔')} 配置校验通过（${count} 个设置项 + ${result.overridesChecked} 个运行时覆盖）`)
    return 0
  }
  console.log(`${color.red('✖')} 配置校验失败:`)
  for (const [k, errs] of Object.entries(result.keys)) console.log(`  ${color.bold(k)}: ${errs.join('; ')}`)
  return 1
}
