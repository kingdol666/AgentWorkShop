# AgentWorkShop 系统能力矩阵与执行逻辑(2026-11-02 e2e 验收轮交付)

> 本文回答两个问题:**这个系统支持什么功能**、**每个功能的执行逻辑是什么**。
> 每项能力标注:入口 → 链路 → 守卫 → 终态,以及本轮(2026-11-02)或近期的真机证据。
> 证据根目录:`docs/audit/evidence/2026-11-02-e2e-full-acceptance/`;论文级实验证据见 S7 权威包(不混淆)。

## 0. 系统定位一句话

配置驱动的工业多 Agent 平台:把「产线(节点/协议/配方/治理)」做成配置,把「Agent 团队」做成频道,让 LLM Agent 在**写控咽喉+HITL 审批+全程台账**的治理框架内对真实/虚拟产线做数采分析、数控下发与闭环优化。

## 1. 协议与数据接入面

| 能力 | 执行逻辑(入口→链路→守卫→终态) | 本轮证据 |
| --- | --- | --- |
| 厂家协议文档→点位蓝图 | skill `aw-protocol-onboarding`:文档逐点提取(量程/单位/stepLimit/采样周期/期望值)→澄清门(A 文档缺口/B 系统必需/C 意图确认,每条带 mapsTo)→能力匹配(内置/插件/不支持) | `01-blueprint.json`(13 点全内置)、`01-clarifications.json`(10 条) |
| 五协议同线接入 | Modbus TCP/RTU(寄存器 float32 big)、OPC UA(nodeId 订阅)、MQTT(订阅池 jsonPath/写 jsonKey)、HTTP 轮询(jsonPath,scalar/vector/image) | `03-conn-result.txt` 12/12;孪生 6 设备 13 信号 |
| 孪生模拟器 | `sim-twin.mjs --blueprint`:SP=manual(可写),PV=因果 hook(一阶滞后+增益);MQTT 内置 broker;HTTP /sim-http 路径;OPC UA ns=2 自动生成 | 孪生活性 6/6;`02-twin-export.json` |
| 镜像采集验收 | provision→样本入库→`verify-mirror.mjs`(窗口/期望值/时间戳单调;vector 点数/指标) | 9/9 节点 PASS(`03-mirror-verify.txt`) |
| 向量后处理管线 | 节点模板 sink.processors(resample n=64 / derive-metric)在入库前处理向量帧 | P5 16 点原始→64 点网格(模板语义,`03-mirror-verify.txt`) |
| 插件扩展面 | registerDecoder/registerDriver/registerWriteDriver/registerProcessor/registerTemplate;project 级热加载(~1s),builtin 优先级遮蔽 | 10 个已注册插件清单(诊断/知识库/串口/孪生/自定义驱动) |

## 2. 数采(DAQ)面

| 能力 | 执行逻辑 | 本轮证据 |
| --- | --- | --- |
| 采集总控 | 全局 controller(tick=5s)轮询所有到期节点;样本落 TSDB,带 line/product/recipe/run 标签 | 供给 19/19(总控 running);采样连续(90 点/20min) |
| 标量/向量/图像 | signalKind 门控:scalar→daq_samples;vector→daq_frames(meta.points);image→对象存储+meta.objectKey | P5 vector 帧验收 3/3 |
| 查询/导出 | `/daq/query`(多节点批量,run/recipe/product 过滤)→ `/daq/export`(异步 job,manifest+CSV)→ 五项核对(值/量/时间/标识/清单) | 五项核对通过(`04-export-check.txt`+`04-export-job.json`,3511 行,truncated=[]) |
| 告警/模板 | 节点模板带 metrics 阈值(alarmHigh/warnLow)→alarms 台账 | 模板 metrics 见 thickness-scan 定义 |

## 3. 数控(DCW)写控面

| 能力 | 执行逻辑 | 本轮证据 |
| --- | --- | --- |
| 写穿链 | REST/Agent 写请求 → 工程量校验 → 驱动换算(raw↔eng)→ 设备写 → **回读校验** → ACK(readback-verified / transport-ack / unverified) | `04-writes-run.txt`:S3 modbus rb-verified;S1 mqtt transport-ack+P9 确认;S4 opcua rb-verified |
| 分级守卫 | 量程(节点安全量程交集)→ 单步限幅(stepLimit)→ 60s 在线写闸 → 保写心跳(holdIntervalMs)→ 工艺窗(配方窗)→ 在飞 409 | G1 越量程拒/G2 超步长拒/G3 60s 间隔拒,原文结构化拒绝 |
| 参数台账 | append-only journal:anchorId/prevValue/newValue/actor/source/approvalId | 7+ 锚点(`04-journal-anchor.json`) |
| HITL 审批 | 首绑恒 manual;审批卡挂 approvals → 人工/授权裁决 → 单一咽喉执行发布 | 本体 R-BOUND 批准链;优化 Profile 采纳链(见 §6) |
| 配方 | recipe(参数→节点引用)→ 开跑批次(run)→ 配方回写全参数(journal src=recipe)→ recipe_trial 受控试验(试验节拍门) | FL7-BASE-v1 rc-db837818;每批开跑 4 参数回写锚点 |

## 4. 产线管理面

| 能力 | 执行逻辑 | 本轮证据 |
| --- | --- | --- |
| 产线/产品/批次 | line(节点容器)→ product(隔离)→ recipe 开跑=run(批次窗,采样与台账按 run 打标) | `00-baseline.json`;批次循环收放(US-006) |
| 开/停线 | start(recipeId)→ 建批次+配方回写;stop → 批次闭合(run.endedAt)——均为**人动作**(REST/UI),台账留痕 | US-006 批次循环 ×6 |
| 频道(Channel) | 模板实例化(4 人团队 lead+workers)→ 绑定(daq 读面/recipe 参数面/dcw 写面 × execute-mode observe/manual/auto)→ 插件开关 → 种子任务 | 三频道锻造 6/4/6 PASS |
| 工作区 | workspace 挂载频道(/workshop/w/<id> 群聊入口);owner 显式开群聊(chatEnabled=1) | WS 88332150 + 3 频道挂载 |

## 5. Agent 作业面

| 能力 | 执行逻辑 | 本轮证据 |
| --- | --- | --- |
| 群聊对话 | 人类 @Agent → mentions 解析 → 定向投递 → Agent 回合(工具面)→ platformReply 群聊答复(F-3 修复:人类投递不被 poll 认领) | 诊断频道问答:实测均值 495.21 vs 物理模型 495.2 精确吻合(`07-chat-reply.json`) |
| 工具面(126 工具) | xd:// 宿主工具按治理档注入:daq_query/line_context/my_industrial_nodes/diag_run/kb_agent/optimizer_*/ontology_*/twin_* | 注册表 126 工具;本体 10 工具在册 |
| 任务台账 | 根任务→子任务派工;状态 WORKING/COMPLETED/FAILED;history 上限 200;**收口缺陷(D 族)已立案**:200 条上限处 FAILED、自述与台账不一致(微调频道) | 三频道任务实测(US-007,含负结果如实记录) |
| HITL 卡 | agent 写/采纳 → approvals 挂卡 → decide(approved/choice)→ 单一咽喉执行 | optimizer_profile_propose 采纳链(US-006) |

## 6. 优化器与 AML 面

| 能力 | 执行逻辑 | 本轮证据 |
| --- | --- | --- |
| 过程规格 | process-model/specs(schemaVersion 2:mv/cv 变量+timing+trainer+datasetPolicy+gate)→ 发布版本 | spec v2-v4 注册发布 |
| 数据集 | 按规格拉「已完结批次」带标签序列 → 公共网格对齐 → 缺失率/窗口校验 → 分割(训练/验证/测试) | 68 行数据集(批次内新建节点绕行 D8) |
| 训练 | trainer linear_arx@1(平台参考训练器)→ job 轮询 → 门禁(nrmse/分割集非空/**G6 动作覆盖:离散水平+低时间共线**)→ 模型登记 + artifactHash(64 位) | 模型进化套件 51/53:模型 A/B/C 登记(mdl-mvzc0sw9/v3y/wip);G6 拒连续激励=门禁生效实测 |
| 优化资格 | eligibility 报告:solve 前置(无报告 → solve 422) | 资格端点实测 |
| MPC 求解 | Profile(modelRef+problemTemplate linear_mpc_quadratic+targets)→ 绑定(agent↔profile,mode=recommendation/governed)→ solve → optimal/feasible + MV 建议序列 | 三次 solve 全 optimal(基线A/新B/新C) |
| 模型采纳闭环 | optimizer_profile_propose(工具)→ HITL 卡 → 批准 → 单一咽喉发布新版本 + **自动重绑** → 新模型 solve(模型进化闭环) | 两轮采纳 optp-mlp0cg7@v2/v3,revision 1→2→3 自动递进,全程零 DCW 写入(推荐模式);孪生 trial 面 provider fail-closed(2 项负结果如实记录) |

## 7. 本体(Ontology)面

| 能力 | 执行逻辑 | 本轮证据 |
| --- | --- | --- |
| 本体建模 | 草稿(schemaVersion 1:name/entities/relations/rules/bindings)→ 乐观锁 rev → 校验(量纲兼容/证据档纪律) | 14/14(`05-ontology-run.txt`) |
| 证据档纪律 | 量化主张(gainPerUnit/lagMs)必须 validated_control 证据;candidate 证据只允许定性关系;hard 规则无 validated 证据不得进入控制态 | candidate 关系带增益被拒 422;R-GUARD validated 被拒 422 |
| 规则生命周期 | proposed→reviewed→validated→(**无批准拒绝 403**)→approval→decision→approved_for_control | R-BOUND 全链 + 守卫拒绝双证 |
| 编译与溯源 | compile→四产物(processModel featureCandidates/rulePack/…)→contentHash/rulePackHash→publish 版本→RuleTrace→export bundle | v5 发布;RuleTrace 3 条;export 15KB |
| 场景语义卡 | /ontology/scene 三层合并(本体+节点语义+配方) | 语义卡 163B+ 实测 |

## 7b. MCP 与外部集成面

| 能力 | 执行逻辑(入口→链路→守卫→终态) | 本轮/近期证据 |
| --- | --- | --- |
| MCP 工具面 | 两个面:①stdio `aw mcp`(38 工具;AW_MCP_ENABLED 门控,未开时除 aw_status 外全部拒);②HTTP `/api/mcp/workshop`(16 工具,常挂载,Bearer token 工具级鉴权)。两面同一治理咽喉(绑定/授权/写控 journal)与宿主工具同源 | `docs/mcp.md`;`mcp/aw-mcp-server.mjs` isMcpEnabled;历史轮 MCP 套件 14 项全绿(2026-11-01) |
| 知识库(kb_agent) | rag-bridge 插件→kb_agent 对话工具(async 即回)→rag-knowledge 检索命中;凭据走 register/login/tokens 三步,不进对话 | 诊断频道已启用 rag-bridge 插件开关;优化频道任务真实调用 kb 检索(任务史);近端真机:kb 检索命中 0.772(2026-10-31 DEMO2) |
| 深度诊断(diag-bridge) | diag_run(异步提交即返 task_id)→diag_status 轮询→报告台账+ops 告警遥测;daq-export 喂数 | 本轮诊断频道 diag_run 产出报告 ff54faa5(灌装量 493.6-498.1 波动评估,任务史可查);IDD/RAG 异步契约 2026-11-02 全绿(当日 iddrag-r2 轮) |

## 8. 观测与运维面

| 能力 | 执行逻辑 | 本轮证据 |
| --- | --- | --- |
| 运行时视图 | /api/workshop/runtime:wiredAgents/activeChannels | 12 wired / 8 active |
| 日志台账 | 产线日志/ops-logs(分类 alarm,时间窗) | 诊断 agent 读产线日志实测 |
| 健康探针 | /api/health(activeChannels/wiredAgents) | US-001 |
| 守护红线 | preflight(运行实例=生产对待:禁重启/禁杀进程/禁改既有资源;附加模式=命名空间隔离) | `00-preflight.json` treatAsProduction=true |

## 9. 本轮负结果与新缺陷(诚实边界)

| 编号 | 内容 | 影响 | 状态 |
| --- | --- | --- | --- |
| D8 | 多次停/开线后 daq 样本不再打 run 标签;PATCH 重注册仅恢复 ~30s | AML 数据集按 runId 取空 → 训练数据治理失败 | **可靠绕行=批次内新建节点**;根因修复需维护窗口 |
| D 族(既有) | 任务 history 200 条上限收口 FAILED;自述与台账不一致(微调频道 S2"受治理试验"无 journal/approval 台账) | 频道根任务闭环率受损;agent 自述不可作为写控证据 | 与 C3 pilot 同族,已立案 |
| D9 | `/api/workshop/dcw/params` ledger 端点 500 | 参数台账查询面不可用 | 新立案,journal 面可用(替代) |
| 训练门禁拒绝 | 68 行数据集分割集空 → 永久失败不重试 | 门禁 fail-closed 生效(设计行为) | 对策:批次≥700s + split 0.3/0.3 |

## 10. 执行逻辑一张图(文字版)

```
厂家文档 ──aw-protocol-onboarding──▶ 蓝图+澄清门 ──▶ 孪生模拟器 ──▶ 平台产线(节点/配方/批次)
                                                                          │
        ┌─────────────────────────────────────────────────────────────────┘
        ▼
  采集总控(5s tick)──▶ TSDB(带 run 标签)──▶ query/导出/EDA/诊断(diag-bridge)──▶ 分析/知识库(kb_agent)
        │                                     │
        │                                     └──▶ AML 数据集(网格校验)──▶ 训练(linear_arx)──▶ 门禁 ──▶ 模型登记
        │                                                                                │
        │                                     优化器 Profile ◀── optimizer_profile_propose(HITL 卡)◀──┘
        │                                           │
        └── DCW 写控 ── 守卫链(量程/步长/60s/保写/工艺窗) ──▶ 驱动 ──▶ 回读 ──▶ ACK ──▶ journal 锚点
                     ▲                                        │
                HITL 审批卡(manual 首绑)──────────────────────┘
```

**铁律**:所有写控走同一咽喉+台账;Agent 自述永远不是证据,台账才是;负结果如实入档。
