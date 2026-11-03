# E4 生产态守卫一致性（P 态，无 bench 旁路）

- run: `20261101113644-production-guards` · base http://127.0.0.1:3010
- 夹具: 节点 [120, 260]·配方窗 [175, 205]·stepLimit 5·writeLockSeconds 180

| 层 | 用例 | 值 | 状态 | code | 结果 | 消息 |
|---|---|---|---|---|---|---|
| — | baseline legal | 190 | 200 | 0 | accept | ok |
| L5 | L5 60s interval | 192 | 429 | WRITE_INTERVAL_NOT_ELAPSED | reject | DCW 节点「E4段 pgr8rfw」两次在线写入间隔必须至少 60s，当前还需 60s |
| L4 | L4 step limit | 200 | 409 | STEP_LIMIT_EXCEEDED | reject | 节点「E4段 pgr8rfw」本次变化 10℃ 超过单步限制 5℃（来源:recipe） |
| L2 | L2 node range high | 280 | 400 | NODE_RANGE_EXCEEDED | reject | 设定值 280℃ 超出上限 节点工艺安全量程 的 260℃ —— 约束层:节点安全量程(当前有效写入区间 175~205℃;各层限界按安全规约取交集,越界写入已 |
| L3 | L3 recipe window | 210 | 400 | RECIPE_LIMIT_EXCEEDED | reject | 设定值 210℃ 超出上限 配方「E4工艺 pgr8rfw」工艺窗口(工艺参数 cw-95d61f22) 的 205℃ —— 约束层:配方「E4工艺 pgr8r |
| L6 | L6 hold window | 192 | 429 | WRITE_FREQUENT | reject | 当前写入频繁:「E4段 pgr8rfw」处于写入保持窗口(剩余 118s),请稍后再试 |

**判定：PASS** — 五层各自拒绝，无穿透。

## 口径

1. 本表证明「生产语义下每层各自生效」，**不**证明消融后损失多大（那是 E4 的 OFF 臂，需独立安全复核）。
2. 与 E1a 的关系：E1a 在 B 态测软窗/回读；本表在 P 态补 L4/L5/L6。两者不可合并成一张「拦截率」。
3. 基线合法写若被拒 → 夹具不成立，实验作废（脚本直接抛错）。
