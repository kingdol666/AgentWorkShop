# 全量加固(P0–P2)与三模式 Qwen3.5 真机验收(2026-10-28 最终轮)

> 计划:`docs/plans/2026-10-28-security-hardening-plan.md`(S1–S16 已全部实施)
> 主证据:`docs/audit/evidence/2026-10-28-p2-qwen35-3mode/report.json`
> 安全证据:`docs/audit/evidence/2026-10-28-security-hardening/report.json`(29/29)
> 本轮结论:**代码计划全部落地;单测 702/702、产线治理 44/44、本体离线 57/57、安全 29/29;三模式(观察/手动/自动)在 omp 18.12.2 + Qwen3.5-9B 下全部 COMPLETED。**
> 诚实边界:DAQ/DCW 仍是内置 mock 设备(无物理 PLC/无工艺响应耦合);真实设备试点前仍需按第六节清单做现场验证。

---

## 一、计划落地(S1–S16)

| 项 | 实施内容 |
|---|---|
| S1 | 新增 `harness-spawn-policy.ts`:Channel/Agent/成员/模板的 command/args/cwd/env 仅 admin;命令须与引擎同族;spawn 剥离平台口令类 env |
| S2 | DCW/DAQ 节点 PATCH 分权:驱动、落点、标定、量程、步限、保持窗、lineId 仅 admin |
| S3 | 新增 `agent-dto.ts`:名册不回显 token;config 仅属主/admin |
| S4 | 新增 `line-scope.ts`:配方/账本/参数台账/优化记录/MES 产物/节点读值/报警/删配方/关批次按产线授权 |
| S5 | test-driver/reconnect 要求 admin/editor;`allowPrivateHost` 只认服务端开关;reconnect 单飞 |
| S6 | 保写心跳过四层限界;量程/标定/驱动/产线变更清 value;删线清 value;未分配产线默认不保写 |
| S7 | trial overrides 执行前复检配方窗;优化器 D13 增加运行门/活动配方/产品一致性 |
| S8 | 回退记录不得再作回退目标;sweep 跳过回退记录;markGood 校验配方/产线归属 |
| S9 | HITL 待批按本 Channel 成员过滤;顺延上限 3 次后恢复 ROOT_TIMEOUT |
| S10 | 新增 DAQ 启动屏障 `__daqInfraReady`;workshop 等装配完成再 resumeAll;后端 init 失败显式 degraded + 停采;降级时 `startAll` 拒绝 |
| S11 | 未知驱动不再降级 mock:保留原 kind + `lastError` 落盘,采样由 unavailable driver 显式拒绝 |
| S12 | ingest 增加未来时间戳判定(默认 60s skew);未来帧 400,且不推进 `lastIngestAt` |
| S13 | MQTT topic 的 nodeId 必须等于 payload.nodeId,不一致丢弃并计数;compose 默认只绑 127.0.0.1 |
| S14 | 告警 raise/recover 载荷补 lineId;WS peer 记录用户身份,授权变更后就地刷新可见集 |
| S15 | Modbus `engToRaw` 越界抛错;`encodeWords` 校验 int16/uint16/int32/uint32 范围;配置期校验 raw 量程;写失败文案改为"PLC 可能已变更" |
| S16 | 新增 `01-instance-guard.ts`:同一配置根数据锁,第二实例 exit 1;进程退出/信号释放 |

额外修复(真机测试中发现):`lineStart` 现在会清理"注册表指向已关闭批次"的过期窗口,不再让整条线永久卡在"已在运行"。

---

## 二、验收矩阵

| 套件 | 结果 | 说明 |
|---|---|---|
| `typecheck` | PASS | P2 改动后通过 |
| `lint`(变更面) | 0 error | — |
| `build` | PASS | 本地 .output 构建 |
| `test:unit` | **702/702 PASS** | 含新增 `tests/hardening-p2.test.ts` 6 条(S10/S11/S12/S15) |
| `test:e2e-line` | **44/44 PASS** | 隔离实例;开停线 HITL/TOCTOU/换线清理/Agent token/DAQ 实采/DCW 写回读/单步/60s/量程 |
| 本体离线 `e2e-ontology.mjs` | **57/57 PASS** | 全生命周期/守卫/diff/退役,无需实例 |
| 安全验收 `scripts/security-acceptance.mjs` | **29/29 PASS** | P0/P1 + S12 未来时间戳/回填 + S15 配置期拒绝 |
| `test:mcp` | 14/14 PASS | MCP 契约 |
| `test:plugin-lifecycle` | 22/22 PASS | — |
| `test:sdk-surface` / `test:twin-provider` / `test:skills` | PASS | skills 124/124 |
| `i18n:check` / `readme:lint` | PASS | — |
| `docs:check` | 77 pass / **14 fail(存量)** | 文档版本仍 0.8.4 而 package 0.8.5(11 处)+ 2 处表格竖线;与本次改动无关 |
| S16 第二实例 | PASS | 同 `AW_HOME` 启动 → `[instance-guard] 数据目录已被进程…` + exit 1 |
| S13 MQTT 注入 | PASS | 向 `aw/daq/FAKE-NODE/sample` 推 payload(nodeId=真实节点,value=999)→ 未入库,查询 max 仍 107.04 |

> 注:首次全量单测出现过 `optimizer-worker-pool` 一次超时失败,单独重跑 4/4 通过;判为并行资源竞争(本地 LLM + 实例 + Python worker),非代码回归。

---

## 三、三模式真机结果(omp 18.12.2 + Qwen3.5-9B)

| 模式 | 任务 | 链路 | 结果 |
|---|---|---|---|
| 观察(exp-miner) | `59835395` | `line_context` → `daq_query` → `complete_task` | **COMPLETED**。21 个 15s 桶,温度恒 107.04C,21/21 超 50~70C 窗,节点 alarm;只读无写 |
| 手动(HITL) | `ba39e61c` | `daq_query` → `recipe_trial(58→56)` → HITL `ap-4d841a05` 批准 → 批次 `rr-70cbc` | **COMPLETED**。**ACK 1/1 设备证实**;配方版本仍 v1(trial 不写版本) |
| 自动(免批) | `71a749dd` | `daq_query` → `recipe_trial(60→58)` → 批次 `rr-01a61` | **COMPLETED**。**ACK 1/1 设备证实**;无 HITL |

账本(A,倒序):`58→56`(本轮手动)、`60→58`、`58→60`、`60→58`、`null→60`。  
账本(B,倒序):`60→58`(本轮自动)、`62→60`、`60→62`、`null→60`。  
最终 HITL 待办:0。

> 说明:手动 HITL 卡面显示「60→56」,而设备实际是从 58→56(卡面 `from` 取的是配方保存基线,不是节点实时值)。目标值与窗口校验正确,但审批人看到的"从值"与实际不符 —— 已记录为待修项(优先于生产试点)。

证据:
- `evidence/2026-10-28-p2-qwen35-3mode/report.json`
- `.../obs-task.json`、`manual-task.json`、`auto-task.json`
- `.../security-report.json`(29/29)
- `.../idd-check.json`

---

## 四、真机测试中发现并修复的问题

1. **运行门误拒(已修)**:多次 `recipe_trial` 会为同一配方留下多个 `endedAt=null` 批次;重启/关闭某批次后,注册表仍指向已关闭批次,导致 `recipe_trial` 报"配方未在执行",而 `daq_query` 显示批次在跑。修复:`lineStart` 发现注册表指向已结束/不存在批次时清理过期窗口后继续开跑;运行门仍以"注册表活动批次 + 该批次未结束"双向校验。
2. **弱模型的工具面干扰(已用策略规避)**:Qwen3.5-9B 偶发尝试 omp 原生 `get_task`/`write`;Channel `selected` 工具面 + 明确任务指令后稳定走平台工具。
3. **任务失败不落终态(未修)**:harness 回合失败后任务会停在 `SUBMITTED`,需人工 cancel。生产无人值守前应把"回合失败且无产出"收敛为 FAILED。
4. **mock 设备无物理耦合(环境限制)**:设定变化不会改变 DAQ 值,"调整→工艺响应→复测"物理闭环未验证;需换 PLC 模拟器 first-order SP→PV 场景。
5. **HITL 卡「从值」取自配方基线而非现场实时值(待修)**:本轮卡面显示 60→56,设备实际 58→56。目标/窗口/ACK 均正确,但审批人看到的前值不真实;生产试点前应改为读取节点实时值(读不到再回退配方基线)并在卡面标注来源。

---

## 五、IDD 集成状态(未启动分析)

- `idd-closedloop-bridge` 10 工具、`diag-bridge` 5 工具、`rag-bridge` 2 工具均 enabled、`error=null`;
- IDD 后端 `http://127.0.0.1:3210/health` = 200;
- 只读 `diag_status(run_id=…)` 返回 **401 AUTH_REQUIRED**:本隔离实例未配置 `plugins.diag-bridge.token` / `plugins.idd-closedloop-bridge.token`。
- 结论:**接线与工具注册正常,鉴权未配置**;本轮未提交任何分析任务。

---

## 六、能否进入真实设备试点

**可以做受控试点,仍不建议直接生产。** 试点前按顺序确认:

1. 协议匹配:Modbus TCP/RTU、OPC UA、MQTT、HTTP、MES REST 可用;**S7 未实现**。
2. 若用插件/串口驱动:确认驱动在插件宿主已注册(S11 已改为 fail-loud,不会再假数据,但节点会离线)。
3. Modbus int16/uint16:确认 `rawMin/rawMax` 可表示(S15 现在配置期拒绝 + 运行期拒绝写);首版建议 float32。
4. `AW_BENCH_MODE` 未设置;单实例(`instance-guard` 已加)。
5. MQTT 生产必须启用 broker 账号/TLS(compose 已默认只绑 127.0.0.1)。
6. 标定:在设备 HMI 核对 `transform` scale/offset 与 eng/raw 映射;单点写后核对回读。
7. 首次写:线 `manual` + 配方绑定 `manual` + 小步长 + 保持窗;保留 `line_stop` 作为最后闸。
8. NTP 对时;IDD 若要使用先配 token。
9. 试运行节奏:只读 24–72h → 单点人工写 → 单参数 trial/rollback → 小范围 auto。

仍需补齐后再生产:真实设备长跑/断线/PLC 重启演练、任务失败收敛、IDD token 与分析验收、真实 MES 多字段 hook 的变更管理。
