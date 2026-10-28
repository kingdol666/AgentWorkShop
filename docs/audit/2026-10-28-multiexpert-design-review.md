# 多专家系统设计审查报告(2026-10-28)

- 方式:四路领域专家并行审查(数采/写控权限/Agent运行时/数据与REST),统一证据标准(file:line + 具体触发序列 + 确定逻辑错误与设计权衡分开),明确排除在档已知缺陷(F1 OPC UA 子模块、R1 dev 实例稳定、LLM 预算墙、表单高级字段缺口)。
- 复核:主会话对四席全部 P0/P1 头条发现逐条亲验(6/6 属实,字节序缺陷经手工字节推演复现)。
- 结论:**P0×2(均已亲验)、P1×11、P2×28**;四席一致确认运行时与治理骨架的"确认正确路径"大量存在(详见各席报告),系统性短板集中在**异步边界时序假设、缓存/信号失效、双后端语义等价、治理不变式的入口不对称**四个主题。

## P0(已亲验,静默错数据/配置损坏级)

| # | 发现 | 锚点 | 触发 |
|---|---|---|---|
| P0-1 | Modbus `byteOrder:'little'` 解码错误:`[hi(d1),lo(d1),hi(d0),lo(d0)].reverse()` = BADC 序,与注释 DCBA、UI 标注 CDAB 三者互不相符;float32 1.0(CDAB 设备)→ 4.6e-41,**静默错值入库并参与告警/训练集** | `daq/drivers/modbus-tcp.ts:165-174` | 任何 32 位数据类型节点选"小端"即触发;int16 不受影响 |
| P0-2 | 掩码凭据回写:视图脱敏 `password→'******'`(`daq-node.ts:276`)→ 前端参数页整包 PATCH(`useDaqDetailParams.ts:81,98,115`)→ `crud.ts:64` 无掩码过滤 merge → **真实口令被字面量覆盖**,节点永久 offline;DCW 侧 `dcw-node.ts:263` 同型 | `daq-controller/crud.ts:64` | 打开参数页保存或点"测试连接"(先 PATCH)即触发 |

修法:P0-1 `little` 改真 DCBA(或与 wordSwap 合并+修 UI 标签)+ 1.0f 四字节序单测;P0-2 后端 merge 前剔除掩码值键(单点收口,前后端同防)。

## P1(11 项,按域)

**数采(A)**
- A-P1-1 帧指标告警持续期节点态被每帧抹回 `ok`(runtime 帧分支无条件置 ok × ingest 持续分支缺失)——告警面板与节点态直接矛盾(`daq-runtime.ts:172`、`ingest.ts:151-176`)
- A-P1-2 停线补种被乱序游标吞掉:retained-only 设备换批后 `runSeeded` 已置 true 但补种值判 `late` 丢弃 → **整批零数据**(`push.ts:316-319` × `daq-runtime.ts:165`)
- A-P1-3 外部 ingest 帧载荷绕过 sink 管线(缩略图/质量门/指标派生不跑),与"完全相同链路"承诺不符(`ingest.post.ts:131-189`)

**写控/权限(B)**
- B-P1-1 系统兜底回退是陈旧决策:`captureMetrics` await 期间不复查 open/judge → 覆写最新写意图、推翻人工 `uncertain` 判定并物理写回 PLC(`sweep.ts:27-56`)
- B-P1-2 配方频控"查-做-记"三段跨 await:并发 trial/apply 双双过检,opIntervalMs/试验节拍整体被绕(`recipes.ts:221,291-304`)
- B-P1-3 **委派路径可无 confirm/无审计把绑定 manual→auto**(lead Agent 一句话摘 worker 的 HITL)——与 REST 面刻意的 confirm+留痕不变式直接矛盾(`node-delegation.ts:88,103`、`team-delegation.ts:36`)
- B-P1-4 `recipe_update` 审批后无定义快照比对:审批窗口期的并发编辑被静默并入已批版本(apply 有快照,update 双标)(`ops-tools.ts:794-846` vs `:1219`)

**运行时/Team(C)**
- C-P1-1 `stopAndDetach` 停机窗口消息黑洞:`agentIndex.delete` 在 `await stop()` 之后,窗口内 route 命中旧缓存 → **假送达+消息永久丢失**,任务树 ASSIGNED 永挂(`runtime-wiring.ts:241-261`、`mailbox.ts:60-62`)
- C-P1-2 人类调用作用域(activeInvocationScopes)无 TTL、失败路径永久卡死:回合无 platformReply(模型只调工具/报错/被停)即永存 → lead 管理面/worker 写面被陈旧 scope 封锁,自增强卡死(`chat.ts:367-369`,唯一清除点 `runtime-wiring.ts:119`)
- C-P1-3 调度停滞看门狗的"工具活性"信号对 omp(默认引擎)恒空(只有 REST/MCP 回程刷新)→ busy 5min 误notify、间隙 stall 误 COMPLETED/CANCELED(`host-tools.ts:121-122` × `tools-steer.ts:14-16`)

**数据/REST(D)**
- D-P1-1 Timescale 适配器 `queryTagged` 缺 state/ingested_at、无 `queryTaggedPage` → 生产后端坏点清洗/水位静默失效(C5 修复只落了 sqlite),训练数据质量受损(`timescale.adapter.ts:232`)
- D-P1-2 `migrateDropOwnerFks` channels 重建 DDL 落后(9 列):带 owner FK 老库升级 → **全部频道 scenario_prompt/llm_json 静默丢失**,一次性不可复现(`migrations.ts:253-269` × `open.ts:40-68`)

*交叉证实:B-P1-3 与 C-P2-7 为同一问题的两个入口(REST 有 confirm,委派/lead 工具没有)——两席独立命中;C-P1-1 与 C-P1-2 叠加(消息黑洞 → 永无回复 → scope 永不清除)。*

## P2(28 项摘要)

A×4(TSDB 断连恢复不回灌降级窗数据、时钟回拨轮询全丢样、`/:id/test` 权限口径缺口、防抖注释漂移等);B×11(配方删除零级联、dcw_judge 授权与 v2 不对称、emergency+auto 频控全豁免、60s 间隔不落盘、lineStart 先激活后下发、停线竞态续写、409 不走 reject 审计、双入口输家 502、批准即烧窗、normParams 隐式改挂、approve_rollback 周期重发);C×7(ROOT_QUEUED 后根滞留 WORKING、dispatch 不校验 enabled、steer 同轮消费 assign、grant_node_ids 无回滚、无父根无预算、HITL 顺延 all-or-nothing、lead 授 auto 无门槛);D×6(schema.sql 漂移 42 表、Timescale retention 违 C6、500k 截断取最旧段、dataQuery 并发闸竞态、audit q 通配未转义、analysis PATCH 空串清空谱系)。

## 四席"确认正确"要点(防系统性误判)

sweep 饥饿游标/在飞互斥、MQTT retained 语义与断线防线、告警幂等与去抖状态机、写咽喉联锁顺序与并发 429 收敛、HITL 双入口原子抢占与撤权清卡、审批后二次复核链、回退防回旋、信箱 at-least-once + 原子 claim、执行代次栅栏、调度器双挂防线、工具分发三路同源无绕行、三模式门一致、maker-checker 原子核销、json-store 防丢原语、REST 鉴权抽查未发现越权通道、错误响应不泄漏。

## 共性主题(修复时的结构视角)

1. **"检查点与生效点之间隔着 await,期间世界已变"**(B-P1-1/2/4、A-P1-2、C-P1-1 同族)→ 修法统一为"await 后重验状态/快照"。
2. **缓存与信号的失效路径**(C 三 P1:缓存不看生命周期、副作用无失败清理、信号只覆盖部分路径)→ 修法为"缓存命中复查状态 + finally 清理 + 单一回写点"。
3. **治理不变式的入口不对称**(REST 严、委派/工具面松:B-P1-3/C-P2-7)→ "摘闸门必经单一入口"。
4. **双后端语义等价**(D-P1-1/P2-2/P2-3)→ 补 Timescale `queryTaggedPage`+两列+retention 口径,加"双后端同输入同输出"契约测试。

## 修复优先级建议

1. **立即**:P0-1(错数据)、P0-2(凭据损坏)——均为小改;B-P1-1(物理写回正确性)。
2. **本迭代**:B-P1-2 频控并发、C-P1-1 消息黑洞、C-P1-2 scope 卡死、B-P1-3 委派 confirm、D-P1-1/P1-2。
3. **随版本**:P2 清单按域分批;契约测试锁双后端等价。

## 关联

- 既有在档:F1(OPC UA 子模块)、R1(dev 稳定)、LLM 预算墙、表单高级字段缺口——本轮未重复。
- 观察:审查期间有并行会话在实施"节点级绑定双轨授权"计划(tool-verify writeNodeRefs 已出现),专家 B 已按新代码状态复核,不与本报告冲突。
