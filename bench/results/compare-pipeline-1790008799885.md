# Pipeline 复现判定: 判定类失败 0 · 环境类报告 6 项
- A: `20260921151620-ykk` (git `e692df1`, harness `77d571c3`)
- B: `20260921161746-x2w` (git `e692df1`, harness `11f00c62`)
- NOTE: harnessHash 不同(源码演进合法,判定类逐位一致即改判据未变)

## 判定类指标

| 指标 | A | B | 判定 |
|---|---|---|---|
| verdict(pass/warn/fail) | [82,0,0] | [82,0,0] | ok |
| 检查 id 集合 | 82 | 82 | ok |
| F5 池化拦截/误拦 | {"rate":1,"tot":24,"rej":24,"falseBlock":0} | {"rate":1,"tot":24,"rej":24,"falseBlock":0} | ok |
| 工具闭环 iterations 集合 | [0,3,3,3,3] | [0,3,3,3,3] | ok |
| J*(offline optimum) | 89.894 | 89.894 | ok |
| closedloop iters/writes/rejected/converged | [[null,null,null,null],[null,null,null,null],[null,null,null,null]] | [[null,null,null,null],[null,null,null,null],[null,null,null,null]] | ok |
| ratio mean (env, 带内) | 0.972 | 0.97 | report |
| portability 构成 | {"preset":"film-line","lines":5,"ownLines":3,"sat":2,"f5":9,"falseBlocks":0} | {"preset":"film-line","lines":5,"ownLines":3,"sat":2,"f5":9,"falseBlocks":0} | ok |
| system backstop fired/restored | [true,true] | [true,true] | ok |
| backstop latency_s (env) | 130.139 | 130.224 | report |
| biax 建线构成+多节点覆盖+达标 | {"devices":9,"signals":49,"sp":30,"knobs":3,"attained":true} | {"devices":9,"signals":49,"sp":30,"knobs":3,"attained":true} | ok |
| biax writes/final μm (env) | [3,25.68] | [4,25.32] | report |
| write p50 集合 (env) | [] | [] | report |
| daq samples 集合 (env) | [] | [] | report |
| closedloop J0/Jend (env) | [[66.788,87.315],[67.863,87.366],[70.248,87.366]] | [[66.525,87.29],[68.046,87.262],[65.319,87.105]] | report |

## 结论: **REPRODUCIBLE** (判定类失败 0 · 环境类报告 6 项)

_环境类(时延/采样计数/J 采样值)由物理采样时序决定,只报告不设门槛 —— 与 bench/compare.mjs 的判定契约同哲学。_