# 实验流水线 v2 优化 + C3 活体 Agent Pilot 报告

**时间**:2026-11-02 18:30~19:10 · 隔离 B 态(平台 3005 / 模拟器 4011)· 生产实例 3300 已恢复
**目标**:补全实验设计(尤其"活体 Agent 多轮"),把 PIPELINE 优化到"能真正执行完整作业并产出结果",然后开跑。

---

## 0. 结论

- **流水线已补全并可真实执行到"Agent 动作层"**:新增 C3 标准化 runner,修掉 5 个会让实验"空跑/假绿/卡死"的缺陷;
- **C3 活体 Agent pilot 全部为负结果**:4 次尝试中,最好的一次是 worker 完成 15 分钟取证但 **0 次受治理写入**,PV 31.23 g 未入带;另一次在 0 写下被平台隐式 `COMPLETED`;
- **因此 C3 目前不能写入论文**;论文可写的仍是确定性块(E1 准入、E2 C0/C1、E4 消融)。本轮的价值是把"为什么不能写"定位到了可修的工程点,而不是含糊归因。

## 1. 设计补全(E2-C3)

在 `EXPERIMENT-PIPELINE.md` E2 增加 C3 协议:
- 单元/N:每场景 **N=5 次独立 fresh episode**(optloop 无 seed,run 序号即重复),不与 C1 按 seed 配对;
- 预算:pilot 15 min、确认性 30 min(LLM 回合时延不可控,必须报 `budgetMin` 与终态);
- 终点:PV 是否在带、守卫是否满足、写次数、轮次、wall time、终态;
- 判据:C3 只做"完成 + 在带 + 守卫满足"的可行性判定,不做 vs C1 的优越性;
- 产物:`bench/results/<rid>-agent-multiround/{agent-c3.csv,agent-c3.md,run.json}`。

## 2. 流水线优化(6 项)

| # | 缺陷 | 修复 |
| --- | --- | --- |
| P1 | **零探针假 PASS**:`--scenarios cast-film` 不在 `SCENARIOS` 映射,runner 静默过滤后 0/0 仍打印 PASS | `scenario-protocol-probes.mjs` 增加 fail-closed:未知场景报错退出;`rows=0` 或 `legalDen=0` 抛错。实测 `cast-film` 现在返回"未知场景(injection, wwtp, anneal, biax)" |
| P2 | 优化对照 runner 同样会静默过滤未知场景 | `optimization-control.mjs` 加同样的未知场景/零场景守卫 |
| P3 | optloop 建频道后未装配 lead 调度循环 → goal 任务永久 SUBMITTED | deploy 后调用 `POST /channels/:id/activate` |
| P4 | lead 首轮后不消费队列(生产 R-4 同源)→ 任务滞留 | 创建根任务后 `reassign` 给 worker(经平台状态机,以 lead 身份执行并留痕) |
| P5 | 任务 parts 变成 `artifact://<uuid>`,omp artifact 协议只认数字 ID → worker 读不到任务书 | 任务书同时写入 **description**(worker 可直接读);parts 保留原文 |
| P6 | 裸建 agent 未带 `rpcMode:'rpc'` → omp 不挂 `xd://` 宿主工具,worker 报 `No such tool: xd://dcw_control` | agent config 增加 `rpcMode:'rpc'`(与生产模板一致) |

新增 `bench/experiment/agent-multiround.mjs`:N 次 episode 包装 optloop,按 E2 口径输出 CSV(写次数/轮次由 recorder 产物推导,不用 Agent 自述)。

## 3. 执行记录(全部在隔离 B 态 3005/4011)

| 尝试 | 修到的层 | 观察到 |
| --- | --- | --- |
| A | 无 activate | 根任务一直 `SUBMITTED`,lead `idle q=1`,worker `idle`;15 min 内 0 写、无结果行 |
| B | activate + reassign | worker 启动并跑约 5 min;任务变 **COMPLETED**,但 **PV 31.28 g 未入带、0 写** → 平台**隐式收口未校验 goalCriteria** |
| C | 任务书入 description | worker 能读任务书,但写工具缺失:`No such tool: xd://dcw_control` → 0 写 |
| D | `rpcMode:'rpc'` | worker 已能调用 `xd://my_industrial_nodes`、`daq_query`、recipe/ops 历史;15 min 内完成取证但 **0 次写入**,`BUDGET_TIMEOUT`、PV 31.23 g |

C3 结果(attempt D,`agent-c3.csv`):

| condition | scene | run | PV | 目标带 | inBand | guards | finalState | writes | rounds | wall |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| C3 | injection | 1 | 31.23 | 32.5±0.35 | No | VIOLATED | BUDGET_TIMEOUT | 0 | 0 | 902.84 s |

## 4. 缺陷清单(对平台/流水线)

| # | 缺陷 | 归属 | 状态 |
| --- | --- | --- | --- |
| D1 | 探针 runner 零分母假 PASS | 实验流水线 | **已修** |
| D2 | 频道 REST 创建 + team deploy 后无 lead 调度循环 | 平台/流水线 | 流水线已用 activate 绕过;平台建议在 deploy 内自动 ensure |
| D3 | lead 回合结束后不继续消费队列(SUBMITTED 滞留) | 平台(R-4) | **未修**,流水线用 reassign 绕过 |
| D4 | task parts 的 `artifact://<uuid>` 与 omp numeric artifact 协议不兼容 | 平台/agent 集成 | 流水线用 description 绕过;**平台应内联文本** |
| D5 | 手工创建的 agent 缺 `rpcMode:'rpc'` 默认值 → 宿主工具不挂载 | 平台 | 流水线已显式设置;建议服务端默认 rpc |
| D6 | goal 任务可在 0 写、PV 未入带时被隐式 `COMPLETED` | 平台 | **未修**,需 `complete_task` 前校验 goalCriteria |
| D7 | 活体 Agent 15 min 内只取证不写入 | Agent 行为 | 需更长预算/更强"先写一版"提示;不能作为论文阳性证据 |

## 5. 对论文的影响

- **可写**:E1(5 场景准入,4 场景探针 220/220)、E2 C0/C1(0/15 vs 15/15)、E4 四臂+五层消融、双跑 77/0/0;
- **不可写**:C3 活体 Agent 多轮(本轮 0 写/超时)、任何"Agent 自主优化"主张;
- 论文现有的克制口径仍然成立;本轮没有产生可替换论文数字的新阳性结果。

## 6. 下一步(按阻塞优先级)

1. **平台修 D3/D4/D6**:lead 队列续消费、task parts 内联、goal 收口校验;
2. C3 确认性:预算 30 min/episode,先给 worker 一条"5 分钟内必须完成第一次受治理写入"的硬提示;N=5;
3. 若 D6 修复,再用"是否入带 + 写入次数 + 守卫"三指标判定,不再依赖任务终态;
4. 修完后重跑 C3;仍 0 写则把 C3 降级为"可行性 pilot"并在论文中明确 NOT-RUN/负结果。

## 7. 环境恢复

- 隔离 B 态 3005/4011 已停;
- 生产模拟器 4010 已重启;**生产平台 3300 已恢复**(健康 200,OPC 保压读回 64.8,注塑线克重 32.29 g 在窗);
- 期间清过一次 PID 复用导致的 stale `data.lock`(旧 server PID 被系统复用给新 supervisor,instance-guard 误判)。

*证据:`docs/audit/evidence/2026-11-02-experiment-pipeline-v2/`(4 次 C3 attempt、false-pass-run.json、cast-probes2.log、c3-pilot*.log)。*
