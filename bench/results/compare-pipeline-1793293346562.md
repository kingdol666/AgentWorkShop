# Pipeline 复现判定: 判定类失败 5 · 环境类报告 7 项
- A: `20261029163124-28vk` (git `60fa983e`, harness `c8f4698b`)
- B: `20261029164809-dzg` (git `60fa983e`, harness `7688adcb`)
- NOTE: harnessHash 不同(源码演进合法,判定类逐位一致即改判据未变)

## 判定类指标

| 指标 | A | B | 判定 |
|---|---|---|---|
| verdict(pass/warn/fail) | [72,5,0] | [72,5,0] | ok |
| 检查 id 集合 | 77 | 77 | ok |
| status P10·biax-mission-multinode | "pass" | "warn" | **FAIL** |
| status P4·line-1-loop | "warn" | "pass" | **FAIL** |
| F5 池化拦截/误拦 | {"rate":1,"tot":24,"rej":24,"falseBlock":0} | {"rate":1,"tot":24,"rej":24,"falseBlock":0} | ok |
| 工具闭环 iterations 集合 | [0,0,0,0,3] | [0,0,0,3,3] | **FAIL** |
| J*(offline optimum) | 89.894 | 89.894 | ok |
| closedloop iters/writes/rejected/converged | [[null,null,null,null],[null,null,null,null],[null,null,null,null]] | [[null,null,null,null],[null,null,null,null],[null,null,null,null]] | ok |
| ratio mean | 0.976 | 0.982 | **FAIL**(带 [0.966,0.973] 与差 ≤0.005) |
| portability 构成 | {"preset":"film-line","lines":5,"ownLines":3,"sat":2,"f5":9,"falseBlocks":0} | {"preset":"film-line","lines":5,"ownLines":3,"sat":2,"f5":9,"falseBlocks":0} | ok |
| system backstop fired/restored | [true,true] | [true,true] | ok |
| backstop latency_s (env) | 120.251 | 110.185 | report |
| biax 建线构成+多节点覆盖+达标 | {"devices":9,"signals":49,"sp":30,"knobs":3,"attained":true} | {"devices":9,"signals":49,"sp":30,"knobs":2,"attained":true} | **FAIL** |
| biax writes/final μm (env) | [3,24.779999999999998] | [2,25.580000000000002] | report |
| write p50 集合 (env) | [] | [] | report |
| daq samples 集合 (env) | [] | [] | report |
| closedloop J0/Jend (env) | [[61.963,88.779],[85.783,88.123],[86.281,86.281]] | [[58.871,88.386],[84.944,88.176],[85.89,88.254]] | report |
| aml 投用链判定布尔(adopted/工件存在) | null | null | ok |
| aml 指标/写数/PV 均值 (env) | [null,null,null,null] | [null,null,null,null] | report |
| p14 能力面判定布尔(MCP 面宽/开关门控) | null | null | ok |
| mcp tools 数 (env) | undefined | undefined | report |

## 结论: **NOT REPRODUCIBLE** (判定类失败 5 · 环境类报告 7 项)

_环境类(时延/采样计数/J 采样值)由物理采样时序决定,只报告不设门槛 —— 与 bench/compare.mjs 的判定契约同哲学。_