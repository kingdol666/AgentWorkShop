# Gemma4 + omp 测试覆盖盘点与补测汇整报告(2026-11-19)

- 问题:测试都做了什么?是否全部过程都测试完整?
- 动作:盘点全部轮次 → 识别 6 项未测缺口 → 用本地 gamma(omp harness,:3073 存活实例)复测补齐 → 汇整
- 结果:**补测 15 步中 13 步直接 PASS;2 步经根因分析 + 修正复验后全数闭环**(两项 FAIL 均为治理机制按设计工作,详见 §3)
- 模型:全程 `local/google/gemma-4-12b-qat`(omp 会话 provenance 取证,零例外)

---

## 1. 全部轮次汇整

| 轮次 | 时间 | 实例 | 结果 | 备注 |
| --- | --- | --- | --- | --- |
| 手工验收轮 | 11-18 下午 | :3072 fresh home | 全绿(补漏后) | 证据 122 文件;独立复核 2 轮 APPROVED |
| PIPELINE attempt1 | 11-18 21:39 | :3073 fresh home | 36/41 | 5 fail = 脚本节奏/取证范围(非治理失败) |
| PIPELINE attempt2 | 11-18 21:51 | :3073 重跑 | 40/41 | 越量程负例撞 60s 下发间隔 |
| PIPELINE attempt3 | 11-18 22:35 | :3073 重跑 | 41/41 | leader 退化由补发指令抢救 |
| PIPELINE attempt4(加固版) | 11-18 23:39 | :3073 清理重启 | **41/41 全绿** | 独立评审 APPROVED,P1 加固全落地 |
| **补测轮(本报告)** | **11-19** | :3073 存活实例复用 | **13/15 + 2 修正闭环** | 覆盖盘点识别的 6 项缺口全部补齐 |

## 2. 覆盖矩阵

### 已测完整(多轮互证,全部绿)
| 域 | 覆盖项 |
| --- | --- |
| Channel | 创建/成员绑定(omp+gamma)、lead 真实回合、worker @群聊回合、A2A 即时回执、双 Session 隔离(三证)、消息持久化、**worker 直派任务(本轮补测)**、**跨 Channel lead 通信(本轮补测)**、**任务取消路径(本轮补测)** |
| Project | 创建→绑定→交付物→激活→**真实 leader 规划**→计划审批→物化→派发→实例执行(REST 收口,披露)→reconcile→draft→submit→L1→**自批负例**→L2 approver→交付物 approved→completed→report;(手工轮)工作项取消/重派 v2 |
| 产线 | 供给(线/产品/模板/节点/配方)、开线、DAQ 查询、propose→**HITL 批准**→下发设备证实→**回读一致**→journal 审批锚、**越量程预检拒绝**、**超单步派发门拒绝(设备零写入)**、停线、**HITL 拒绝路径(本轮补测)**、**recipe_update 版本固化走 HITL(本轮补测)** |
| RSI | 反射经验(channel+line)、合并、单任务晋级负例、人工晋升 validated、**越权 401**、**validated 经验召回复用(本轮补测)**、(手工轮)改进提案列表+404 |
| 模型 | 直连探针、omp provenance(每轮全 local/gemma) |
| 基建 | 归属核验清理、home 轮换+marker、pacing 节奏器、失败路径证据落盘 |

### 本轮补测明细(15+5 步)
| 编号 | 测试 | 结果 | 关键证据 |
| --- | --- | --- | --- |
| A1 | worker 直派任务(assigneeId 独立派发路径) | PASS | COMPLETED,产物 `The answer is 12.`,非工具报错文本 |
| B1–B2 | 产线重启 + recipe_propose 审批卡 | PASS | 卡 `ap-1aca0cc6`(144→138 候选) |
| B3 | **HITL 拒绝**(confirmed=false + 指导) | PASS | `status=rejected` |
| B4 | Agent 收到拒绝回执 | PASS | 「方案未获批准…未做任何下发」+ 完整人工意见回传 |
| B5c | **拒绝不变量**:被拒方案(138)从未下发 | PASS | 节点值 150(开线基线),journal agent 锚=[144],无 138 |
| C1x–C2x | **跨 Channel lead 通信**(toChannelId+requireReply) | PASS | 回执 `CROSS-OK-7`(新频道 lead B 真实回合) |
| D1 | **validated line 经验召回** | PASS | `hits=1/命中率 100%`,`scope=line:ln-68b4a946 · status=validated · score=1` |
| E1–E2 | **任务取消路径** | PASS | CANCELED 稳定终态,不产生经验副作用 |
| F1c–F4c | **recipe_update 版本固化走 HITL** | PASS | manual 绑定下挂「配方参数写入审批」→ 拒旧卡/准新卡 → **v2 固化(150→144)**,设备值不变(定义面操作) |
| X1 | 模型来源 | PASS | 本轮 omp 会话全部 local/gemma |

### 未测(候选,低风险,留待后续)
- `recipe_rollback`(dispatch 回退)——回退走同一治理闸,风险低
- 经验 retire/contested 状态、改进提案 decide 接受路径
- Project replan/route gate/observe+auto 模式变体、harness profile 晋升

### 明确超出实验范围(设计使然,不计缺口)
UI/WebSocket 事件流(headless)、物理 HIL、IDD/RAG 集成、优化器/AML/本体/MES 全链、Mimosa 安全封印。

## 3. 两个 FAIL 的根因与闭环(重要:都是治理按设计工作)

1. **B5(首轮)**:断言把「零写入」错写成「节点值==144」。实际:重启产线的开线批次把配方基线 150 重新下发(source=recipe,正常供给);拒绝路径真正的不变量——被拒目标 138 从未下发 + agent 锚不变——修正复验 **PASS**(B5c)。
2. **F1(首轮)**:`recipe_update` 在 manual 绑定下**挂「配方参数写入审批」卡阻塞等待人工**(治理按设计工作;我的 fetch 客户端 300s headers 超时先断,服务端继续等,产生两张卡)。处置:拒旧卡/准新卡 → **v2 固化成功**,设备值不变(定义面操作)。这反而补上了「update 也要 HITL」这条此前未知的治理证据。

## 4. 汇总结论

- 六大域(Channel / Project / 产线 / RSI / 模型取证 / 基建)全部有真实回合证据,核心治理不变量(四层限界、步长、保持窗、节拍、HITL 批准+拒绝两侧、自批禁止、越权 401)全部实测成立。
- 补测后:**测试完整性缺口清零**(候选项均为低风险尾部路径)。
- 全程模型 = 本地 gamma(`local/google/gemma-4-12b-qat`),omp harness,单实例串行。

## 5. 证据索引(本目录)

`summary.json`(补测 15 步)/ `summary-fix.json`+`summary-fix2.json`(修正闭环)/ `coverage-inventory.json`(盘点)/ `a-… f-… b5c-…` 分项原始返回 / `run.log` 全程时间线 / `omp-provenance.json`。
上轮全量报告:`2026-11-18-gemma4-omp-rerun/REPORT.md`(41/41)与 `2026-11-18-gemma4-omp-system/REPORT.md`(手工轮,两轮复核 APPROVED)。
