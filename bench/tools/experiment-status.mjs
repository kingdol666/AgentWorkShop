#!/usr/bin/env node
/**
 * bench/tools/experiment-status.mjs —— 论文实验状态台账（从产物派生，禁止手抄）
 *
 * 背景: `bench/PIPELINE/EXPERIMENT-PIPELINE.md` 里的状态表曾经手写维护,出现
 * 「PIPELINE.md 说 20 对 / runner 说 15 对」这类漂移(EXPERIMENT-PIPELINE §1 D7)。
 * 本工具只做一件事:扫描 bench/results/ 的产物指纹,按 block 推出
 * EVIDENCE / PARTIAL / NOT-RUN / NONE,并列出证据目录与缺口提示。
 *
 * 用法:
 *   node bench/tools/experiment-status.mjs                       # 打印台账
 *   node bench/tools/experiment-status.mjs --out <dir>           # 另存 md+json
 *   node bench/tools/experiment-status.mjs --json                # 只输出 JSON
 *
 * 纪律: 本工具不做通过/失败判定 —— 判定在各自 runner 的 checks.json 里。
 * 这里只回答「有没有证据、证据在哪、缺什么」。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const RESULTS = join(REPO, 'bench', 'results')
const args = process.argv.slice(2)
const has = (n) => args.includes(`--${n}`)
const val = (n) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : undefined }

function readJson(file) {
  try { return JSON.parse(readFileSync(file, 'utf8')) }
  catch { return null }
}

/** 一个结果目录的产物指纹。只读目录与 run.json 顶层键,不做业务判定。 */
function fingerprint(dir) {
  const abs = join(RESULTS, dir)
  const has = (f) => existsSync(join(abs, f))
  const run = readJson(join(abs, 'run.json'))
  const keys = run ? Object.keys(run) : []
  const kind
    = keys.includes('phases') && keys.includes('portability')
      ? 'pipeline'
      : keys.includes('aggregate') && keys.includes('rows')
        ? 'e1lite'
        : keys.includes('dims')
          ? 'tier'
          : has('e1-lite.csv')
            ? 'e1lite'
            : has('scenarios.json')
              ? 'scenarios'
              : has('checks.json') && has('manifest.json')
                ? 'agentteam'
                : has('manifest.json')
                  ? 'approval-ablation'
                  : has('prepare-failure.json')
                    ? 'approval-prepare-failed'
                    : dir.endsWith('-approval-ablation')
                      ? 'approval-aborted'
                      : dir.endsWith('-optloop')
                        ? 'optloop'
                        : 'other'
  const stats = (() => {
    try { const s = statSync(abs); return s.mtime.toISOString() } catch { return '' }
  })()
  const phases = Array.isArray(run?.phases) ? run.phases : null
  const verdict = run?.verdict ?? run?.summary ?? null
  const hasRows = Array.isArray(run?.lines) && run.lines.length > 0
  return { dir, kind, keys, mtime: stats, phases, verdict, hasRows, files: safeList(abs) }
}

function safeList(abs, limit = 40) {
  try { return readdirSync(abs).slice(0, limit) }
  catch { return [] }
}

function pick(entries, kind) {
  const hit = entries.filter(e => e.kind === kind)
  return { count: hit.length, latest: hit.sort((a, b) => b.mtime.localeCompare(a.mtime))[0] ?? null }
}

function findArtifact(entries, name) {
  return entries.filter(e => e.files.includes(name)).sort((a, b) => b.mtime.localeCompare(a.mtime))[0] ?? null
}

/** 矩阵覆盖几个场景（CSV 里 distinct scene 数）—— 少于 6 就还不能支撑「多场景」主张。 */
function matrixSceneCount(hit) {
  if (!hit) return 0
  const base = hit.dir.startsWith('reports-archive/') ? join(REPO, 'bench', hit.dir) : join(RESULTS, hit.dir)
  try {
    const lines = readFileSync(join(base, 'protocol-matrix.csv'), 'utf8').trim().split(/\r?\n/).slice(1)
    return new Set(lines.map(l => l.split(',')[0])).size
  }
  catch { return 0 }
}
function archiveArtifacts(name) {
  const root = join(REPO, 'bench', 'reports-archive')
  if (!existsSync(root)) return []
  const hits = []
  for (const d of readdirSync(root)) {
    const abs = join(root, d)
    try { if (!statSync(abs).isDirectory()) continue } catch { continue }
    if (existsSync(join(abs, name))) hits.push({ dir: `reports-archive/${d}`, mtime: statSync(abs).mtime.toISOString(), files: safeList(abs) })
  }
  return hits.sort((a, b) => b.mtime.localeCompare(a.mtime))
}

const entries = (() => {
  try { return readdirSync(RESULTS).filter(d => !d.includes('.')).map(fingerprint) }
  catch { return [] }
})()

const pipeline = pick(entries, 'pipeline')
const pipelineWithRows = (() => {
  const hit = entries.filter(e => e.kind === 'pipeline' && e.hasRows).sort((a, b) => b.mtime.localeCompare(a.mtime))
  return { count: hit.length, latest: hit[0] ?? null }
})()
const scenarios = pick(entries, 'scenarios')
const e1lite = pick(entries, 'e1lite')
const optloop = pick(entries, 'optloop')
const agentteam = pick(entries, 'agentteam')
const approveOk = pick(entries, 'approval-ablation')
const approveFail = pick(entries, 'approval-prepare-failed')
const approveAborted = pick(entries, 'approval-aborted')

const matrix = findArtifact(entries, 'protocol-matrix.csv') ?? archiveArtifacts('protocol-matrix.csv')[0] ?? null
const scenarioProbes = findArtifact(entries, 'scenario-protocol-probes.csv') ?? archiveArtifacts('scenario-protocol-probes.csv')[0] ?? null
const optControl = findArtifact(entries, 'optimization-control.csv') ?? archiveArtifacts('optimization-control.csv')[0] ?? null
const optControls = [
  ...entries.filter(e => e.files.includes('optimization-control.csv')),
  ...archiveArtifacts('optimization-control.csv'),
]
const e4Layers = findArtifact(entries, 'e4-defense-layers.csv') ?? archiveArtifacts('e4-defense-layers.csv')[0] ?? null
const e4Auth = findArtifact(entries, 'e4-authorization.csv') ?? archiveArtifacts('e4-authorization.csv')[0] ?? null
const e3Gate = findArtifact(entries, 'e3-approval-gate.csv') ?? archiveArtifacts('e3-approval-gate.csv')[0] ?? null
const a2Matrix = findArtifact(entries, 'a2-harness-matrix.csv') ?? archiveArtifacts('a2-harness-matrix.csv')[0] ?? null

/** 场景探针覆盖的场景数（CSV 第一列）。 */
function probeSceneCount() {
  // 并集：结果目录里的多份探针 CSV + 归档里的合并 CSV 都要算，否则会低估覆盖场景。
  const scenes = new Set()
  const files = []
  for (const e of entries) {
    if (e.files.includes('scenario-protocol-probes.csv')) files.push(join(RESULTS, e.dir, 'scenario-protocol-probes.csv'))
  }
  const arch = join(REPO, 'bench', 'reports-archive')
  if (existsSync(arch)) {
    for (const d of readdirSync(arch)) {
      const f = join(arch, d, 'scenario-protocol-probes.csv')
      if (existsSync(f)) files.push(f)
    }
  }
  for (const f of files) {
    try {
      const lines = readFileSync(f, 'utf8').trim().replaceAll(String.fromCharCode(13), '').split(String.fromCharCode(10)).slice(1)
      for (const l of lines) { const sc = l.split(',')[0]; if (sc) scenes.add(sc) }
    }
    catch { /* 读不到就跳过 */ }
  }
  return scenes.size
}

/** E2 覆盖度：条件集合 + 场景数 + seed 数。确认性要求 C0∩C1、≥3 场景、≥5 seed。 */
function optControlCoverage() {
  const conditions = new Set()
  const scenes = new Set()
  const seeds = new Set()
  for (const hit of optControls) {
    const base = hit.dir.startsWith('reports-archive/') ? join(REPO, 'bench', hit.dir) : join(RESULTS, hit.dir)
    try {
      const lines = readFileSync(join(base, 'optimization-control.csv'), 'utf8').trim().split(/\r?\n/).slice(1)
      for (const l of lines) {
        const [cond, scene, seed] = l.split(',')
        if (cond) conditions.add(cond)
        if (scene) scenes.add(`${cond}:${scene}`)
        if (seed) seeds.add(`${cond}:${seed}`)
      }
    }
    catch { /* 读不到就跳过 */ }
  }
  return {
    conditions: [...conditions].sort(),
    sceneCond: scenes.size,
    seedCond: seeds.size,
    complete: conditions.has('C0') && conditions.has('C1') && new Set([...scenes].map(s => s.split(':')[1])).size >= 3 && new Set([...seeds].map(s => s.split(':')[1])).size >= 5,
  }
}

function statusOf(evidence, partialWhen) {
  if (evidence) return 'EVIDENCE'
  return partialWhen ? 'PARTIAL' : 'NONE'
}

const matrixScenes = matrixSceneCount(matrix)
const probeScenes = probeSceneCount()
const e1Scenes = Math.max(matrixScenes, probeScenes)
const e1Evidence = [...new Set([matrix?.dir, scenarioProbes?.dir, pipelineWithRows.latest?.dir].filter(Boolean))]
const coverage = optControlCoverage()
const conditions = coverage.conditions

const blocks = [
  {
    id: 'E1 场景×协议矩阵',
    status: e1Scenes >= 6 ? 'EVIDENCE' : (e1Scenes > 2 || matrix || scenarioProbes ? 'PARTIAL' : (pipeline.count > 0 && scenarios.count > 0 ? 'PARTIAL' : 'NONE')),
    evidence: e1Evidence,
    gap: e1Scenes >= 6 ? '' : `合起来覆盖 ${e1Scenes}/6 场景（矩阵=${matrixScenes || '—'}，写探针=${probeScenes || '—'}）；缺的格见各产物 NOT-COLLECTED`,
  },
  {
    id: 'E2 闭环优化控制',
    status: coverage.complete ? 'EVIDENCE' : (conditions.length > 0 ? 'PARTIAL' : (pipeline.count > 0 && optloop.count > 0 ? 'PARTIAL' : 'NONE')),
    evidence: [optControl?.dir, optloop.latest?.dir].filter(Boolean),
    gap: coverage.complete
      ? ''
      : `已跑条件 ${conditions.join('/') || '无'} · 场景-条件 ${coverage.sceneCond} · seed-条件 ${coverage.seedCond}；确认性要 C0∩C1 × 3 场景 × 5 seed`,
  },
  {
    id: 'E3 审批门消融',
    status: approveOk.count > 0 ? 'EVIDENCE' : (e3Gate ? 'PARTIAL' : (approveFail.count + approveAborted.count > 0 ? 'NOT-RUN' : 'NONE')),
    evidence: [approveOk.latest?.dir, e3Gate?.dir, approveFail.count > 0 ? `${approveFail.count} 份 prepare-failure` : ''].filter(Boolean),
    gap: approveOk.count > 0 ? '' : (e3Gate ? '已有 manual vs auto 配置级对照；缺「只跳过审批等待」的单机制 OFF 臂（需 bench-only 旁路 + 安全审阅）' : '审批 hook 挂在 recipe_trial（D2）；第 4 类刺激需 P 态（D3）；prepare 未通过（G8）'),
  },
  {
    id: 'E4 防御纵深',
    status: e4Auth && e4Layers ? 'EVIDENCE' : (e4Layers || e1lite.count > 0 ? 'PARTIAL' : 'NONE'),
    evidence: [e4Layers?.dir, e1lite.latest?.dir, e4Auth?.dir].filter(Boolean),
    gap: e4Auth
      ? (e4Layers ? '' : '缺 P 态 L2–L6（e4-defense-layers.csv）')
      : `缺 L1 授权面消融（e4-authorization.csv）；已覆盖 ${
        [e4Layers ? 'P 态 L2–L6' : '', e1lite.count > 0 ? 'B 态 L3/L7' : ''].filter(Boolean).join(' + ') || '无'
      }`,
  },
  {
    id: 'E5 Harness×模型',
    status: a2Matrix ? 'EVIDENCE' : 'NOT-IMPLEMENTED',
    evidence: [a2Matrix?.dir].filter(Boolean),
    gap: a2Matrix ? '' : 'A2 runner 未实现',
  },
]

const generatedAt = new Date().toISOString()
const counts = {
  pipeline: pipeline.count,
  scenarios: scenarios.count,
  e1lite: e1lite.count,
  optloop: optloop.count,
  agentteam: agentteam.count,
  approvalEvidence: approveOk.count,
  approvalPrepareFailure: approveFail.count,
  approvalAborted: approveAborted.count,
  tierRuns: pick(entries, 'tier').count,
}

const md = [
  '# 论文实验状态台账（产物派生）',
  '',
  `- 生成时间: ${generatedAt}`,
  `- 数据源: ${RESULTS}`,
  `- 结果目录总数: ${entries.length}`,
  `- 产物计数: ${JSON.stringify(counts)}`,
  '',
  '| block | 状态 | 证据 | 缺口 |',
  '|---|---|---|---|',
  ...blocks.map(b => `| ${b.id} | **${b.status}** | ${b.evidence.join('<br>') || '—'} | ${b.gap || '—'} |`),
  '',
  '> 状态语义见 `bench/PIPELINE/EXPERIMENT-PIPELINE.md`：EVIDENCE = 论文可用产物已存在；',
  '> PARTIAL = 只有部分条件的证据；NOT-RUN = 执行器在但零结果；NOT-IMPLEMENTED = 无执行器。',
  '> 本台账不做通过/失败判定 —— 判定见各 runner 的 checks.json / run.json。',
  '',
].join('\n')

const json = { generatedAt, results: RESULTS, counts, blocks }

const out = val('out')
if (out) {
  mkdirSync(out, { recursive: true })
  writeFileSync(join(out, 'experiment-status.md'), md)
  writeFileSync(join(out, 'experiment-status.json'), JSON.stringify(json, null, 2))
}
if (has('json')) process.stdout.write(`${JSON.stringify(json, null, 2)}\n`)
else process.stdout.write(`${md}\n`)
