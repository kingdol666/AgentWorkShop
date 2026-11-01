# Pipeline 复现判定: 判定类失败 0 · 环境类报告 10 项
- A: `20261101103641-9j8` (git `da627d21`, harness `f706e5b4`)
- B: `20261101104849-xu0` (git `da627d21`, harness `f706e5b4`)

## 判定类指标

| 指标 | A | B | 判定 |
|---|---|---|---|
| verdict(pass/warn/fail) | [77,0,0] | [77,0,0] | ok |
| 检查 id 集合 | 77 | 77 | ok |
| F5 池化拦截/误拦 | {"rate":1,"tot":24,"rej":24,"falseBlock":0} | {"rate":1,"tot":24,"rej":24,"falseBlock":0} | ok |
| 工具闭环 iterations 集合 (激励步,环境类) (env) | [0,3,3,3,3] | [0,3,3,3,3] | report |
| J*(offline optimum) | 89.894 | 89.894 | ok |
| closedloop iters/writes/rejected/converged | [[null,null,null,null],[null,null,null,null],[null,null,null,null]] | [[null,null,null,null],[null,null,null,null],[null,null,null,null]] | ok |
| ratio mean (带 [0.95,0.995], 差≤0.01) | 0.976 | 0.975 | ok |
| portability 构成 | {"preset":"film-line","lines":5,"ownLines":3,"sat":2,"f5":9,"falseBlocks":0} | {"preset":"film-line","lines":5,"ownLines":3,"sat":2,"f5":9,"falseBlocks":0} | ok |
| system backstop fired/restored | [true,true] | [true,true] | ok |
| backstop latency_s (env) | 120.166 | 120.156 | report |
| biax 建线构成+达标 | {"devices":9,"signals":49,"sp":30,"attained":true} | {"devices":9,"signals":49,"sp":30,"attained":true} | ok |
| biax mission knobs (激励路径,环境类) (env) | 3 | 3 | report |
| biax writes/final μm (env) | [3,25.419999999999998] | [3,24.8] | report |
| write p50 集合 (env) | [] | [] | report |
| daq samples 集合 (env) | [] | [] | report |
| closedloop J0/Jend (env) | [[63.767,88.514],[86.229,86.229],[63.896,88.359]] | [[66.204,88.409],[84.998,88.124],[86.385,86.385]] | report |
| aml 投用链判定布尔(adopted/工件存在) | null | null | ok |
| aml 指标/写数/PV 均值 (env) | [null,null,null,null] | [null,null,null,null] | report |
| p14 能力面判定布尔(MCP 面宽/开关门控) | null | null | ok |
| mcp tools 数 (env) | undefined | undefined | report |

## 结论: **REPRODUCIBLE** (判定类失败 0 · 环境类报告 10 项)

_环境类(时延/采样计数/J 采样值)由物理采样时序决定,只报告不设门槛 —— 与 bench/compare.mjs 的判定契约同哲学。_