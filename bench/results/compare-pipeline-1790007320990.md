# Pipeline 复现判定: 判定类失败 3 · 环境类报告 6 项
- A: `20260921151620-ykk` (git `e692df1`, harness `77d571c3`)
- B: `20260921155514-16lg` (git `e692df1`, harness `77d571c3`)

## 判定类指标

| 指标 | A | B | 判定 |
|---|---|---|---|
| verdict(pass/warn/fail) | [82,0,0] | [80,2,0] | **FAIL** |
| 检查 id 集合 | 82 | 82 | ok |
| status P11·scen-anneal | "pass" | "warn" | **FAIL** |
| status P11·scen-report | "pass" | "warn" | **FAIL** |
| F5 池化拦截/误拦 | {"rate":1,"tot":24,"rej":24,"falseBlock":0} | {"rate":1,"tot":24,"rej":24,"falseBlock":0} | ok |
| 工具闭环 iterations 集合 | [0,3,3,3,3] | [0,3,3,3,3] | ok |
| J*(offline optimum) | 89.894 | 89.894 | ok |
| closedloop iters/writes/rejected/converged | [[null,null,null,null],[null,null,null,null],[null,null,null,null]] | [[null,null,null,null],[null,null,null,null],[null,null,null,null]] | ok |
| ratio mean (env, 带内) | 0.972 | 0.97 | report |
| portability 构成 | {"preset":"film-line","lines":5,"ownLines":3,"sat":2,"f5":9,"falseBlocks":0} | {"preset":"film-line","lines":5,"ownLines":3,"sat":2,"f5":9,"falseBlocks":0} | ok |
| system backstop fired/restored | [true,true] | [true,true] | ok |
| backstop latency_s (env) | 130.139 | 130.216 | report |
| biax 建线构成+多节点覆盖+达标 | {"devices":9,"signals":49,"sp":30,"knobs":3,"attained":true} | {"devices":9,"signals":49,"sp":30,"knobs":3,"attained":true} | ok |
| biax writes/final μm (env) | [3,25.68] | [3,25.559999999999995] | report |
| write p50 集合 (env) | [] | [] | report |
| daq samples 集合 (env) | [] | [] | report |
| closedloop J0/Jend (env) | [[66.788,87.315],[67.863,87.366],[70.248,87.366]] | [[68.987,87.314],[70.9,87.053],[66.948,87.314]] | report |

## 结论: **NOT REPRODUCIBLE** (判定类失败 3 · 环境类报告 6 项)

_环境类(时延/采样计数/J 采样值)由物理采样时序决定,只报告不设门槛 —— 与 bench/compare.mjs 的判定契约同哲学。_