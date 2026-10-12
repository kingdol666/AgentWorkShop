# 审计:生产环境完整优化场景 + 前后端真人操作 + 论文一致性核对(2026-10-13)

- 实例:`http://127.0.0.1:3001`,v0.7.59 **全新生产构建**(合并远端 7 提交后 `rm -rf .output .nuxt` 重建),repo 模式
- 场景:PLC 模拟器 4031(cast-film-physics,专用影子树)→ 建线 `ln-7228f0b1`(3 SV DCW + 3 PV DAQ + 3 SP 镜像 DAQ)→ 基线配方 `rc-ada346a1`(v2 授权面)→ 优化频道 `231a7acd`(generic-optimize 模板 + KB 开 + 绑线 + 授权/委托)
- 脚本:`tmp-e2e/prod-opt-ui-20261013{,b,c,d,e}.mjs`(全程未改任何系统代码)
- 产物:`.AgentWorkShop/analysis/prod-opt-20261013/`(6 张 UI 截图 + state.json + msgs.json)

## 1. git 合并

远端 main 领先 7 提交(论文终稿 6eb8ca6 / 91 检查归档 84d4c36 / typecheck 修复 c06dcdb / 57 脚本清理 ed3c800 等),本地领先 2(MCP 双修 + 审计补录)。**变基合并零冲突,线性历史推送**(99c5ee6..ab60615)。

## 2. R1 优化闭环:前端 UI 真人批准 → 写穿 → 分级证实(★核心实证)

审计台账逐帧(01:43:39–01:43:44):

```
recipe.propose
  → approval.approve {comment:"产线验收:批准该有界微调(模口 1.00→1.04),观察膜厚响应",
                      via:"agent-tools/decide"}   ← 意见为 puppeteer 在 UI 意见框逐字键入
  → dcw.write.recipe {eng:1.04, prevValue:1, ok:true,
                      message:"POST 成功(HTTP 200),接口回读 1.04(标定后物理值 1.04)"}
  → recipe.dispatch.ack {verified:1, unverified:0, failed:0, total:1}   ← 分级=readback-verified
  → recipe.apply {runId:"rr-93495205"}
```

UI 截图三连(`ui-r1-card-before/selected/after.png`):审批卡结构化字段(方案/调整 1→1.04mm/预检通过/Agent 依据/经验引用)+ 意见框 + 批准后卡片消失、节点表 dieGapSP 当前设定 1.04mm@01:43:44。镜像通道(DAQ 只读面独立读)同步证实 1.04。

## 3. R2 恢复闭环:批准后下发 + 三级分级活体呈现(02:43:58)

`recipe_apply`(v1 整包)在飞并行批准后下发 3 参数,审计逐帧:

| 参数 | 传输 | 结果 | 分级 |
|---|---|---|---|
| 加热区1SP 200 | Modbus 写+回读 | 回读 200 一致 | readback-verified |
| dieGapSP **1.04→1.0** | HTTP POST | **接口回读 1**(设备恢复基线) | verified |
| lineSpeedSP 95 | MQTT 发布(QoS1 受理,设备侧待验证) | 无读通道 | **unverified** |

一条产线、三种传输、三级鉴定同帧呈现——论文 §III-C 的分级规则在生产实例上原样复现。回执如实报"未全绿(证实 2/3)"。

## 4. 治理门行为实录(fail-closed 全对)

- **调用方断开 → 不下发**:b 脚本顺序 await 使 400s 超时掐断在飞调用,其后到达的批准落在僵尸卡上,**平台未执行任何下发**(审计无 apply 行为)。符合"监督进程断连=停止派发"语义。
- **回退锚点缺失 → 拒绝**:`to_last_good` 无 lastGood 批次 → "无可回退的良好批次";`version:1` 但当前已是 v1 → "回退目标是更早的版本"(试验级下发不写版本,故设备恢复用 `recipe_apply` 而非 rollback)。
- **HTTP 429 限流**:脚本+人工高频轮询触发限流器(安全加固生效)。
- **LLM 供应商 3h 预算耗尽**:02:43 起 `OMP_LLM_429 ExceededBudget Spend=$30.1211/Limit=$30.00`,lead 引擎"执行中"但回合全部被 429 拒——P7 9 分钟无回复的根因(引擎进程/编成/派发均正常,运行时监控截图 5 个活跃 harness 进程在册)。

## 5. 环境与产品发现

| 级别 | 发现 |
|---|---|
| P1 | **外部进程杀手两次硬杀 3001**(01:49、02:30,计划任务自动拉起,符合"监督宕机=停派发"安全设计)。**第二次重启后 DAQ 入库管道 ~12s 内停摆**:produced 25125 / stored 330 / dropped 47589,全实例历史样本查询返回空(含 Timescale 真库模式);镜像通道读 1.04 系 02:30:28 前的陈旧值,设备侧实际已恢复 1.0(接口回读)。需专项修复(入库管道对重启的弹性 + dropped 计数告警)。 |
| P2 | 镜像通道陈旧读数会误导"设备证实"判断——建议节点 freshness 超龄显式标注。 |
| P3 | 产线页写入成功 toast 显示"写入 undefined → undefined"(前端取值缺陷,不影响治理链)。 |
| P3 | 膜厚 PV 在模拟器 warmup 相位恒定 56.00175μm,warmup 后恢复波动(2min 37 唯一值)——R2a 物理响应窗口落在 warmup 内,Δ=0 为窗口伪影。 |
| 环境 | 限流器、429 预算、进程杀手均为外部/既有安全与配额机制按设计触发。 |

## 6. 论文一致性核对(终稿 6eb8ca6,10 页)

**结论:一致。** 论文标题 *Grading Machine-Originated Plant Writes*(写治理专刊论文),三层验证全部通过:

1. **机制层(代码逐一比对)**:四级准入区间 H∩B∩P∩R(`param-limits` 四层限界)、三级写确认(readback-verified/transport-acknowledged/unverified,本轮 R1/R2 实测复现)、产线主开关 fail-safe manual + MODE_CONFIRM_REQUIRED 服务端强制、HITL hold 模式(不自动拒/周期催办)、backstop(监控窗累计越限→系统兜底回退,RECHECK_MS=30s)、dcw_judge keep/rollback/uncertain、S7 stub(`daq/drivers/s7-stub.ts`)、驱动族 5+MES REST 与 §III 清点一致。
2. **常量层**:官方静态审计 `bench/results/20261012145644-ng0`(99c5ee6)**s2 论文-代码常量一致性 100%**(85.2 总分,pass 1/warn 2/fail 0)。
3. **工件层**:引用归档全部在库——`bench/results/20260921184204-10lc`(Q1-Q4 快照)、`-e1lite`(消融)、`docs/benchmarks/benchmark-20261008045434`(Q5,91 检查 ✓,channels 112 ✓)、benchmark-20261009* 三连跑 ✓。

论文自身声明的边界与项目实况相符:仿真层级证据(不主张物理产线)、内部 oracle(author-implemented/adjudicated 已具名为效度威胁)、line-scoped approver 授权缺失(§VI 已列)、无优化收益主张(与 AML 门禁如实拒小样本一致)。**论文范围窄于项目实况**(写治理专刊;MES v2 完整面/AML 混合孪生/IDD-RAG 插件/权限 v2 recipe 面等未入文,属范围选择而非不一致)。两条 DA CRITICAL 已在终稿修复关闭(review/final-acceptance-2026-10-12/DECISION.md + 6eb8ca6 P0 十项闸门全闭)。

## 7. 生产可落地判断

- **治理面可落地**:准入/HITL/分级/审计/回退拒绝/断连 fail-safe 全部在生产构建实测按设计工作,且经得起"真人 UI 操作 + API 操作"双路径与外部硬杀扰动。
- **落地前置清单**(与论文 §VI-D 一致 + 本轮新增):① 修复 DAQ 入库管道重启弹性(本轮 P1);② 时钟同步(NTP,本机慢 17.4s 待校);③ line-scoped approver 角色上线前补齐(论文已披露);④ 供应商预算/限流容量规划;⑤ 进程守护验证(本机计划任务已证实可自动拉起)。
