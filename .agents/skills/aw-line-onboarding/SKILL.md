---
name: aw-line-onboarding
description: AgentWorkShop 产线接入与作业频道锻造 skill。当用户给出 MES API 文档、PLC 协议接入文档或产线背景资料,需要自动接入产线(建线/建节点/设上下限/连通性测试)、创建配方并绑定 Agent、按作业场景(闭环优化找工艺区间/纯数据分析诊断/工艺稳定性微调)自动创建最佳适配频道时使用。触发词:接入产线、MES 接入、PLC 接入、新产线上线、建作业频道、闭环优化频道、诊断频道。不适用于:单节点绑定细节深潜(见 aw-node-bind)与 AML 训练双模式闭环深潜(见 aw-opt-channel)。
---

# AgentWorkShop 产线接入与作业频道锻造

> 双位置说明:本 skill 的**校验基准副本**在仓库 `skills/aw-line-onboarding/`(scripts/test-aw-skills.mjs 校验对象),
> **ZCode 发现副本**在 `.agents/skills/aw-line-onboarding/`(官方标准发现路径)。改动须两处同步;
> 脚本实体在仓库 `scripts/onboarding/`(平台强绑定,不随 skill 目录走)。

从用户文档(或口述规约)到"可作业的频道":提取点位与量程 → 连通性预检 → 产线供给
(线+写控/数采节点+上下限+配方) → 按场景锻造频道(模板+插件+绑定+种子任务) → 验收。
分工铁律:**你(助手)负责读文档、生成 driverConfig、选场景;逐点操作走 aw 工业 MCP 工具,
批量供给/验收走 scripts/onboarding/ 脚本(输入是配置 JSON,永不理解文档)。**

## 前置条件

- **MCP 集成开关已启用**:平台 Web「系统设置 → MCP 集成 → 启动 MCP 集成」打开(或为
  MCP 进程设 env `AW_MCP_ENABLED=true`)。未启用时 `aw_status` 返回 `mcpEnabled=false`,
  除 `aw_status` 外所有工具调用都会被拒——先引导用户开启,不要绕过。
- AgentWorkShop 实例运行中(默认 `http://127.0.0.1:3001`,env `AW_BASE` 可覆盖);凭据
  env `AW_TOKEN`(优先)或 `AW_EMAIL`/`AW_PASS`;未鉴权先 `aw_login`。
- 模拟器目标产线(如有):plc-node-simulator 默认 `:4010`;**禁用整包替换型预设
  (film-line / cast-film-physics / biax-line)——会替换掉既有全部节点**;共存/验收只用
  injection-line / wwtp-line / anneal-line(增量补建,不动其他设备)。
- 受保护资源:演示线1 `ln-d7e0a2a2` 及其节点/配方/批次**只读参照,一律不得写入或删除**。

### 0. 连接检查

调 `aw_status`:确认 base/port 与 `mcpEnabled=true`;未鉴权先 `aw_login`。
实例从未初始化管理员时提示用户走 Web /setup,不要代注册。

### 1. 输入识别与点位提取

先判断用户资料属于哪类,缺什么字段**停下来问用户,禁止猜测**:

1. **PLC 寄存器表(Modbus)** → modbus-tcp / modbus-rtu;SP(可写)点建写控节点,PV(只读)点建数采节点。
2. **OPC UA 节点表** → opcua;要 endpoint 与每点 `ns=;s=` nodeId。
3. **MQTT 主题表** → mqtt;遥测主题建数采(读 jsonPath),命令主题建写控(写 jsonKey)。
4. **MES REST 文档** → mes-rest;查值端点→readMap,下发端点→writeMap,历史端点→historyMap;认证段→secretRef。
5. **产线背景资料(纯文字)** → 提炼工序链、关键参数、目标区间/规格线、约束;点位缺失时先给用户"待补点位清单"。

每驱动 driverConfig 字段表(生成前逐项核对;来源只能是文档、设备 export 或用户确认,**永不手抄猜测**;
模拟器可对每设备调 `GET /api/nodes/:id/export` 直接拿 driver+driverConfig):

| 驱动 | 必需字段(缺省值) | 说明 |
| --- | --- | --- |
| modbus-tcp | host, port(502), unitId(1), register, area(holding), dataType(float32), byteOrder(big) | 量程→min/max,精度→decimals |
| modbus-rtu | host(串口网关), port, unitId, register, dataType, byteOrder | 写需网关支持 buffered RTU |
| opcua | endpoint(opc.tcp://…), nodeId(ns=;s=…), securityMode(None) | 每点一份配置 |
| mqtt | host, port(1883), topic;读 jsonPath,写 jsonKey+qos | 遥测与命令主题分开 |
| http | url, headersJSON, bodyKey | 写 POST,读 GET 探测 |
| mes-rest | baseUrl, authType(bearer/header/none), secretRef;readMap{method,path,query,response.valuePath,tsPath};writeMap{method,path,bodyTemplate(`{{value}}` 插值)} | secretRef 零明文:凭据存 env `AW_MES_<REF>_TOKEN` |

同时提取:**工程量程(min/max)**、**单步上限(stepLimit,建议 ≤量程/20)**、采样周期
(intervalMs 1~5s;写保持 holdIntervalMs ≥120000)。

### 2. 连通性验证(未全绿不得进入供给)

批量:把每个点位写成 `tests` 数组跑 `node scripts/onboarding/test-connection.mjs <config.json>`
(逐驱动调平台 `POST /api/workshop/daq/test-driver`,mes-rest 走 `mes-test-read`)。
单点抽查:用 `aw_request` 直接 POST 上述端点。任一失败即停:回报原始 message
(超时/拒绝/路径 404),修正 driverConfig 后重跑。

### 3. 产线供给(线+节点+上下限+配方)

批量(推荐,幂等):`node scripts/onboarding/provision-line.mjs <config.json>`——以指纹标签
(`AW-LINE:<hash>`)复用既有线/节点,量程漂移自动 PATCH 对齐(配置为权威);配方 params 用
节点名引用;脚本末行输出 JSON 摘要(`{lineId,dcw,daq,recipeId}`),**保存它**。
手工逐点(等价工具面):`aw_line_create` → `aw_dcw_create`(必带 templateRef/min/max/
stepLimit/holdIntervalMs)与 `aw_daq_create` → `aw_recipe_create`;随时 `aw_dcw_snapshot`
核对落袋情况。缺 stepLimit 的配方在下发期会 fail-closed(`EXPLORATION_SAFE_STEP_REQUIRED`)
——供给期必须显式配 stepLimit。

### 4. 场景化频道锻造(按需求选最佳适配)

批量(推荐):`node scripts/onboarding/forge-channel.mjs <config.json>`——模板实例化→
团队级插件开关→Agent 绑定(权限模型 v2)→线域授权→种子任务一条龙。
手工逐点(等价工具面):`aw_channel_template_list` 选模板 → `aw_channel_template_instantiate`
(带 bindLineId 与 controlPolicy)→ `aw_agent_tool_bind`(agentId 必须是频道成员实例 id,
可用 `aw_request` GET channels/:id/agents 取)→ `aw_task_create` 派种子任务。

场景决策矩阵(`scenario` 字段;默认模板可用 templateId 覆盖):

| scenario | 适用工况 | 频道构成 | 治理档位 | Agent 绑定 | 插件 | 种子任务要点 | KPI/守恒判据 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `optimize` | 闭环优化找工艺区间:目标带明确、允许做试验 | chtpl-generic-optimize-default(生产主管+数据分析师+知识调优+工艺工程师) | hitl_governed | 工艺工程师绑配方(manual 起步);分析师绑 daq(auto) | idd-closedloop-bridge + rag-bridge | sentinel_baseline 建档 → optimizer_campaign(带 hard 安全限与预算) → optimizer_round design/ingest 循环,外推点报 HITL 确认 → 收敛后治理下发 → kb 沉淀 | 目标指标落窗且 3 次重复稳定;试验预算不超;约束零违例 |
| `diagnose` | 纯数据分析诊断:只读,零写 | chtpl-line-doctor-default(零写只读档) | recommendation_only | 仅 daq 只读绑定,零 dcw/recipe 写绑定 | idd-closedloop-bridge + rag-bridge | daq_query 拉时窗 → sentinel_screen 初筛 → 异常则 sentinel_watch 整窗批筛 → kb 检索历史案例 → 结论入库,只出建议不动手 | 根因报告必须含数据证据与置信口径;无写权限故无工艺风险 |
| `tuning` | 工艺稳定性微调:规格边缘抖动,只许小步修正 | chtpl-generic-optimize-default | hitl_governed | **全部强制 manual**(脚本对 tuning 硬编码),step ≤量程/20 | idd-closedloop-bridge + rag-bridge | daq 基线 → kb 检索 → 单变量小步激励(settle≥60s) → 读 Δ 判向 → 劣化即回退 → 每轮 kb 沉淀;sentinel_watch 长监视越限即停 | 均值向规格中心单调收敛;方差不变大;连续两步反向即回退升级人工 |

bindings 写法:`{"agentRole":"worker:2","kind":"recipe","nodeId":"$RECIPE","mode":"manual"}`;
`$RECIPE`/`$DAQ:<名字>`/`$DCW:<名字>` 引用阶段3摘要(把摘要作为 `provision` 字段内联传入)。

### 5. 验收(未全绿不得宣告完成)

`node scripts/onboarding/verify-line.mjs <config.json>` 六组断言:
V1 数采落库(每 daq 节点 2 分钟窗内有真实样本,等价抽查 `aw_daq_samples`)→
V2 越界写必须被拒(量程联锁)→ V3 合法写回环(回读一致,单点可用 `aw_dcw_write`)→
V4 配方在册且参数映射正确 → V5 频道绑线/成员/插件生效 → V6 受保护演示线零扰动
(journal 锚点核对)。任一红即退出码 1,修复后重跑。

### 6. 治理红线与回滚

- driverConfig 只来自文档/设备 export/用户确认;缺失字段问用户,不猜。
- secretRef 零明文:凭据进环境变量 `AW_MES_<REF>_TOKEN`,不进配置文件与对话。
- 受保护资源(`ln-d7e0a2a2` 及非本次创建的 id)只读;lib.mjs 在脚本层硬拦。
- Agent 写路径权限模型 v2:不绑配方就没有写能力;首绑 manual 逐动作审批是**刻意设计**,
  除非用户明确要求否则不切 auto。
- 模拟器整包替换型预设不得在共存验收中使用。

回滚:供给失败按 配方→节点→线 逆序删除;频道删除用 `DELETE /api/workshop/channels/:id`。
量程类失败发生在写入期(四层限界),供给期以 verify 的 V2 断言为联锁证据,不做破坏性回滚。

## 验收清单

- [ ] 连通性预检全绿(每驱动一条 ✅)
- [ ] 产线/节点/配方 id 落袋并记录进交付说明(附 provision 摘要 JSON)
- [ ] 上下限与 stepLimit 显式配置(四层限界可生效)
- [ ] V1~V6 全绿(verify-line 输出 0 失败)
- [ ] 频道场景与用户需求匹配(optimize/diagnose/tuning),种子任务已派发
- [ ] 受保护演示线零扰动(journal/audit 核对)
- [ ] 交付说明含:复用/新建清单、插件开关、绑定矩阵、HITL 策略、回退路径
