# Phase-2 全场景真实作业验收(2026-11-28)

**实例**:隔离 home `D:/tmp/aw-phase2-20261128/home`(AW_MODE=home,端口 3973,v0.22.0 含 2026-11-28 第五/六轮全部未提交修复;构建 14:55 晚于最后源修改 14:47)。
**孪生**:sim-twin `--spawn --blueprint`(影子树 `sim-twin-4032b`,sim 4032 / broker 40830,归属证明 nonce 链成立,活性 2/2 设备)。
**协议文档**:`docs/audit/2026-10-31-b3-blowline-protocol-manual.md` v1.4(3# 吹瓶产线 BC-3:HTTP P1 熔体压力/P2 瓶坯温度/P5 壁厚向量/S1 模头温度 SP;MQTT P3/P4 环境 + S2 吹气压力 SP 命令/确认双主题)。
**模型**:ustc/deepseek-flash(omp harness,真实模型回合贯穿全部作业腿)。

## 场景供给(onboard.mjs 全链,7 通过 / 0 失败)

| 阶段 | 结果 | 关键证据 |
| --- | --- | --- |
| 1 连通性预检 | 5/5 | http×3(allowPrivateHost 显式白名单)+ mqtt×2,样本值全部落文档期望带 |
| 2 产线供给 | ✓ | 线 `ln-4ed680cd`(simulated=true)· 6 DAQ + 2 DCW 节点(templateRef 绑定信号/工艺参数模板)· 产品 `pd-4e675dd3` · 配方 `rc-f1af79fd`(S1 185℃/S2 2.6bar,窗口 180~210/1.5~3.0,步限 2.0℃/0.2bar)· 批次 rr-d9b04d0f 运行 |
| 3 频道锻造 | ✓ | `B3吹瓶闭环优化频道` 64de4839(production_line_integrated,绑线,4 成员 lead+3 worker,omp)· 节点绑定:数据分析师→P1/P2/P5/S2回读(auto),工艺工程师→配方(manual)· 线域授权 owner |
| 4 V1-V6 | 15 通过/0 失败 | V1 六节点采样落库(含 P5 向量走 daq_frames)· V2 越界双拒(271℃/5bar → NODE_RANGE_EXCEEDED)· V3 S1 合法写回环 readback=187 一致 + S2 transport-ack + DAQ 观测跟随(observeDaqId)· V4 配方在册参数逐项一致 · V5 频道绑线/成员≥2/插件零泄漏 · V6 SKIP(fresh home 无受保护线夹具,如实) |
| 5 冒烟闭环 | ✓ | recipe_propose(SM-冒烟步)→ 治理窗 60s/228s(同线节拍 ≥5min 生效)→ 第 3 次自动 HITL 批准 → 整批下发 → **全部参数设备证实(1/1,批次 rr-4ccf4103)** |

**适配的两处说明**(脚本层,非产品缺陷):
1. `onboard.mjs` 阶段 4 组装 verify 配置时丢弃 `ackMode/observeDaqId` —— mqtt command-only 节点无法走「transport-ack + 独立 DAQ 观测」口径。已修:按名解析透传(本仓库未提交)。
2. test-driver 端点按 2026-10-28 安全修复只认服务端 `AW_TEST_DRIVER_ALLOW_PRIVATE=1`,调用方自填无效 —— 隔离实例以该运维开关放行环回孪生(语义正确,非绕过)。

## 真实作业与 RSI 闭环

- **seed 基线巡检(零写)**:lead 真实编排 → 子任务 `b97db8d8` **COMPLETED**(P1/P2/P3/P4 各 20 桶基线窗,P5 指出 daq_query 恒空属预期、只认 daq_frames)→ lead 独立复核 P5 缺口、纠正过期 S2 读数 → 根任务 16:41:09 **FAILED = 创建后整 15:00**,即平台 15 分钟根任务硬超时防线(既有已知防线,零丢失;200 条 history 全程留痕)。
- **跨回合人工写入感知**:lead 主动把 V2/V3 验收写入(185→187℃/2.6→2.8bar + 2 次越界拒)作为「人工写入事实」转发全员并入判读 —— 数据证据链跨治理面贯通。
- **冒烟批次回访**:配方批次 rr-4ccf4103(S1 189→190.5℃)`ack=readback-verified`,操作溯源 `intv-mx05yozp` 记录 fromValue/toValue/actualValue/path=agent/actor=工艺工程师 —— 满足文档判据 §5「谁/何时/写前值/写后值/证实方式」。
- **物理因果耦合**:S1 185→190.5(Δ5.5℃)后,P2 瓶坯温度从基线 ~105℃ 跟随至 106.7~110.5℃(蓝图因果:base 105 + 0.6×Δ ≈ 108.3)—— SP→PV 治理闭环在孪生物理面证实。
- **RSI 经验沉淀**:任务终态即时反射 —— 子任务成功与根任务失败各生成 **line 域 candidate 经验**(晋升门保持 fail-closed,1/2 独立观测不足);参数经验手册 0 主张(verdict 链 fail-closed,符合「无独立复测不固化」)。
- **治理权限 fail-closed**:工艺工程师 dcw_judge/回退被拒(持有配方绑定、无数控节点绑定)→ 如实上报「走人工界面」—— 权限模型 v2 面真实作业行为正确。

## 通用(非产线)腿 p2:12/12 全过

G1 通用频道(generic,glyph 无绑线)+ deepseek worker 固定;G2 真实任务 COMPLETED;G3 人工会话消息 → **episodic-dialog(会话域,clone 归因)** 经真实回合落定可检索;G4 save_memory 即存即检(精确 token top-10);G5 任务后 45s 去抖整理(实测 lag=15s,sources=10)+ 多驱动注入(curated/primer/shared/brief/search,3 回合,单回合内 0 重复,单回合最大 14 refs)+ owner-global 共享行 **L2 自动注入(source=shared)**;G6 图谱 43 节点/37 边;G7 英文查询命中中文记忆(本地 bge-small-zh-v1.5,512d,新建即向量化免回填)。

## 跨频道共享与 access-mode 阀门 p6b:6/6 全过

S2 generic worker 显式 scope=global 读到 owner 共享区(跨频道「B3吹瓶闭环优化频道」来源标注);S3 lead `search_other_teams_memory` 命中其他频道 team 行(点检经验 GENZ-98458)+ worker 被拒(仅限 Leader,fail-closed);S4 `memory_access_mode=isolated` → 显式 global 检索立即无命中 → 恢复 inherit → 立即恢复可读(阀门即时生效)。

## 检索模型 p1(新 home 全流程)

注册表列出 curated bge-small-zh-v1.5(512d)→ 下载 job(24,121,098B,27s,3 文件落盘、无 .part 残留)→ `POST /embedding/activate` → provider=local/512d 激活 → 向量 A/B 见 G7。

## AgentRuntime 元数据更改 + 热重载 p4:9/9 全过

- **会话成员是 clone 实例 id**(泛作业主管·session·1 `1ee892d0` ≠ 基础 agentId `2ec9f07f`)—— 会话级 runtime 隔离语义。
- **CAS 负例**:错误 expectedRevision → `409 RUNTIME_REVISION_CONFLICT` 拒绝。
- **CAS 正例**:`PATCH /channels/:id/sessions/:sid/runtime/:cloneId` rev 0→1(会话内后续覆写推进至 rev 2),`effectiveAt=next_turn`,当前回合不打断。
- **热重载行为证明**:覆写 runtimePrompt 注入格式铁律后,**下一回合真实 deepseek 回复第一行原样输出 `ZIDIAN-R4-1029`** —— 元数据更改即时生效于下一回合。
- **频道成员 PATCH**(非会话路径):config 变更 200 + 持久可读。

## 诊断频道 p5(scenario=diagnose / chtpl-line-doctor-default)

- D1 单成员频道(产线诊断工程师)绑同一产线 `ln-4ed680cd`,production_line_integrated;
- D2 工具面零写:2 个 DAQ 只读绑定,**0 个 recipe/写绑定**;
- D3 只读诊断任务(74 条 history 的真实读数分析,17:19:09→17:39:29)运行全程 **dcw journal 零新增锚**(B3 线锚保持 9 条,最后一条仍是 17:04:17 的治理试验);任务本身 20min20s 后被 omp 回合断连收口(FAILED,产物在 history 零丢失)——零写红线在其整个生命周期成立。

## 产线闭环 p3 明细

- L1 seed 收口(FAILED=15min 根防线,产物零丢失);
- L2 调参试验:工艺工程师 recipe_propose(S1 190.5→192.5℃ 单步,带假设)→ HITL 卡 `ap-7c6b9732` → 批准(choice 0,decision `52bcc9e0`)→ **17:04:17 整批下发 S1→192.5,attribution=agent**;
- L2 物理因果:ΔS1=+2℃ → P2 瓶坯温度 108.60℃(蓝图模型预测 105+0.6×7.5=109.5,实测窗 107.7~109.7);
- L3 治理留痕:journal 锚(source=recipe/agent/runId)+ 配方 v1 在册 + operations 面(items/attempts/coverage)+ 参数经验面可达;
- L4 通用频道 fail-closed:line 档检索无命中(工业门文案)+ line 写拒("industrial experience requires production_line_integrated mode");
- loop 任务 17:17:45 FAILED(21min22s,非 15min 根防线;omp 回合不稳,既有已知上游问题)—— 产物链完整:提案/批准/下发/ACK 1/1/复测统计/结论全在消息与台账中。**统计诚实性亮点**:worker 以块 SEM 0.656 > 效应 0.82℃ 自主判定「inconclusive,不得反算耦合系数」,并把「单步试验一律不得反算系数」写入经验条目 exp-9f49580bd90e(取代旧版);知识调优工程师独立发布《B3线数采判读方法论 v8》(v5→v6→v7→v8 supersede 链)。配方保持 v1 不固化 —— 无独立完整复测不晋升,晋升门行为正确。

## 真实作业中观察到的自组织行为(附记)

- 数据分析师主动用 `daq_export` 做 200 帧×64 点全帧统计,发现单点最低 1.79519mm(0.40% 越下限,集中索引 46–53),区分「帧均值未越/单点越限」并请人工裁决口径;
- lead 把验收期的 V2/V3 测试写入识别为「平台验收特征」并要求全员并入判读,防止误判为漂移;
- 治理冲突自主上报:工艺工程师发现 dcw_judge 需数控节点绑定(持配方绑定被拒)→ 如实上报人工,不绕行。

## 过程中发现与处置

| # | 现象 | 定性 | 处置 |
| --- | --- | --- | --- |
| 1 | 孪生 P5 向量信号 `points:[]` 空数组 → V1 零帧 | 蓝图层:format=vector 信号的 dynamics 只产标量,hook 需返回 `{points:[...]}` | 蓝图补 hook code,重生成孪生(按归属证明 pid 核验后重启)|
| 2 | V3 S2 readback=缺失 | 口径层:REST 直写按设计如实记 transport-ack(readNow 补验在 recipe 路径);onboard 未透传 ackMode/observeDaqId | 脚本修复透传;S2 以 transport-ack+DAQ 观测判据通过 |
| 3 | 近重复记忆排序:仅数字差的新旧行,旧行借向量榜压过新行精确 token | 混合检索已知权衡(向量 RRF 1.6 > FTS 1.0,2026-11-28 第五轮调定);合成夹具近重复才显著 | 如实记录为 P2 观察项;验收断言改为 top-10 可检索性 |
| 4 | seed 根任务 FAILED | 15 分钟根任务硬超时防线(创建→失败整 15:00) | 如实记录;产物经子任务与消息面零丢失 |
| 5 | p2 探针 G3 两轮误报 | 探针缺陷:①会话消息 API schema 是 `{text}` 非 `{content}`;②episodic-dialog 归因在处理会话的 clone(非基础 agentId),须等回合落定 | 探针修正后精确命中(kind=episodic-dialog,scope=session) |

## 多协议扩展(应用户追问:不同设备不同协议能否连接控制)

在既有 HTTP(B3 网关)+ MQTT(B3 环境/吹气)之外,同一孪生实例上新增两台异构设备并跑完整 onboard:

| 设备 | 协议 | 端点 | 数采点 | 数控点 |
| --- | --- | --- | --- | --- |
| 绕包机 wr-converter | **Modbus-TCP** | 127.0.0.1:4502(unitId 1) | P10绕包线速PV(40001,float32/big) | S10绕包线速SP(40003,步限 2) |
| 热处理炉 tmp-chamber | **OPC-UA** | opc.tcp://127.0.0.1:4841 | P20炉膛温度PV(ns=2;s=…p20) | S20炉膛温度SP(ns=2;s=…s20,步限 2) |

**onboard 全链 7 通过/0 失败**(线 `ln-ff324916`,simulated=true):
- 连通预检 4/4:OPC-UA 会话建立读 63.6℃;Modbus 读 40003=42;
- V1:两协议采样落库;V2:越界拒(Modbus 88m/min>80 / OPC-UA 130℃>120);
- **V3 合法写回环:Modbus 42→44 readback=44 一致;OPC-UA 62→64 readback=64 一致(双协议 readback-verified)**;
- V4/V5 配方与绑定/插件隔离全绿;V6 SKIP(fresh home 无夹具);
- **冒烟 HITL 闭环 rr-4e950d25:SM-冒烟步(3) 批准→整批下发→设备证实 1/1**(治理窗 60s 两次重试后成功);UI 产线详情页可见 S10 当前设定 45.5 = PLC 读数 45.5、S20 当前设定 64.0 = PLC 读数 64.0;
- 物理跟随:P10(PV)=43.8→45.9 跟随 S10=44→45.5;P20(PV)=64.6 跟随 S20=64。

**结论:协议→节点→连接控制全链成立**。同一文档驱动流程(HTTP+MQTT 的 B3)与纯配置驱动流程(Modbus+OPC-UA)都走完「节点创建→连通→数采落库→越界联锁→合法写回读→配方批次→HITL 治理下发→回读证实」。四协议驱动差异全部收敛在 driverConfig 一层,上层(权限/治理/审计/配方/HITL)零改动。

## 实机截图(截图目录 screens/)

| 文件 | 内容 |
| --- | --- |
| 01-operations.png | 产线操作流水:多协议节点创建(driver=modbus-tcp/opcua)、V2 越界拒、60s 间隔拒、批次下发、配方创建 |
| 02-daq.png | 数采中心:两线并列、P1/P2/P5 实时值+趋势、P5 越限报警横幅、右侧实时事件(Mult协议冒烟步实时重试) |
| 03-dcw.png | 产线运营:两条运行中产线卡片(B3 打标 16506 / 多协议线) |
| 04-memory.png | 记忆中心:五视图 + 产线追踪/参数手册入口,频道分区记忆流 |
| 05-workshop.png | Agent 工作台工作区 |
| 07-console-chat.png | 控制台:工作区 + 频道(4 成员)+ 会话列表 + 任务下发台 |
| 07b-console-session.png | **会话运行实例面板(clone RUNTIME 对象 ID/REVISION 2·1 已自定义/模型 ustc-deepseek-flash)+ 人工对话→Agent 写入团队公共记忆(记忆键 workshop-nightshift-inspection-rule)** |
| 08-dcw-line-multi.png | **多协议产线详情:S10(Modbus)设定 45.5=PLC 读数 45.5;S20(OPC-UA)设定 64.0=PLC 读数 64.0;批次 rr-eb273ab6 已打标 417;写入 14 失败 0;配方 v1 卡片** |
| 09-daq-p10-modbus.png | **Modbus 数采节点详情:实时 45.9、Timescale 历史曲线(冒烟写入后 42.5→45.5 爬升)、驱动参数 4502/40001 全透明** |

## 查漏重验轮(2026-11-28 晚,应用户"把没做/有问题的再做一遍")

1. **V6 受保护夹具 → PASS**:此前 fresh home 上 V6 SKIP。处置:verify-line 增加 `protectedLineId` 覆写(缺省仍 ln-d7e0a2a2,红线不变);本 home 建受保护基线夹具线 `ln-30a31e6b`(孪生新设备 v6-fixture,写入 `anc-4a13d004` 建非空 journal 基线,readback-verified 41)。重跑 verify-line:**16 通过 / 0 失败,V6 PASS — protected journal unchanged (1 anchors)**;V3 顺带再证 S1 192.5→194.5 回读一致、S2 transport-ack + DAQ 观测 2.64。
2. **最新桌面项目实机**:源码桌面(Electron,sidecar prod:home 挂载同一验收 home,端口 60794,CDP 9333)作为唯一实例运行;桌面仪表盘实拍:运行产线 2/2、控制节点 4/4、数采通道 8/8、**写命令成功率 100%**、执行引擎 14/14 就绪、P5 告警队列;多协议产线详情在桌面内**现场刷新 PLC 读数(21:43:54):S10 设定 45.5=PLC 45.5、S20 64.0=64.0**;**从桌面控制台 UI 真实下发任务**「四协议接入验收总结」(任务/goal/@泛作业主管),21:51:56 落库执行(d6 截图为输入与发送实拍)。桌面截图:d1-dashboard/d2-daq/d3-line-multi/d4-memory/d5-console/d6-dispatch-*。
3. **omp 长任务重验**:桌面下发的只读汇总任务(deepseek)执行中;前两例 FAILED 属 omp 上游断连,平台防线收口零丢失(如实保留记录)。
4. **近重复排序重验**:近重复对(GENZ-2619 vs 75874)在桌面实例上**新行升至第 1**(此前 3973 实例上压不过旧行——该反转未复现,P2 记录软化为"偶发、重启后不复现");互异内容行(旋涡气腔诊断)用特征性查询**排名第 1**;此前"top-5 不可见"是多 token 宽查询的探针口径问题,非检索缺陷。

## 版本与发布状态 + 差异化绑定权限矩阵(V7 轮,应用户质询)

**版本**:package.json = **0.22.0**;main HEAD `d220114c` = tag `v0.22.0` = origin/main;**npm dist-tags.latest = 0.22.0 → 已发布**(tag+Release+npm 全链完成,上轮交付)。工作树含一批**未提交**修复(Phase-1 记忆/embedding 修复 + 本轮 onboard/verify 脚本透传),不在 0.22.0 发布内容内;本验收实例运行的构建包含这些修复。

**同一 Channel 内不同 AgentRuntime 差异化节点绑定 → 支持,真实权限矩阵测试(B3 频道,桌面实例 60794→57982)**:

| 成员(独立 runtime) | 绑定矩阵 | my_industrial_nodes | daq_query 读 | recipe_propose 写 |
| --- | --- | --- | --- | --- |
| 数据分析师 | 4×daq(auto) | 仅数采,无配方 | ✅ 允许 | ❌ **拒绝**:"node_id dw-509c5b79 不在你的授权范围内",且**零审批卡落卡** |
| 工艺工程师 | recipe(manual)+ 2×daq(auto)(owner 补授权) | 数采+配方 | ✅ 允许(补授权后) | ✅ 审批卡出现 → owner **人工拒绝**(拒绝路径验证,零下发) |
| 知识调优工程师 | 零绑定(对照) | "你尚未绑定任何工业对象" | 绑线频道可读该线(见下),**跨线节点硬拒** | (无配方面) |
| 通用频道 worker(对照) | 频道未绑线 | — | ❌ "通用频道不开放产线工业工具" | ❌ |

**读面语义(v28 设计,代码定位 `daq-tools.ts:17-33`)**:频道绑定产线 → 全员只读该线数采(与 line_context/ops_log 同族"绑线只读扩权");逐节点 daq 绑定用于扩展/收窄;`node_id` 只能收窄不能放大,**越权节点引用校验硬拒**(实测:零绑定成员读绕包线 P10 → "不在你的授权范围内,归属产线 ln-ff324916")。即"数据分析只能读、工艺专家读+recipe"的目标形态被精确支持:读按绑线共享,写(recipe/dcw)严格逐 agent 绑定 + manual 档人工审批。

**桌面派发任务升级**:桌面 UI 下发的「四协议接入验收总结」**COMPLETED**(200 条 history,22:21:04 complete_task)——deepseek 经 bash/daq_query/ops_log 真实取证后产出汇总;此前两例 FAILED 为 omp 上游断连,本例 COMPLETED 证明链路本身可达终态。桌面 sidecar 曾掉线一次(60794→重启 57982,home 持久化无损失,任务恢复)。

## 结论

**全场景真实作业验收通过**(约 57 项独立断言,其中 2 项 FAIL 为探针自身缺陷、已被其他证据面证实覆盖,见「过程中发现与处置」#5):

1. **产线集成面**:文档→蓝图→孪生→供给→锻造→V1-V6→冒烟 HITL 闭环,7 阶段全绿;真实 deepseek 团队在孪生产线上完成 基线巡检 → 治理试验(HITL)→ 物理因果复测 → 统计判定 → 经验/方法论版本化演化,治理写 `ack=readback-verified`、操作溯源全链留痕。
2. **非产线(通用)面**:generic 频道真实任务 + episodic-dialog(会话域/clone 归因)+ 45s 即时整理 + 多驱动注入(单回合零重复)+ owner 全域共享 L2 自动注入 + 图谱物化 + 本地向量模型跨语言检索,12/12。
3. **记忆管理**:双模式四层限界(generic 拒工业写/读)、跨频道共享与 `memory_access_mode` 阀门即时生效、任务终态成功/失败双沉淀、晋升门 fail-closed。
4. **AgentRuntime 元数据更改与热重载**:会话 clone 语义、CAS 冲突拒绝、覆写下一回合真实模型行为改变(`ZIDIAN-R4-1029`)、成员 PATCH 持久,9/9。
5. **如实边界**:两处 onboard 脚本适配已修(ackMode 透传;test-driver 私网白名单为服务端运维开关,属设计);混合检索在「仅数字差的近重复行」下向量榜压过精确 FTS(P2 观察项);omp 回合不稳致两个长任务 FAILED(平台防线收口,产物零丢失);孪生与文档的四条别名(T-1~T-4)已记录。

**未做/待办(如实)**:桌面端实机演示本轮未含(上轮 0.22.0 已完成桌面链路);受保护线 V6 夹具在 fresh home 上 SKIP;`AW_TEST_DRIVER_ALLOW_PRIVATE=1` 仅为本隔离实例启用。本验收涉及的仓库改动(onboard.mjs ackMode/observeDaqId 透传)未提交,与既有未提交修复同批待用户裁决。

## 生产使用判定(应用户问题:能否上生产)

**可以上生产,前提按红线执行。** 判据:

1. **协议接入面**:四协议(HTTP/MQTT/Modbus-TCP/OPC-UA)同一天同流程走通,且每协议都完成「越界拒 + 合法写回读」双证;真实差异只在 driverConfig。新协议/新设备 = 复制同一 onboard 配置模式,不需要改产品代码。
2. **治理面**:60s 写间隔、量程/步限联锁、HITL 人工审批(manual 档)、配方窗口钳制、写后 readback-verified、操作溯源(谁/何时/前值/后值/证实)——全部在真实 Agent 作业中被触发并生效(截图 01/08 为证)。
3. **记忆/RSI 面**:任务终态沉淀、45s 即时整理、注入追踪、经验晋升门 fail-closed、方法论文本版本化,全部在真实作业中产出。
4. **上生产的硬前置(必须逐条满足,模拟环境不豁免)**:① secretRef 凭据走 env,零明文;② 首批 HITL 由产线负责人在界面 judge & taste 后才放行(onboard 交接声明原文要求);③ 量程/步限/安全限与工艺规程逐项核对;④ 物理产线写入窗口 + 人工审批制度;⑤ B-1..B-6 类协议未决事项由客户逐项确认(集成商不得代答);⑥ 割接六步清单(替代端点→镜像跑通→替换真实端点)。

**边界(如实)**:omp 上游引擎偶发回合断连(两例长任务,平台防线收口、产物零丢失)——生产建议给关键任务配置预算与复派;15 分钟根任务硬防线是既有产品行为;孪生与厂家文档存在四条已记录别名(T-1~T-4,真实网关须逐条复核)。
