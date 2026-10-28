# 数采/数控/Agent 三模式真机验收报告(2026-10-28)

> 配套计划:`docs/plans/2026-10-28-security-hardening-plan.md`
> 证据目录:`docs/audit/evidence/2026-10-28-harness-3mode/`、`docs/audit/evidence/2026-10-28-security-hardening/`
> 结论:**三模式(观察/手动/自动)全部 COMPLETED;安全加固验收 26/26;单测 696/696;类型检查通过。**
> 诚实边界:设备层使用平台内置 mock 驱动(DAQ/DCW),**没有物理 PLC 响应耦合**;LLM 为本机 LM Studio `qwen3-8b-32k`。平台、omp 进程、工具桥、TSDB、HITL、配方写控均为真实链路。

---

## 一、本轮代码改动(按计划)

| 计划项 | 状态 | 落点 |
|---|---|---|
| S1 harness 启动面收敛 | 已实施 | 新增 `agents/harness-spawn-policy.ts`;接入 Channel/Agent/成员/Channel 模板的创建与编辑;`line-spawn` 剥离平台口令类 env |
| S2 DCW/DAQ 配置面分权 | 已实施 | `dcw/[id].patch`、`daq/[id].patch`:driver/driverConfig/transform/量程/步限/保持窗/lineId 仅 admin;operate 仅运行参数 |
| S3 Agent 名册不回显 token | 已实施 | 新增 `agents/agent-dto.ts`;Channel 名册/详情统一投影,token 永不出现在列表,config 仅属主/admin |
| S4 REST 数据面产线授权 | 已实施 | 新增 `line-scope.ts`;配方列表/版本、账本、参数台账、优化记录、MES 产物、节点读值、报警、删配方/关批次全部按线授权;列表按可见线过滤 |
| S5 test-driver/reconnect 收敛 | 已实施 | 两者要求 admin/editor;`allowPrivateHost` 只认服务端开关;reconnect 加单飞 |
| S6 保写心跳纳入限界 | 已实施 | 心跳先过四层限界;改量程/标定/驱动/产线清 value;删线清 value;未分配产线不再默认豁免(需 `AW_HOLD_UNASSIGNED=1`) |
| S7 配方第四层 + 运行门 | 已实施 | trial overrides 执行前复检配方窗;优化器 D13 增加运行门/活动配方/产品一致性;建卡仍允许(开线后批准) |
| S8 回退链 / lastGood | 已实施 | 回退记录不得再作为回退目标;sweep 跳过回退记录;节点回退排除回退锚;markGood 校验配方/产线归属 |
| S9 HITL 收敛 | 已实施 | 待批只统计本 Channel 成员;顺延上限 3 次后恢复 ROOT_TIMEOUT,不再跨 Channel 冻结 |
| S10-S16(启动屏障/未知驱动/ingest 时间戳/MQTT/WS 隔离/Modbus 范围/单实例锁) | **未实施** | 已在计划中保留,本轮不动,避免扩大回归面 |

验证:
- `npm run typecheck` 通过;
- 变更面 ESLint 0 error;
- `npm run test:unit` **696/696 pass**(含新增优化器运行门负例);
- `npm run test:e2e-line` **44/44 PASS**(隔离实例;L1-L12:开停线 HITL/TOCTOU/换线清理/Agent token 自证/DAQ 实采/DCW 写回读/单步/60s/量程);
- `npm run build` 通过(首次出现 NUXT_B7021 客户端 manifest 瞬时错误,重跑即恢复);
- 安全验收 `node scripts/security-acceptance.mjs` **26/26 PASS**(可复跑,环境变量驱动)。

---

## 二、验收环境与场景

| 项 | 值 |
|---|---|
| 实例 | 隔离实例 `AW_HOME=D:\tmp\aw-e2e-20261028`,`PORT=3410`(未触碰 3000 上的其它会话实例) |
| 版本 | 0.8.5(本地构建) |
| Harness | omp 18.12.2(RPC 模式,真实子进程) |
| 模型 | LM Studio 本地 `qwen3-8b-32k`(32k 上下文;外网 ustc/ark/superapi 额度均不可用) |
| 设备 | DAQ:内置 mock(温度/压力);DCW:内置 mock(温度设定,带真实 ACK + 独立回读补验) |
| 时序库 | TimescaleDB(5432,真实) |
| 产线A(手动) | `ln-9ceed1e7` / 配方 `rc-9363b8d1` / 设定 60C,窗口 50~70C |
| 产线B(自动) | `ln-a7d18fe7` / 配方 `rc-e335442b` / 设定 60C,窗口 50~70C |
| 观察 Channel | exp-miner 内置模板 `chtpl-exp-miner-default`,绑产线A,工具面 6 个(只读+complete/report) |
| 手动 Channel | legacy,lead+worker 各 1,绑定配方A(mode=manual),产线 controlMode=manual |
| 自动 Channel | legacy,lead+worker 各 1,绑定配方B(mode=auto,confirm),产线 controlMode=auto |

> 工具面按 Channel 用 `selected` 策略裁剪(观察 6 个;手动/自动 23 个)。原因是本机 8B 模型的 32k 上下文装不下 104 个工具 schema;这也是平台本就支持的能力。

---

## 三、三模式实测结果

### 3.1 观察模式(exp-miner,零写)

任务:`观察模式-三步巡检` → **COMPLETED**

Agent 实际调用:
1. `line_context` → 读到产线运行中、活动批次 `rr-c3ebea4e`、配方/产品/窗口;
2. `daq_query(line_id, last_minutes=5)` → 2 个测点各 21 个 15s 桶;
3. `complete_task` 交付结论。

结论原文(摘录):
> 温度:21 点,均值/最小/最大均 107.04C,节点 alarm;**配方窗口 [50,70]C,21/21 全部越限(100%)**;同窗数控设定 60C、PLC 读回 60C,实测恒偏 +47.04C 且无收敛趋势,非设定-响应滞后可解释。压力:均值 0.933bar,12:15:15 单桶 1.55bar 尖峰。权限:仅用只读工具,无写入。

判定:**通过**。零写工具面生效;Agent 能取证、对照窗口、给出可审计结论。

### 3.2 手动模式(HITL)

任务:`手动模式-受控下发` → **COMPLETED**

链路:
1. `daq_query` 取证(温度 107.04C);
2. `recipe_trial(recipe=rc-9363b8d1, params=[{node: dw-f3471765, value: 58}], hypothesis=...)`;
3. 生成 HITL 卡 `ap-dcbb3f39`(摘要:60→58C,附假设与窗口);
4. 人工批准(`/hitl/respond`,confirmed=true);
5. 批次 `rr-bcafd6f0` 整批下发,**1/1 设备证实**;
6. `complete_task`。

账本:`2026-10-28T12:19:41 recipe 60→58 recipeRun=rr-bcafd6f0`。
配方版本仍为 **v1**(trial 不写版本,值仍 60)——语义正确。

判定:**通过**。审批前零写、批准后一次整批写入、ACK 证实、版本语义正确。

### 3.3 自动模式(免批)

任务:`自动模式-免批下发` → **COMPLETED**

链路:1) `daq_query` 取证(107.04C);2) `recipe_trial(recipe=rc-e335442b, value=62)`;3) 无 HITL,直接批次 `rr-1f1afd2f`,**1/1 设备证实**(60→62);4) `complete_task`。

账本:`2026-10-28T12:22:06 recipe 60→62 recipeRun=rr-1f1afd2f`。
HITL 待办数:0。

判定:**通过**。auto 绑定 + 产线 auto 下免批直发,四层限界与运行门仍生效。

---

## 四、数采 / 数控 / Agent 集成评价

### 做得好的

- **数采**:真实 TSDB 落库、按线查询、活动批次打标、越窗告警链路完整;`daq_query` 返回物理语义(单位/量程/窗口/批次)而不是裸数,Agent 可直接判读。
- **数控写控**:四层限界(节点∩参数∩产品∩配方)+ 步长/频控/保持窗/运行门在真实写路径上生效;ACK 三桶 + 独立回读补验,**没有出现"命令成功即设备生效"的假成功**;账本含 prev/new/source/recipeRun,配方 trial 不写版本、rollback 可恢复,语义一致。
- **Agent 集成**:绑定面 → 工具描述 → 执行面 grant/verify 同源;omp 原生 host tools 注册与调用正常;HITL 卡能挂起、人工批准后原调用继续并回传附言;Channel 工具策略 `selected` 能有效裁剪工具面。
- **安全加固**:26 条负例(越权读/删/写、命令注入、token 泄露、SSRF 入口)全部按预期拒绝,正常路径(admin/授权 operate)不受影响。

### 需要正视的问题

1. **小模型 × 大工具面**:104 个工具 schema 直接超过 32k 上下文,首次任务直接 `Context size has been exceeded`。必须用 Channel `selected` 策略或更大上下文模型。生产上如果接 7B/8B 本地模型,建议模板内置精简工具集。
2. **omp 原生工具会干扰**:弱模型会去调 omp 自身 `task`/`write`/`edit`(报 `sourceSession`/hunk header 错误),而不是平台工具。需要在场景提示里显式禁止,或后续给 harness 增加"仅平台工具"白名单。
3. **任务失败不自动落终态**:harness 工具报错后任务仍停在 `SUBMITTED`,需要人工 cancel 才能推进队列(本次 v1–v3 均手工取消)。这是鲁棒性缺口,建议在 dispatch 层把"harness 回合失败且无可用产出"收敛为 FAILED。
4. **mock DAQ 无物理耦合**:设定从 60 改到 58/62 后,DAQ 值仍由 mock 波形决定,所以"调整→工艺响应→复测"的物理闭环无法在本次验证。若要看真实响应,应使用 `plc-node-simulator` 的 first-order SP→PV 耦合(下一轮)。
5. **IDD 集成只到"接线正常"**:`idd-closedloop-bridge`/`diag-bridge`/`rag-bridge` 均 enabled、`error=null`,IDD 后端 3210 `/health=200`,`diag_status` 只读探测返回 **401 AUTH_REQUIRED**(本隔离实例未配置诊断 token)。**未启动任何分析任务**。主实例若已配置 token,需在设置页确认后另行验收。

---

## 五、证据索引

| 文件 | 内容 |
|---|---|
| `scripts/security-acceptance.mjs` | 可复跑安全验收脚本(`AW_BASE_URL`/`AW_E2E_DIR` 环境变量;每次先撤销历史授权,负例可重复) |
| `evidence/2026-10-28-harness-3mode/report.json` | 三模式任务/频道/账本/运行/DAQ/插件/IDD 结构化快照 |
| `.../obs-task.json`、`manual-task.json`、`auto-task.json` | 三任务完整历史(含每个工具调用与结果) |
| `.../security-report.json` | 安全加固 26 条负例结果 |
| `.../idd-check.json` | IDD 只读探测原始回包(401 AUTH_REQUIRED) |
| `evidence/2026-10-28-security-hardening/report.json` | 安全验收原始报告 |

---

## 六、建议的下一步

1. **P2 安全项**(S10 启动屏障 / S11 未知驱动 fail-loud / S12 ingest 时间戳 / S13 MQTT / S14 WS 隔离 / S15 Modbus 范围 / S16 锁覆盖)——这些直接影响"数据可信度",建议下一轮优先 S10/S11。
2. **任务失败收敛**:把 harness 回合失败→任务 FAILED 的路径补上,避免队列被一个坏回合卡住。
3. **真实工艺响应**:用 `plc-node-simulator` 的 first-order SP→PV 场景重跑手动/自动两模式,验证"调整→响应→复测→固化/回退"的完整闭环。
4. **IDD token**:在隔离实例或主实例设置 `plugins.diag-bridge.token` 与 `plugins.idd-closedloop-bridge.token` 后,再跑一次只读 `diag_status`,确认 200 后再做分析验收。
