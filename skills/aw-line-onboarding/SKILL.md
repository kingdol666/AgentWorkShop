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

## 对产线负责的两条铁律(高于一切步骤)

1. **不确定必问,禁止猜测**:凡是缺字段/两可的决策,停下来问用户 —— 必问清单:
   ①点位的量程/单位/单步上限缺失(直接影响四层限界与工艺安全);
   ②SP(可写)/PV(只读)判定不明(写错方向=对真实设备误动作);
   ③MES 认证方式与凭据归属(bearer/header/none;token 放哪个 secretRef);
   ④场景目标不清晰(找区间?诊断?微调?达标判据是什么);
   ⑤配方下发治理档位(首绑一律 manual;用户明确要求才切 auto)。
2. **测试自动裁决,投用用户裁决**:接入验收/冒烟期由助手自动创建并裁决 HITL(测试语义);
   **投入使用必须由产线负责人在界面上 judge & taste 后放行** —— skill/脚本只到"可投用",
   不得代用户宣告投产,交接时必须输出绑定矩阵/HITL 策略/安全限复核清单。

## 一键接入(onboard.mjs,首选执行方式)

```bash
node scripts/onboarding/onboard.mjs <统一配置.json> [--skip-connectivity] [--smoke]
```

一条命令跑完全阶段:连通性预检 → 产线供给(mes-rest 映射自动字符串化)→ 频道锻造
(含 **mesFetchGrants 自动授权配方**:history-only mes 节点的可见面 = 授权配方参数;
场景 scene/promptVariables 透传)→ V1-V6 验收 →(`--smoke`)冒烟闭环步**自动 HITL 裁决** →
交接声明(落袋 id + 投用复核清单)。统一配置 schema 见脚本头注;
分阶段手工执行(下述阶段 1-5)仍是等价路径,适合定位问题。

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
- 配方级下发间隔频控:recipe 可配 `opIntervalMs`(缺省 60s;0=禁用),Agent 下发族
  (trial/apply/propose/rollback-dispatch)两次**已批准**下发间隔不得小于该值,计时锚=审批时刻
  (未批准不计时);窗内被拒时可用 `emergency=true` 豁免频控(审批照挂且卡片标注【应急】)。
- 模拟器整包替换型预设不得在共存验收中使用。

回滚:供给失败按 配方→节点→线 逆序删除;频道删除用 `DELETE /api/workshop/channels/:id`。
量程类失败发生在写入期(四层限界),供给期以 verify 的 V2 断言为联锁证据,不做破坏性回滚。

MES 区间取数契约(多字段+时间段+间隔 API 的 historyMap 接入,2026-10-07 实测定稿):

- 时间段/游标平台注入,不必配进 query:`from`/`to`(ISO)/`pageSize`/`cursor` 由 mes_fetch 按
  historyMap 自动携带;`query.fields=<本节点字段>` 按节点声明,`valuePath` 写行内路径
  (如 `values.melt_pressure`)。
- **分页 API 必须配 `response.nextCursorPath`**,漏配=驱动按"无游标=取完"只取第一页
  (实测:3h 窗 5000+ 行只回 500)。
- 调用期参数(如 `interval` 聚合秒)用 `requestHook` 注入:Agent 传 `param.interval`,
  hook 返回 `{query:{interval:String(param.interval)}}`;内联与异步数据集两模式同样生效。
- 大窗取数纪律:窗口≤7 天、max_rows≤5000;>2000 行走异步 CSV 数据集(`mes_dataset_read`
  读统计/分页),行级原文永不进对话。

MES 接入实战契约坑(2026-10-10 退火线投用轮实证):

- **historyMap/readMap/writeMap 必须是 JSON 字符串**(存 driverConfig 时 JSON.stringify):
  传对象会让驱动按 "[object Object]" 解析失败(取数失败:historyMap 不是合法 JSON)。
- **history-only(仅 historyMap)mes 节点的可见面授权**:kind='dcw' 绑定已废弃(BINDING_KIND_DEPRECATED),
  正道 = 建一个**授权配方**(把 mes 节点列为 params,不下发该配方)并绑定给取数 Agent ——
  mes_fetch 可见面 = dcw 存量绑定 ∪ 绑定配方参数节点。
- **节点视图的 secretRef 是打码值("******")**:按视图回写 driverConfig 会把真实 secretRef
  覆盖成掩码(401);PATCH 时必须显式给真值,或不要动 secretRef 字段。
- secretRef→env 链:env 键 = AW_MES_<REF大写折叠>_TOKEN(如 MES_ANNEAL → AW_MES_MES_ANNEAL_TOKEN),
  由 start.mjs 预载 .env 注入;仓库模式直启时 env 必须显式传给子进程。
- mes-test-read 只覆盖 readMap(现值)面 —— historyMap-only 节点的连通验收走一次真实 mes_fetch。
- mes_fetch 参数是 **from/to(ISO 字符串)**,不是 from_ms/to_ms;缺省无窗 → 落当前值快照(需 readMap)。
- 写控/配方参数里的节点引用一律用**节点 id**(Agent 工具按 id 解析;传名字会报「节点已删除」误导错)。

MES 双模式接入(2026-10-07 实测定稿;同一 MES API 按用户意愿二选一或并用):

- **镜像入库模式**(数据进平台时序库,Agent 从库读,与 PLC 同管线):建**数采节点**
  (`POST /api/workshop/daq`,driver=`http`),`driverConfig.url`=MES"最新一组数据"端点
  (API 每次只回最新值/最新帧),`headersJSON` 放 token,标量加 `jsonPath`;形态由模板
  决定——标量(缺省)/向量(模板 `signalKind:'vector'`,jsonPath 指点列数组)/图像
  (模板 `signalKind:'image'`,端点回 image/* 字节或 JSON{png:base64})。轮询节拍
  `intervalMs` 与 PLC 采集同源,样本/帧自动带活动批次打标(run/recipe/line)。
  自定义模板用 `POST /api/workshop/daq/templates`(注意:unit 必填;注册表会忽略传入
  key 生成 `ct-*`,须用**返回的 key** 拼 `daq-<key>` 作 templateRef)。
- **参数直取模式**(不镜像,Agent 传时间段直接调 API):建 **dcw 节点**
  (`POST /api/workshop/dc`,driver=`mes-rest`)+ `historyMap`(from/to/cursor 平台注入,
  分页 API 必配 `nextCursorPath`),标量/向量/图像(`format:'image'`,dataPath 指 base64
  字段)全格式;`mes_fetch(ids,[from,to],max_rows)` 取数——标量/向量大窗落 CSV 数据集,
  图像帧自动落盘 `<数据根>/mes-artifacts/<节点id>/`,像素永不进对话。
- 模式判据(替用户选型):要"定时持续积累+批次打标+告警/导出/IDD 诊断"→ 镜像;
  要"按需回看历史区间、API 只支持查询"→ 直取。两者可同 API 并用(镜像入库存最新流,
  直取节点查历史窗)。前端区分:数采管理页节点(driver 徽标+形态徽标 标量/向量/图像)
  = 镜像;数字孪生写控页 mes-rest 点位 = 直取。
- 在线控制:控制面走 mes-rest `writeMap`(POST 设定值),Agent 侧 recipe 绑定+HITL 审批
  下发,与 PLC 控制同治理(四层限界/步长/频控全适用)。

孪生/AML 链契约坑(2026-10-07 注塑大考定稿,四连坑+两缺陷):

- **场景三元组必须完整**:`twin_scene_compile` 漏传 `product_id` → 快照 BINDING_PRODUCT_MISMATCH;
  `physics_profile_id` 必须是注册 provider(如 injection-greybox-v1,查 twin_provider_catalog)→
  自造 declarative-* 会 TWIN_PROVIDER_UNAVAILABLE。
- **帧节点(向量/图像)不得进入场景状态**:auto_daq 快照只采标量样本 → AUTO_DAQ_SAMPLE_MISSING;
  编谱场景前先把帧节点从编谱 Agent 的绑定里摘除。
- **snapshot phase 必须取自场景 phases 表**(如 exploration),传 steady 会被拒。
- **hybrid 频道场景谱系**:实例化模板时传 `scene`(冻结契约)才会把 profile.sceneId 指向真实场景;
  缺省落到模板通用场景(line-injection-01)→ BINDING_LINE_MISMATCH。
- **mark-good 固化的是批次起点快照**,试验中改的值不会进良好版;收敛值要 PATCH 新版本固化。
- **供给数控节点必须带 `driver` 字段**,缺省落 mock 驱动——mock 写入"成功"且 journal 照常留痕
  但设备零触达;交付前务必做「配方|设备|镜像回读」三方对照。
- **换设备/换线前先清遗留保写心跳**:旧数控节点(holdIntervalMs>0)会周期性把旧设定重写回同一
  设备,覆盖新配方(PATCH holdIntervalMs=null 缴械)。
- **场景控制量↔数据集控制量桥**:AML 数据集 control 角色只能取数采节点(SP 回读镜像),而场景
  spec 控制变量绑定 dcw——amlkit 按 nodeId 建别名会全 MISSING→物理 NaN。现修法:spec 控制变量
  nodeId 重映射到镜像数采节点+方程引用同步重写;根治待平台自动桥接。
- **stage-A 标定小样本会退化**(calibrationError 反升):物理系数用 min=max 锁定,只放开 τ 给
  一维网格;门禁 G1/G2 不过会 fail-closed 拒绝升格,VirtualTrial UQ 缺失→OOD 拒签,属安全设计。

## 验收清单

- [ ] 连通性预检全绿(每驱动一条 ✅)
- [ ] 产线/节点/配方 id 落袋并记录进交付说明(附 provision 摘要 JSON)
- [ ] 上下限与 stepLimit 显式配置(四层限界可生效)
- [ ] V1~V6 全绿(verify-line 输出 0 失败)
- [ ] 频道场景与用户需求匹配(optimize/diagnose/tuning),种子任务已派发
- [ ] 受保护演示线零扰动(journal/audit 核对)
- [ ] 交付说明含:复用/新建清单、插件开关、绑定矩阵、HITL 策略、回退路径
