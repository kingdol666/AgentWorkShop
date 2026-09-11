// ============================================================
// 指令:plugin — 插件管理(list / create / enable / disable)
// ------------------------------------------------------------
// 插件目录(三作用域,与宿主 host.mjs discoverPluginDirs 一致):
//   builtin: <packageRoot>/server/plugins-builtin/<name>/   ← 随包发布,永远存在
//   project: <repo>/.AgentWorkShop/plugins/<name>/          ← aw plugin create 默认落点
//   user:    ~/.AgentWorkShop/plugins/<name>/               ← aw plugin create --global
//   ⚠️ 同名优先级 builtin > project > user(宿主先扫先占),与 scopes() 的返回顺序一致。
// 插件契约:入口 index.mjs 导出 { name, version?, description?,
//   setup(ctx)?, client?: './client.mjs', routes?: [...] } —— 零导入依赖。
// ============================================================
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { color } from '../core/logger.mjs'
import { CliError } from '../core/errors.mjs'

/** 本文件位于 <packageRoot>/cli/commands/,故包根 = 上两级 */
const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

export const meta = {
  name: 'plugin',
  aliases: ['plugins', 'plug'],
  group: '扩展',
  summary: '插件管理:查看/启停(热重载)/脚手架',
  usage: 'aw plugin <list|create|enable|disable> [name] [--global|-g] [--project] [--force|-f]',
  // 短选项必须在这里登记:cli/aw.mjs 只把 meta.short 声明过的短名映射成长名,
  // 未登记的 `-g` 会被 args.mjs 丢进 unknown 且**不报错** —— 插件会静默落到 project 级。
  short: { g: 'global', f: 'force' },
  description: [
    '插件 = plugins/<name>/ 下的自包含目录:入口 index.mjs 导出 { name, setup(ctx) }',
    '即自动装载(服务端钩子/API 路由/Agent 工具/数采扩展),client.mjs 可选(浏览器增强)。',
    '作用域:builtin(随包) > project(仓库 .AgentWorkShop/plugins) > user(~/.AgentWorkShop/plugins)。',
    'create 默认落 project 级,--global/-g 落 user 级。',
    '服务端钩子:daq:sample / daq:frame / dcw:write / line:start|stop / config:changed /',
    'plugins:reloaded / event:*(scene 全事件) / server:close —— 通配写法是 \'*\'(裸星号)。',
  ],
  needsProject: false,
}

const ENTRY_TEMPLATE = name => `/**
 * ${name} — AgentWorkShop 插件(入口)。
 * setup(ctx) 服务端生命周期:ctx.hooks / ctx.config / ctx.kv / ctx.route / ctx.logger / ctx.http / ctx.events
 * 完整契约见 docs/plugins.md。
 */
export default {
  name: '${name}',
  version: '0.1.0',
  description: '${name} 插件',
  client: './client.mjs',

  async setup(ctx) {
    ctx.logger.info('已装载 ✓')

    // 示例:订阅数采采样(下发级),计数落插件私有 KV
    ctx.hooks.on('daq:sample', (s) => {
      ctx.kv.bump('samples')
      void s
    })

    // 示例:产线生命周期
    ctx.hooks.on('line:start', (p) => {
      ctx.kv.set('lineRunning', true)
      ctx.logger.info('产线开跑', p?.lineId)
    })
    ctx.hooks.on('line:stop', () => ctx.kv.set('lineRunning', false))

    // 示例:注册插件 API → GET /api/plugins/${name}/stats
    ctx.route('GET', '/stats', () => ({
      plugin: ctx.name,
      samples: ctx.kv.get('samples') ?? 0,
      lineRunning: ctx.kv.get('lineRunning') ?? false,
      at: new Date().toISOString(),
    }))

    // 示例:scene 实时事件订阅(与 WS 同源)
    ctx.events.on('daq.node.changed', (p) => {
      ctx.logger.debug('node changed', p)
    })
  },
}
`

const CLIENT_TEMPLATE = name => `// ${name} — 客户端增强(可选;自包含 ESM,无裸导入)
// ctx: on(type,fn) scene 事件订阅 / el() DOM 助手 / root() 私有挂载点 / log
// ⚠️ ctx.on 只装 **scene 事件**(type 传事件名本身,如 'daq.reading' / 'daq.alarm';
//    收全部用字面量 'event:*')。服务端钩子(daq:sample / dcw:write / line:start…)
//    不会过桥到浏览器;浏览器侧生命周期钩子(client:init / page:change / i18n:changed)
//    要走 ctx.hooks.on(...)。
export function setup(ctx) {
  const badge = ctx.el('div', {
    style: 'padding:6px 10px;border:1px solid #2de0a0;border-radius:8px;color:#2de0a0;background:rgba(0,0,0,.55)',
  }, [\`\${ctx.name} · 0\`])
  ctx.root().append(badge)

  let n = 0
  ctx.on('daq.reading', () => {
    n++
    badge.textContent = \`\${ctx.name} · \${n} 样本\`
  })

  ctx.log.info('client ready')
}
`

const PLUGIN_README = name => `# ${name}

AgentWorkShop 插件。

- \`index.mjs\` — 服务端入口(setup(ctx))
- \`client.mjs\` — 浏览器增强(可选)
- API:GET /api/plugins/${name}/stats

装载无需重启:运行中的服务监听 <home>/plugins-state.json(fs.watch + 10s 轮询兜底),
启用/停用会在 ~1s 内热重载。**改插件源码不会自动触发重载** —— 重载时宿主会用带
时间戳的 dynamic import 破缓存重新加载模块,所以改完代码触碰一下 plugins-state.json
(或 Web 端切一次开关)即生效,不必重启进程。
完整契约见 docs/plugins.md。
`

export async function run(argv, ctx) {
  const { flags, positionals } = argv
  const sub = positionals[0] ?? 'list'

  if (sub === 'list' || sub === 'ls')
    return list(ctx)

  if (sub === 'create' || sub === 'new' || sub === 'add')
    return create(ctx, positionals[1], flags)

  if (sub === 'enable' || sub === 'disable')
    return setEnabled(ctx, sub === 'enable', positionals[1])

  throw new CliError('USAGE', '用法: aw plugin <list|create|enable|disable> [name]')
}

// ---- 启停状态机(单一事实源:<home>/plugins-state.json;服务 fs.watch 热重载) ----
function stateFile(ctx) {
  return join(ctx.home, 'plugins-state.json')
}

function readState(ctx) {
  try {
    const j = JSON.parse(readFileSync(stateFile(ctx), 'utf8'))
    return new Set(Array.isArray(j.disabled) ? j.disabled : [])
  }
  catch {
    return new Set()
  }
}

function writeState(ctx, disabledSet) {
  const p = stateFile(ctx)
  const tmp = `${p}.${process.pid}.tmp`
  writeFileSync(tmp, `${JSON.stringify({ version: 1, updatedAt: new Date().toISOString(), disabled: [...disabledSet] }, null, 2)}\n`, 'utf8')
  renameSync(tmp, p)
}

function setEnabled(ctx, enabled, name) {
  if (!name) throw new CliError('USAGE', `用法: aw plugin ${enabled ? 'enable' : 'disable'} <name>`)
  const dir = findPluginDir(ctx, name)
  if (!dir) throw new CliError('NOT_FOUND', `未找到插件 "${name}"(aw plugin list 查看)`)

  const disabled = readState(ctx)
  if (enabled) disabled.delete(name)
  else disabled.add(name)
  writeState(ctx, disabled)

  console.log(`${color.green('✔')} 插件 ${color.bold(name)} 已${enabled ? '启用' : '停用'}${color.dim(`(${dir})`)}`)
  console.log(`  › 运行中的服务会在 1s 内自动热重载;网页「插件管理」页状态同步`)
  return 0
}

function findPluginDir(ctx, name) {
  for (const { dir } of scopes(ctx)) {
    if (dir && existsSync(join(dir, name, 'index.mjs'))) return join(dir, name)
  }
  return null
}

function scopes(ctx) {
  // 顺序 = 宿主 host.mjs 的发现顺序(builtin → project → user);
  // findPluginDir 取首个命中,故顺序必须与宿主同名优先级一致,否则启停会打到另一个同名插件上。
  return [
    { scope: 'builtin', dir: join(PACKAGE_ROOT, 'server', 'plugins-builtin'), label: '内置插件(随包发布)' },
    { scope: 'project', dir: ctx.root ? join(ctx.root, '.AgentWorkShop', 'plugins') : null, label: '项目级(仓库 .AgentWorkShop/plugins)' },
    { scope: 'user', dir: join(ctx.home, 'plugins'), label: '用户级(~/.AgentWorkShop/plugins)' },
  ]
}

function list(ctx) {
  console.log('')
  console.log(`${color.bold('AgentWorkShop 插件')}  ${color.dim('— 三作用域自动装载;aw plugin enable/disable 启停(热重载)')}`)
  let total = 0
  const disabled = readState(ctx)
  for (const { dir, label } of scopes(ctx)) {
    console.log('')
    console.log(color.bold(`  ${label} ${color.dim(dir)}`))
    if (!dir || !existsSync(dir)) {
      console.log(`    ${color.dim('(目录不存在)')}`)
      continue
    }
    const dirs = readdirSync(dir).filter(n => existsSync(join(dir, n, 'index.mjs')))
    if (!dirs.length) {
      console.log(`    ${color.dim('(空 —— aw plugin create <name> 创建)')}`)
      continue
    }
    for (const name of dirs) {
      total++
      const hasClient = existsSync(join(dir, name, 'client.mjs'))
      const off = disabled.has(name)
      const stateText = off ? color.yellow('已停用') : color.green('已启用')
      console.log(`    ${off ? color.yellow('○') : color.green('●')} ${color.cyan(name.padEnd(24))}${stateText}${hasClient ? color.dim(' +client') : ''}`)
    }
  }
  console.log('')
  console.log(color.dim(`共 ${total} 个 · 启停: aw plugin enable|disable <name>(运行中服务热重载) · 文档: docs/plugins.md`))
  console.log('')
  return 0
}

function create(ctx, name, flags) {
  if (!name || !/^[a-z][a-z0-9-]{1,31}$/.test(name)) {
    throw new CliError('USAGE', '用法: aw plugin create <name> [--global|-g] [--project] [--force|-f](name: 小写字母开头,2-32 位 a-z0-9-)')
  }
  // 默认落 project 级;--global/-g 落 user 级。--project 是显式写法(与默认等价,保留以符合直觉)。
  const global = Boolean(flags.global ?? flags.g)
  const force = Boolean(flags.force ?? flags.f)
  const target = global
    ? join(ctx.home, 'plugins', name)
    : join((ctx.root ?? process.cwd()), '.AgentWorkShop', 'plugins', name)

  if (existsSync(join(target, 'index.mjs')) && !force) {
    throw new CliError('CONFLICT', `插件已存在: ${target}(--force 覆盖)`)
  }
  mkdirSync(target, { recursive: true })
  writeFileSync(join(target, 'index.mjs'), ENTRY_TEMPLATE(name), 'utf8')
  writeFileSync(join(target, 'client.mjs'), CLIENT_TEMPLATE(name), 'utf8')
  writeFileSync(join(target, 'README.md'), PLUGIN_README(name), 'utf8')

  console.log(`${color.green('✔')} 插件已创建: ${color.bold(name)} → ${target}`)
  console.log(`  › 作用域: ${global ? 'user(用户级,~/.AgentWorkShop/plugins)' : 'project(项目级,<repo>/.AgentWorkShop/plugins)'}`)
  console.log(`  › 装载: 运行中的服务在 plugins-state.json 变化后 ~1s 内热重载;改代码后触碰该文件即生效(无需重启进程)`)
  console.log(`  › 查看列表: ${color.cyan('aw plugin list')}    API 示例: ${color.cyan(`GET /api/plugins/${name}/stats`)}`)
  return 0
}
