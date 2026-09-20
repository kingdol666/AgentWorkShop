# Pipeline 复现判定: 判定类失败 0 · 环境类报告 6 项
- A: `20260920093330-md4` (git `1585948`, harness `b203077a`)
- B: `20260920094610-to4` (git `1585948`, harness `b203077a`)

## 判定类指标

| 指标 | A | B | 判定 |
|---|---|---|---|
| verdict(pass/warn/fail) | [75,0,0] | [75,0,0] | ok |
| 检查 id 集合 | 75 | 75 | ok |
| F5 池化拦截/误拦 | {"rate":1,"tot":24,"rej":24,"falseBlock":0} | {"rate":1,"tot":24,"rej":24,"falseBlock":0} | ok |
| 工具闭环 iterations 集合 | [0,3,3,3,3] | [0,3,3,3,3] | ok |
| J*(offline optimum) | 89.894 | 89.894 | ok |
| closedloop iters/writes/rejected/converged | [[null,null,null,null],[null,null,null,null],[null,null,null,null]] | [[null,null,null,null],[null,null,null,null],[null,null,null,null]] | ok |
| ratio mean (env, 带内) | 0.97 | 0.968 | report |
| portability 构成 | {"preset":"film-line","lines":5,"ownLines":3,"sat":2,"f5":9,"falseBlocks":0} | {"preset":"film-line","lines":5,"ownLines":3,"sat":2,"f5":9,"falseBlocks":0} | ok |
| system backstop fired/restored | [true,true] | [true,true] | ok |
| backstop latency_s (env) | 130.182 | 130.205 | report |
| biax 建线构成+多节点覆盖+达标 | {"devices":9,"signals":49,"sp":30,"knobs":3,"attained":true} | {"devices":9,"signals":49,"sp":30,"knobs":3,"attained":true} | ok |
| biax writes/final μm (env) | [4,25.639999999999997] | [4,25.48] | report |
| write p50 集合 (env) | [] | [] | report |
| daq samples 集合 (env) | [] | [] | report |
| closedloop J0/Jend (env) | [[70.323,86.871],[68.046,87.366],[65.319,87.262]] | [[70.167,86.845],[68.608,87.236],[65.74,87.08]] | report |

## 结论: **REPRODUCIBLE** (判定类失败 0 · 环境类报告 6 项)

_环境类(时延/采样计数/J 采样值)由物理采样时序决定,只报告不设门槛 —— 与 bench/compare.mjs 的判定契约同哲学。_