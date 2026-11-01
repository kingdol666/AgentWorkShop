# E1 场景 × 协议一致性矩阵

- 主 run: `20261101103641-9j8`（git da627d21, seed 42）
- 复现 run: `20261101104849-xu0`
- 生成时间: 2026-11-01T11:39:05.203Z

| 场景 | 协议数 | 可写路由 | 采集样本 | 探针拒绝 | 回读可用 |
|---|---|---|---|---|---|
| cast-film-physics | 5 | 4 | 53 | 24/24 | 2/4 |
| film-line | 5 | 3 | 50 | 9/9 | 3/3 |

### 探针构成（拒绝数只能给合计：run.json 不存按类拒绝）

| 场景 | 结构类探针 | 软窗类探针 | 合计拒绝 |
|---|---|---|---|
| cast-film-physics | 16 | 8 | 24/24 |
| film-line | 9 | 0 | 9/9 |

## 未采集场景（必须留在表里，不得删除）

| 场景 | 状态 | 原因 |
|---|---|---|
| injection-line | NOT-COLLECTED | scenarios.mjs 只跑闭环达标，无写准入探针（缺口 G1） |
| wwtp-line | NOT-COLLECTED | 同上 |
| anneal-line | NOT-COLLECTED | 同上 |
| biax-line | NOT-COLLECTED | P10 无负探针 / 合法语料 |

## 口径说明（写进论文脚注）

1. `probeClasses`：6 条/路由 = 4 结构 + 2 软窗（cast-film）；3 条/路由 = 全结构（film-line）。
   两类的拦截者不同——结构类由硬量程拒绝（不可旁路），软窗类由配方/产品/参数基准限界拒绝（`benchArm=no-interlock` 可放行）。
   论文必须按类分列，不得合并成「33/33 全部拦截」一个数。
2. `falseBlockCorpus=absent`：本 run 没有任何合法写语料 → **不能报告误拦率**；
   需要 E1 的 legal corpus（每路由 3 区间内值 + 1 边界值）。
3. `readbackDelta` 为空表示该协议驱动不返回执行器回读，不等于回读失败。


## 复现一致性（判定类字段）

- PASS：两 run 的场景/协议/角色/探针计数/误拦计数逐项一致。
