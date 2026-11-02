#!/usr/bin/env node
/**
 * bench/experiment/agent-multiround.mjs —— E2-C3:活体 Agent 多轮闭环(标准化 N 次运行)
 *
 * 背景(EXPERIMENT-PIPELINE §3 E2):
 *   C0 不写 = 阴性对照;C1 确定性脚本策略 = 阳性/规则基线;
 *   C3 才是"Agent 自主多轮":任务书只给目标带 + 守卫 + 定性机理,每轮由 omp 工艺工程师
 *   读数→决策→受治理写入→复测→迭代。本 runner 把 bench/optloop.mjs 的 episode 包装成
 *   E2 同口径 CSV,便于与 C0/C1 同表报告(不与 C1 按 seed 配对)。
 *
 * 关键纪律:
 *   - 每次 episode 都是 fresh 复位;optloop 无 --seed,run 序号就是独立重复;
 *   - 预算以 wall-clock 分钟计(LLM 回合时延不可控),报告必须带预算;
 *   - 不把 Agent 自述当判据:PV/守卫取平台独立数据面(optloop summary 的 pvFinal/quality)。
 *
 * 用法(B 态平台 + 模拟器;env 同 PIPELINE.md §0):
 *   node bench/experiment/agent-multiround.mjs --scenarios injection --runs 2 --budget 15
 *   node bench/experiment/agent-multiround.mjs --scenarios injection,wwtp,anneal --runs 1 --budget 20
 *
 * 产物:bench/results/<rid>-agent-multiround/{agent-c3.csv,agent-c3.md,run.json}
 * 退出码:0 = 所有 episode 都已执行并落盘(含未达标/超时);1 = 环境/子进程失败。
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..', '..')
const args = process.argv.slice(2)
const arg = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? (args[i + 1] ?? '') : d }
const has = (k) => args.includes(`--${k}`)

const scenarios = (arg('scenarios', 'injection') || 'injection').split(',').map(s => s.trim()).filter(Boolean)
const runs = Math.max(1, Number(arg('runs', 1)))
const budgetMin = Math.max(5, Number(arg('budget', 15)))
const tag = arg('tag', `c3-${Date.now().toString(36).slice(-4)}`)
const base = arg('base', process.env.AW_BASE ?? 'http://127.0.0.1:3005')
const rid = `${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}-agent-multiround`
const outDir = resolve(arg('out', join(REPO, 'bench', 'results', rid)))
mkdirSync(outDir, { recursive: true })

const resultsDir = join(REPO, 'bench', 'results')

function newestOptloopSummary(afterMs) {
  const dirs = readdirSync(resultsDir)
    .filter(d => d.includes('-optloop'))
    .map(d => ({ d, m: statSync(join(resultsDir, d)).mtimeMs }))
    .filter(x => x.m >= afterMs)
    .sort((a, b) => b.m - a.m)
  for (const x of dirs) {
    const p = join(resultsDir, x.d, 'summary.json')
    if (existsSync(p)) return { dir: join(resultsDir, x.d), summary: JSON.parse(readFileSync(p, 'utf8')) }
  }
  return null
}

/** 从 recorder 产物推导写次数/轮次(不把 Agent 自述当判据;只数平台侧变化) */
function deriveWorkload(dir, scene) {
  // recorder 按场景前缀落盘:<scene>-setpoints.jsonl / <scene>-timeline.jsonl
  const pick = (name) => [join(dir, `${scene}-${name}`), join(dir, name)].find(p => existsSync(p))
  const setp = pick('setpoints.jsonl')
  const tl = pick('timeline.jsonl')
  let writes = 0
  let rounds = 0
  if (setp) {
    let prev = new Map()
    for (const line of readFileSync(setp, 'utf8').split(/\r?\n/)) {
      if (!line.trim()) continue
      try {
        const j = JSON.parse(line)
        const k = j.nodeId
        const v = Number(j.value)
        if (!prev.has(k)) { prev.set(k, v); continue }
        if (Number.isFinite(v) && Number.isFinite(prev.get(k)) && v !== prev.get(k)) { writes++; prev.set(k, v) }
      }
      catch { /* 坏行跳过 */ }
    }
  }
  if (tl) {
    const seen = new Set()
    for (const line of readFileSync(tl, 'utf8').split(/\r?\n/)) {
      if (!line.trim()) continue
      try {
        const j = JSON.parse(line)
        const role = String(j.role ?? j.fromRole ?? '')
        const from = String(j.fromAgentId ?? j.from ?? '')
        if (/worker/i.test(role) || /工艺工程师|worker/i.test(from)) {
          const key = `${j.taskId ?? ''}|${j.at ?? j.createdAt ?? ''}|${(j.text ?? '').slice(0, 40)}`
          if (!seen.has(key)) { seen.add(key); rounds++ }
        }
      }
      catch { /* 坏行跳过 */ }
    }
  }
  return { writes, rounds: rounds || writes }
}

const rows = []
const runLogs = []
for (let i = 1; i <= runs; i++) {
  const t0 = Date.now()
  const childTag = `${tag}-r${i}`
  const logPath = join(outDir, `optloop-${childTag}.log`)
  console.log(`\n=== C3 episode ${i}/${runs} · scenarios=${scenarios.join(',')} · budget=${budgetMin}min ===`)
  const r = spawnSync(process.execPath, [join(REPO, 'bench', 'optloop.mjs'), '--scenarios', scenarios.join(','), '--budget', String(budgetMin), '--tag', childTag, '--base', base], {
    cwd: REPO,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
    maxBuffer: 128 * 1024 * 1024,
  })
  writeFileSync(logPath, `$ node bench/optloop.mjs --scenarios ${scenarios.join(',')} --budget ${budgetMin} --tag ${childTag}\n\n${r.stdout ?? ''}\n${r.stderr ?? ''}\n`, 'utf8')
  const wallS = Number(((Date.now() - t0) / 1000).toFixed(2))
  const found = newestOptloopSummary(t0 - 2000)
  if (!found) {
    console.error(`✘ episode ${i} 未找到 optloop summary(见 ${logPath})`)
    runLogs.push({ episode: i, tag: childTag, wallS, exit: r.status, error: 'summary-missing' })
    continue
  }
  const { dir, summary } = found
  for (const l of summary.lines ?? []) {
    const w = deriveWorkload(dir, l.scen)
    const target = String(l.pvTarget ?? '')
    const m = target.match(/(-?[0-9.]+)±([0-9.]+)/)
    const tgt = m ? Number(m[1]) : null
    const tol = m ? Number(m[2]) : null
    rows.push({
      condition: 'C3',
      scene: l.scen,
      run: i,
      seed: '', // C3 无 seed:独立 fresh episode
      pv: l.pvFinal,
      target: tgt ?? '',
      tol: tol ?? '',
      inBand: l.inBand === true,
      guardsOk: l.guardsOk === true,
      finalState: l.finalState,
      writes: w.writes,
      rounds: w.rounds,
      wallS,
      budgetMin,
      channel: l.channel,
      taskId: l.taskId,
    })
    console.log(`  [${l.scen}] state=${l.finalState} pv=${l.pvFinal} inBand=${l.inBand} guards=${l.guardsOk} writes=${w.writes} rounds=${w.rounds}`)
  }
  runLogs.push({ episode: i, tag: childTag, wallS, exit: r.status, optloopDir: dir })
}

const header = 'condition,scene,run,seed,pv,target,tol,inBand,guardsOk,finalState,writes,rounds,wallS,budgetMin'
const csv = [header, ...rows.map(x => [x.condition, x.scene, x.run, x.seed, x.pv ?? '', x.target, x.tol, x.inBand, x.guardsOk, x.finalState, x.writes, x.rounds, x.wallS, x.budgetMin].join(','))].join('\n')
writeFileSync(join(outDir, 'agent-c3.csv'), `${csv}\n`, 'utf8')

const md = [
  '# E2-C3 活体 Agent 多轮闭环(标准化运行)',
  '',
  `- runId: \`${rid}\``,
  `- scenarios: ${scenarios.join(', ')} · episodes: ${runs} · budget: ${budgetMin} min/episode`,
  '- 判据:PV/守卫取平台独立数据面(optloop summary),写次数/轮次由 recorder 产物推导(不从 Agent 自述取数)',
  '',
  '| scene | run | finalState | PV | 目标带 | inBand | guards | writes | rounds | wall(s) |',
  '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
  ...rows.map(x => `| ${x.scene} | ${x.run} | ${x.finalState} | ${x.pv ?? '—'} | ${x.target}±${x.tol} | ${x.inBand ? 'Yes' : 'No'} | ${x.guardsOk ? 'OK' : 'VIOLATED'} | ${x.writes} | ${x.rounds} | ${x.wallS} |`),
  '',
  `> 口径:每次 episode 均为 fresh 复位;C3 无 seed,run 序号是独立重复;`,
  `> 不与 C1 按 seed 配对(C1 是确定性脚本策略,C3 是 LLM 驱动,回合时延不可控)。`,
].join('\n')
writeFileSync(join(outDir, 'agent-c3.md'), md, 'utf8')
writeFileSync(join(outDir, 'run.json'), JSON.stringify({ rid, at: new Date().toISOString(), base, scenarios, runs, budgetMin, rows, runLogs }, null, 2), 'utf8')

const ok = rows.length > 0
console.log(`\n${ok ? '✔' : '✘'} C3 结果: ${rows.length} 行 → ${join(outDir, 'agent-c3.csv')}`)
process.exit(ok ? 0 : 1)
