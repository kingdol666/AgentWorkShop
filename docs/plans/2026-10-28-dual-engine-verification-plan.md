# 双引擎实机验证计划与验收标准(omp + opencode × LM Studio Qwen3.5)

- 日期:2026-10-28
- 实例:`http://127.0.0.1:3415`(隔离 AW_HOME,生产构建 v0.8.6;沿用 2026-10-28 实机演示场景:产线 ln-3e4e8fcd,DAQ 腔体温度 dn-b567e949,DCW 温度设定 dw-761492d8,配方 v1 窗口 50~70C/单步 4C,批次运行中)
- 引擎:**omp**(真实子进程 RPC)+ **opencode**(serve + MCP 桥),二者均指向本机 LM Studio `qwen3.5-9b-32k`
- 本文件即验收标准;结果写入 `docs/audit/2026-10-28-dual-engine-verification.md`

## 验收标准(AE,逐条可判定)

### AE-A 双引擎装配与真实回合
- A1 opencode 模型目录可见 `lmstudio/qwen3.5-9b-32k`(additive 配置,原 zhipu provider 不受影响,备份留档)。
- A2 同一频道内两个 worker:harness=omp 与 harness=opencode,均以 LM Studio Qwen3.5 完成至少一个真实回合(任务终态 COMPLETED)。
- A3 两引擎的工具回程都经平台统一分发(omp=host_tool_call;opencode=MCP 桥→invokeHostTool),任务 history 中可见 🔧 工具调用记录。

### AE-B DAQ 节点绑定 → 数据抓取与分析
- B1 worker(Agent)绑定 DAQ 节点(daq 绑定落库,绑定 id 可查)。
- B2 worker 经 `daq_query` 取到**真实样本**(样本数>0、均值/最值/窗口判定齐备),判读引用活动批次与配方窗口(50~70C)。
- B3 交付物中包含量化的分析结论(非空泛描述)。

### AE-C DCW 节点绑定 → 受治理控制
- C1 worker 绑定 DCW 节点(dcw 绑定落库,mode=manual)。
- C2 负例:越窗候选(90C > 窗口 50~70C)被治理链拒绝/人工拒绝,**产线零写入**(账本锚点不增加 90 的记录)。
- C3 正例:窗内候选(58C,|Δ|=2 ≤ 单步 4)挂 HITL → 人工批准 → 批次 ACK **设备证实(1/1)** → 节点当前设定/PLC 读数变为 58.00C。
- C4 trial 不写配方版本(版本仍 v1);账本新增 58 锚点。

### AE-D 工具注入与节点语义注入(按引擎分别取证)
- D1 两引擎 worker 的 `agent-tools/list`:工具面=频道 selected 清单;`daq_query` 描述含该 worker 绑定的 DAQ 节点 id,`recipe_trial` 描述含其 DCW 节点 id(per-agent 差异化)。
- D2 提示词注入探针(运行时同一 buildIndustrialContext/nodeSemanticCards)对两引擎 worker 均输出:执行模式卡(manual)+ DAQ 语义卡(量程/预警带/配方窗)+ DCW 语义卡(安全量程/单步上限/手动确认模式)。
- D3 运行回合证据:两引擎 worker 的 `my_industrial_nodes` 回显包含绑定节点的语义卡内容(名称/量程/单步/窗口),证明"Agent 真正理解绑定节点"。

### AE-E 本体模型集成
- E1 本体离线 e2e **57/57** 在当前树重跑通过(生命周期/守卫/编译工件/运行时解析/守卫阻断下发意图/diff/退役)。
- E2 活体探针:本体验目录 REST 可读(实体/关系/规则目录非空,封闭词表在列)。

### AE-F AML 与求解器集成
- F1 优化器治理单测矩阵(门序/防伪/幂等锚/单一咽喉/在飞占位/撤权收敛)在当前树重跑通过。
- F2 求解器真实求解证据:Python worker(OSQP/SLSQP)在单测内完成 MPC/Static 求解并与 TS 独立重算一致(≤1e-6)——本轮重跑该测试文件取新鲜日志。
- F3 优化器工具面在目录中存在(optimizer_solve/optimizer_status 等)且其治理门(资格/档位)有单测覆盖;如活体频道未配 AML 档位,如实标注"工具门存在,活体档位未启用"——不冒充。

## 判定
全部 AE 通过 → 结论"双引擎 + 绑定控制/数采分析 + 本体/AML/求解器集成验证通过";任一 FAIL → 如实列出并定位。
