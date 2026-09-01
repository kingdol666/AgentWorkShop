// ============================================================
// 指令:register — 注册一条新指令（指令系统可扩展性的入口）
// ------------------------------------------------------------
// 注册目标：
//   - 项目级（默认）:        <projectRoot>/.agentworkshop/commands/
//   - 用户级（--global/-g）: ~/.agentworkshop/commands/
// 注册来源 spec：
//   - 本地文件路径（.mjs）或目录（含多个 .mjs）
//   - URL（https://.../xxx.mjs）
//   - npm:包名（生成包装模块，动态引入包内导出的 { meta, run }）
// 注册即复制文件到扫描目录 → 下次启动自动发现（无需任何登记清单）。
// ============================================================
import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join, basename, resolve } from 'node:path'
import { color } from '../core/logger.mjs'
import { CliError } from '../aw.mjs'

export const meta = {
  name: 'register',
  aliases: ['reg', 'install-cmd'],
  group: '指令',
  summary: '注册一条新指令（项目级或用户级）',
  usage: 'aw register <path|url|npm:pkg> [--name <n>] [--global|-g] [--force]',
  description: [
    '指令文件只需导出 { meta, run }：',
    '  export const meta = { name, summary, usage, group, aliases?, needsProject? }',
    '  export async function run(argv, ctx) { /* argv={flags,positionals}, ctx=运行上下文 */ }',
    '生效：注册后重启任意 aw 进程即自动发现（无集中登记清单，约定优于配置）。',
  ],
  needsProject: false,
}

export async function run(argv, ctx) {
  const { flags, positionals } = argv
  const spec = positionals[0]
  if (!spec) throw new CliError('USAGE', '用法: aw register <path|url|npm:pkg> [--name <n>] [--global|-g]')

  const global = Boolean(flags.global ?? flags.g)
  const force = Boolean(flags.force ?? flags.f)
  const targetDir = global ? ctx.commandsDir.global : ctx.commandsDir.local
  if (!targetDir) {
    throw new CliError('NO_PROJECT', '未检测到项目上下文。请 cd 到项目目录注册项目级指令，或加 --global 注册到用户级（AW Home/commands,默认 ~/.AgentWorkShop/commands）。')
  }
  mkdirSync(targetDir, { recursive: true })
  if (!existsSync(join(targetDir, 'README.md'))) {
    writeFileSync(join(targetDir, 'README.md'), '# 自定义指令目录\n\n导出 { meta, run } 的 .mjs 文件放入本目录即自动注册。\n', 'utf8')
  }

  const nameOverride = flags.name ? String(flags.name).replace(/\.(mjs|js)$/, '') : undefined
  const scope = global ? `用户级 (${ctx.commandsDir.global})` : `项目级 (${targetDir})`
  let written = []

  console.log(`${color.cyan('›')} 注册到${scope}`)

  if (/^https?:\/\//.test(spec)) {
    written = [await fromUrl(spec, nameOverride, targetDir, force)]
  }
  else if (spec.startsWith('npm:')) {
    written = [await fromNpm(spec.slice(4), nameOverride, targetDir, force)]
  }
  else {
    const srcPath = resolve(ctx.cwd, spec)
    if (!existsSync(srcPath)) throw new CliError('NOT_FOUND', `路径不存在: ${srcPath}`)
    const st = statSync(srcPath)
    if (st.isDirectory()) {
      const files = readdirSync(srcPath).filter(f => /\.(mjs|js|cjs)$/.test(f))
      if (!files.length) throw new CliError('NOT_FOUND', `目录中没有 .mjs 指令文件: ${srcPath}`)
      for (const f of files) written.push(fromFile(join(srcPath, f), nameOverride, targetDir, force))
    }
    else {
      written.push(fromFile(srcPath, nameOverride, targetDir, force))
    }
  }

  for (const w of written) {
    if (w.skipped) console.log(`${color.yellow('⚠')} 跳过(已存在): ${basename(w.name)}  (加 --force 覆盖)`)
    else if (w.name) console.log(`${color.green('✔')} 已注册: ${color.bold(w.name)}  →  ${w.dest}`)
  }

  console.log(`  › 立刻可用: ${color.cyan(`aw ${nameOf(written[0]?.name)} --help`)}`)
  console.log(`  › 查看全部: ${color.cyan('aw help')}`)
  return 0
}

function nameOf(file) {
  return basename(file ?? '').replace(/\.(mjs|js|cjs)$/, '')
}

function fromFile(srcPath, nameOverride, targetDir, force) {
  const base = nameOverride ?? basename(srcPath).replace(/\.(mjs|js|cjs)$/, '')
  const dest = join(targetDir, `${base}.mjs`)
  if (existsSync(dest) && !force) return { name: `${base}.mjs`, dest, skipped: true }
  copyFileSync(srcPath, dest)
  return { name: `${base}.mjs`, dest, skipped: false }
}

async function fromUrl(url, nameOverride, targetDir, force) {
  const base = nameOverride ?? (basename(new URL(url).pathname).replace(/\.(mjs|js|cjs)$/, '') || 'command')
  const dest = join(targetDir, `${base}.mjs`)
  if (existsSync(dest) && !force) return { name: `${base}.mjs`, dest, skipped: true }
  const res = await fetch(url)
  if (!res.ok) throw new CliError('FETCH_FAILED', `下载失败: HTTP ${res.status} ${url}`)
  const text = await res.text()
  const bom = text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text
  writeFileSync(dest, bom, 'utf8')
  return { name: `${base}.mjs`, dest, skipped: false }
}

async function fromNpm(pkg, nameOverride, targetDir, force) {
  const base = nameOverride ?? (pkg.replace(/^@[^/]+\//, '').replace(/[^a-z0-9-]/g, '-') || 'command')
  const dest = join(targetDir, `${base}.mjs`)
  if (existsSync(dest) && !force) return { name: `${base}.mjs`, dest, skipped: true }
  // 包装模块：兼容 default export 与命名导出 { meta, run }
  const wrapper = `// 由 \`aw register npm:${pkg}\` 生成 — 包装 npm 包为 aw 指令\n`
    + `import mod from '${pkg}'\n`
    + `import * as ns from '${pkg}'\n`
    + `const m = (typeof mod === 'object' && mod !== null && mod.meta) ? mod : null\n`
    + `export const meta = m?.meta ?? ns?.meta\n`
    + `export const run = m?.run ?? ns?.run\n`
    + `export default { meta, run }\n`
  writeFileSync(dest, wrapper, 'utf8')
  return { name: `${base}.mjs`, dest, skipped: false }
}
