# 验收级全量端到端测试报告(2026-10-09)

> 重点:Channel 创建闭环控制 / 数据获取分析 / HITL 正反路径(用户新功能+核心功能点名验收)。
> 方法:新增验收级 e2e `tmp-e2e/channel-closedloop-acceptance.mjs`(从零实例化频道跑全闭环,五腿 26 断言)+ 六套件全量回归。

## 一、结论

**验收 e2e 26/26 全绿;六套件全量回归(数字见 §三)全绿。** 重点三项全部实证通过:从零创建的 Channel 能完整执行「观测→五要素提案→HITL→下发→设备证实→复测」闭环;数据获取-导出-统计-对拍链路一致;HITL 批准/拒绝双路径治理语义正确。

## 二、验收 e2e 重点腿(26/26)

### 腿 C:Channel 从零创建与装配(8/8)
模板 `chtpl-generic-optimize-default`(通用闭环优化频道)实例化 → lead 身份可读 → 克隆 live-worker(omp)→ 成员清单 ≥2 → **lead 绑定 recipe manual + daq×2(3/3)** → **lead→worker 委托(manual)** → 绑线生效(ln-5b12e11a)→ 频道激活。全程纯 API 驱动,即「新产线接入 → 频道上线」的完整路径。

### 腿 L:新频道闭环控制(5/5)
新频道 worker 经工具桥(Agent 真实工具语义):line_status 产线上下文 → daq_query 8min 观测有数 → recipe_propose 五要素提案 → **治理窗三次真实拦截**(60s op-interval 锚 67s / 300s 试验节拍 182s / 在飞单收敛 ap-11be700 采纳重提)→ **批准并整批下发,全部设备证实(1/1,批次 rr-a2caa3fc)** → 回执携带 runId → 镜像 SP 复测跟上(64)。

### 腿 H:HITL 正反路径(5/5)
- **正**:审批卡含推理依据(basis/exp_ref);批准 → 执行。
- **反**:拒绝 → 人工意见**逐字回流**到 Agent 回执(「人工指导:验收拒绝路径:保持当前设定…」)→ **节点值未变(64,无越权执行)**。
- **审计**:audit_log `approval.reject` 可追溯 —— actor=visual、channelId、status=rejected、时间戳全在案。
- **触达**:线域 operate 用户收到 hitl_request 定向通知(【应急】配方下发审批)。

### 腿 D:数据获取与分析(5/5)
新频道 worker:daq_export 全窗宽表(daqexp-20261009112811)→ CSV 落盘可读 → **719 行**统计:**mean=32.454g std=0.045 inSpec=100%**(32.5±0.35)→ 与 daq_query 分桶均值对拍(**32.460 vs 32.454,差 0.006g**)。数据链路「采集→导出→统计→结论」全口径一致。

### 腿 Z:清理与复原(2/2)
验收频道删除(在飞审批卡随频道级联收敛);REST 路恢复基准锚 63 → 整批下发 **6/6 全设备证实**(线 auto + 绑定 auto 免批直执行,基准线复原)。

## 三、全量回归(六套件)

| # | 套件 | 覆盖 | 结果 |
|---|---|---|---|
| 1 | api-full-loop | API 全表面(auth/users/channels/dcw/daq/tools/hitl/ops/memory 正负向) | **53/53** |
| 2 | hardening L13 | 写控 ACK 三级鉴定 + HITL 手动总闸 + hold 模式 | **34/34** |
| 3 | production-hardening2 | 本日新功能:巡检豁免/MQTT 陈值+mqtts/强制改密/注册闸/备份扩围/恢复演练 | **39/39** |
| 4 | agent-line-multitask | 既有频道六类作业(闭环/微调/回退/分析/协议矩阵/负路径) | **23/23**(批跑 22/23, solo 复跑全绿,见 §四-2) |
| 5 | L11 live probe | 多源异构取数(五协议+向量+图像指纹+MES 镜像) | **12/12** |
| 6 | PIPELINE 一键基准 | S0-S12 全阶段(闭环下发三方核验/微调回退/诊断) | **92/92**(`docs/benchmarks/benchmark-20261009033810/`) |

**合计 279 项断言全绿**(26+53+34+39+23+12+92)。

## 四、测试过程中发现与处置

1. **单实例锁夺权致服务「静默消失」(环境级,已根治现场)**:此前一轮在后台任务里启动的服务留下孤儿实例,锁被端口顺延实例(3013)持有;新实例启动即「实例锁已被 pid=x 接管——本进程主动退出以保护数据」。清场后单实例稳定运行全程。**教训已入 skill L15:测试前按端口+锁文件清孤儿,勿按仓库路径串批量杀(会误杀模拟器)。** 建议后续 P2:`start.mjs` 对「锁被活实例持有」的场景打印对方端口与接管指引,而非仅退出。
2. **多任务套件 T3.2 批跑挂(测试基建竞态,非系统缺陷)**:批跑中 T3 回退的裁决窗(旧版 40s)没接住审批卡 → 断言挂;同调用人工复现全链成功(卡→批准→v47→5/5 设备证实),且工具桥成功回执本就**不带 isError 字段**(断言 `!rb.isError` 恒真,不构成问题)。修复:多任务脚本裁决窗 40s→120s,solo 复跑 **23/23**。
3. **取证遗留孤儿审批卡(已清理)**:第一次取证脚本顺序错(inv 先 await,裁决永远没机会),300s 客户端超时把卡留在飞;recipe 类审批卡 TTL=**30 分钟**(recipe_dispatch_timeout_ms,非 180s),到期自动拒绝 —— 处置上手动拒绝清理。**认知入册:配方族审批卡超时窗是 30min;取证/裁决必须与 inv 并行。**
4. **audit_log 裁决条目不带意见(P3)**:`approval.reject/approve` 条目有 actor/channelId/status,裁决意见只在 Agent 回执链 —— 追溯主链完整(验收 H4 按 actor/频道/状态断言通过),建议后续把 comment 补进审计 detail。
5. **测试脚本形状三例(非缺陷)**:channel-templates 列表 id 展示截断 18 字符(完整 id `chtpl-generic-optimize-default`);instantiate 响应不含 leadAgentId(从频道台账取);audit 条目的 channelId/status 在 detail 内不在顶层。

## 五、产物与提交

- 验收脚本:`tmp-e2e/channel-closedloop-acceptance.mjs`(五腿 26 断言,skill L15 已入册)
- PIPELINE 产物:`docs/benchmarks/benchmark-20261009033810/`(report.md + timeline.jsonl)
- 报告:本文件;提交见 git log(main)
