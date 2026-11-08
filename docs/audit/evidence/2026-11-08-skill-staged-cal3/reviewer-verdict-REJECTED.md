**审查方式**：只读核对 `staged.json`、`verify-line.log`、`tool-surfaces.json`、`cutover-rehearsal.json`、inputs 文档、`scripts/_audit/cal3-staged-live.mjs`，并只读查询 `.deep-home-20261108` 运行库/JSON 交叉验证；未修改任何文件。

## A. 文档→实现一致性 — ISSUES

对得上的部分：9 点位（3 SP/6 PV）、双协议（Modbus TCP 6 + OPC UA 3）、量程/单位全部一致（700~850、60~120、0~900、0~800、300~600、10~30、0~50），`stepLimit` 10/10/5 与文档 ≤10℃/≤5m/min 一致。

不一致（关键）：

1. **两次调整 ≥300s 未实现**。平台在线写闸是 60s（`server/services/workshop/dcw/dcw-controller/write.ts:145`），试验节拍默认 300s（`recipes.ts:11-15`），但本次实测约 120s：W2 两张 HITL 卡 13:11:23.8 / 13:13:33.5，W2 写入 13:13:35.0，W4 写入 13:15:53.7（距 W2 仅 138s）。`cutover-rehearsal.json` 里的 `holdIntervalMs:120000` 是保写心跳，不是调整间隔；交接声明“平台节拍同值 ≥5min”不成立，且运行环境覆盖试验节拍一事未披露。
2. **寄存器/NodeId 未按协议文档**。文档：HR 40100/40102/40104、IR 30100/30102/30104；实现：holding 40001/40003/40005，PV 仍是 holding 40007/40009/40011（`scripts/onboarding/sim-twin.mjs:232` 统一 `40001+i*2` 且 `area:'holding'`）。OPC UA 文档 NodeId 为 `ns=2;s=CAL3-QM.TensileStrength` 等，实现为 `ns=2;s=cal3-qm.tensile-pv` 等。真实割接不是换端口即可。
3. 质量仪采样：文档建议 5s，实现 2000ms（交接 Gate A 已披露，但仍是偏差）。
4. 工艺约束：二区≥一区未内建（交接已承认）；出口<650 禁提速未见实现/验证，交接复核清单也未列。

## B. 四期守约

- **W1：VERIFIED（零写），但分析质量不成立。** line-doctor profile + 观察面白名单保证零写，W1 时段 `dcw-writes.json` 无设备写。可是 W1-t4 只断言 profile 名，detail“物理零写”是硬编码；W1 报告 `conclusions_json=[]`、`metrics_json={}`、`report=""`，脚本第 160 行硬编码“强度波动与一区温度设定强相关”，并没有做相关性计算。
- **W2：VERIFIED（HITL/write_intent 机制），有保留。** W2-t0 负向控制命中 `PROJECT_WRITE_INTENT_REQUIRED`；2 个 write_intent 均 consumed；2 张 HITL 卡 `ap-9670a019`/`ap-46f875a1` 均 approved；`intervention_events` 中 `approval_id=ap-46f875a1`；778 写入并回读。保留：`emergency:true`（卡标题【应急】、detail【应急豁免频控】），走的是应急豁免频控路径；同一 admin 账号既拥有又批准；778 在约 0.3s 后被 W3 的 `line.start` 回退到 780；HITL 卡承诺的“等待工艺惯性后 daq_query 复测判读 → recipe_update”没有执行。
- **W3：ISSUES（违反零写）。** W3-t1 的 `line.start` 在 13:13:35 经 `writeRecipeParams` 实际下发 780/800/90（`audit_log` 三条 `dcw.write.recipe`；`dcw-controller/lines.ts:134`、文件头 75-76 行明确“开跑会向真实 PLC 下发全部配方参数”），把 W2 的 778 回退。数据集 391 行/4 批次真实，但 `report.json` 的 `runsDropped` 明确把 W2 试验批次 `rr-e5361e3b` 以“有效网格 0 步不足一个窗口”丢弃；数据集 `to_ms=13:13:32`，早于 W2 写入 13:13:35，所以“基于治理后批次”不成立。W3 实际执行者是基础频道 lead `acdefa34`，不是 W3 实例 lead `a646aa41`（W3-t0 已披露），分岗位要求未真正满足。
- **W4：ISSUES。** 有界（6 ≤ stepLimit 10，780→786）和无审批（`intervention_events.approval_id=null`；DB 无 W4 HITL 卡；绑定 auto）可证；但“自主”不成立：`aml_models`/`aml_jobs` 均为 0，没有模型；Channel goal 为空（`objective_json={}`，工具原文“Channel 未设置 goal”）；方向 up/step 6 是脚本第 271 行硬编码；工具自己说 12s 窗前后各不足 8 拍、响应不可辨识，`verdict=unassessed/effect=null`。W4-t2 只比较 `/hitl/pending` 前后计数（`hitlAfter <= hitlBefore`），只能证明 pending 队列没新增，不能证明“没有逐动作审批”；DB 的 `approval_id=null` 是更强补证，但不在四件套里。W4-t3 只查 `after>before && after<=850`，没查步长上限/下限。且 W4 距 W2 仅 138s，违反文档 ≥300s。

## C. 三条抽查真实性

- **W2-t4（786→778）：真实，但只是瞬时值。** `dcw-writes.json` 13:13:35.009 一区温度SP=778、`ack=readback-verified`；`intervention_events` `intv-mw7dmz35-vc4y5j` 786→778、approval `ap-46f875a1`；`dcw-runs.json` `rr-e5361e3b` results 778。该 trial run 只存活 0.307s，13:13:35.289 W3 `line.start` 即写回 780；W2-t4 的 ±3 容差（|780-778|=2）也会让回退后的 780 通过。
- **W3-t3（391 行/4 批次）：真实，但“治理后”是错误解读。** `aml_datasets` 行 `ds-mw7dpxws-73rty8`：row_count=391、4 个 run、created_at=13:15:53.465；`report.json` window train/val/test=227/114/50，与 detail 完全一致。不是编造；但 4 个 run 全是 W2 之前的，`rr-e5361e3b` 被丢弃。
- **W4-t1（780→786、Δ-8.623）：真实，但不是可辨识响应。** `optimization_explorations` 行 `opt-exploration-mw7dq7eh-hcv53t`：control_before=780/control_after=786、target_before=495.0833/target_after=486.46、write_status=ok、created_at=13:16:05.753；`audit_log` 13:15:53.745 写 786。不是编造；但 Δ 落在仿真噪声（12 MPa）内，工具原文说前后各不足 8 拍、不可辨识，`verdict=unassessed`。
- **结论：三条原始 detail 都是真实系统输出；被质疑的是围绕它们的叙述**（W1“强相关”、W3“治理后/60min”、W4“依据 W3 数据集方向/判读结论”），这些是脚本硬编码，不是工具输出。

## D. 脚本假阳性风险 — ISSUES

- `invoke()`（`cal3-staged-live.mjs:55-64`）不检查 `res.ok`/HTTP status；401/403/500/非 JSON 会得到 `isError=false, text=''`，W1-t2/W1-t3/W2-t1/W3-t3/W4-t1/closeRoot 都可能“通过”。
- `finish()`（306-312）在早退/`main().catch` 时仍写证据，`fail=0`、results 不完整；没有 `expected`/`complete` 标志；S3-2（295）是条件断言，缺 approval id 时静默不记录。72 条是唯一完整性线索。
- `W1-t4`（163）只查 profile 名；W1-t2（159）只查 `!isError`；`tool-surfaces.json` 为手写、无生成器，W2 只列 3 个写面工具，而代码直写族常量有 8 个（dcw_control/param_control/dcw_rollback/recipe_create/update/rollback/trial/apply），至少未完整枚举。
- `W3-t2`（249-252）把 `isError:true` 的“熔断/已构建过同规格”当 pass，只要文本里有 `ds-...` id；去重消息本身就带旧 id，所以 10 分钟内同规格复用会直接通过，可能复用治理前的数据集。本次是新建（未触发），但该兜底不适合作为“本次构建”的证据；应 `force:true` 或断言 dataset.createdAt/runIds 含本次治理后 run。
- `W4-t2`（285）只看 pending 计数且用 `<=`，窗口内“建卡后又批准”检测不到；`W4-t3`（287）只查上限和增长，不查 stepLimit/下限；W4 重试（269-282）5 次后仍报错，不会把硬失败写成成功，但会掩盖首次被闸拒绝的次数/节拍，`/(\d+)s/` 兜底过宽，证据里没有重试日志。
- `W2-card`（193）匹配任意 `dcw-approval`、只按 1.5s 时间窗，可能批准到陈旧卡；`W2-t4`（218）±3 容差大于 2° 的回退幅度，回退后的 780 也会通过；`cur0` 在 S0-2 就固定。
- 全局副作用：118-119 行 PATCH `dcw.rollback_stale_ms=60000`（默认 1800000），退出恢复是不 await 的 fetch；当前 `runtime-settings.json` 持久值仍是 60000（updatedAt 11:13:13）。本次运行在/留下了非默认治理设置，交接/README 未披露。
- W3-t1（232）的 `line.start` 是设备写，但断言只查 `status=200`，这是相对 B 的最大假阳性。
- 硬编码叙述：W1“强相关”（160）、W3“基于治理后批次…60min 窗”（255）、W4“依据 W3 数据集方向”都不是工具输出；W1 报告 conclusions 为空，W3 数据集不含 W2 数据。

## E. 割接论证 — ISSUES

- **包内证据不足**：`cutover-rehearsal.json` 是割接后的单点快照（9 节点、37562、治理字段），没有 before 快照、没有 PATCH 请求/字段 diff、没有 37542/4034 撞车记录；`verify-line.log` 只有 19 行结论，无时间戳/run id。两者合起来不能证明“只改 driverConfig 端点、治理零改动”。
- **运行库补证（不在四件套内）**：`audit_log` 12:55:10 有 3 条 `dcw.patch` + 3 条 `daq.node.patch`，`keys:["driverConfig"]`、fromLine=toLine，治理字段未在 patch keys 中；12:55:31 的 V2/V3 写入也在 audit 中，说明 verify 在 PATCH 后 21s 跑过。但 audit 只记 top-level key，不能证明 driverConfig 内只改了 port；`cutover-rehearsal.json` 没有 37542 的 before 值，port-only 无法证实。
- **反证/不足**：实现寄存器/OPC UA NodeId 与协议文档不一致（holding 40001 系列 vs HR/IR 40100/30100；`cal3-qm.*-pv` vs `CAL3-QM.*`），真实割接必须改 register/registerType/NodeId，不止端口；3 个 OPC UA 节点本次完全没 PATCH（只动 6 个 Modbus 节点），V1 的 3 个 OPC UA 仍在 37544 孪生端点。生产“无缝只换端点”说法过度。
- `verify-line` 19/19 对孪生线是可信的（V2/V3 有 audit 对应），但它验证的是孪生，不是真机；V6 只有一行“锚点=3 溢出=0”，无明细。

## 总体判断

72/72 全绿、项目 completed、四期 approved 的事实是真的；工具链、HITL/write_intent、数据集行数、优化记录都是真实系统输出。但验收的核心语义不成立：W3 阶段实际写设备并回退 W2；W3 数据集不含 W2 后数据；≥300s 约束未实现；W1 分析为空壳；W4 非模型化自主且 W4-t2 证明不足；割接证据不足。按“四期递进能力验收”口径不能签核。

VERDICT: REJECTED —
