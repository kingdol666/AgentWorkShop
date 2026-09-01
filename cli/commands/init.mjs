// ============================================================
// 指令:init — 从本包脚手架一个可运行的新 AgentWorkShop 项目
// ------------------------------------------------------------
// 复制 app/server/shared/i18n/public/scripts/bin/cli 与全部配置文件，
// 生成派生的 package.json（名称=目录名，含完整依赖）与 data/runtime-settings.json。
// 之后: cd <dir> && pnpm install && aw dev
// ============================================================
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve, basename } from 'node:path'
import { color } from '../core/logger.mjs'
import { CliError } from '../aw.mjs'

export const meta = {
  name: 'init',
  aliases: ['create', 'new'],
  group: '项目',
  summary: '脚手架一个可运行的新项目（含完整配置系统与 CLI）',
  usage: 'aw init [dir] [--force] [--no-install] [--silent]',
  needsProject: false,
}

const COPY_DIRS = ['app', 'server', 'shared', 'i18n', 'public', 'scripts', 'bin', 'cli']
const COPY_FILES = [
  'config.yml',
  'nuxt.config.ts',
  'tsconfig.json',
  'uno.config.ts',
  'eslint.config.mjs',
  'commitlint.config.mjs',
  '.env.example',
  '.gitignore',
  '.npmrc',
  '.editorconfig',
  'pnpm-workspace.yaml',
]

/** 排除产物/依赖/缓存目录（不复制） */
function skipEntry(name) {
  return name.startsWith('.')
    || name === 'node_modules'
    || name === '.nuxt'
    || name === '.output'
    || name === '.data'
    || name === 'dist'
    || name.endsWith('.log')
}

function copyDir(src, dst, { depth = 0 } = {}) {
  mkdirSync(dst, { recursive: true })
  for (const entry of readdirSync(src)) {
    if (skipEntry(entry) && depth === 0) continue
    const s = join(src, entry)
    const d = join(dst, entry)
    const st = statSync(s)
    if (st.isDirectory()) copyDir(s, d, { depth: depth + 1 })
    else if (st.isFile()) cpSync(s, d)
  }
}

/** 派生 package.json：保留依赖，替换项目标识与脚本 */
function derivePackageJson(ownPkg, name) {
  const { dependencies, devDependencies, engines, packageManager, type } = ownPkg
  return {
    name,
    version: '0.1.0',
    private: true,
    type: type ?? 'module',
    description: 'AgentWorkShop 项目实例（由 aw init 脚手架生成）',
    packageManager,
    engines,
    scripts: {
      dev: 'node scripts/dev-guard.mjs dev',
      build: 'nuxt build',
      start: 'node scripts/start.mjs',
      preview: 'nuxt preview',
      generate: 'nuxt generate',
      postinstall: 'nuxt prepare',
      lint: 'eslint .',
      aw: 'node bin/aw.mjs',
    },
    dependencies,
    devDependencies,
  }
}

export async function run(argv, ctx) {
  const { flags, positionals } = argv
  const target = positionals[0] ? resolve(ctx.cwd, positionals[0]) : ctx.cwd
  const force = Boolean(flags.force || flags.f)
  const silent = Boolean(flags.silent)
  const skipInstall = Boolean(flags['no-install'])

  if (existsSync(join(target, 'config.yml')) && !force) {
    throw new CliError('CONFLICT', `目标目录已是项目（存在 config.yml）: ${target}\n如需覆盖请加 --force`)
  }
  mkdirSync(target, { recursive: true })

  const src = ctx.packageRoot
  const log = (msg) => {
    if (!silent) console.log(msg)
  }

  log(`${color.cyan('›')} 正在脚手架项目: ${color.bold(target)}`)

  // 1. 源码目录
  for (const dir of COPY_DIRS) {
    if (existsSync(join(src, dir))) copyDir(join(src, dir), join(target, dir))
  }
  // 2. 配置文件
  for (const file of COPY_FILES) {
    if (existsSync(join(src, file))) cpSync(join(src, file), join(target, file))
  }
  // 3. 派生 package.json
  const ownPkg = JSON.parse(readFileSync(join(src, 'package.json'), 'utf8'))
  const projPkg = derivePackageJson(ownPkg, basename(target).toLowerCase().replace(/[^a-z0-9-]/g, '-') || 'agentworkshop')
  writeFileSync(join(target, 'package.json'), `${JSON.stringify(projPkg, null, 2)}\n`, 'utf8')

  // 4. 运行时数据与用户指令目录
  mkdirSync(join(target, 'data'), { recursive: true })
  writeFileSync(join(target, 'data', 'runtime-settings.json'), `${JSON.stringify({ version: 1, updatedAt: new Date().toISOString(), overrides: {} }, null, 2)}\n`, 'utf8')
  mkdirSync(join(target, '.AgentWorkShop', 'commands'), { recursive: true })
  writeFileSync(join(target, '.AgentWorkShop', 'commands', 'README.md'),
    '# 项目级自定义指令\n\n把导出 `{ meta, run }` 的 .mjs 文件放入本目录即自动注册。\n\n```js\n// 例如 my-tool.mjs\nexport const meta = { name: \'my-tool\', group: \'自定义\', summary: \'我的指令\', usage: \'aw my-tool [--opt]\' }\nexport async function run(argv, ctx) { console.log(\'hello from my-tool\', argv) }\n```\n\n`aw register <path>` 可自动把指令文件复制到此处。\n',
    'utf8')

  log(`${color.green('✔')} 项目脚手架完成: ${target}`)

  if (skipInstall) {
    log(`  › 跳过依赖安装，请自行执行: ${color.cyan('pnpm install')}`)
  }
  else {
    log(`${color.cyan('›')} 安装依赖 (pnpm install) ...`)
    const { spawnSync } = await import('node:child_process')
    const r = spawnSync('pnpm', ['install', '--reporter=silent'], { cwd: target, stdio: silent ? 'ignore' : 'inherit' })
    if (r.status !== 0) {
      log(`${color.yellow('⚠')} 依赖安装未完成(status=${r.status})，可稍后手动在项目目录执行 pnpm install`)
    }
    else {
      log(`${color.green('✔')} 依赖安装完成`)
    }
  }

  log('')
  log('下一步:')
  log(`  ${color.cyan(`cd ${target}`)}`)
  log(`  ${color.cyan('aw dev')}         # 启动开发服务器（端口来自 config.yml / 运行时设置）`)
  log(`  ${color.cyan('aw config list')} # 查看全部可配置项`)
  log(`  ${color.cyan('aw config set theme.primaryColor #35e0a0')}`)
  return 0
}
