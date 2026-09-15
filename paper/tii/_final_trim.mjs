import { readFileSync, writeFileSync } from 'node:fs'
const R = 'paper/tii/sections/'

// A) 图高再收敛
let e = readFileSync(R + 'evaluation.tex', 'utf8')
e = e.split('height=4.0cm').join('height=3.7cm')
e = e.split('height=3.9cm').join('height=3.6cm')
e = e.split('height=4.1cm').join('height=3.8cm')
writeFileSync(R + 'evaluation.tex', e)

// B) Fig.1 收窄
let s = readFileSync(R + 'system.tex', 'utf8')
s = s.split('width=0.72\\textwidth').join('width=0.64\\textwidth')
writeFileSync(R + 'system.tex', s)

// C) 三张表 scriptsize
let b = readFileSync(R + 'benchmark.tex', 'utf8')
b = b.split('\\footnotesize').join('\\scriptsize')
writeFileSync(R + 'benchmark.tex', b)
let r = readFileSync(R + 'related.tex', 'utf8')
r = r.replace('\\footnotesize\n\\setlength{\\tabcolsep}{4pt}', '\\scriptsize\n\\setlength{\\tabcolsep}{3pt}')
writeFileSync(R + 'related.tex', r)
let y = readFileSync(R + 'system.tex', 'utf8')
y = y.split('\\caption{Harness registry (subset; 14 engines total) and capability flags. "steer" = mid-run guidance; "supervise" = lead-decision participation; "hitl" = approval-frontend support; "compact" = context compaction. The mock engine is the deterministic stub used for reproducible experiments. Engine classes: \\texttt{omp} = first-party RPC engine; \\texttt{codex}/\\texttt{claude}/\\texttt{gemini}/\\texttt{qwen}/\\texttt{copilot}/\\texttt{cursor} = vendor CLI/SDK agents; \\texttt{dsh} = Agent-Client-Protocol engine; \\texttt{pi}/\\texttt{hermes}/\\texttt{crush}/\\texttt{goose}/\\texttt{opencode} = open-source headless CLI agents.}', '\\caption{Harness registry (subset; 14 engines total). "steer"/"supervise"/"hitl"/"compact" are capability flags; the mock engine is the deterministic stub used for reproducible experiments. Engine classes: \\texttt{omp} = first-party RPC; \\texttt{codex}/\\texttt{claude}/\\texttt{gemini}/\\texttt{qwen}/\\texttt{copilot}/\\texttt{cursor} = vendor CLI/SDK; \\texttt{dsh} = Agent-Client-Protocol; \\texttt{pi}/\\texttt{hermes}/\\texttt{crush}/\\texttt{goose}/\\texttt{opencode} = open-source headless CLI.}')
writeFileSync(R + 'system.tex', y)

// D) 案例研究 Trajectory+Observations 合并精简
let ev = readFileSync(R + 'evaluation.tex', 'utf8')
const evTrims = [
  ["The agent team opened an optimization record, probed the plant with \\texttt{daq\\_query}, adjusted $N$ from 150 to 144\\,rpm and $v$ from 95 to 98\\,m/min, and held zone temperatures at 200\\,°C, terminating after two in-window evaluations without over-optimization. Table~\\ref{tab:castfilm} summarizes. $J$ improved from ${\\approx}78$ to $86.2$---95.9\\,\\%--96.0\\,\\% of the offline optimum, the range bracketed by the two in-window evaluation readings. Film thickness moved from 53.9 to 50.1--50.4~$\\mu$m against the $50{\\pm}2$~$\\mu$m target; the defect rate ended at 0.78\\,\\% (threshold 2\\,\\%); melt pressure rose to 17.6\\,MPa (within limits). A physics cross-check tied cause to effect: the executed $N/v$ change ($-7.0\\,\\%$) predicts the measured thickness change ($-6.5$ to $-7.1\\,\\%$ across the bracket) under $h \\propto N/v$. Interpretive caveat: the grid optimum sits at a low-throughput corner ($N{=}55$\\,rpm, $v{=}40$\\,m/min) because the objective's energy weight slightly exceeds its throughput weight; the agent holds ${\\approx}2.4\\times$ the corner's throughput at 96\\,\\% of its $J$, so the reported figure quantifies the objective gap at an operationally meaningful point, not distance to the corner.",
   "The agent team opened an optimization record, probed the plant with \\texttt{daq\\_query}, adjusted $N$ from 150 to 144\\,rpm and $v$ from 95 to 98\\,m/min at zone 200\\,°C, and terminated after two in-window evaluations. Table~\\ref{tab:castfilm} summarizes: $J$ improved from ${\\approx}78$ to $86.2$ (95.9--96.0\\,\\% of the offline optimum), thickness from 53.9 to 50.1--50.4~$\\mu$m, defect 0.78\\,\\%, pressure 17.6\\,MPa. The executed $N/v$ change ($-7.0\\,\\%$) predicts the measured thickness change under $h \\propto N/v$. The grid optimum sits at a low-throughput corner ($N{=}55$\\,rpm, $v{=}40$\\,m/min); the agent holds ${\\approx}2.4\\times$ the corner's throughput at 96\\,\\% of its $J$, so the figure quantifies the objective gap at an operationally meaningful point."],
  ["Eight \\texttt{dcw\\_control} writes crossed three protocol families; every write traversed the approval gate (manual binding, auto-approved---see disclosures above), and every write is reconstructable from the journal anchors and audit log---the attribution rate is 100\\,\\% by inspection, not by assumption. The backstop evaluated the open record against the recipe monitoring window on its 30\\,s cadence; no breach-triggered rollback was necessary. An independent, read-only inspector agent audited the final state within 0.5\\,\\mu$m and 0.15 percentage points of the agent's readings ($h = 49.97$~$\\mu$m, defect 0.63\\,\\%), and the acceptance suite completed 40/40 checks in approximately 22\\,min including thermal preheat.",
   "All eight writes traversed the approval gate and are reconstructable from the journal anchors and audit log---attribution is 100\\,\\% by inspection. The backstop found no breach requiring rollback; an independent read-only inspector audited the final state within 0.5\\,\\mu$m and 0.15 percentage points of the agent's readings, and the acceptance suite completed 40/40 checks in approximately 22\\,min including thermal preheat."],
  ["(iii) no arm adds measurable latency at this tier (p50 110--141\\,ms, p95 150--215\\,ms across all arms and all released runs; the protocol-tier readback cost is measured in E6). Boundary behavior follows each arm's specification (9/9 probes).",
   "(iii) no arm adds measurable latency at this tier (p50 110--141\\,ms, p95 150--215\\,ms; the protocol-tier readback cost is measured in E6). Boundary behavior follows each arm's specification (9/9 probes)."],
]
for (const [a, b2] of evTrims) {
  if (!ev.includes(a)) console.log('MISS ev:', a.slice(0, 40))
  ev = ev.split(a).join(b2)
}
writeFileSync(R + 'evaluation.tex', ev)
console.log('final trims done')
