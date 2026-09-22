# Pipeline 复现判定: 判定类失败 0 · 环境类报告 6 项
- A: `20260921174255-11sw` (git `e692df1`, harness `9f2756dc`)
- B: `20260921181401-oas` (git `e692df1`, harness `9f2756dc`)

## 判定类指标

| 指标 | A | B | 判定 |
|---|---|---|---|
| verdict(pass/warn/fail) | [83,0,0] | [83,0,0] | ok |
| 检查 id 集合 | 83 | 83 | ok |
| F5 池化拦截/误拦 | {"rate":1,"tot":24,"rej":24,"falseBlock":0} | {"rate":1,"tot":24,"rej":24,"falseBlock":0} | ok |
| 工具闭环 iterations 集合 | [0,3,3,3,3] | [0,3,3,3,3] | ok |
| J*(offline optimum) | 89.894 | 89.894 | ok |
| closedloop iters/writes/rejected/converged | [[null,null,null,null],[null,null,null,null],[null,null,null,null]] | [[null,null,null,null],[null,null,null,null],[null,null,null,null]] | ok |
| ratio mean (env, 带内) | 0.971 | 0.969 | report |
| portability 构成 | {"preset":"film-line","lines":5,"ownLines":3,"sat":2,"f5":9,"falseBlocks":0} | {"preset":"film-line","lines":5,"ownLines":3,"sat":2,"f5":9,"falseBlocks":0} | ok |
| system backstop fired/restored | [true,true] | [true,true] | ok |
| backstop latency_s (env) | 130.109 | 130.209 | report |
| biax 建线构成+多节点覆盖+达标 | {"devices":9,"signals":49,"sp":30,"knobs":3,"attained":true} | {"devices":9,"signals":49,"sp":30,"knobs":3,"attained":true} | ok |
| biax writes/final μm (env) | [3,25.68] | [3,25.68] | report |
| write p50 集合 (env) | [] | [] | report |
| daq samples 集合 (env) | [] | [] | report |
| closedloop J0/Jend (env) | [[68.935,87.236],[68.098,87.236],[65.756,87.341]] | [[66.421,87.262],[67.012,87.132],[65.323,87.053]] | report |

## 结论: **REPRODUCIBLE** (判定类失败 0 · 环境类报告 6 项)

_环境类(时延/采样计数/J 采样值)由物理采样时序决定,只报告不设门槛 —— 与 bench/compare.mjs 的判定契约同哲学。_