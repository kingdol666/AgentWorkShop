/**
 * 崩溃恢复全循环 E2E —— 一次命令跑完「常规执行 → 硬杀 → 重启恢复 → 消费缺口 → 重启重投」。
 *
 * 为什么需要编排层:`e2e-resume-crash.mjs` 的三个场景必须**跨进程**执行
 * (crash/gap 阶段用 `taskkill /F` 打死实例,verify 阶段要等实例重启后再跑),
 * 单进程跑不出"崩溃"这件事。此前只能人工分五次执行 + 手工重启服务。
 *
 * 覆盖:
 *   场景 A  慢速 mock 任务 → WORKING → COMPLETED → 全员 idle
 *   场景 B  执行中硬杀服务器 → DB 仍为 WORKING → 重启 → assign 重投 → 自动恢复 COMPLETED
 *   场景 C  assign 消息已被消费但任务未完成(极端缺口)→ 重启 → restore 重投 → COMPLETED
 *
 * 用法:
 *   node scripts/e2e-crash-cycle.mjs [--port 3300] [--home .e2e-home-full] [--mode start]
 * 前置:无需手工起服务 —— 编排层会用 scripts/_audit/detached-instance.mjs 拉起/重启隔离实例
 *       (AW_HOME 指向的 home 目录;建议用**专用** home,崩溃演练会反复杀进程)。
 */
import { spawnSync } from 'node:child_process'
import { existsSync, rmSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const arg = (k, d) => {
  const i = process.argv.indexOf(k)
  return i >= 0 ? process.argv[i + 1] : d
}
const PORT = Number(arg('--port', '3300'))
const HOME = resolve(repo, arg('--home', '.e2e-home-full'))
const MODE = arg('--mode', 'start')
const BASE = `http://127.0.0.1:${PORT}`
const DB = resolve(HOME, 'data/workshop.sqlite')

const results = []
const run = (cmd, args, opts = {}) => spawnSync(cmd, args, { cwd: repo, stdio: 'inherit', ...opts })

async function instanceUp() {
  try {
    const r = await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(4000) })
    const j = await r.json()
    return j?.data?.status === 'ok'
  }
  catch {
    return false
  }
}

/** 拉起/重启隔离实例(detached-instance 自带 --wait 健康门与 pidfile) */
function startInstance() {
  console.log(`  · 拉起隔离实例 ${BASE}(home=${HOME})`)
  const r = run(process.execPath, [
    'scripts/_audit/detached-instance.mjs',
    '--port', String(PORT), '--mode', MODE, '--home', HOME, '--wait', '120',
  ])
  if (r.status !== 0) throw new Error(`隔离实例启动失败(exit=${r.status})`)
}

/** 跑一个阶段(独立进程;用 AW_RESUME_* 指向同一实例与同一 DB) */
function runPhase(mode) {
  const t0 = Date.now()
  const r = spawnSync(process.execPath, ['scripts/e2e-resume-crash.mjs', mode], {
    cwd: repo,
    stdio: 'inherit',
    env: { ...process.env, AW_RESUME_BASE: BASE, AW_RESUME_DB: DB, NO_PROXY: '127.0.0.1,localhost' },
  })
  const sec = Math.round((Date.now() - t0) / 1000)
  const exit = r.status ?? 1
  results.push({ phase: mode, exit, sec })
  console.log(`  ${exit === 0 ? 'PASS' : `EXIT${exit}`}  ${mode}  ${sec}s`)
}

async function main() {
  console.log(`\n═══ 崩溃恢复全循环 @ ${BASE}(db=${DB})═══\n`)
  if (!existsSync(DB)) {
    console.error(`✖ 找不到 ${DB} —— 请先用 --home 指定一个已初始化过的隔离 home`)
    process.exit(1)
  }
  // 上一轮残留的标记文件会让 verify 阶段读到过期目标
  rmSync(resolve(repo, '.resume-test.json'), { force: true })

  if (!(await instanceUp())) startInstance()
  else console.log(`  · 实例已在运行(${BASE})`)

  console.log('\n━━ 场景 A:常规执行监控 ━━')
  runPhase('watch')

  console.log('\n━━ 场景 B:执行中硬杀 → 持久化断言 ━━')
  runPhase('crash')
  console.log('━━ 重启实例 ━━')
  startInstance()
  runPhase('verify')

  console.log('\n━━ 场景 C:制造消费缺口 → 硬杀 ━━')
  runPhase('gap')
  console.log('━━ 重启实例 ━━')
  startInstance()
  runPhase('verify-gap')

  const failed = results.filter(r => r.exit !== 0)
  console.log(`\n═══ 崩溃恢复全循环:通过 ${results.length - failed.length} / ${results.length} 阶段 ═══`)
  for (const f of failed) console.log(`  FAIL ${f.phase} exit=${f.exit}`)
  process.exit(failed.length === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('崩溃恢复循环异常:', err.message)
  process.exit(1)
})
