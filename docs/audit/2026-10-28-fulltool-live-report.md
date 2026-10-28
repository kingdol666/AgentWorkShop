# 全工具面实机测试报告:代码设计 × 真实 harness 作业 × 实机截图(2026-10-28)

- 实例:`http://127.0.0.1:3415`(隔离 AW_HOME,生产构建 v0.8.6;产线 ln-3e4e8fcd 运行中)
- 引擎:omp(真实子进程 RPC)+ opencode(serve + MCP 桥),均 LM Studio `qwen3.5-9b-32k`
- 证据目录:`docs/audit/evidence/2026-10-28-fulltool/`(截图/矩阵/交付物/台账/日志)
- 结论:**工具面质量套件 19/19;13 工具作业套件两引擎零缺失注入;真实作业两引擎 COMPLETED——Agent 完成了"理解产线→读账本→取数→量化判读→留痕台账→受控写→回执"的完整闭环;过程中发现并定位了一起并行构建污染运行实例的事故(非平台逻辑缺陷,已复现-定位-修复-验证)。**

---

## 一、工具面测试(静态 + 注入矩阵)

| 项 | 结果 |
|---|---|
| 工具目录总量 | **104 个宿主工具**(read 75 / write 29),唯一定义源 `.AgentWorkShop/prompts/host-tools.json` |
| 描述完备性/EN 对齐/高危面/执行模式面 | `host-tools-quality + host-tools-en + execution-mode-surface + high-risk-tool-scope` 共 **19/19 PASS**(`logs-toolface-quality.log`) |
| 频道作业套件 | 13 工具(理解:`line_context/dcw_journal/ops_log/recipe_catalog/recipe_versions`;数采:`daq_query/my_industrial_nodes`;分析:`analysis_save/analysis_query`;受治理写:`recipe_trial/recipe_rollback`;任务:`complete_task/report_progress`) |
| 注入矩阵 | 两引擎 worker 均 **13/13 零缺失**;全目录逐工具标注(注入/风险级/角色)见 `matrix.json` |
| 动态提示 | `prompt-injection-probe-*` 与 `tool-injection.json`(前轮取证继续有效):描述按绑定面差异化,节点语义卡/执行模式卡每回合注入 |

## 二、真实 harness 作业(全部为真实 LLM 回合,人工只做审批)

### omp 作业员:六步产线作业(`e86c131d`,COMPLETED/100)

| 步 | 工具 | 实测结果 |
|---|---|---|
| 1 理解产线 | `line_context` | 回显全景:批次 rr-79a39577、3195 打标样本、产品窗 50~70C、**配方目标 60C vs PLC 当前 58C** |
| 2 读写历史 | `dcw_journal` | 首次缺 `node_id` 被**参数校验拒绝**(拒绝文案含补齐指引)→ 模型自纠补参成功 → "该点位尚无 Agent 调控历史" |
| 3 取数 | `daq_query`(15min/15s 桶) | 61 点,均值/最小/最大 107.04C;**Agent 自主判读:"15 分钟波动 0.00C 且越量程,疑似测点/信号异常(恒值冻结/模拟越量程),非真实工艺升温"** |
| 4 留痕 | `analysis_save` | 台账 **`ar-99bf192a`**(category=alarm,5 条结论,引用批次/样本/均值/设定) |
| 5 受控写 | `recipe_trial`(58→60,\|Δ\|=2≤4) | 挂 HITL 卡 `ap-8d16fb5f` → 批准 → **ACK 设备证实** |
| 6 收口 | `complete_task` | COMPLETED,交付物含逐步关键返回 |

效果核验:账本四锚点 `null→60→56→58→60`(全程可溯),节点当前设定/PLC 读数 **60.00C(已 ACK)**,配方仍 **v1**。

### opencode 分析员:四步数采分析(`05be1a73`,COMPLETED/100)

`my_industrial_nodes → daq_query(15min) → analysis_save → complete_task`,工具链经 `aw-host-tools_*`(MCP 桥);台账 **`ar-ab29385f`**(category=quality,交付物:"台账 id:ar-ab29385f | 结论:61 个样本均值 107.04C >> 窗口上限 70C,越限报警已触发")。

## 三、实机截图(证据)

| 文件 | 内容 |
|---|---|
| `08-dashboard-agents-working.png` | 双 Agent 作业中:3241 样本、14/14 引擎、通知徽标 3(任务回执+审批卡) |
| `09-analysis-ledger.png` | **数据分析台账页:两台 Agent 产出的报告在册**——omp(告警类):"…零波动,疑似测点/信号异常而非设定响应滞后;设定 58C 低于基线 60C,拟回补至 60";opencode(质量类):"61 样本均值 107.04C 远超上限 70C";来源均标注 频道/作业员 |
| `10-line-after-fullkit.png` | 产线页:温度设定 **60.00C(已 ACK)**、配方 v1、试验批次 rr-2ca8fa4c 在册、3362 打标样本 |

## 四、事故记录:并行构建污染运行实例(诚实归因,非平台逻辑缺陷)

作业后打开 `/analysis` 页报 `数据集规格不合法:lineId Required` + `getAnalysisRepo(...).get is not a function`。定位过程:

1. 服务器日志锁定错误时刻(17:40),复现于 REST 直调;
2. 构建产物 `routes/api/workshop/analysis/` 只有 `_id_*`,index 路由"消失";
3. 抓到**外部进程每 ~40 分钟重跑 `npm run build`**(17:31:45、18:10:02;进程链:另一会话 bash → npm → `node bin/aw.mjs build`);
4. 干净构建(18:10)完成后路由表**包含** `/api/workshop/analysis` GET/POST(nitro.mjs:76115-76116)——证明源码与构建逻辑无误;
5. 根因:**多个构建共用 `.nuxt`/`node_modules/.cache`,并发时互相踩踏**;演示服务器 15:20 从被污染的 15:04 构建启动,其路由表缺 index 路由,后续磁盘被反复替换又使懒加载 chunk 在窗口期错配;
6. 处置:干净构建 + 重启实例 → `GET /api/workshop/analysis` 恢复 `code=0 count=2`,页面正常显示两份 Agent 报告。

运维教训(已写入门清单):**生产实例不得从正在被重建的 `.output` 目录运行**——构建应输出到版本化目录再原子切换,或构建后重启;多会话共用一个工作区时必须串行化构建。这也是一个可选的产品加固点(启动时记录构建指纹,运行中检测 .output 变更并告警)。

## 五、"完美集成"判定

| 维度 | 判定 | 依据 |
|---|---|---|
| 工具注入 | **达成** | 104 目录·13 套件零缺失;注入=执行同源;拒绝透明化(参数校验文案自带补齐指引,模型可自纠) |
| Agent 理解产线 | **达成** | line_context 全景回显;DCW 语义卡/执行模式卡每回合注入;**Agent 能把"恒定 107.04C"与"设定 58C"关联,判读为信号异常而非工艺响应**——这是理解而非复述 |
| 学会操控 | **达成** | 受治理写全链:trial→HITL→批准→ACK 证实;越窗负例拒;账本四锚点闭环;60s/单步/窗口联锁在咽喉点(前轮 44/44 验证) |
| 学会分析 | **达成** | daq_query 量化判读 → analysis_save 落 append-only 台账(人可查/可修订/可引用),两引擎各自产出 |
| 边界(诚实) | — | 设备仍为 mock(判读结论"信号异常"恰是对 mock 恒值的正确反应);complete_task 由平台按交付物兜底收口;AML/本体/求解器活体档位未在本线启用(门禁与工具面已由单测+前轮验证) |

## 六、复跑

```bash
node scripts/live-demo-seed.mjs                       # 场景供给(实例 3415)
# 扩充工具面 + 双任务下发脚本见会话记录(.omc 已清理,模式同前轮)
npx tsx --tsconfig .nuxt/tsconfig.server.json --test --test-force-exit \
  tests/host-tools-quality.test.ts tests/host-tools-en.test.ts \
  tests/execution-mode-surface.test.ts tests/high-risk-tool-scope.test.ts
```
