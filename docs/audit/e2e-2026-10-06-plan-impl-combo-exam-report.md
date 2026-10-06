# 优化 Plan 落实 + 插件组合大考 —— 数据分析/KB/HITL 控制/AML 四腿全功能实测报告(2026-10-06)

> 两阶段:①上轮 plan 六项全部落实到代码(含回归断言);②以测试 skill L4/L6 + benchmark PIPELINE 为纲,在 Channel 内做组合大考——注入 heaterDecay=5.0 真实扰动,lead 完成分析→KB→五要素提案→HITL 人类批准→下发→闭环证伪→停步上报全链,AML 腿由工具桥补完真实训练+门禁。熔体 180→204.4℃ 恢复验证。

## 1. Plan 落实(六项,全部有验证)

| 项 | 改动 | 验证 |
|---|---|---|
| D6 回扫键不一致(P0) | `idd-closedloop-bridge/host/plugin.mjs` 完成分支同步收敛清单键 `idd_closedloop_runs`(此前只写 `iddcl:<id>` 单键);`helpers.mjs` 增 `kvSaveRuns/exchangeDirOf` | 新增 `tests/idd-bridge-sweep.test.ts` 2 断言全绿(completed+failed 收敛、幂等不重轮询);**线上实测:重启首轮 sweep 把积压 25 条永停 running 全部收敛(19 completed/6 failed/0 running)** |
| D1 队头饿死处决(P1) | `scheduler-loop/tick.ts:56` 过期豁免从「非队头排队根」扩展为「一切 SUBMITTED 根」——从未入场预算不启动,队头滞留根不再被 ROOT_TIMEOUT 处决(实测:lead 干到 12:36 被旧预算处决,修后不再发生) | 组合大考 reopen 后 1h 预算内完成全链 |
| D1 入场兜底(P1) | `manager/runtime-wiring.ts` 新增 `rescueStaleRoots()`(挂 idleSweeper 30s 节拍):队头开放根滞留>90s → 卸载重组 lead 运行时 + 正规 assign 消息入场(补 RUNNING 中间态) + 入场即刷新执行预算 | 线上三次自动触发,投递/预算刷新均有 DB 证据(assign 消息 consumed、deadline +15min);「消息路径入场预算刷新」另修 `agent-runtime/message.ts:52-66` |
| KB 长轮询(P1) | rag-bridge `kb_agent_status` 增 `wait_seconds`(≤120,5s 步进):窗口内完成直接返回结果,免 sleep 轮询循环 | 大考中 agent 不再需要 25s/60s/90s 手工轮询阶梯 |
| 沙箱路径免疫(P2) | `daq-export.ts` 输出拼接已配置的 `exchange_dir` 提示行(读 `settingOf('plugins.idd-closedloop-bridge.exchange_dir')`);哨兵失败提示带动态目录值 | 大考中 lead 一次到位落盘交换目录,零沙箱试错(前轮有 2 次首试被拒) |
| [object Object] 帧(P2) | `omp-agent/event-mapping.ts` 工具 end 帧结果安全序列化(对象 JSON 化,循环引用兜底) | lint/typecheck 过;AEP 帧不再出现 [object Object] |

回归:`pnpm typecheck` ✓;`tests/daq-export.test.ts` 6/6;新回归 2/2;`scripts/testing/idd-kb-smoke.mjs` 9/9(每次重启后复跑)。

## 2. 组合大考(真实扰动、四腿全链)

**工况**:向 PLC 注入 heaterDecay=5.0(上轮 2.5 的两倍)——熔体自 206℃ 真实崩落至 180℃ 平台,晶点飙至 66 个/m²(护栏 6 的 11 倍)。频道 `4903890d`(模板 859c2742 实例化,线1)。

**阶段一·分析腿 ✓**:lead 自主 `daq_export`(merge 60min 宽表 3461 行)→ 交换目录双份 CSV(自主命名 v2_stage1_*)→ `sentinel_screen` 17 条 + `sentinel_watch` 全窗批筛 SNW-20261006053525=**50 条(high 32)**→ `kb_agent` 检索 6 篇历史文档取判读基准(GOAL 205.5/联合增益 0.57~0.82℃/℃/回退线/停步线)。

**阶段二·控制腿 ✓(HITL 全程可见)**:13:22 提交 `recipe_propose`(ap-2f72fa5f)**双方案结构化审批**:方案A 稳健(双区 +2.8℃/区=单步上限,预期 +2.7~4.6℃)、方案B 积极(加开 z1,附历史增益仅 0.056 的封存依据)。**五要素齐备**:依据=30min 实测 180.02℃/破窗 −25.5℃/晶点 66;参照=KB 固化卡(v9 0.48/v6 0.74/工况C 0.73~0.82)+doc_id 引用;预期收益=按保守下沿定量;步长理由=stepLimit 2.8 顶格+节拍合规;风险回退=3min max>207 或晶点>10 → recipe_rollback 回 v9。人类 13:27 批准方案A(附裁决理由),**批次 rr-c446514a 整批下发,双区读回 208.8℃ 与提案完全一致**。

**阶段三·闭环腿 ✓(阴性结果·科学诚实)**:双窗复测(下发后 19min/25min)熔体 180.12/180.29,预期 +3.2~4.6℃ **完全落空**(实测增益<预期 1/10);lead 按自己预设的停步线判定「SP 杠杆在 decay5 下增益归零,阶梯前提被证伪」——**不提交 step2、不回退、不盲目加码**,闭环判读入库(kbt_muw9jjko,检索探针 0.7698 命中),并向人类上报三选一(根治/实验/接受)。**人类采纳根治:撤除扰动后熔体 180 → 200 → 204.4℃**(持续爬向 206),与 lead 的预判「恢复后应自主回升」一致。跨频道亮点:lead 们通过 KB 协作修订了根因判读(「功率衰减」表述修正,附证据回执 a69a6cd)。

**阶段四·AML 腿 ✓(工具桥补完,真实训练)**:lead 如实上报本频道未挂载 AML 工具(职责解耦设计)并备好底料(24h 导出+备案文档 d46d4488)。测试者经 **AML 训练频道**(chtpl-aml-training-default 实例化,优化频道被治理闸正确拒绝——「工艺优化 Channel 不承担建模与训练」)补完:场景 discover→compile(3 controls,配方参数展开)→freeze(hash 2376f67a)→物理规格 draft/validate/compile→**数据集 ds-muwa5zmj(6961 行,byRun 4 批次,逐节点清洗摘要)→uv Python 3.11.9 真实 torch 训练→ONNX 导出→门禁全评**。结果:单步 NRMSE 0.129/滚动(horizon=8) **0.087 优**/G2✓ G4✓ G5✓,**G1✗(0.129>0.1) G3✗(45.4%>20%)→ 晋升被 fail-closed 正确拒绝**(三次提交三次拒,无一是误放)。

**交付**:任务 COMPLETED,交付物含四阶段全留痕+工况判断+人工三选一上报;KB 库 8→15 篇。

## 3. benchmark PIPELINE

- `bench/run.mjs --tier static`:**85.2/100(pass 1/warn 2/fail 0)**——D1 数据采集 88.9/D2 写控治理 83.3/D3 智能体 88.9/D6 互操作 88.9/D7 审计 66.7/论文一致性 100。
- `--profile extended` 四次尝试(P0-P6 全绿后中断):**发现平台级约束**——`scripts/start.mjs` 单实例锁按配置根互顶,两个平台实例在本机无法共存(bench 自举的 :3005 会顶掉生产 :3001);bench 共享 :4010 模拟器时会重写预设。隔离机制存在(AW_HOME+SIM_BASE=:4011 影子实例)但 AW_HOME 不隔离 DB 且丢失 harness 凭据(见 §4-D8)。**extended 完整契约需专用干净环境执行,已列入 plan**。
- `--profile integrated` 于大考结束后独占环境执行:**首次完整跑完**(此前三次尝试均中断)——**pass 29 / warn 4 / fail 8 / skip 6**。通过面覆盖:治理只读面、recipe lifecycle、twin provisioning、**P9 团队调度(lead 派发→worker 完成,验证本轮调度/消息改动无回归)**、团队记忆 dedupKey 幂等、引擎注册表枚举。8 个 fail 全部定位为共享环境耦合,与 plan 代码改动无关:①P8 port-1/2/3 governed write → HTTP 409(与演示线活动批次 rr-1b22571c 的写闸状态冲突);②P3 line-1..4-io 采样计数(共享 :4010 模拟器被演示设备稀释);③P4 tool-loop-setup `agent=undefined`(tool-harness 默认 opencode 本机未安装,级联 P4m/P4b/P4c skip)。**干净环境复跑列入 plan**(配合 AW_TOOL_HARNESS=mock 或安装 opencode)。

## 4. 新缺陷与观察

- **D7(P1):lead 重试循环烧穿配额**——AML 腿期间某仍在跑的 lead 以 ~1 次/分钟连续构建 30 个同哈希数据集(14:29-14:44),烧穿 2058/2048MB 磁盘配额。缺「同 sha256 数据集短期内重复构建」的熔断;已手动清理 30 个并停 lead。建议:配额告警前置 + 同指纹数据集 10min 去重窗。
- **D8(P2):AW_HOME 隔离不完整**——AW_HOME 只隔离 prompts/config,不隔离 DB(共享 workshop.sqlite),且新配置根缺 runtime-settings.json 导致 omp harness 凭据丢失(lead 全体 inert 的根因之一,已回退仓库配置根)。bench 隔离文档应明确此边界。
- **G-1(既有,再次实锤)**:hybrid_residual 训练 `HYBRID_PHYSICS_NON_FINITE`——物理规格变量(dw 节点)与数据集控制列(dn 代理)错位;根治需数据模型支持 DCW 写历史作为控制序列。
- **切分彩票(既有)**:byRun 4 批次在 15% test 比例下仅 111 窗,G3 泛化比 45.4% 不稳定;调 test_ratio=0.3 后(776 窗)指标反而更差(transient 段更难)——瞬态工况数据的门禁通过率是真实科学问题,非机制缺陷。
- 消费惰性观察:服务器重启后 restore 的 lead 运行时偶发「state=idle 但消费循环不取消息」(消息表 pending 滞留 5-11 分钟),rescue 的卸载重组可解;根因指向 omp 会话层,留待专项。

## 5. 优化 Plan(增量)

| 级 | 项 | 动作 |
|---|---|---|
| P1 | D7 数据集构建熔断 | 同 sha256 10min 去重 + 配额 80% 告警;lead 长回合的工具调用频控 |
| P1 | D1 消费惰性专项 | restore 路径消费循环自检(启动 30s 无 dequeue 即自愈重组) |
| P2 | D8 AW_HOME 边界 | 隔离 DB 路径或文档明示「仅隔离 prompts」;bench 隔离指引补凭据迁移 |
| P2 | extended 契约常态化 | 专用干净环境(独立数据目录+凭据)跑 extended 111 项,纳入发版前检查 |
| P2 | G-1 根治 | DCW 写历史作为控制序列入数据集(数据模型改造,已两轮实锤) |
| P2 | bench 干净环境 | 独立平台+SIM_BASE=:4011 影子模拟器+AW_TOOL_HARNESS=mock;补 AW_HOME 凭据迁移指引;extended 111 项入发版前检查 |

## 6. 留痕

- 大考频道 `4903890d`(lead 972ffff8)/AML 训练频道 `95011600`(lead d0a81d83);任务 `9d991e16`→reopen `fcf6a4e0`(COMPLETED)
- 审批 `ap-2f72fa5f`(方案A,decisionId 10a055e5);批次 rr-c446514a(z2/z3→208.8)
- 导出 daqexp-20261006133118/133626;批筛 SNW-20261006053525(50 条);交换目录 v2_stage1_*
- KB:decay5 系列共 7 篇(d89ae5f5/c366b740/d46d4488/kbt_muw9jjko 等),库 8→15 篇
- AML:ds-muwa5zmj/ds-muwbu936;场景 scene-line1-extrusion@0.1.0-draft(frozen,3 controls);物理规格 draft-scene-line1-extrusion(validate ✓);训练 job-muwbm8mw(G1✗G3✗,fail-closed)/job-muwbugrg;hybrid_residual G-1 受阻 job-muwb3hm3
- 代码:plugin.mjs/helpers.mjs(idd)、rag-bridge/index.mjs、daq-export.ts、event-mapping.ts、tick.ts、runtime-wiring.ts、message.ts、tests/idd-bridge-sweep.test.ts
- 环境复位:root_timeout_ms=900000 ✓;PLC 已重放 cast-film-physics 预设(撤扰恢复中,熔体 204.4℃↗);误建频道已清理;AML 垃圾数据集 30 个已清
