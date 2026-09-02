// ============================================================
// AW Home 引导（postinstall / `aw home` 共用）
// ------------------------------------------------------------
// 类似 Claude Code 首次运行：在用户主目录创建 ~/.AgentWorkShop 并种子
// 全部配置文件 —— 之后无论从哪个目录 `aw start`，配置/数据/日志都在这里，
// 与环境变量和当前路径无关（AW_HOME 可重定向）。
// 原则：幂等（已存在绝不覆盖）、零依赖、任何失败只告警不阻断安装。
// ============================================================
import { randomBytes } from 'node:crypto'
import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** 生成 .env 内容（安全默认：随机 session 密钥） */
function envTemplate() {
  return [
    '# AgentWorkShop 密钥/环境注入（本文件已被 .gitignore 排除,绝不入库）',
    `# 生成于 ${new Date().toISOString()};如需更换密钥直接改下行后重启服务`,
    `NUXT_SESSION_PASSWORD=${randomBytes(24).toString('hex')}`,
    '',
  ].join('\n')
}

const COMMANDS_README = `# AW Home 自定义指令目录

把导出 \`{ meta, run }\` 的 .mjs 文件放入本目录即自动注册为 \`aw <name>\` 指令
（用户级,对所有项目生效;项目检出内还可以用 <project>/.agentworkshop/commands 放项目级指令）。

\`\`\`js
// 例:hello.mjs
export const meta = { name: 'hello', group: '自定义', summary: '问好', usage: 'aw hello [--name <n>]' }
export async function run(argv, ctx) {
  console.log(\`你好, \${argv.flags.name ?? 'AW'}!\`)
}
\`\`\`

也可以用 \`aw register <path|url|npm:pkg> --global\` 自动注册到这里。
`

const PLUGINS_README = `# AW Home 插件目录

每个子文件夹 = 一个插件(node 项目,入口 index.mjs),重启 aw start / aw dev 自动装载。

\`\`\`
plugins/
└── my-plugin/
    ├── index.mjs    # 服务端: export default { name, setup(ctx) }
    └── client.mjs   # 浏览器增强(可选): export function setup(ctx)
\`\`\`

生命周期钩子: daq:sample · dcw:write · line:start|stop · event:*(scene 全事件) · server:close
插件 API: ctx.route('GET', '/x', handler) → /api/plugins/my-plugin/x

完整指南: docs/plugins.md · 脚手架: aw plugin create <name>
`

/**
 * 执行引导。返回 { home, created: string[], seeds: string[] }。
 * @param {{ quiet?: boolean, env?: NodeJS.ProcessEnv }} opts
 */
export function runBootstrap({ quiet = false, env = process.env } = {}) {
  const log = (...a) => {
    if (!quiet) console.log(...a)
  }
  const home = env.AW_HOME && String(env.AW_HOME).trim() ? String(env.AW_HOME).trim() : join(homedir(), '.AgentWorkShop')
  const created = []
  const seeds = []

  // 1. 目录骨架
  for (const dir of [home, join(home, 'data'), join(home, 'logs'), join(home, 'commands'), join(home, 'plugins')]) {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true })
      created.push(dir)
    }
  }

  // 2. 主配置 config.yml（工厂默认来自包内;已存在绝不覆盖）
  const cfgDest = join(home, 'config.yml')
  if (!existsSync(cfgDest) && existsSync(join(packageRoot, 'config.yml'))) {
    copyFileSync(join(packageRoot, 'config.yml'), cfgDest)
    seeds.push('config.yml')
  }

  // 3. 运行时覆盖（空骨架）
  const settingsDest = join(home, 'runtime-settings.json')
  if (!existsSync(settingsDest)) {
    writeFileSync(settingsDest, `${JSON.stringify({ version: 1, updatedAt: new Date().toISOString(), overrides: {} }, null, 2)}\n`, 'utf8')
    seeds.push('runtime-settings.json')
  }

  // 4. 密钥 .env（随机 session 密钥;已存在绝不覆盖）+ .env.example
  const envDest = join(home, '.env')
  if (!existsSync(envDest)) {
    writeFileSync(envDest, envTemplate(), 'utf8')
    seeds.push('.env(含随机 NUXT_SESSION_PASSWORD)')
  }
  if (existsSync(join(packageRoot, '.env.example')) && !existsSync(join(home, '.env.example'))) {
    copyFileSync(join(packageRoot, '.env.example'), join(home, '.env.example'))
  }

  // 5. docker-compose 种子（home 模式下数采基础设施自拉起需要）
  const composeDest = join(home, 'docker-compose.yml')
  if (!existsSync(composeDest) && existsSync(join(packageRoot, 'docker-compose.yml'))) {
    copyFileSync(join(packageRoot, 'docker-compose.yml'), composeDest)
    seeds.push('docker-compose.yml')
  }

  // 6. 自定义指令目录说明
  const readmeDest = join(home, 'commands', 'README.md')
  if (!existsSync(readmeDest)) {
    writeFileSync(readmeDest, COMMANDS_README, 'utf8')
  }

  // 7. 插件目录说明(插件 = 配置根 plugins/<name>/ 的 node 项目,SDK 驱动,见 docs/plugins.md)
  const pluginsReadme = join(home, 'plugins', 'README.md')
  if (!existsSync(pluginsReadme)) {
    writeFileSync(pluginsReadme, PLUGINS_README, 'utf8')
    seeds.push('plugins/README.md')
  }

  // 8. 官方示例插件随包分发(sdk/examples/*):只复制目标缺失的目录,绝不覆盖用户改动;
  //    新种子的示例默认**停用**(写入 plugins-state.json),经 aw plugin enable 开启
  const examplesSrc = join(packageRoot, 'sdk', 'examples')
  if (existsSync(examplesSrc)) {
    const pluginsDir2 = join(home, 'plugins')
    const stateFile = join(home, 'plugins-state.json')
    let state = { version: 1, updatedAt: new Date().toISOString(), disabled: [] }
    try {
      state = JSON.parse(readFileSync(stateFile, 'utf8'))
    }
    catch { /* 首次无状态文件 */ }
    state.disabled ??= []
    for (const example of readdirSync(examplesSrc)) {
      const dest = join(pluginsDir2, example)
      if (existsSync(join(dest, 'index.mjs'))) continue // 已存在(或用户改过)——不动
      cpSync(join(examplesSrc, example), dest, { recursive: true })
      if (!state.disabled.includes(example)) state.disabled.push(example) // 默认停用
      seeds.push(`plugins/${example}(默认停用)`)
    }
    state.updatedAt = new Date().toISOString()
    const stateTmp = `${stateFile}.${process.pid}.tmp`
    writeFileSync(stateTmp, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
    renameSync(stateTmp, stateFile)
  }

  // 9. prompts 初始化(提示词规约):包内资产(.AgentWorkShop/prompts)→ AW Home/prompts,
  //    只补缺失文件、绝不覆盖用户定制 —— 运行时目录引导即完整,服务端 loader.ts 另有
  //    同规则兜底(懒播种),两处幂等互不冲突
  const promptsSrc = join(packageRoot, '.AgentWorkShop', 'prompts')
  if (existsSync(promptsSrc)) {
    const promptsDest = join(home, 'prompts')
    mkdirSync(promptsDest, { recursive: true })
    for (const f of readdirSync(promptsSrc)) {
      const dest = join(promptsDest, f)
      if (existsSync(dest)) continue
      try {
        copyFileSync(join(promptsSrc, f), dest)
        seeds.push(`prompts/${f}`)
      }
      catch { /* 单文件失败不阻断 */ }
    }
  }

  log(`[aw-home] ${home}  ${created.length ? `（新建 ${created.length} 项）` : '（已就绪）'}`)
  if (seeds.length) log(`[aw-home] 种子文件: ${seeds.join(', ')}`)
  return { home, created, seeds }
}

// 直接执行时运行（postinstall: node scripts/home-bootstrap.mjs）
const thisEntry = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (thisEntry) {
  try {
    runBootstrap()
  }
  catch (err) {
    // 引导失败不阻断 npm 安装（只影响 home 目录未就绪,首次 aw start 会重试）
    console.warn(`[aw-home] 引导未完成(不影响安装,首次运行会自动重试): ${err?.message ?? err}`)
  }
}

export default runBootstrap
