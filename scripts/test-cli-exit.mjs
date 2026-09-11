/**
 * CLI 退出码与 argv 解析回归测试（node 直跑,不启动服务器、不触发构建）:
 *   node scripts/test-cli-exit.mjs
 *
 * 覆盖两类真实缺陷:
 *   A. 退出码语义 —— 子进程被信号杀死时 close code === null,旧代码 `code ?? 0`
 *      把「被 Ctrl+C 打断」报成成功;约定:被信号 N 终止 → 128 + N。
 *   B. argv 剥离 —— 全局标志必须按「选项位」剥离,不能按字面量过滤,
 *      否则值位上出现的同名 token 会被误删（值丢失 / 位置参数错位）。
 *   C. 入口退出码 —— stdout/stderr 为管道且写入未 flush 时,顶层 await 下
 *      Node 以 13 收场;入口必须显式 process.exit(code)。
 *
 * 子进程测试一律用 'inherit' stdio:父进程不持有子进程的管道句柄,
 * 父侧事件循环保持干净,信号转发语义才可被确定性地观测。
 */
import { spawn } from 'node:child_process'
import { readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const AW = join(root, 'cli', 'aw.mjs')
const LIFECYCLE = join(root, 'cli', 'core', 'child-lifecycle.mjs')
/** Windows 无 POSIX 信号语义(child.kill 走 TerminateProcess,子进程无法捕获) */
const IS_WINDOWS = process.platform === 'win32'

/**
 * 去掉行/块注释后再做"源码里不应出现某写法"的静态断言。
 * 直接 includes() 会被**注释里对旧写法的引用**误伤:例如 aw.mjs 的说明注释
 * 明确写着"必须用 process.exit(code) 而非 process.exitCode = await main()",
 * 于是断言把解释文字当成了违规代码 —— 假阳性。
 */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
}

let failures = 0
let checks = 0
const check = (name, cond, extra = '') => {
  checks++
  console.log(`${cond ? '  ✓' : '  ✗ FAIL'} ${name}${extra ? ` (${extra})` : ''}`)
  if (!cond) failures++
}

/** 起一个 aw 子进程,回传 { code, signal, stdout, stderr } */
function runAw(args, { timeoutMs = 30000 } = {}) {
  return new Promise((resolveRun) => {
    const child = spawn(process.execPath, [AW, ...args], {
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, NO_COLOR: '1' },
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => {
      stdout += d
    })
    child.stderr.on('data', (d) => {
      stderr += d
    })
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL')
      }
      catch { /* ignore */ }
    }, timeoutMs)
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      resolveRun({ code, signal, stdout, stderr })
    })
    child.on('error', (err) => {
      clearTimeout(timer)
      resolveRun({ code: null, signal: null, stdout, stderr, error: err })
    })
  })
}

/** 测试替身子进程文件 */
const TMP = {
  sig: join(root, 'scripts', '_tmp-sig-child.mjs'),
  stubborn: join(root, 'scripts', '_tmp-stubborn-child.mjs'),
  marker: join(root, 'scripts', '_tmp-signal-marker.json'),
}
const cleanup = () => {
  for (const p of [TMP.sig, TMP.stubborn, TMP.marker]) rmSync(p, { force: true })
}
process.on('exit', cleanup)

console.log('[1] aw 入口退出码（缺陷 C:stdio 未 flush 导致 TLA 以 13 收场）')
{
  const help = await runAw(['--help'])
  check('aw --help → 0（非 13）', help.code === 0, `code=${help.code} signal=${help.signal}`)
  check('aw --help 退出码不是 13(ERR_UNSETTLED_TOP_LEVEL_AWAIT)', help.code !== 13, `code=${help.code}`)
  check('aw --help 输出未被 process.exit 截断', help.stdout.includes('agentworkshop'), `len=${help.stdout.length}`)

  const version = await runAw(['--version'])
  check('aw --version → 0', version.code === 0, `code=${version.code}`)
  check('aw --version 有版本号输出', /\d+\.\d+\.\d+/.test(version.stdout), `out=${version.stdout.trim()}`)

  const noCmd = await runAw([])
  check('aw（无指令）→ 2 用法错误', noCmd.code === 2, `code=${noCmd.code}`)

  const bad = await runAw(['definitely-not-a-command'])
  check('aw 未知指令 → 2', bad.code === 2, `code=${bad.code}`)

  const cmdHelp = await runAw(['start', '--help'])
  check('aw start --help → 0', cmdHelp.code === 0, `code=${cmdHelp.code}`)

  const badSub = await runAw(['help', 'definitely-not-a-command'])
  check('aw help <未知> → 2', badSub.code === 2, `code=${badSub.code}`)
}

console.log('[2] 全局标志剥离不吞掉值位同名 token（缺陷 B）')
{
  const { parseArgs, stripGlobals } = await import(pathToFileURL(join(root, 'cli', 'core', 'args.mjs')).href)
  const GLOBALS = ['--json', '--debug']

  // 关键回归:值位上的同名 token 必须留下
  const u1 = stripGlobals(['--name', '--json'], GLOBALS)
  check('值位 --json 保留（是 --name 的取值）', JSON.stringify(u1) === JSON.stringify(['--name']),
    `got=${JSON.stringify(u1)}`)

  const u2 = stripGlobals(['--title=--json'], GLOBALS)
  check('等号值位 --json 保留', JSON.stringify(u2) === JSON.stringify(['--title=--json']),
    `got=${JSON.stringify(u2)}`)

  // 真正的全局选项必须被剥离
  const u3 = stripGlobals(['--json', 'x'], GLOBALS)
  check('选项位 --json 被剥离', JSON.stringify(u3) === JSON.stringify(['x']), `got=${JSON.stringify(u3)}`)

  const u4 = stripGlobals(['--json', '--name', '--debug', 'v'], GLOBALS)
  check('选项位剥离 + 值位保留共存', JSON.stringify(u4) === JSON.stringify(['--name', 'v']),
    `got=${JSON.stringify(u4)}`)

  const u5 = stripGlobals(['--', '--json'], GLOBALS)
  check('-- 之后不剥离', JSON.stringify(u5) === JSON.stringify(['--', '--json']), `got=${JSON.stringify(u5)}`)

  // 布尔全局项**不得吞掉**紧随其后的位置参数。
  // 旧实现对每个被剔除项一律套用"下一 token 非选项就当它的取值吃掉",
  // 于是 `aw build --json x` 里的 x 会静默消失(位置参数丢失)。
  const u8 = stripGlobals(['--json', 'x'], GLOBALS)
  check('布尔全局项不吞位置参数', JSON.stringify(u8) === JSON.stringify(['x']), `got=${JSON.stringify(u8)}`)

  // 带值全局项:经 opts.valueNames 显式声明后,才连同取值一起移除
  // (注:要被移除的项必须出现在 names 里;valueNames 只是"其中哪些带取值"的声明)
  const u6 = stripGlobals(['--root', 'R', '--json'], ['--json', '--debug', '--root'], { valueNames: ['--root'] })
  check('带值全局项连同取值一起移除', JSON.stringify(u6) === JSON.stringify([]), `got=${JSON.stringify(u6)}`)
  // 未声明带值时按布尔处理:只移除选项本身,取值 token 原样保留
  const u6b = stripGlobals(['--root', 'R', '--json'], GLOBALS)
  check('未声明带值 ⇒ 仅移除选项本身', JSON.stringify(u6b) === JSON.stringify(['--root', 'R']), `got=${JSON.stringify(u6b)}`)
  // --root 的取值恰好长得像另一个全局项时,它是"值"而不是选项 → 随 --root 一起移除
  const u6c = stripGlobals(['--root', '--json'], ['--json', '--root'], { valueNames: ['--root'] })
  check('--json 作为 --root 的取值时随它一起移除', JSON.stringify(u6c) === JSON.stringify([]), `got=${JSON.stringify(u6c)}`)

  const u7 = stripGlobals(['--debug=1'], GLOBALS)
  check('内联取值形式 --debug=1 整体移除', JSON.stringify(u7) === JSON.stringify([]), `got=${JSON.stringify(u7)}`)

  // 旧实现（字面量过滤）确实会丢值 —— 缺陷复现对照
  const oldWay = ['--name', '--json'].filter(a => a !== '--json' && a !== '--debug')
  const oldFlags = parseArgs(oldWay).flags
  check('旧字面量过滤确会丢值（缺陷复现）',
    JSON.stringify(oldWay) === JSON.stringify(['--name']) && oldFlags.name === true && oldFlags.json === undefined,
    `old=${JSON.stringify(oldWay)} flags=${JSON.stringify(oldFlags)}`)

  // 修复后的调用约定:--name 取值位被 --json 占住时解析结果不同
  const fixedFlags = parseArgs(['--name', '--json']).flags
  check('按位置解析后 --json 不再是全局标志', fixedFlags.json === true && fixedFlags.name === true,
    JSON.stringify(fixedFlags))

  // 指令名提取必须跳过全局选项的**取值位**:
  // 旧实现只跳过 '-' 开头的 token,于是 `aw --root /p version` 把 '/p' 当指令名
  // → "未知指令: /p",用户被迫只能写 --root=/p 等号形式。
  const { extractCommandName } = await import(pathToFileURL(join(root, 'cli', 'core', 'args.mjs')).href)
  check('extractCommandName: --root <值> 后取到指令名',
    extractCommandName(['--root', '/p', 'version']) === 'version',
    `got=${extractCommandName(['--root', '/p', 'version'])}`)
  check('extractCommandName: --root=<值> 等号形式',
    extractCommandName(['--root=/p', 'version']) === 'version',
    `got=${extractCommandName(['--root=/p', 'version'])}`)
  check('extractCommandName: 布尔全局项不吃指令名',
    extractCommandName(['--json', 'build']) === 'build',
    `got=${extractCommandName(['--json', 'build'])}`)
  check('extractCommandName: -- 之后一律位置参数',
    extractCommandName(['--', '--weird']) === '--weird',
    `got=${extractCommandName(['--', '--weird'])}`)
  check('extractCommandName: 单个 - 视为位置参数',
    extractCommandName(['-']) === '-', `got=${extractCommandName(['-'])}`)
}

console.log('[3] 子进程生命周期:信号 → 退出码传播（缺陷 A）')
{
  const { runChild, signalExitCode, SHUTDOWN_GRACE_MS } = await import(pathToFileURL(LIFECYCLE).href)

  check('signalExitCode(SIGINT) === 130', signalExitCode('SIGINT') === 130, `got=${signalExitCode('SIGINT')}`)
  check('signalExitCode(SIGTERM) === 143', signalExitCode('SIGTERM') === 143)
  check('signalExitCode(未知信号) === 1', signalExitCode('NOPE') === 1)
  check('grace 默认 5000ms（对齐 stop.mjs）', SHUTDOWN_GRACE_MS === 5000)

  // 正常退出:退出码原样透传(不能被污染成 128+)
  const ok = await runChild(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'inherit' })
  check('正常退出 0 → 0', ok === 0, `got=${ok}`)
  const seven = await runChild(process.execPath, ['-e', 'process.exit(7)'], { stdio: 'inherit' })
  check('正常退出 7 → 7 原样透传', seven === 7, `got=${seven}`)

  // spawn 失败 → 1（且不抛异常）
  const enoent = await runChild(join(root, '__no_such_binary__'), [], { stdio: 'inherit' })
  check('spawn ENOENT → 1', enoent === 1, `got=${enoent}`)

  // 核心场景:信号转发 → 子进程被信号杀死 → 父得 128+N（旧代码 code ?? 0 → 0 误报成功）
  writeFileSync(TMP.sig, 'setTimeout(() => {}, 60000)\n')
  {
    const p = runChild(process.execPath, [TMP.sig], { stdio: 'inherit', graceMs: 2000 })
    setTimeout(() => process.emit('SIGTERM'), 250)
    const code = await p
    check('子进程被 SIGTERM 杀死 → 父得 143', code === 143, `got=${code}`)
    check('不再出现 code ?? 0 的「假成功」', code !== 0, `got=${code}`)
  }

  // 强杀兜底:子进程忽略 SIGTERM → 宽限期后 SIGKILL,父仍非 0 且能返回
  writeFileSync(TMP.stubborn, [
    '// 忽略可捕获信号,只有 SIGKILL 能终止',
    'process.on(\'SIGTERM\', () => {})',
    'process.on(\'SIGINT\', () => {})',
    'setTimeout(() => {}, 60000)',
    '',
  ].join('\n'))
  {
    const t0 = Date.now()
    const p = runChild(process.execPath, [TMP.stubborn], { stdio: 'inherit', graceMs: 800 })
    setTimeout(() => process.emit('SIGTERM'), 250)
    const code = await p
    const elapsed = Date.now() - t0
    check('忽略 SIGTERM → 强杀兜底,父非 0 返回', code !== 0, `got=${code}`)
    check('强杀在宽限期内发生（未挂死）', elapsed < 8000, `elapsed=${elapsed}ms`)
  }

  // 信号转发确实到达子进程（缺陷 A/2:子进程不再变孤儿）:
  // 子进程收到 SIGTERM 后写标记文件,父进程排在后面的监听器据此断言。
  writeFileSync(TMP.sig, [
    'import { writeFileSync } from \'node:fs\'',
    `process.on('SIGTERM', () => { writeFileSync(${JSON.stringify(TMP.marker)}, JSON.stringify({ sig: 'SIGTERM' })); process.exit(0) })`,
    'process.on(\'SIGINT\', () => {})',
    'setTimeout(() => {}, 60000)',
    '',
  ].join('\n'))
  {
    let forwarded = null
    // observe 在信号到达时立即执行,而子进程可能还没写完标记文件 ——
    // 必须容忍"文件尚不存在",否则 readFileSync 抛 ENOENT 会把整个测试进程带走
    // (旧写法在文件缺失时直接崩,断言根本没机会执行)。
    const observe = () => {
      try {
        forwarded = readFileSync(TMP.marker, 'utf8')
      }
      catch {
        forwarded = null
      }
    }
    process.on('SIGTERM', observe) // 注册在 runChild 之后 → 在 runChild 转发之后执行
    try {
      const p = runChild(process.execPath, [TMP.sig], { stdio: 'inherit', graceMs: 3000 })
      setTimeout(() => process.emit('SIGTERM'), 300)
      const code = await p
      const sawSignal = forwarded !== null && String(forwarded).includes('SIGTERM')
      if (IS_WINDOWS) {
        // Windows 没有真正的 POSIX 信号:child.kill('SIGTERM') 底层走 TerminateProcess,
        // 子进程**无法捕获**它,因此"子进程收到信号后写标记文件"在该平台不可观测。
        // 能且只能在 Windows 断言的是:转发路径确实把子进程终止了(不是放任它变孤儿)。
        check('SIGTERM 转发确实终止了子进程(Windows 无法观测捕获)',
          code !== 0 || sawSignal, `code=${code} marker=${forwarded}`)
        console.log('    · Windows:跳过"子进程捕获 SIGTERM"断言(平台无 POSIX 信号语义)')
      }
      else {
        check('SIGTERM 被转发至子进程（孤儿化已修复）', sawSignal, `marker=${forwarded}`)
        check('子进程正常退出(0)后父透传 0', code === 0, `got=${code}`)
      }
    }
    finally {
      process.removeListener('SIGTERM', observe)
    }
  }

  // 转发后必须摘掉监听器,不能泄漏到进程级
  const before = process.listenerCount('SIGINT') + process.listenerCount('SIGTERM')
  await runChild(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'inherit' })
  const afterCount = process.listenerCount('SIGINT') + process.listenerCount('SIGTERM')
  check('退出后不泄漏信号监听器', afterCount === before, `before=${before} after=${afterCount}`)
}

console.log('[4] start / dev / build 已接入统一生命周期（静态断言）')
{
  // 静态断言一律在**去注释后的代码**上做:注释里对旧写法的引用不是违规代码
  for (const f of ['start.mjs', 'dev.mjs', 'build.mjs']) {
    const raw = readFileSync(join(root, 'cli', 'commands', f), 'utf8')
    const src = stripComments(raw)
    check(`${f} 复用 runChild`, src.includes('from \'../core/child-lifecycle.mjs\'') && src.includes('runChild('))
    check(`${f} 不再有 'code ?? 0' 误报`, !src.includes('code ?? 0'))
    check(`${f} 不再自建 SIGINT handler（统一收敛）`, !src.includes('process.on(\'SIGINT\''))
  }
  const buildSrc = stripComments(readFileSync(join(root, 'cli', 'commands', 'build.mjs'), 'utf8'))
  check('build.mjs 已转发信号（Ctrl+C 不再产生孤儿 nuxt）', buildSrc.includes('runChild(process.execPath'))
  const awSrc = stripComments(readFileSync(AW, 'utf8'))
  check('aw.mjs 入口改用 process.exit(code)', awSrc.includes('process.exit(await main())'))
  check('aw.mjs 不再用 exitCode = await main()', !awSrc.includes('process.exitCode = await main()'))
  // 入口不得反向被命令模块引入:cli/commands/* → ../aw.mjs 会形成循环依赖,
  // 在 cli/aw.mjs 自任入口时死锁(顶层 await main() 永远等不到 scanDirs 完成),
  // 现象是 `aw --help` 退出码 13 且无输出。
  const cmdDir = join(root, 'cli', 'commands')
  const cyclic = readdirSync(cmdDir)
    .filter(n => /\.(mjs|js)$/.test(n))
    .filter((n) => {
      const s = stripComments(readFileSync(join(cmdDir, n), 'utf8'))
      return /from '\.\.\/aw\.mjs'/.test(s) || /import\('\.\.\/aw\.mjs'\)/.test(s)
    })
  check('命令模块不反向 import 入口（无循环依赖）', cyclic.length === 0, `违规=${cyclic.join(',') || '无'}`)
}

console.log(`\n${failures === 0 ? '✔ 全部通过' : '✖ 存在失败'} : ${checks - failures}/${checks}`)
if (failures > 0) {
  console.log(`失败 ${failures} 项`)
  process.exitCode = 1
}
