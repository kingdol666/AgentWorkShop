# 双引擎实机验证报告(omp + opencode × LM Studio Qwen3.5)——2026-10-28

- 验收标准:`docs/plans/2026-10-28-dual-engine-verification-plan.md`(AE-A…AE-F)
- 实例:`http://127.0.0.1:3415`(隔离 AW_HOME,生产构建 **v0.8.6**,产线 ln-3e4e8fcd 运行中)
- 证据目录:`docs/audit/evidence/2026-10-28-dual-engine/`
- 结论:**AE-A/B/C/D 全部 PASS;AE-E PASS(离线 57/57 + 活面响应);AE-F PASS(优化器单测矩阵 15/15 + 真实 OSQP 求解,活体 AML 档位未启用如实标注)。**

## 一、总判定

| AE | 内容 | 判定 | 关键证据 |
|---|---|---|---|
| A1 | opencode 可见 `lmstudio/qwen3.5-9b-32k` | **PASS** | `opencode models` 输出含该模型;原 zhipu provider 未动(备份 `opencode.json.pre-lmstudio-20261028`) |
| A2 | 双引擎各完成真实回合 | **PASS** | omp 任务 `77129431` COMPLETED;opencode 任务 `a5e21a47`(R3)COMPLETED |
| A3 | 工具回程统一分发 | **PASS** | omp=host_tool_call;opencode=`aw-host-tools_*`(MCP 桥)——`dual-tasks.json` toolCalls |
| B1-B3 | DAQ 绑定→抓取分析 | **PASS** | opencode 交付物:41 点/均值 107.04C/最小最大/「严重越限,超上限 37.04C」量化判定 |
| C1-C4 | DCW 绑定→受治理控制 | **PASS** | 负例 90C 挂卡→人工拒绝(拒导回流 Agent);正例 58C 挂卡→批准→账本 `56→58@17:07:42`、节点值=58(ok)、配方仍 v1 |
| D1 | 工具面按绑定差异化 | **PASS** | `tool-injection.json`:两引擎 6 工具,`daq_query` 描述含 dn-b567e949,`recipe_trial` 描述含 dw-761492d8 |
| D2 | 节点语义卡注入 | **PASS** | `prompt-probe-*.json`:两引擎 cards 均含 执行模式卡(manual)/DAQ 卡/DCW 卡/单步上限/手动确认模式,stale=0 |
| D3 | 运行回合理解绑定节点 | **PASS** | omp `my_industrial_nodes` 回显完整语义卡(量程/预警带/窗口);opencode 交付物引用 dn-b567e949 与 [50,70] 窗口 |
| E1 | 本体离线 e2e | **PASS** | `logs-dual-ontology.log`:**57/57**(生命周期/编译/守卫阻断下发意图/diff/退役) |
| E2 | 本体活面 | **PASS** | REST:草稿创建 `ontd-mvrwd89l-0pw5l4`、草稿详情/校验面、`scene?lineId=` 正确应答(未发布→active:false)+ LINE_REQUIRED 参数校验 |
| F1/F2 | 优化器治理单测 + 求解器真实求解 | **PASS** | `logs-dual-optimizer-unit.log`:**15/15**(门序/防伪/幂等锚/在飞占位/撤权收敛;MPC/Static 由 Python worker 真实求解并与 TS 独立重算一致 ≤1e-6) |
| F3 | 优化器工具面/档位 | **PASS(如实标注)** | 工具与治理门有单测覆盖;演示频道未启 AML 档位(需先训模型/绑 Provider),不冒充活体 AML |

## 二、双引擎运行实录

### omp(真实子进程 RPC)
任务 `77129431`「双引擎验证-omp-控制闭环」:27 条 history,五步全部执行——
1. `my_industrial_nodes` → 回显执行模式卡 + DAQ/DCW 语义卡(AE-D3);
2. `daq_query`(近 10 分钟,引用活动批次 rr-79a39577);
3. `recipe_trial value=90`(负例)→ 首次参数缺 line_id 被**参数校验**拒绝(模型自纠),补齐后挂审批卡 `ap-034aa56c` → 人工**拒绝**并附指导 → 拒绝原文回流 Agent;
4. `recipe_trial value=58`(正例,|Δ|=2≤4)→ 卡 `ap-b0d54eb6` → 人工**批准** → 批次下发 **ACK 设备证实**;
5. 任务 COMPLETED。
效果(权威账本):journal `56→58@17:07:42`,节点当前设定=58.00C(state ok),配方版本仍 **v1**(trial 不写版本)。

### opencode(serve + MCP 桥)
任务 `a5e21a47`(R3)COMPLETED,工具链 `aw-host-tools_my_industrial_nodes → aw-host-tools_daq_query → aw-host-tools_complete_task`;交付物:**腔体温度(dn-b567e949),41 点,均值/最小/最大 107.04C,判定"严重越限"(窗口 [50,70],超上限 37.04C),已触发 alarm**——数采绑定 → 真实抓取 → 量化分析闭环成立。

## 三、诚实记录:opencode 上下文超限的排障链(未隐藏)

| 轮次 | 初始 prompt | 结果 |
|---|---|---|
| R1(全局配置) | **108,823 tok** | FAIL:超 32K 上下文(用户全局 opencode 配置的 MCP/插件/技能全部进入系统提示) |
| R2(隔离 configDir/dataDir,仅 lmstudio provider) | **33,435 tok** | FAIL:仍超 32768(模型当前会话以 32K 加载) |
| R3(隔离 + 禁用 opencode 内置工具面与 plan agent;平台 MCP 桥 6 工具保留) | < 32K | **COMPLETED** |

- 佐证:`opencode-context-failures.json`(R1/R2 的原始错误);LM Studio `/api/v0/models` 显示该模型支持 262K,但当前会话按 32K 加载,且本版本无 load API 可编程改上下文——若在 LM Studio 界面把该模型以 ≥64K 重新加载,R1/R2 的裁剪即可放宽。
- 这不是平台缺陷:omp(同 prompt 面)同模型正常;瓶颈在 opencode 自身的系统提示体积 + 本地模型会话上下文。

## 四、其他如实说明

- omp 任务的交付物工件只截到回执头部(400 字符,场景简报),**控制效果以账本/审批/节点值为权威证据**;opencode 交付物完整。
- 审批历史端点按频道列出(两引擎同频道),两条裁决记录:`ap-034aa56c=denied`(90C,附拒导)、`ap-b0d54eb6=approved`(58C,附批注)。
- AE-F 的活体 AML 档位(训练→Profile→solve→治理下发)需要先有合规数据集与已训模型,本验证以单测矩阵(真实 Python 求解)+ 工具面/门禁覆盖为准,未在演示线上跑完整 AML 闭环(此前 optimizer-live 104/104 已覆盖,见 2026-10-23 记录)。
- 本体验证 = 离线全生命周期 57/57 + 活面 REST 探针;未在本线发布本体图(需双人在档审批流,超出本轮范围)。

## 五、复跑方式

```bash
# 前置:实例 3415(AW_HOME=D:/tmp/aw-live-demo-20261028)+ LM Studio qwen3.5-9b-32k
node scripts/live-demo-seed.mjs                     # 场景供给
node .omc/tmp-dual-setup.mjs                        # opencode worker + 绑定(脚本已留档于会话记录)
# opencode 需隔离配置:D:/tmp/aw-live-demo-20261028/oc-config/opencode/opencode.json
npx tsx --tsconfig .nuxt/tsconfig.server.json scripts/e2e-ontology.mjs
npx tsx --tsconfig .nuxt/tsconfig.server.json --test --test-force-exit tests/optimizer-dispatch.test.ts tests/manual-approval-optimization.test.ts
```
