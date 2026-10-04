# 运行门禁与数据链路深度实测报告 —— 僵尸批次 BUG 修复 + 全场景验证

- **日期**:2026-10-04 · **平台**:v0.7.55(生产构建 :3001)· **驱动**:omp 真实 harness(GLM-5.3-flash)
- **结论**:✅ 按需求规则全面实证——**产线未运行 = 禁下发但可采数;运行中 = 可下发**。过程中发现并修复一个**高危真实系统 BUG(运行门僵尸批次放行)**;数据链路(CSV 导出→脚本分析)、日志/配方历史可追溯、goal 驱动闭环(三步梯度达标 + recipe 保存 v4)全部实证。
- **配套曲线**:[`assets/opt-curve-2026-10-03-pressure.svg`](./assets/opt-curve-2026-10-03-pressure.svg)

---

## 1. 发现并修复的真实系统 BUG:运行门僵尸批次放行(高危)

**现象(实测)**:线1 停止后,`recipe_propose` 仍创建审批卡并挂起等待、REST `apply` 照样在停止的产线上创建新批次——**「产线未运行禁下发」整条规则失效**。

**根因**:runs 表泄漏 `endedAt=null` 的僵尸行(多次 apply/崩溃/重启遗留,同线最多 8 行),而 `activeRunOfRecipe` 只查 DB「存在未结束行」即放行。

**修复(提交 a5726ec)**:
1. `recipe-gate.activeRunOfRecipe` 反僵尸交叉校验:run 所属产线必须在 line-run 权威注册表(内存+落盘,崩溃可恢复)中运行,且活跃批次=本批次,否则视为僵尸行拒绝;
2. `lineStop` 结清本产线全部未结束批次行;`lineStart` 开跑即取代历史行——**自愈**。

**实测**:线1 停止后 propose 快速失败(运行门文案);一轮 stop/start 后僵尸行从 8 → 1(合法活跃行)。

## 2. 运行门禁矩阵(修复后复测)

| 场景 | 操作 | 结果 |
|------|------|------|
| 线1 停止 | recipe_propose | ✅ 快速失败:「按运行门约束下发被拒」 |
| 线1 停止 | recipe_trial | ✅ 拒绝(审批随停线收敛,fail-closed) |
| 线1 停止 | daq_query 读历史 | ✅ **可采数**(停线只停打标,数据保留可查) |
| 线1 停止 | mes_fetch | ✅ 可采数 |
| 线2 运行 | recipe_propose→审批→下发 | ✅ 全链通 |

## 3. 数据获取深度(CSV 导出 → 脚本分析闭环)

- `daq_export`(3 节点 × 2h 窗):manifest.json(节点映射/语义/批次上下文/报警统计)+ 逐节点 CSV(ts_iso,ts_ms,value,state)
- **脚本直读 CSV 实测**:45 行,mean 199.542 / stddev 0.364 / 前5点→末5点趋势 199.38→199.52——完整时序数据成功导出并被外部脚本消费分析
- 统计数据进上下文:daq_query 返回均值/极差/stddev/最近序列,Agent 直接引用为 proposal 依据(审计可见)
- 注:仿真时序库按批次分区,跨批次窗口查询建议走 daq_export(全量无降采样)

## 4. Agent 可见性(log / 优化历史)

- **ops_log**:Agent 读到产线运维日志(开跑/停止,来源/操作者/时刻)——「可读产线 4 条」按权限过滤
- **recipe_versions**:v1→v4 全链可见(每版变更参数/来源/操作者/理由)
- **line_context**:产线全景(运行状态/活动批次/当前配方)

## 5. GOAL 达成闭环(线2 泵压,真实梯度)

| 轮 | ScrewSpeedSP | 审批单 | 泵压 3min 均值 | 增益 |
|----|--------------|--------|---------------|------|
| 基线 | 125 | — | 15.14 MPa | — |
| R1 | 130 | ap-bf8067ee | 15.66 | +0.52 |
| R2 | 136 | ap-e9aa26cf | 16.37 | +0.71 |
| R3 | 139 | ap-81a75bd3 | **16.73** | +0.36 |

**GOAL ≥16.6 达成** ✅(终判窗 14:32~14:35 均值 16.73)。斜率模型 0.11~0.12 MPa/rpm 三次复测证实。**配方保存 v4**(ScrewSpeedSP=139,reason 引用达标证据)。全程 dcw.write.recipe/recipe.apply/approval.approve 审计逐笔留痕(见 §5 追溯链)。

## 6. 追溯链实测(本日审计节选,14:02~14:36)

```
14:02:47 user approval.approve → system dcw.write.recipe(130rpm) → agent recipe.apply
14:26:10 agent recipe.propose → user approval.approve → system dcw.write.recipe(136rpm) → agent recipe.apply
14:31:54 agent recipe.propose → user approval.approve → system dcw.write.recipe(139rpm) → agent recipe.apply
14:36:30 agent recipe.update.agent(保存 v4)
```

## 7. 已知事项

1. Timescale 在线模式(容器)下样本实时入库正常(本次 308 行/30min 实测);SQLite 降级模式跨批次窗口查询有分区限制——生产配置 DAQ_TSDB_URL 走 Timescale 即无此限制
2. 群聊 agent 会话内 ask 工具未挂载(仅任务会话挂载)——worker 已诚实降级为群聊文本提问
