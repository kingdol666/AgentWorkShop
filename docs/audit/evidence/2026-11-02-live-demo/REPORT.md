# 实机演示报告:真实交互作业 × 数采数控 × Agent 生产对话(2026-11-02)

**时间**:2026-11-02 14:43~15:50 · 平台 v0.8.8(mode=dev,`.output` 产物)· 注塑线 `ln-b715163a` + 模拟设备(4010/16052)
**演示人**:ZCode(admin)· 频道:`DEMO-产线对话-1102`(`e3c90ba1-6ed9-4eee-adca-24ca080dd3b2`)

---

## 0. 一句话结论

**"和产线对话 → Agent 取数 → 分析 → 回话"的第一轮完整闭环在真机上跑通了:用户群聊提问 → lead 拆解派工 → 数据分析师拉 576 个真实样本 → 工艺工程师独立复核并反算出"保压等效 45 bar" → lead 15:13 在群聊给出带规格窗口/偏差/告警的完整判读表;任务 COMPLETED 100。数采(modbus)实时、数控写穿+回读+60s 频控+台账全部实证。** 同时暴露三类真实问题:①本机缺两个运行依赖导致 OPC UA / MQTT 通道不可用(注塑线保压/保时/注速 3 个 DCW 点正好是 OPC UA);②第二轮追问的团队侧答案已产出,但 lead 的群聊答复在观察窗内未送达(消息 pending、lead 会话 15:43 后无活动);③omp 会话启动被 kb-mcp 超时拖慢 2~7 分钟,回合时长波动大。

---

## 1. 演示环境与频道(D1)

| 项 | 值 |
| --- | --- |
| 平台 | v0.8.8,`/api/health` ok,workshop ready,uptime 3.2e6 ms |
| 六服务 | 3300 / 3210(IDD)/ 8771+6789(RAG)/ 4010 / 4021 全部在线 |
| 产线 | `ln-b715163a` 注塑成型质量窗口寻优(14 DAQ + 14 DCW),活动批次 `rr-387b8f7c`,配方 `rc-923da07b v2` |
| 频道 | 由模板 `chtpl-generic-optimize-default` 实例化,4 成员(生产主管/数据分析师/知识调优工程师/工艺工程师),`bindLineId=ln-b715163a`,chat 已开启 |
| 授权 | 演示中给工艺工程师补绑:`dcw dw-036f0a6e(hold-pressure-sp)`、`dw-bb644e42(hold-time-sp)`、`line-recipe ln-b715163a`,全部 manual |

## 2. 第一轮对话:用户提问 → 团队作业 → 群聊答复(D2 ✅)

### 2.1 用户(群聊 @生产主管,15:10:31)

> 请把数据分析师对注塑线的取证结论汇总给我:各关键测点当前值、是否在规格窗口内、偏差多少;并说明你对下一步的判断(这一轮不要动任何参数)。

### 2.2 Agent 侧真实作业链(证据:mailbox + omp session)

1. **14:58:38 平台调度兜底**把用户需求落成任务卡"注塑线当前工况分析取证(只读,不改参数)"(lead 未及时认领时的自愈);
2. **15:02:06 lead → 数据分析师**派发结构化取数单(指定 5 个节点 id、30 分钟窗、只读约束);
3. **15:05:45 数据分析师回报**(全文见 `analyst-report.txt`):克重 n=576 均值 31.252 g、0/576 在窗、偏低 1.248 g;熔温 246.694 ℃;模温 39.985 ℃;飞边 0.0149%;缩痕 2.135% 超标;**保压无独立实测点,inj-pressure-pv(dn-6acb7171)离线**;
4. **15:29:07 工艺工程师独立复核 + 机制解释**(全文见 `process-engineer-reports.txt`):用 dcw_journal 标定斜率 0.0519 g/bar 反算 **等效保压 44.97 bar**(设定 63 bar 未被 PLC 执行),sink 2.147% 与 45 bar 基线 2.150% 交叉印证;并指出 11-01 19:24–22:53 停机 3.5 h、今日 13:49:18 起 water-temp/cool-flow/inj-pressure 三通道断流;
5. **15:13:42 lead 群聊答复**(截取核心表格):

| 关键量 | 实测 | 规格/窗口 | 判定 | 偏差 |
| --- | --- | --- | --- | --- |
| 克重 dn-660d644e | 31.252 g(n=576) | 32.5±0.35 → [32.15,32.85] | 越下限,0/576 在窗,alarm | 低 1.248 g(−3.8%),低于下限 0.898 g |
| 飞边 dn-b13051e0 | 0.0149% | ≤0.4% | 在窗 | 余量 0.385 pp |
| 熔体温度 dn-a1f4f3d7 | 246.694 ℃(σ0.38) | 235–262 ℃ | 在窗 | — |
| 模腔温度 dn-f82b3d2f | 39.985 ℃ | 设定 40 ℃ | 正常跟随 | −0.015 ℃ |
| 保压压力 | 设定 63 bar | 20–110 bar | 设定在窗 | **实际无在线测点** |
| 缩痕 dn-27ab5a36 | 2.135% | ≤1.5% | 超标,alarm | +0.635 pp |
| 尺寸偏差 dn-9a4d3f80 | 0.008 mm | ±0.05 mm | 在窗 | — |

6. **任务 45133648 COMPLETED / progress=100**,交付物为同一份判读(见 `t-final.json`)。

> 判定:**"与产线对话并按用户需求分析作业"第一轮 = PROVEN**(取数、判读、规格对照、异常告警、口径说明、只读约束全部落地,且 lead 明确声明"未做任何参数变更")。

## 3. 第二轮追问:解释与验证方案(D3 ◐)

- 15:15:56 用户群聊追问"保压实测离线时能否用塑化背压/锁模力/模温解释;63→66 bar 小步试验的前置/治理/回读顺序"。投递成功(`delivery=delivered`);
- **团队侧答案已产出**:工艺工程师 15:29/15:41 两份报告给出定量解释(等效保压 44.97 bar、斜率 0.0519 g/bar、断链窗口、处置顺序),并明确请求数控/配方授权;
- **用户侧答复未在观察窗内出现**:该群聊消息至 15:50 仍为 `pending`,lead 会话文件 15:43:29 后无新事件,队列持续显示 `生产主管:busy`。即:消息已入信箱、团队已把答案算出来,但 lead 的群聊回写没有发生。
- 该现象已立案 **F-3**(长回合结束后排队的人类群聊消息未被继续排空 / 运行态虚挂 busy),需要单独复现定位;不是"分析没做",而是"答复没送达"。

## 4. 数采/数控运行逻辑实测(D4 ✅ 部分)

### 4.1 数采(DAQ)真实、连续

`daq_query(ln-b715163a, 30min)` 返回 1999 点/节点:克重 mean 31.251 g(last 31.205)、熔温 246.701 ℃、模温 40.001 ℃,与分析师取数一致;告警面 `flash-rate 1.122%>0.8`、`sink-mark` 等真实存在。

### 4.2 数控(DCW)写穿链完整

| 步骤 | 结果 |
| --- | --- |
| 读 `dw-09428467`(桶温1,modbus-tcp) | ok,240 ℃ |
| 写 240.5 | **ok:"写入并回读一致:240.5 → raw 240.5,回读 240.5",ack=readback-verified,anchor=anc-c345bb7f** |
| 独立再读 | ok,240.5 ℃ |
| 立即回写 240 | **被频控拒绝**:`WRITE_INTERVAL_NOT_ELAPSED`(需 60s,还剩 57s)——频控治理真实生效 |
| 60s 后写回 240 | ok,回读 240,ack=readback-verified,anchor=anc-9ce7bd95 |
| 独立再读 | ok,240 ℃(复原) |
| 台账 | journal 两条 manual:prev 240→240.5、240.5→240,actor=admin,lineId 关联 |

### 4.3 阻断项:OPC UA / MQTT 通道不可用(F-1)

- `dw-036f0a6e(hold-pressure-sp)`、`dw-bb644e42(hold-time-sp)`、`dw-b7f272a4(inject-speed-sp)` 为 **OPC UA** 驱动,读/写返回:`Cannot find module '@peculiar/webcrypto'`;
- MQTT 侧(PROTO2/3 的 DAQ 推送)每 5s 报 `Cannot find module '@babel/runtime/helpers/defineProperty'`;
- 本机 `node_modules` 实测:`@peculiar/webcrypto` 缺失、`@babel/runtime` 缺失(`node-opcua` 本体在)。**根因已定位为 pnpm 悬空链接**:`node_modules/.pnpm/node-opcua-crypto@5.6.0/node_modules/@peculiar/webcrypto → ../../../@peculiar+webcrypto@1.7.1/...` 的链接目标目录不存在;`pnpm install --frozen-lockfile` 判"Already up to date"而不修复。→ 与本轮代码改动无关;modbus 链路因此成为本次唯一可实证的数控通道。修复建议:`pnpm install --force --frozen-lockfile --prefer-offline`(需停机窗口,当前未执行以免打断演示实例)。
- 影响:注塑线的"保压/保时/注速"三个写点正好是 OPC UA,**工艺工程师提出的"hold-time 6.2→6.0 归位 + recipe_apply 重下发"方案在当前环境无法执行**,需先修依赖。

## 5. 发现汇总

| # | 发现 | 证据 | 定级 |
| --- | --- | --- | --- |
| F-1 | 运行依赖缺失 → OPC UA 全断、MQTT 推送全断(仅 modbus 可用) | `/dcw/:id/read` 报错原文;平台日志 5s 重试 | **P1(环境)** |
| F-2 | omp 会话启动被 `kb-mcp` MCP 连接超时拖慢(30s×5 重试,单会话 2~7 分钟) | `~/.omp/agent/mcp.json` 使用 `${RAG_PROJECT_ROOT}`;omp 日志 MCP timeout | P2(性能) |
| F-3 | 长回合结束后,排队的人类群聊消息未被继续排空;lead 显示 busy 但会话无活动 | 15:15:56 消息 pending 至 15:50;lead jsonl mtime 15:43 冻结 | **P1(待复现)** |
| F-4 | 回合时长波动大(3~30+ 分钟),长任务取证会拖长用户等待 | 时间线;omp 进程 CPU 长时间空闲等待模型 | P2(运维) |
| F-5 | 平台调度兜底可用(lead 未认领时自动建卡),任务终态与交付物正常 | 14:58:38 调度兜底;45133648 COMPLETED 100 | 正向 |

## 6. 判定

- **真实交互作业:PROVEN(第一轮全链)**——用户自然语言 → lead 编排 → 分析师取数 → 工艺工程师复核 → 群聊答复,所有数字可回查节点 id 与时间窗;
- **与产线对话:PROVEN**——回答直接引用时序库实测值与规格窗口,不是模板话术;且主动暴露"保压实测点离线"这一真实盲区;
- **数采:PROVEN(modbus)**;MQTT/OPC UA 受 F-1 阻断;
- **数控:PROVEN(modbus 写穿+回读+频控+台账)**;OPC UA 受 F-1 阻断;
- **稳定性:需修 F-1/F-3 后再做无人值守评估**;受控试点结论不变(GO),但"完整运行"必须先把依赖树补齐。

*证据目录:`docs/audit/evidence/2026-11-02-live-demo/`(chat-final.json、chat-transcript.txt、analyst-report.txt、process-engineer-reports.txt、wr1/wr2/rd1/rd2、dcw-read1/2、jour.json、daq-final.json、t-final.json、demo-ch-create.json)。*
