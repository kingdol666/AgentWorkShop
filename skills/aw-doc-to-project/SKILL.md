---
name: aw-doc-to-project
description: AgentWorkShop 全自动编排 skill——从产线工况文档到可作业 Project。当用户给出产线工况文档/需求说明,需要"一键搭建"整套作业系统时使用:先模拟 PLC 节点协议(影子模拟器),再连接建节点/产线,按需创建多个 Channel 并完成绑定,创建 Project 把 Channel 绑定编组、下发依赖链任务跑通。内置三门 ask 机制(意图澄清/蓝图审签/投用裁决)——先弄清用户真实意图、经人工确认后才自动构建。触发词:工况文档、一键搭建、自动构建、建项目、频道编组、多Channel协同、把频道绑定到项目、跑通产线作业、按文档建整套系统。不适用于:单协议细节深潜(见 aw-protocol-onboarding)、单频道锻造细节(见 aw-line-onboarding)、模拟器内部机制(见 aw-plc-sim-twin)。
---

# 从产线工况文档到可作业 Project

> 双位置说明:校验基准副本在仓库 `skills/aw-doc-to-project/`,ZCode 发现副本在 `.agents/skills/aw-doc-to-project/`;改动须两处同步。脚本实体在 `scripts/onboarding/`。
> 组合定位:本 skill 是**编排层**,不重复下层细节——文档理解与三门 ask 在这里;
> 模拟 PLC 协议 = `aw-plc-sim-twin` 模式 B(`scripts/onboarding/sim-twin.mjs --blueprint`);
> 产线供给/频道锻造/验收 = `aw-line-onboarding` 的 onboarding 脚本;
> **Project 编组与跑通 = 本 skill ### 5-6**(现有技能族不覆盖的增量面,经 `aw_request` 走 REST)。

## 三门 ask 铁律(高于一切步骤;每门必须有人类明确答复才能过)

1. **Gate A 意图澄清**:文档读完先用自己的话向用户复述理解,再分轮提问(每轮 ≤4 问,先问阻塞项)。必问清单:①点位量程/单位/单步上限缺失;②SP(可写)/PV(只读)判定不明;③一期范围(哪些点位进系统);④每个频道的作业场景(找区间/诊断/微调)与验收判据;⑤是否组 Project、几个频道、职责如何分;⑥治理档位(首绑 manual 是缺省,用户明确要求才 auto)。用户答复**原文记录**进 clarifications 清单,不代答不改写。
2. **Gate B 蓝图审签**:把完整构建蓝图(下方五清单)呈现给用户,**批准后才允许创建任何资源**——预检/列表等只读操作除外。执行中凡超出蓝图的新增资源,先补充说明并重新取得确认;蓝图变更(节点增删/依赖重排)同样重新审签。
3. **Gate C 投用裁决**:跑通验收后输出交接声明(落袋 id/绑定矩阵/HITL 策略/回退路径);**是否投入使用由产线负责人裁决**——本 skill 只交付到"可投用",不得代用户宣告投产。

## 失败处置通则

- 请求 400 → 先看 `message` 定位字段(多为量程/stepLimit/templateRef 缺失);401 → 鉴权/行权限;409 → 重名或在飞写;超时 → 先确认实例是否被其他作业占用,**不要重启**。
- 任一阶段红即停,回报原始 message,修正后重跑当前阶段;已创建资源按 id 记录(回滚按 id 逆序)。

### 0. 环境判定与连接检查(只读,不受 Gate B 约束)

调 `aw_status`:确认 `AW_BASE`/端口与 `mcpEnabled=true`;未鉴权先 `aw_login`。
- **MCP 集成开关已启用**:平台 Web「系统设置 → MCP 集成 → 启动 MCP 集成」打开(或为 MCP 进程设 env `AW_MCP_ENABLED=true`)。未启用时 `aw_status` 返回 `mcpEnabled=false`,除 `aw_status` 外所有工具调用都会被拒——先引导用户开启,不要绕过。脚本路径(scripts/onboarding/*.mjs)走 REST 不依赖 MCP 开关,可作等价执行路径,但工具面缺省以 MCP 为准。
- `node scripts/onboarding/preflight.mjs --json` 记录实例状态;运行中实例一律按生产对待(附加模式:`PROTO-`/本次前缀的测试线,不改不删既有资源;禁 `aw start`/`aw stop`/杀进程/同 home 再启实例)。
- 文档为 PDF/Word 时先转 Markdown/CSV(平台不内置解析;只有原始文档时让 Agent 用可用文档工具读取或请用户提供文本)。

### 1. 文档理解与意图澄清(Gate A)

从工况文档提取:工序链 → 点位表(每点:名称/SP-PV/协议/量程/单位/stepLimit/采样周期/精度)→ 目标与判据 → 约束。缺什么按必问清单问(见三门铁律 Gate A),产出 `clarifications[]`:`{no, category(文档缺口|系统必需|意图确认), question, answer原文, mapsTo:"具体到配置字段"}`。**无澄清记录不得进蓝图。**

### 2. 构建蓝图审签(Gate B)

蓝图五清单,逐项与用户对齐后签字:

| 清单 | 内容 | 来源 |
| --- | --- | --- |
| ① 节点表 | 名称/SP→写控(dcw)或PV→数采(daq)/协议/量程/单位/stepLimit(建议≤量程/20)/采样周期/精度 | 文档+Gate A 答复 |
| ② 模拟方案 | sim-twin 蓝图(设备分组/protocol/dynamics 因果)/影子端口(独立影子树,绝不碰共享 4010) | 清单①推导 |
| ③ 频道清单 | 每频道:场景(optimize/diagnose/tuning)/模板(可用 `aw_channel_template_list` 核对在册)/绑定矩阵/插件/种子任务 | Gate A ⑤答复 |
| ④ Project 编组 | 项目名/objective/成员频道+charter/交付物(acceptanceCriteria)/工作项依赖链(如 W1分析→W2调优→W3建模,routingPolicy=technical) | Gate A ⑤答复 |
| ⑤ 治理档位 | controlPolicy/绑定首绑 manual/频控/验收判据 | 文档+缺省 |

### 3. 模拟 PLC 协议先行(aw-plc-sim-twin 模式 B)

1. 清单①→`blueprint.json`(形状见 `scripts/onboarding/sim-twin.mjs` 头注;`kind:'sp'` 可写、`'pv'` 带一阶滞后/因果耦合动力学);
2. `node scripts/onboarding/sim-twin.mjs --blueprint blueprint.json --sim-port <影子端口>` → 影子模拟器 + tick 活性自检;
3. 对每设备 `GET /api/nodes/:id/export` 取 `driverConfig`(**永不手抄**;脚本末行 JSON 摘要含设备 id 与溯源)。
失败处置:某设备创建成功但活性自检报**冻结** = 模拟器 tick 静默死亡怪癖,POST 修不了——整树重启影子模拟器(仅影子树,生产实例无关)即恢复;响应 `<!doctype` HTML = 路径缺 `/api` 前缀(脚本已内置重试)。
**多影子并存纪律(2026-11-08 实测踩坑)**:影子树的 modbus/opcua 端口按信号序自动分配,**不同影子会撞同一端口**(如两台都占 37542),后启动者的设备静默不监听 → 平台侧该协议节点零采样/回读缺失。多个影子同时运行时:先查 `netstat` 确认端口唯一,必要时改影子 `data/config.json` 的 `config.port` 并重启,再 `PATCH` 平台节点 `driverConfig` 对齐(只改端点,治理字段不动)。另:sim-twin 自举偶发"路由未就绪"——先手动 `SIM_PORT=<port> npx tsx src/server/index.ts` 起影子,再跑 sim-twin 物化。

### 4. 产线供给与频道锻造(aw-line-onboarding 阶段 3-5)

- `node scripts/onboarding/provision-line.mjs <config>`(driverConfig=export 真值)→ 末行摘要 `{lineId,dcw,daq,recipeId}` **保存**;
- `node scripts/onboarding/forge-channel.mjs <config>` 逐频道锻造(scenario/bindings 用 `$DAQ:名字`/`$RECIPE` 引用/seedTask;手工等价路径 = `aw_channel_template_instantiate` + `aw_agent_tool_bind` + `aw_task_create`);
- `node scripts/onboarding/verify-line.mjs <config>` V1-V6 全绿才进下一步;抽查可用 `aw_daq_samples`(数采落库)与 `aw_dcw_read`(回读)。
失败处置:V1 数采落库红 → 先查采集总控 running 与 `intervalMs`;V3 合法写红 → 核对 driverConfig 字节序/量纲(export 真值不应出现,出现即说明手抄);400 红 → message 定位到节点字段逐点修。

### 5. Project 编组(本 skill 新增面;经 `aw_request` 走 REST)

```
POST /api/workshop/projects                                  # {name, objective, leaderHarness, mode:'supervised', routingPolicy:'technical'}
POST /api/workshop/projects/:id/channels                     # {channelId, charter} ← 把频道绑定到项目
POST /api/workshop/projects/:id/deliverables                 # {name, required, ownerChannelId, acceptanceCriteria:['artifact_present']}
POST /api/workshop/projects/:id/work-items                   # {deliverableId, channelId, title, brief, execBudgetMinutes, dependsOn:[上游id]}
POST /api/workshop/projects/:id/activate                     # 激活(编排循环启动前提)
POST /api/workshop/projects/:id/plan/request-approval        # {version, plan:{facts,steps}} → owner/admin 批准
POST /api/workshop/projects/:id/work-items/:wid/dispatch     # 派发 → 自动创建任务实例 Channel(任务级多会话)
GET  /api/workshop/projects/:id/observability                # 工作项/attempts/实例 Channel 全景
```

- `leaderHarness` 选型:mock=确定性编排骨架(工具/治理全真实,编排由驱动或人推进);omp=真 LLM 计划与派发(产能受本地模型能力约束)。给用户说明差异后按 Gate A 答复选。
- **验收链(双账号)**:成果 draft 自动物化 → owner `POST /results/:rid/submit {summary}` → 独立 admin L1 `POST /results/:rid/review {decision:'reviewed'}` → `request-acceptance` → 独立 admin L2 `POST /approvals/:id/decide {approve:true}`。L1/L2 需 admin 或 owner(评审与提交不得同一人——SELF_APPROVAL_FORBIDDEN)。
- 实战坑:派发响应带 `instanceChannelId`;`complete_task` 只吃 summary/deliverable 字符串;父任务收口要求全部子任务 COMPLETED 或 superseded 且交付物非空;mock 引擎只有 `[mock:complex]` 剧本才拆子任务保持 root 在飞;项目内设备写需 write_intent(`project_request_write_intent` → owner 批准)+ HITL 双闸。
- **项目内治理写拓扑(2026-11-08 实测钉死)**:`project_request_write_intent` 是 **lead-only** 工具,且意图绑定申请者(P0-5)——**由谁申请就由谁消费**。因此协作频道的 **lead 必须持写控+配方绑定**并亲自执行写;worker 的绑定服务频道内常规作业。写执行者还须处于「项目来源任务」上下文(实例 lead 天然满足)。
- **四期递进档位(能力成熟度路径,同产线同节点仅换档)**:分析=line-doctor(物理零写,43 工具无写面)→ 控制=legacy/tuning 或 generic-optimize(recipe_* + 绑定 manual 触发 HITL)→ 训练=aml_training(数据集/训练,零设备写)→ 自主优化=aml_optimization 探索模式(仅 optimization_explore,有界步长+可辨识性闸,**dcw 绑定必须 auto** 否则每次激励仍挂 HITL)。工具面数量随档位变化,是治理强度的物理体现。
- **AML 档位是频道级,任务实例不继承** → 训练/优化族工具由**基础频道 lead** 执行,实例 lead 负责项目任务收口;派发实例仍有价值(会话行/审计/交接)。
- 数据集构建:需 **beat 对齐网格连续覆盖 history+horizon 步**(如 beat 2000ms × 40 步 ≈ 80s 数据,留 130s 余量),且需**已完结批次**(先关当前 run 再 `line_start`);同规格 10 分钟内重复构建会触发**去重熔断返回既有 ds-id**(设计行为,直接复用,勿当失败)。
- 平台在线写节拍:DCW 相邻写 **≥60s**、配方试验 **≥300s/线**;节拍早拒会**消费掉 write_intent**,重试前须重新申请+批准。驱动必须把等待重试实现为循环,并把「首次被拒」与「最终态」分开断言。

### 6. 跑通与验收(Gate C)

1. 派发首个工作项 → 轮询 observability 看实例/成果物化 → 走验收链至 approved;整链按依赖顺序推进至项目 completed(或按用户范围止于首项);
2. 证据三面:V1-V6 报告、治理写证据(HITL 卡+设备回读,可用 `aw_dcw_write` 最小步写验/`aw_dcw_read` 回读)、项目审计事件;
3. 交接声明:落袋 id 清单(线/节点/配方/频道/项目/工作项)、绑定矩阵、HITL 策略、回退路径(按 id 逆序)、**投用复核清单**(Gate C)。

### 7. 虚拟 → 真实割接(无缝衔接的机制与实证)

节点行把 **`driver`/`driverConfig`(端点)** 与 **治理字段(`min/max/stepLimit/holdIntervalMs/lineId`)** 分开存储,绑定与配方引用节点 **id** 而非端点 —— 所以割接只需 PATCH `driverConfig`,治理面零改动(端点为 admin-only 独立字段,`server/api/workshop/dcw/[id].patch.ts`)。2026-11-08 实测:影子端口冲突修复即一次真实端点迁移(6 节点 `driverConfig.port` 37542→37562),治理字段未动,迁移后 verify-line 19/19 且整条四期项目在新端点跑通。
六步放行:①真实 driverConfig 重跑连通预检 →②只读浸泡 ≥30min(只接 PV)→③单点最小步写入首验(写控|设备|回读三方一致)→④其余节点 PATCH driverConfig(配方/绑定/限界不动)→⑤verify-line V1-V6 重跑 →⑥割接清单交付 + 投用裁决。secretRef 视图为掩码,PATCH 时显式给真值或不动该字段。

## 红线

- **无审签不建资源**;超蓝图创建视为违规,先补确认再继续。
- 模拟器只写影子树(绝不碰共享 4010 与他人影子树);受保护演示线 `ln-d7e0a2a2` 只读;多影子并存先做端口唯一化。
- 量程/stepLimit/SP-PV 判定不明必问,禁止猜测;driverConfig 只来自模拟器 export/文档/用户确认。
- 凭据零明文(secretRef/env);Agent 写路径首绑 manual;不重启生产实例。
- 档位只按用户确认的成熟度路径放宽:manual→auto 属风险操作,须显式 `confirm:true`;未获确认不得切 auto。

## 验收清单

- [ ] Gate A/B/C 三门记录齐全(用户答复原文 + 蓝图版本对应)
- [ ] 蓝图五清单与实际创建资源逐项对账一致(无超建/漏建)
- [ ] 孪生设备 tick 活性自检通过;driverConfig 全部来自 export
- [ ] verify-line V1-V6 全绿;频道绑定矩阵与蓝图一致
- [ ] Project 编组完成(频道 charter/交付物/依赖链/plan 批准)且首个工作项 approved(或整链 completed)
- [ ] 交接声明含全部落袋 id、回退路径、投用复核清单
