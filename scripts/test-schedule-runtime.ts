/**
 * 定时任务核心单元测试(纯层:next_run_at 计算 + ScheduleRuntime 状态机,内存库)。
 *
 * 覆盖:
 *  1. computeNextRunAt:interval 固定间隔 / daily 定点(当日未到/已过翻日)/ 非法参数
 *  2. validatePlanAndComputeFirstRun:间隔下限 / HH:MM 校验
 *  3. ScheduleRuntime.tick:
 *     - interval 到期触发 → run RUNNING → 任务终态后收口 COMPLETED → 计数/last_run_at/next_run_at
 *     - 忙等守卫:Channel 有未收口任务 → waiting,不触发;收口后下一 tick 补触发
 *     - daily 模式:构造 next_run_at 已过(跨点)→ 补跑一次
 *     - 失败路径:submitTask 抛错 → run FAILED + 失败计数;连续失败达阈值 → 熔断停用
 *     - 幂等:在途(state=running)不二次触发
 *
 * 运行: npx tsx scripts/test-schedule-runtime.ts
 */
import { DatabaseSync } from 'node:sqlite'
import { installLocalIso } from '../shared/local-time.mjs'
import { initWorkshopDb } from '../server/services/workshop/db/database'
import { createScheduledTaskRepo } from '../server/services/workshop/db/scheduled-task.repo'
import {
  ScheduleRuntime,
  computeNextRunAt,
  validatePlanAndComputeFirstRun,
  SCHEDULE_MIN_INTERVAL_MS,
} from '../server/services/workshop/runtime/schedule-runtime'

// 与生产一致:ISO 输出本地时区(daily 定点/断言格式都依赖此语义)
installLocalIso()

let testCount = 0
let failures = 0

function check(name: string, ok: boolean, detail = ''): void {
  testCount += 1
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures += 1
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

// ===== 1. computeNextRunAt =====
function testComputeNextRunAt(): void {
  console.log('\n▶ computeNextRunAt')
  const from = new Date('2026-09-20T10:00:00')

  const interval = computeNextRunAt('interval', 5 * 60_000, '', from)
  check('interval:next = from + 间隔', interval?.startsWith('2026-09-20T10:05:00.000'), String(interval))

  check('interval:低于下限 → null', computeNextRunAt('interval', SCHEDULE_MIN_INTERVAL_MS - 1, '', from) === null)
  check('interval:非数 → null', computeNextRunAt('interval', Number.NaN, '', from) === null)

  // 当日 10:00 视角:09:30 已过 → 明日 09:30;10:30 未到 → 今日 10:30
  const past = computeNextRunAt('daily', 0, '09:30', from)
  const future = computeNextRunAt('daily', 0, '10:30', from)
  check('daily:当日时刻已过 → 翻日', past?.includes('T09:30:00.000') && new Date(past!).getDate() === 21, String(past))
  check('daily:当日时刻未到 → 今日', future?.includes('T10:30:00.000') && new Date(future!).getDate() === 20, String(future))
  check('daily:非法 HH:MM → null', computeNextRunAt('daily', 0, '24:00', from) === null)
  check('daily:非法分钟 → null', computeNextRunAt('daily', 0, '07:99', from) === null)
  check('未知 mode → null', computeNextRunAt('weekly' as 'interval', 1, '', from) === null)
}

// ===== 2. validatePlanAndComputeFirstRun =====
function testValidatePlan(): void {
  console.log('\n▶ validatePlanAndComputeFirstRun')
  const now = new Date()
  const okInterval = validatePlanAndComputeFirstRun({ mode: 'interval', intervalMs: 120_000 }, now)
  check('interval 合法:透传间隔并给出首触发', okInterval.intervalMs === 120_000 && !!okInterval.nextRunAt)

  let threw = ''
  try {
    validatePlanAndComputeFirstRun({ mode: 'interval', intervalMs: 1000 }, now)
  }
  catch (e) { threw = (e as Error).message }
  check('interval 低于下限 → 抛错', threw.includes('60'), threw)

  threw = ''
  try {
    validatePlanAndComputeFirstRun({ mode: 'daily', dailyTime: '7点到' }, now)
  }
  catch (e) { threw = (e as Error).message }
  check('daily 非法 HH:MM → 抛错', threw.includes('HH:MM'), threw)

  const okDaily = validatePlanAndComputeFirstRun({ mode: 'daily', dailyTime: '08:05' }, now)
  check('daily 合法:intervalMs 归零 + 时刻保留', okDaily.intervalMs === 0 && okDaily.dailyTime === '08:05' && !!okDaily.nextRunAt)
}

// ===== 3. ScheduleRuntime 状态机(内存库) =====
interface Harness {
  rt: ScheduleRuntime
  repo: ReturnType<typeof createScheduledTaskRepo>
  db: DatabaseSync
  submitted: Array<{ channelId: string, title: string }>
  taskStates: Map<string, string>
  setBusy: (channelId: string, busy: boolean) => void
  /** 注入 submitTask 直接抛错(模拟提交失败;独立于忙等守卫) */
  setFailing: (channelId: string, on: boolean) => void
}

function makeHarness(channelIds: string[] = ['ch-1', 'ch-busy', 'ch-daily', 'ch-manual', 'ch-fail']): Harness {
  const db = new DatabaseSync(':memory:')
  initWorkshopDb(db)
  // scheduled_tasks.channel_id 有 FK:先种 channel 行
  const now = new Date().toISOString()
  const insertCh = db.prepare(`INSERT INTO channels (id, name, description, workspace, enabled, created_at, updated_at) VALUES (?, ?, '', '', 1, ?, ?)`)
  for (const id of channelIds) insertCh.run(id, id, now, now)
  const repo = createScheduledTaskRepo(db)
  const submitted: Array<{ channelId: string, title: string }> = []
  const taskStates = new Map<string, string>()
  let seq = 0
  const busyChannels = new Set<string>()
  const failingChannels = new Set<string>()
  const rt = new ScheduleRuntime({
    repo,
    submitTask: async (input) => {
      if (failingChannels.has(input.channelId)) throw new Error('SCHEDULE_FIRE_FAILED(测试注入)')
      const id = `task-${++seq}`
      submitted.push({ ...input })
      taskStates.set(id, 'SUBMITTED')
      return { id }
    },
    channelHasActiveTasks: channelId => busyChannels.has(channelId),
    getTaskState: taskId => taskStates.get(taskId),
  })
  return {
    rt,
    repo,
    db,
    submitted,
    taskStates,
    setBusy: (channelId, busy) => {
      if (busy) busyChannels.add(channelId)
      else busyChannels.delete(channelId)
    },
    setFailing: (channelId, on) => {
      if (on) failingChannels.add(channelId)
      else failingChannels.delete(channelId)
    },
  }
}

async function testIntervalFlow(): Promise<void> {
  console.log('\n▶ ScheduleRuntime.interval 全流程(触发→收口→再触发)')
  const h = makeHarness()
  const s = h.repo.create({
    channelId: 'ch-1', name: '巡检', title: '执行巡检', description: '每日巡检产出报告',
    mode: 'interval', intervalMs: 60_000, nextRunAt: '2026-09-20T10:00:00.000',
  })
  check('创建后 idle + run_count=0', s.state === 'idle' && s.runCount === 0)

  // tick①:到期 → 触发;busy 守卫放行
  await h.rt.tick(new Date('2026-09-20T10:00:01'))
  check('到期触发:提交 1 次', h.submitted.length === 1)
  let after = h.repo.findById(s.id)!
  check('计划翻 running + run_count=1', after.state === 'running' && after.runCount === 1)
  check('last_run_at 已记', after.lastRunAt?.startsWith('2026-09-20T10:00:01.000'))
  check('next_run_at = 触发 + 60s', after.nextRunAt?.startsWith('2026-09-20T10:01:01.000'), String(after.nextRunAt))

  // 任务未收口:下一 tick 不二次触发(幂等)
  await h.rt.tick(new Date('2026-09-20T10:00:30'))
  check('在途不二次触发', h.submitted.length === 1 && h.repo.findById(s.id)!.state === 'running')

  // 任务完成 → 下一 tick 收口
  const taskId = h.submitted[0]!
  h.taskStates.set(taskId.title ? 'task-1' : '', 'COMPLETED')
  await h.rt.tick(new Date('2026-09-20T10:00:40'))
  after = h.repo.findById(s.id)!
  check('任务 COMPLETED → 计划回 idle + 连续失败清零', after.state === 'idle' && after.consecutiveFailures === 0)
  const runs = h.repo.listRuns(s.id)
  check('run 收口 COMPLETED + 关联 taskId', runs.length === 1 && runs[0]!.state === 'COMPLETED' && runs[0]!.taskId === 'task-1')

  // 到点再触发(10:01:01)
  await h.rt.tick(new Date('2026-09-20T10:01:02'))
  check('第二轮到点再触发', h.submitted.length === 2 && h.repo.findById(s.id)!.runCount === 2)

  // 历史保留:多轮不超上限(此处仅验证 prune 不抛错)
  h.repo.pruneRuns(s.id)
  check('pruneRuns 可调用', true)
}

async function testBusyGuard(): Promise<void> {
  console.log('\n▶ ScheduleRuntime 忙等守卫(Channel 忙 → waiting → 收口补触发)')
  const h = makeHarness()
  const s = h.repo.create({
    channelId: 'ch-busy', name: '晚班汇总', title: '汇总', mode: 'interval', intervalMs: 60_000,
    nextRunAt: '2026-09-20T18:00:00.000',
  })
  h.setBusy('ch-busy', true)

  await h.rt.tick(new Date('2026-09-20T18:00:01'))
  check('Channel 忙 → 不触发', h.submitted.length === 0)
  check('计划置 waiting', h.repo.findById(s.id)!.state === 'waiting')

  await h.rt.tick(new Date('2026-09-20T18:00:30'))
  check('仍忙:继续 waiting 且不触发', h.submitted.length === 0 && h.repo.findById(s.id)!.state === 'waiting')

  // Channel 任务收口 → 下一 tick 立即补触发(next_run_at 已过)
  h.setBusy('ch-busy', false)
  await h.rt.tick(new Date('2026-09-20T18:01:00'))
  check('忙解除 → 立即补触发', h.submitted.length === 1)
  check('计划翻 running', h.repo.findById(s.id)!.state === 'running')
}

async function testDailyCatchUp(): Promise<void> {
  console.log('\n▶ ScheduleRuntime.daily 跨点补跑 + manual 立即执行')
  const h = makeHarness()
  // 场景:计划建于昨日,每日 08:00;今日 09:00 启动(停机跨点)→ next_run_at 已过 → 补跑
  const s = h.repo.create({
    channelId: 'ch-daily', name: '晨报', title: '生成晨报', mode: 'daily', dailyTime: '08:00',
    nextRunAt: '2026-09-20T08:00:00.000',
  })
  await h.rt.tick(new Date('2026-09-20T09:00:00'))
  check('daily 跨点补跑一次', h.submitted.length === 1)
  const after = h.repo.findById(s.id)!
  // 补跑后 next = 明日 08:00(触发时刻 09:00 > 今日 08:00)
  check('补跑后 next = 明日 08:00', after.nextRunAt?.includes('T08:00:00.000') && new Date(after.nextRunAt!).getDate() === 21, String(after.nextRunAt))
  await h.rt.tick(new Date('2026-09-20T09:00:10'))
  check('同日不重复触发', h.submitted.length === 1)

  // manual:绕到期判定直接触发(受忙等守卫)
  const busy = h.repo.create({
    channelId: 'ch-manual', name: '手动盘', title: '手动任务', mode: 'interval', intervalMs: 3_600_000,
    nextRunAt: '2027-01-01T00:00:00.000',
  })
  h.setBusy('ch-manual', true)
  const r1 = await h.rt.fire(h.repo.findById(busy.id)!, 'manual')
  check('manual:Channel 忙 → 拒绝 + 计划置 waiting', !r1.ok && r1.reason === 'channel_busy' && h.repo.findById(busy.id)!.state === 'waiting')
  h.setBusy('ch-manual', false)
  const r2 = await h.rt.fire(h.repo.findById(busy.id)!, 'manual')
  check('manual:空闲 → 立即触发并返回 taskId', r2.ok && !!r2.taskId)
  check('manual 触发计入 runCount', h.repo.findById(busy.id)!.runCount === 1)
  // 触发种类留痕
  const runs = h.repo.listRuns(busy.id)
  check('run 记录 trigger_kind=manual', runs[0]!.triggerKind === 'manual')
}

async function testFailureCircuit(): Promise<void> {
  console.log('\n▶ ScheduleRuntime 失败计数与熔断')
  const h = makeHarness()
  h.setFailing('ch-fail', true) // submitTask 注入抛错(模拟提交失败;忙等守卫不受影响)
  const s = h.repo.create({
    channelId: 'ch-fail', name: '脆任务', title: '会失败', mode: 'interval', intervalMs: 60_000,
    maxConsecutiveFailures: 2, nextRunAt: '2026-09-20T10:00:00.000',
  })
  await h.rt.tick(new Date('2026-09-20T10:00:01'))
  let after = h.repo.findById(s.id)!
  check('提交失败:run FAILED + 连续失败 1', after.state === 'idle' && after.consecutiveFailures === 1 && after.failCount === 1)
  const runs1 = h.repo.listRuns(s.id)
  check('失败 run 留 error 痕', runs1[0]!.state === 'FAILED' && runs1[0]!.error.length > 0)
  check('失败后 next_run_at 仍推进(不空转重试)', after.nextRunAt?.startsWith('2026-09-20T10:01:01.000'), String(after.nextRunAt))

  await h.rt.tick(new Date('2026-09-20T10:01:02'))
  after = h.repo.findById(s.id)!
  check('连续失败 2 达阈值 → 熔断停用', after.enabled === 0 && after.state === 'failed' && after.consecutiveFailures === 2)
  await h.rt.tick(new Date('2026-09-20T10:02:03'))
  check('熔断后不再触发', h.submitted.length === 0 && after.runCount === 2)

  // 重启用:清连续失败 + 重新计时
  h.setFailing('ch-fail', false)
  h.repo.update(s.id, { enabled: 1, state: 'idle', consecutiveFailures: 0, nextRunAt: '2026-09-20T12:00:00.000' })
  await h.rt.tick(new Date('2026-09-20T12:00:01'))
  check('重启用后可再触发', h.repo.findById(s.id)!.state === 'running' && h.repo.findById(s.id)!.consecutiveFailures === 0)
}

async function testChannelFlagAndCascade(): Promise<void> {
  console.log('\n▶ repo 辅助:计数标志 + channel 级联')
  const db = new DatabaseSync(':memory:')
  initWorkshopDb(db)
  const now = new Date().toISOString()
  db.prepare(`INSERT INTO channels (id, name, description, workspace, enabled, created_at, updated_at) VALUES ('ch-x', '产线A', '', '', 1, ?, ?)`).run(now, now)
  db.prepare(`INSERT INTO channels (id, name, description, workspace, enabled, created_at, updated_at) VALUES ('ch-y', '产线B', '', '', 1, ?, ?)`).run(now, now)
  const repo = createScheduledTaskRepo(db)
  repo.create({ channelId: 'ch-x', name: 'a', title: 't', mode: 'interval', intervalMs: 60_000 })
  repo.create({ channelId: 'ch-x', name: 'b', title: 't', mode: 'daily', dailyTime: '09:00' })
  repo.create({ channelId: 'ch-x', name: 'c', title: 't', mode: 'interval', intervalMs: 60_000, nextRunAt: null })
  repo.update(repo.listByChannel('ch-x')[2]!.id, { enabled: 0 })
  const flags = repo.countEnabledByChannelAll()
  check('计数只算 enabled:ch-x=2 / ch-y=0', flags.get('ch-x') === 2 && !flags.has('ch-y'))
  check('countEnabledByChannel 单查一致', repo.countEnabledByChannel('ch-x') === 2)

  // channel 删除 → 计划级联(run 随之)
  const sid = repo.listByChannel('ch-x')[0]!.id
  repo.createRun({ scheduleId: sid, triggerKind: 'timer' })
  db.prepare(`DELETE FROM channels WHERE id = 'ch-x'`).run()
  check('channel 删除级联删计划', repo.listByChannel('ch-x').length === 0 && repo.findById(sid) === undefined)
  check('级联删运行历史', repo.listRuns(sid).length === 0)
}

async function main(): Promise<void> {
  console.log('╔════════════════════════════════════════════╗')
  console.log('║  定时任务核心单元测试(内存库)           ║')
  console.log('╚════════════════════════════════════════════╝')
  testComputeNextRunAt()
  testValidatePlan()
  await testIntervalFlow()
  await testBusyGuard()
  await testDailyCatchUp()
  await testFailureCircuit()
  await testChannelFlagAndCascade()
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  console.log(`  ${failures === 0 ? `🎉 全部通过(${testCount} 项检查)` : `❌ ${failures}/${testCount} 项失败`}`)
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  await sleep(1)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error('测试异常:', e)
  process.exit(1)
})
