# 集成验收轮 round3 汇总报告（2026-11-20 TSA3）

- 实例：AW 0.13.0，持久 home（D:/tmp/aw-liv2-1119/home 复活，:3021，pid 175240）
- 代码基线：远端 main `cf9dfab3`；PR-A（`acbe91ee`，本地分支）仅新增离线取证工具，未改运行行为；本轮报告清单由 PR-A 的 `buildBaselineManifest` 出账
- 执行模型：omp rpc / ustc-deepseek-flash（全部真实回合）；上游本轮健康（近期日志 0 次 ROOT_TIMEOUT/PROCESS_EXIT 级联）
- 证据目录：`docs/audit/evidence/2026-11-20-governed-acceptance-round/`（本目录）；运行私密态在 D:/tmp/aw-liv3-1120/（不入库）

## 一、任务与结果

| # | 任务 | 结果 | 关键证据 |
|---|---|---|---|
| S | IDD(:3210/:8764)+RAG(:8770/:6789) 服务拉起 + 桥集成 | ✅ | 铸 token→PATCH 热配；插件 12 个 failures=0；工具面 155（桥 14 + 通讯/记忆 9）；diag_results 实查 98 条真实结果 |
| L | 真实工况文档(WC-INJ-2026-1115)→skill 建节点场景→绑定→建频道 | ✅ | sim-twin :4056 `--spawn` 归属证明成立（bundle 在档，5 设备 14 信号 5 协议族）；供给 33/33、锻造 15/15、V1–V6 **24/24**（verify-final，V6 SKIP 同前轮口径）；冒烟闭环 1/1：审批 ap-22f1a6bd→下发→**独立回读 72=72**（rr-44513a98） |
| G3 | 绑线全链复跑（新线 ln-a80dfb0d / 频道 4bbf5d97） | ✅ | 巡检真实回合✓；受控写+回读（ap-2f25174c，72）；种子任务驱动的**七轮复合调参**（11:29–11:50，每轮 +2MPa/+0.5s/+3℃ 并联、全程 HITL）使克重 **31.03→32.58g 进入目标带 32.15–32.85 居中**；配方固化卡 ap-f33fda7f（五参数 v1）回读一致；C5 记忆沉淀+召回✓；C6 越量程 **400** / 跨用户 **403 LINE_FORBIDDEN** ✓ |
| G3·RSI | 反射与晋升门 | ✅(含缺口证据) | 3 条 line 候选（均为负样本：首轮巡检未完成、调参建议未完成等）；单条晋升被门拒（"任务证据未完成"）；负样本合并亦被门拒；**人审拒绝把负证据晋升 validated**。成功轮次的反思未成候选=反射面缺口（→计划 Task 3/7 的实证） |
| G4 | 产线 Project 续作（旧项目 87407519） | 🟡 | leader 真实规划 plan v2（卡 7c1846a4，11:08 提交）→owner 批准→**R1s✓ R2s✓**；结论汇总项被两级闸正确拦住：R2s 完成但零产物提交、且**补交链路被硬阻断**（重试预算门拒返工）→G4=PARTIAL，根因=完成后无产物补救通道（→计划 Task 9 实证） |
| G5 | 落地页 Project 续作（26389929，续上轮 W2） | ✅(收口链在途) | W2 达 3 次尝试上限被拒（预算门✓）；leader 取证（输入仅 CRLF 差异，哈希核对）→W3 规格（输入固化+分阶段写盘+自测）→plan v2（8facd10e）批准→**W3 新项 DISPATCHED→RUNNING**；13:42 产物冻结：landing-page.html 40054B（sha256 36b31739，双副本一致），**机器自测 PASS=62 FAIL=0 EXIT=0**；收口的只读独立复核子任务（W3-A2）已派发在途；实现频道 lead 自建 root 被平台硬拦（防伪造✓）。报告时点：正式 submit→L1 终态未落账（执行实例慢回合，D1 救援已执行并触发复核链） |
| X | Channel 间通讯 | ✅ | 新频道 lead→`send_cross_channel_message`→旧频道落信（12:14:39）→旧 lead 回执→**反向再送达新频道** + 共享记忆落账（dedup_key=xchannel-tsa3-…）；双向闭环 |
| M | 记忆管理 | ✅(含缺口证据) | save/search 召回✓；负样本按 candidate 落账✓；同时观察：成功反思缺候选、19 条 episodic-peer 以 active 落账（自动注入面，Task 3/4 实证）；kb_agent 异步任务全链完成但内部 kb-mcp 被权限拒、降级只读并如实作答（降级可见性✓） |

## 二、本轮新确诊/复核的平台缺陷（全部有盘上证据）

| ID | 级别 | 现象与根因 | 去向 |
|---|---|---|---|
| DEF-20261120-RTU-POOL-PENDING | P1 | modbus-rtu 连接池 pending 泄漏：`sample()` 在 pending>8 时静默返回 null 不告警不逐出，`isOpen` 恒真复用半开连接 → 节点永久 offline 且零日志；DAQ/DCW 共键双面受影响。死端口制造 3 次错误触发逐出后立即恢复 | `def-rtu-pool-pending.json`；修复归 PR-D3/D4 验收 |
| GOV-3 plan-card 可见性 | P2 | 全局 /approvals 只列 ops 复核，project plan_approval 卡只在项目端点可见；本轮靠 lead 回复文本才发现 11:08 已提交的卡 | 计划 Task 9（PlanProgress 统一投影） |
| 完成后产物补交通道缺失 | P1(流程) | 回合 COMPLETED 但零产物时，下游被两级闸正确拦住；但 item 无法返工补交（retry 预算门 + 无 rework 路由）→ 项目收口被永久卡 | 计划 Task 9（提交/对账语义） |

## 三、PR-A 新增功能结合本轮的出账

`acceptance-manifest.json`（由 `scripts/_audit/governed-learning-evidence.mjs` 的 `classifyEvidenceCheck/buildBaselineManifest` 生成，captureOrigin=current，revision=cf9dfab3）：

- mechanism 9 项：8 PASS + kb PARTIAL（kb 内部权限拒降级，如实记）
- resilience 3 项：retry-budget PASS；rtu-stability FAIL；plan-card-visibility FAIL
- effect 1 项：NOT_RUN（32.58g 进带是机制级闭环成果，不冒充冻结协议下的效果证明）
- field_admission 1 项：NOT_RUN（全程影子孪生，无任何物理现场主张）

## 四、四个能力问题的回答（证据口径）

1. **产线集成·数采数控**：**支持（模拟产线）**。五协议族（modbus-tcp/rtu、mqtt、opc-ua、http）真实采集落库、受控下发→HITL→独立回读全链成立（24/24+冒烟 72=72+七轮进带）；**但 rtu 连接池缺陷与修复未落地前，rtu 面不满足无人值守长跑**。真实 PLC/物理 HIL 未测（NOT_RUN）。
2. **Project 任务执行编排**：**机制支持**。真实 leader 规划→审批→物化→依赖派发→两级验收闸全部实测（两项目均走通到派发/执行）；**收口语义有缺口**（完成后产物补交无通道）→ G4 PARTIAL、G5 推进中（W3 RUNNING，收口见目录内终态文件）。
3. **Channel 内部/跨频道通讯**：**支持**。频道内 lead 分工派工+worker 回执全链✓；跨频道定向消息→落信→回执→反向送达→共享记忆落账，双向闭环✓。
4. **会话经验记忆管理**：**部分支持（治理面生效，反射面有缺口）**。分类落账（candidate/负样本保留）、晋升证据门、人审拒绝、越权 403/401（前轮+本轮口径）均生效；**成功轮次反思不成候选、episodic-peer 以 active 落账并进入召回面**=计划 Task 3/4/7 的现存缺口，有本轮实证。

## 五、运行监控与修复核验（用户点名项）

- 上轮三大坑复验：plan 物化窗口（本轮批准后物化+派发按计划发生，未再出现 15min 级异常等待）；observability.plan 不可见（**复现**，GOV-3）；omp 上游（本轮全程健康，无 ROOT_TIMEOUT 连环——夜间劣化结论保持"时段相关"）。
- 看门狗/救援：D1 rescue 两次调用（两个 office 频道）均 200 生效。
- 未知效果不重发：预算门+两级闸+root 防伪造三处全部实测拦截（GOV-1/2 及 G4 拦截）。

## 六、边界与不主张

模拟环境+影子孪生（归属证明在档）；无任何物理设备、真实 MES、外部 SLA 主张；32.58g 进带为**机制闭环演示**，不构成 Task 5 意义上的效果验证；Mimosa 本轮提交扫描不完整（scanner_enobufs），**不作为安全结论**；现场准入保持 NOT_RUN。
