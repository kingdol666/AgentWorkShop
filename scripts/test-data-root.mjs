/**
 * 回归测试 —— 单一数据根(.AgentWorkShop/data)与「最新者胜」迁移
 *
 * 覆盖:
 *   1. 静态断言:全部 JSON 仓库不再自建 cwd 相对路径(process.cwd().endsWith('server')
 *      / 'server', 'data'),且统一 import ensureDataDir;
 *   2. 解析器:注入 cwd/env 后数据目录落在 <cwd>/.AgentWorkShop/data,与 process.cwd() 无关;
 *   3. 迁移:旧位置严格更新时覆盖配置根,目标更新或同时刻时保持不动(不再永久分叉);
 *   4. 收尾:清理临时目录。
 *
 * 运行: node scripts/test-data-root.mjs
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dataDirFor, resolveRunMode, ensureDataDir } from '../shared/config/home.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..')

let pass = 0, fail = 0
// 与 scripts/test-lru.mjs / test-rollback-index.mjs 同款 PASS/FAIL 行式断言
// (分支体保持单语句以过 @stylistic/max-statements-per-line)
const check = (n, ok, d = '') => {
  if (ok) return console.log('  PASS  ' + n) ?? pass++
  return console.log('  FAIL  ' + n + (d ? '  — ' + d : '')) ?? fail++
}

/** 静态断言必须覆盖的 9 个 JSON 仓库(相对检出根) */
const TARGETS = [
  'server/services/workshop/daq/daq-node.repo.ts',
  'server/services/workshop/dcw/dcw-node.repo.ts',
  'server/services/workshop/dcw/dcw-line.repo.ts',
  'server/services/workshop/dcw/dcw-product.repo.ts',
  'server/services/workshop/dcw/dcw-recipe.repo.ts',
  'server/services/workshop/dcw/dcw-templates.ts',
  'server/services/workshop/dcw/recipe-rollback.repo.ts',
  'server/services/workshop/dcw/line-run.ts',
  'server/services/workshop/scene/scene-layout.repo.ts',
]

// 临时工作区(全部测试产物都在其下,结束时整体删除;绝不触碰真实 server/data 与 .AgentWorkShop/data)
const TMP = mkdtempSync(join(tmpdir(), 'aw-data-root-'))
// 隔离:注入独立 AW_HOME,绝不落到真实 ~/.AgentWorkShop
const runEnv = { ...process.env, AW_HOME: join(TMP, 'fake-home') }

/** 造一个「项目工作区」:含 .AgentWorkShop 目录即被识别为项目运行时根 */
function makeWorkspace(name) {
  const ws = join(TMP, name)
  mkdirSync(join(ws, '.AgentWorkShop'), { recursive: true })
  return ws
}

/** 写文件并显式设定 mtime(避免依赖文件系统时间戳精度) */
function writeWithMtime(file, content, mtimeMs) {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, content, 'utf8')
  const secs = mtimeMs / 1000
  utimesSync(file, secs, secs)
}

const mtimeOf = f => statSync(f).mtimeMs
const read = f => readFileSync(f, 'utf8')

// 触发点原文(用模板串包裹,避免内层单引号影响引号风格规则)
const BAD_PATH_LITERAL = `'server', 'data'`
const BAD_CWD_GUARD = `process.cwd().endsWith('server')`

console.log('\n━━━ 1. 静态断言:9 个仓库不再自建 cwd 相对路径 ━━━')
for (const rel of TARGETS) {
  const abs = join(REPO, rel)
  let src
  try {
    src = readFileSync(abs, 'utf8')
  }
  catch (err) {
    check(`${rel} 可读取`, false, String(err.message))
    continue
  }
  check(`${rel} 不含 'server', 'data'`, !src.includes(BAD_PATH_LITERAL))
  check(`${rel} 不含 process.cwd().endsWith('server')`, !src.includes(BAD_CWD_GUARD))
  check(`${rel} import 了 ensureDataDir`, /import\s*\{[^}]*\bensureDataDir\b[^}]*\}\s*from\s*'[^']*shared\/config\/home\.mjs'/.test(src))
}

// 反向兜底:整个 server/ 目录再扫一遍,防止遗漏同类写法(本用例的文件列表本身也可能漏)
const strayFiles = []
const walk = (dir) => {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, e.name)
    if (e.isDirectory()) walk(abs)
    else if (/\.(ts|mjs)$/.test(e.name)) {
      const text = read(join(dir, e.name))
      if (text.includes(BAD_PATH_LITERAL) || text.includes(BAD_CWD_GUARD)) strayFiles.push(relative(REPO, abs))
    }
  }
}
try {
  walk(join(REPO, 'server'))
  check('server/ 全目录无同类 cwd 相对数据路径', strayFiles.length === 0, strayFiles.join(', '))
}
catch (err) {
  check('server/ 全目录扫描完成', false, String(err.message))
}

console.log('\n━━━ 2. 解析器:数据根 = <cwd>/.AgentWorkShop/data ━━━')
const wsA = makeWorkspace('proj-a')
{
  const rm = resolveRunMode({ cwd: wsA, env: runEnv })
  const expected = join(wsA, '.AgentWorkShop', 'data')
  check('mode = repo', rm.mode === 'repo', 'mode=' + rm.mode)
  check('configRoot = <cwd>/.AgentWorkShop', resolve(rm.configRoot) === resolve(wsA, '.AgentWorkShop'), rm.configRoot)
  check('dataDir = <cwd>/.AgentWorkShop/data', resolve(rm.dataDir) === resolve(expected), rm.dataDir)

  const dir = dataDirFor(wsA, runEnv)
  check('dataDirFor(cwd) 同上', resolve(dir) === resolve(expected), dir)
  check('dataDirFor 只解析不建目录', !existsSync(dir))

  // 与 process.cwd() 无关:同一个 cwd 参数在任意进程工作目录下结果一致
  const before = process.cwd()
  const returned = ensureDataDir(wsA, runEnv)
  check('ensureDataDir 返回数据根', resolve(returned) === resolve(expected), returned)
  check('ensureDataDir 建好目录', existsSync(dir) && statSync(dir).isDirectory())
  check('调用后 process.cwd() 未被改变', process.cwd() === before, process.cwd())
  check('两个不同 cwd 各自独立', resolve(dataDirFor(wsA, runEnv)) !== resolve(dataDirFor(makeWorkspace('proj-b'), runEnv)))
  check('结果不落在检出仓库内', !resolve(dir).startsWith(resolve(REPO)), dir)

  // 注入 env 优先:AW_DATA_DIR 覆盖解析(启动器注入路径的契约)
  const forced = join(TMP, 'forced-data')
  check('AW_DATA_DIR 优先', resolve(dataDirFor(wsA, { ...runEnv, AW_DATA_DIR: forced })) === resolve(forced))
}

console.log('\n━━━ 3. 迁移:最新者胜(不再永久分叉) ━━━')
{
  const ws = makeWorkspace('migrate')
  const legacy = join(ws, 'server', 'data')
  const dest = join(ws, '.AgentWorkShop', 'data')
  const xSrc = join(legacy, 'x.json')
  const xDst = join(dest, 'x.json')
  const now = Date.now()

  // 3a. 目标缺失 → 必须复制(原行为保留)
  mkdirSync(dest, { recursive: true })
  writeWithMtime(xSrc, '{"v":"legacy-only"}', now - 30000)
  ensureDataDir(ws, runEnv)
  check('a) 目标缺失时复制', existsSync(xDst) && read(xDst) === '{"v":"legacy-only"}', xDst)

  // 3b. 旧位置严格更新 → 覆盖配置根(收敛的关键)
  writeWithMtime(xDst, '{"v":"configroot-old"}', now - 20000)
  writeWithMtime(xSrc, '{"v":"legacy-new"}', now - 10000)
  const srcMs = mtimeOf(xSrc), dstMs = mtimeOf(xDst)
  check('b) 前置:mtime 严格有序(旧位置更新)', srcMs > dstMs, `src=${srcMs} dst=${dstMs}`)
  ensureDataDir(ws, runEnv)
  check('b) 旧位置更新时覆盖为目标', read(xDst) === '{"v":"legacy-new"}', read(xDst))
  check('b) 旧文件不被删除', existsSync(xSrc))

  // 3c. 反向:配置根更新 → 保留配置根内容(不得回退)
  writeWithMtime(xSrc, '{"v":"legacy-stale"}', now - 20000)
  writeWithMtime(xDst, '{"v":"configroot-new"}', now - 5000)
  const srcMs2 = mtimeOf(xSrc), dstMs2 = mtimeOf(xDst)
  check('c) 前置:mtime 严格有序(目标更新)', dstMs2 > srcMs2, `src=${srcMs2} dst=${dstMs2}`)
  ensureDataDir(ws, runEnv)
  check('c) 目标更新时保留目标内容', read(xDst) === '{"v":"configroot-new"}', read(xDst))

  // 3d. 同时刻 → 不复制
  const same = now - 1000
  writeWithMtime(xSrc, '{"v":"legacy-tie"}', same)
  writeWithMtime(xDst, '{"v":"configroot-tie"}', same)
  check('d) 前置:mtime 相等', mtimeOf(xSrc) === mtimeOf(xDst), `${mtimeOf(xSrc)} vs ${mtimeOf(xDst)}`)
  ensureDataDir(ws, runEnv)
  check('d) 同时刻不覆盖', read(xDst) === '{"v":"configroot-tie"}', read(xDst))

  // 3e. 保留既有守卫:非运行时文件不迁移
  writeWithMtime(join(legacy, 'noise.log'), 'log', now)
  writeWithMtime(join(legacy, 'script.mjs'), 'x', now)
  // 与 .json 同名的目录:必须按「非文件」跳过(statSync(src).isFile() 守卫)
  mkdirSync(join(legacy, 'sub.json'), { recursive: true })
  ensureDataDir(ws, runEnv)
  check('e) 非运行时扩展名不迁移', !existsSync(join(dest, 'noise.log')) && !existsSync(join(dest, 'script.mjs')))
  check('e) 目录不被当作文件复制', !existsSync(join(dest, 'sub.json')) && statSync(join(legacy, 'sub.json')).isDirectory())
  check('e) 单文件失败不阻断其余(其它文件仍迁入)', existsSync(xDst))

  // 3f. 保留既有守卫:AW_MODE=home 跳过整个迁移
  const wsHome = makeWorkspace('migrate-home')
  const homeLegacy = join(wsHome, 'server', 'data')
  writeWithMtime(join(homeLegacy, 'y.json'), '{"v":"home-mode"}', now)
  ensureDataDir(wsHome, { ...runEnv, AW_MODE: 'home', AW_HOME: join(TMP, 'home-mode-root') })
  check('f) AW_MODE=home 时跳过迁移', !existsSync(join(wsHome, '.AgentWorkShop', 'data', 'y.json')))

  // 3g. 幂等:重复调用不再变化
  const beforeIdem = read(xDst)
  ensureDataDir(ws, runEnv)
  ensureDataDir(ws, runEnv)
  check('g) 幂等(重复调用结果稳定)', read(xDst) === beforeIdem, read(xDst))
}

console.log(`\n━━━ 结果:${pass} passed, ${fail} failed ━━━\n`)

// 清理临时目录(含上面所有工作区)
try {
  rmSync(TMP, { recursive: true, force: true })
  console.log('  临时目录已清理: ' + TMP)
}
catch (err) {
  console.log('  临时目录清理失败(可手动删除): ' + TMP + ' — ' + String(err.message))
}

process.exit(fail === 0 ? 0 : 1)
