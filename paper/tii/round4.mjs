// Iteration-2 补丁: 真正落盘 4 条文献+定位句(上轮因脚本中断未写入)。幂等。跑完即删。
import { readFileSync, writeFileSync } from 'node:fs'
const rd = p => readFileSync(p, 'utf8')
const wr = (p, s) => writeFileSync(p, s)
const rep = (s, a, b, tag) => { if (!s.includes(a)) { console.log('SKIP:', tag); return s } return s.replace(a, b) }
const log = []

// 1) refs.bib +4(IEC 62443 / CBF / shielding / Sheridan)
{
  let s = rd('refs.bib')
  if (!s.includes('iec62443')) {
    s += `
@misc{iec62443,
  title        = {{IEC} 62443: Security of Industrial Automation and Control Systems},
  author       = {{International Electrotechnical Commission}},
  howpublished = {International Standard},
  year         = {2018}
}

@article{ames2017cbf,
  author  = {Ames, Aaron D. and Xu, Xiangru and Tabuada, Paulo and Grizzle, Jessy W.},
  title   = {Control Barrier Function Based Quadratic Programs for Safety Critical Systems},
  journal = {IEEE Transactions on Automatic Control},
  volume  = {62},
  number  = {8},
  pages   = {3861--3876},
  year    = {2017}
}

@inproceedings{alshiekh2018shielding,
  author    = {Alshiekh, Mohammed and Bloem, Roderick and Ehlers, R{\"u}diger and K{\"o}nighofer, Bettina and Niekum, Scott and Topcu, Ufuk},
  title     = {Safe Reinforcement Learning via Shielding},
  booktitle = {Proc. AAAI Conference on Artificial Intelligence},
  year      = {2018}
}

@techreport{sheridan1978,
  author      = {Sheridan, Thomas B. and Verplank, William L.},
  title       = {Human and Computer Control of Undersea Teleoperators},
  institution = {MIT Man-Machine Systems Laboratory},
  year        = {1978}
}
`
    wr('refs.bib', s)
  }
  log.push('refs.bib iec62443:' + rd('refs.bib').includes('iec62443'))
}

// 2) related.tex §II-C 定位句(CBF/shielding/Sheridan)
{
  let s = rd('sections/related.tex')
  if (!s.includes('ames2017cbf')) {
    s = rep(s, "Hard constraints on actuator values have their own enforcement literature---control barrier functions \\cite{ames2017cbf} and shielding for learned policies \\cite{alshiekh2018shielding} bound actions by construction; our interlock plays this role at the agent tool boundary, and safe Bayesian optimization \\cite{sui2015safe} is the optional upgrade of the proposal step. Approval semantics likewise have four decades of levels-of-automation theory behind them \\cite{sheridan1978}; E8 grounds its approval-gate metrics in that line.",
      'PLACEHOLDER-NEVER-MATCHES', 'related-already-there')
    // 上面的 rep 只用于幂等;真正插入:
    s = rep(s, "Approval semantics likewise have four decades",
      'Approval semantics likewise have four decades', 'related-marker-check')
    const anchor = "and safe Bayesian optimization \\cite{sui2015safe} is the optional upgrade of the proposal step. Approval semantics likewise"
    if (!s.includes(anchor)) {
      const a2 = "and safe Bayesian optimization \\cite{sui2015safe} is the optional upgrade of the proposal step."
      s = rep(s, a2, a2 + " Hard enforcement of actuator values has its own control-theoretic line---control barrier functions \\cite{ames2017cbf} and shielding of learned policies \\cite{alshiekh2018shielding} bound actions by construction; our interlock plays the equivalent role at the agent tool boundary. Approval semantics likewise rest on four decades of levels-of-automation research \\cite{sheridan1978}, which grounds the approval-gate metrics of Sec.~VI.", 'related-insert')
    }
    wr('sections/related.tex', s)
  }
  log.push('related.tex ames2017:' + rd('sections/related.tex').includes('ames2017cbf'))
}

// 3) pipeline.tex §IV-F IEC 62443
{
  let s = rd('sections/pipeline.tex')
  if (!s.includes('iec62443')) {
    s = rep(s, 'plant protocol ports are network-segmented from agent hosts so that the governed tool surface is the only \\emph{reachable} write path.',
      'plant protocol ports are network-segmented from agent hosts in the sense of IEC~62443 zones and conduits \\cite{iec62443}, so that the governed tool surface is the only \\emph{reachable} write path.', 'pipeline-62443')
    wr('sections/pipeline.tex', s)
  }
  log.push('pipeline.tex iec62443:' + rd('sections/pipeline.tex').includes('iec62443'))
}

// 4) benchmark.tex E8 human-factors 定位
{
  let s = rd('sections/benchmark.tex')
  if (!s.includes('sheridan1978')) {
    s = rep(s, 'B4 is a human-operator reference (operator study or scripted expert profile under the $\\tau$-bench user-simulator paradigm \\cite{yao2024taubench}).',
      'B4 is a human-operator reference (operator study or scripted expert profile under the $\\tau$-bench user-simulator paradigm \\cite{yao2024taubench}); approval semantics are grounded in levels-of-automation research \\cite{sheridan1978}.', 'bench-sheridan')
    wr('sections/benchmark.tex', s)
  }
  log.push('benchmark.tex sheridan:' + rd('sections/benchmark.tex').includes('sheridan1978'))
}

for (const l of log) console.log(l)
if (log.some(l => l.includes('false') || l.includes('MISS'))) process.exit(1)
