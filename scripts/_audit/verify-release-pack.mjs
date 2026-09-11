/**
 * 发布包验收:解包 0.7.35 tarball → 用解包后的产物做 CLI 与资产自检。
 * 不安装依赖(上游 registry 偶发缺版本),只验证产物本身是否自洽可启动。
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..', '..')
const TGZ = join(REPO, 'agentworkshop-0.7.35.tgz')
const WORK = resolve(REPO, '..', 'aw-pack-verify')

let pass = 0
let fail = 0
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? '✔' : '✘'} ${name}${detail ? ` — ${detail}` : ''}`)
  ok ? pass++ : fail++
}

rmSync(WORK, { recursive: true, force: true })
mkdirSync(WORK, { recursive: true })
check('tarball 存在', existsSync(TGZ), TGZ)
// 在仓库根解包:用相对文件名,避开 GNU tar 把 "D:\..." 当远程主机解析
execFileSync('tar', ['-xzf', 'agentworkshop-0.7.35.tgz'], { cwd: REPO, stdio: 'inherit' })
const PKG = join(WORK, 'package')
const extracted = join(REPO, 'package')
execFileSync('cmd', ['/c', 'move', extracted, PKG], { stdio: 'inherit' })

console.log('\n=== 产物结构 ===')
for (const rel of [
  'package.json', 'bin/aw.mjs', 'cli/core/meta.mjs', 'cli/core/child-lifecycle.mjs', 'cli/core/post-build.mjs',
  '.output/server/index.mjs', '.output/.AgentWorkShop/schema.json',
  '.output/.AgentWorkShop/aml-python/amlkit.py', '.output/.AgentWorkShop/aml-python/requirements.txt',
  '.AgentWorkShop/prompts/host-tools.json', 'server/services/workshop/aml/entity.ts',
]) {
  check(rel, existsSync(join(PKG, rel)))
}
const ver = JSON.parse(readFileSync(join(PKG, 'package.json'), 'utf8')).version
check('包内版本 = 0.7.35', ver === '0.7.35', ver)

console.log('\n=== CLI 冒烟(管道 stdio:验证退出码与输出都不丢)===')
const bin = join(PKG, 'bin', 'aw.mjs')
// --version/--help 在 createContext 之前返回,无需依赖;其余指令要走配置引擎(js-yaml)。
// 本脚本刻意不装依赖(上游 registry 偶发缺版本),故对需要依赖的用例显式标注为跳过,
// 而不是伪装成通过 —— 需要在真实安装环境补跑。
const hasDeps = existsSync(join(PKG, 'node_modules', 'js-yaml'))
if (!hasDeps) console.log('  · 未安装依赖(node_modules 缺失):跳过需要配置引擎的用例')
const CASES = [
  ['aw --version → 0 + 版本号', ['--version'], 0, /0\.7\.35/, false],
  ['aw --help → 0 + 帮助正文', ['--help'], 0, /AgentWorkShop CLI/, false],
  ['aw(无指令)→ 2 用法错误', [], 2, /AgentWorkShop CLI/, true],
  ['aw 未知指令 → 2', ['definitely-not-a-command'], 2, /未知指令/, true],
]
for (const [label, args, wantCode, wantOut, needsDeps] of CASES) {
  if (needsDeps && !hasDeps) {
    console.log(`  · ${label} — 跳过(需 js-yaml)`)
    continue
  }
  const r = spawnSync(process.execPath, [bin, ...args], {
    cwd: PKG,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, NO_COLOR: '1' },
    encoding: 'utf8',
  })
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`
  check(label, r.status === wantCode && wantOut.test(out), `code=${r.status} out=${out.length}B`)
}

console.log('\n=== 产物自检:import-meta 占位符必须已修 ===')
const nitro = readFileSync(join(PKG, '.output/server/chunks/_/nitro.mjs'), 'utf8')
check('无 file:///_entry.js 占位符残留', !nitro.includes('file:///_entry.js'))
check('已改为 import.meta.url 兜底', nitro.includes('url:import.meta.url,env:process.env'))
const entry = readFileSync(join(PKG, '.output/server/chunks/virtual/entry.mjs'), 'utf8')
check('虚拟入口同样已修', !entry.includes('file:///_entry.js'))

console.log(`\n结果:${pass} 通过 / ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
