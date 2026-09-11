/**
 * 配置根解析审计 —— 验证「启动目录的 ./.AgentWorkShop 优先,~/.AgentWorkShop 兜底」
 * 在解析层与三条启动路径(start.mjs / dev-guard.mjs / 直跑 .output)上的一致性。
 *
 * 运行:node scripts/_dbg-configroot-audit.mjs
 */
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { resolveRunMode, dataDirFor } from '../shared/config/home.mjs'
import { groupsPathFor } from '../shared/config/groups.mjs'

const REPO = resolve(new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
const HOME = homedir()
let pass = 0, fail = 0
const ok = (n, cond, d = '') => {
  if (cond) { pass++; console.log(`  PASS  ${n}${d ? `  — ${d}` : ''}`) }
  else { fail++; console.log(`  FAIL  ${n}${d ? `  — ${d}` : ''}`) }
}
const show = (label, rm) => console.log(`   · ${label}: mode=${rm.mode} configRoot=${rm.configRoot} settings=${rm.settingsPath}`)

console.log('\n━━━ 1. 解析层:优先级与兜底 ━━━')

// ① 检出目录内(有 ./.AgentWorkShop)→ 项目运行时根
const rmRepo = resolveRunMode({ cwd: REPO, env: process.env })
show('检出内(repo)', rmRepo)
ok('repo 模式 = 项目运行时根 <repo>/.AgentWorkShop', rmRepo.mode === 'repo' && rmRepo.configRoot === join(REPO, '.AgentWorkShop'), rmRepo.configRoot)
ok('settingsPath 在项目运行时根', rmRepo.settingsPath === join(REPO, '.AgentWorkShop', 'runtime-settings.json'))
ok('AW_HOME 不抢项目根(② 优先于 ④)', resolveRunMode({ cwd: REPO, env: { ...process.env, AW_HOME: join(HOME, '.AgentWorkShop') } }).configRoot === join(REPO, '.AgentWorkShop'))

// ② 检出内但无 ./.AgentWorkShop → 回退 ~/.AgentWorkShop
const tmp = mkdtempSync(join(tmpdir(), 'aw-root-'))
mkdirSync(join(tmp, 'server'), { recursive: true })
writeFileSync(join(tmp, 'config.yml'), 'app:\n  title: probe\n')
writeFileSync(join(tmp, 'nuxt.config.ts'), 'export default {}\n')
const rmCheckoutNoRoot = resolveRunMode({ cwd: tmp, env: process.env })
show('检出内但无 .AgentWorkShop', rmCheckoutNoRoot)
ok('回退 ~/.AgentWorkShop(项目根的 config.yml 仍生效)', rmCheckoutNoRoot.configRoot === join(HOME, '.AgentWorkShop') && rmCheckoutNoRoot.configPath === join(tmp, 'config.yml'))

// ③ 任意目录(非检出)→ ~/.AgentWorkShop,AW_HOME 可重定向
const rmAny = resolveRunMode({ cwd: tmpdir(), env: process.env })
show('任意目录', rmAny)
ok('非检出目录 → ~/.AgentWorkShop(兜底)', rmAny.configRoot === join(HOME, '.AgentWorkShop'))
const redirected = join(tmp, 'aw-home-redirect')
mkdirSync(redirected, { recursive: true })
const rmRedirect = resolveRunMode({ cwd: tmpdir(), env: { ...process.env, AW_HOME: redirected } })
ok('AW_HOME 可重定向兜底根', rmRedirect.configRoot === redirected, rmRedirect.configRoot)

// ④ AW_MODE=home 强制 home(全局安装的 aw 在检出内运行时,载荷来自包目录)
const rmForced = resolveRunMode({ cwd: REPO, env: { ...process.env, AW_MODE: 'home' } })
show('AW_MODE=home(强制)', rmForced)
ok('AW_MODE=home → configRoot=~/.AgentWorkShop(即使 cwd 是检出)', rmForced.configRoot === join(HOME, '.AgentWorkShop'))

console.log('\n━━━ 2. 派生路径一致性 ━━━')
ok('dataDir = 配置根/data', dataDirFor(REPO) === join(REPO, '.AgentWorkShop', 'data'), dataDirFor(REPO))
const repoConfRoot = join(REPO, '.AgentWorkShop')
ok('分组注册表与 settings 同目录(配置根)', groupsPathFor(repoConfRoot) === join(repoConfRoot, 'config-groups.json'), groupsPathFor(repoConfRoot))
ok('~ 兜底下分组注册表同样落 ~/.AgentWorkShop', groupsPathFor(join(HOME, '.AgentWorkShop')) === join(HOME, '.AgentWorkShop', 'config-groups.json'))

console.log('\n━━━ 3. 启动器与运行时服务同源 ━━━')
const fsMod = await import('node:fs')
const read = (p) => fsMod.readFileSync(p, 'utf8')
const startSrc = read(join(REPO, 'scripts', 'start.mjs'))
const devSrc = read(join(REPO, 'scripts', 'dev-guard.mjs'))
ok('start.mjs 用 resolveRunMode(cwd) 解析配置根', /resolveRunMode\(\{ cwd: process\.cwd\(\)/.test(startSrc))
ok('dev-guard.mjs 用 resolveRunMode(cwd) 解析配置根', /resolveRunMode\(\{ cwd: process\.cwd\(\)/.test(devSrc))
// 启动插件不得写死 <cwd>/data(遗留位置);真实路径须经 resolveRunMode 解析并如实打印
const bootSrc = read(join(REPO, 'server', 'plugins', 'system-config.ts'))
ok('system-config 启动插件走 resolveRunMode(与启动器同源)', /resolveRunMode/.test(bootSrc))
ok('启动插件不再写死 <cwd>/data/runtime-settings.json', !/runtime-settings\.json`\)/.test(bootSrc))

const scSrc = read(join(REPO, 'server', 'services', 'system-config.ts'))
const stSrc = read(join(REPO, 'server', 'services', 'workshop', 'settings.ts'))
const hostSrc = read(join(REPO, 'server', 'services', 'workshop', 'plugins', 'host.mjs'))
ok('SystemConfigService 走 resolveRunMode(与启动器同源)', /resolveRunMode/.test(scSrc))
ok('settings 服务走 resolveRunMode', /resolveRunMode/.test(stSrc))
ok('插件宿主走 resolveRunMode(插件目录/状态文件同根)', /resolveRunMode/.test(hostSrc))

console.log('\n━━━ 4. 分组注册表随配置根走 ━━━')
ok('repo 的分组注册表存在(本机已由设置页写入)', existsSync(groupsPathFor(repoConfRoot)))
rmSync(tmp, { recursive: true, force: true })

console.log(`\n━━ 结果:${pass} passed, ${fail} failed ━━`)
process.exit(fail === 0 ? 0 : 1)
