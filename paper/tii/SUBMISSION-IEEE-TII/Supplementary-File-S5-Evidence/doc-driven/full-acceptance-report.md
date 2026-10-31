# 2026-10-31 文档驱动虚拟验证 + 分层实机验收报告

> **判定:PASS(受控范围)** —— 当前 3300 实例未重启;按产线接口文档从零建立新虚拟产线、5 个 DAQ/1 个 DCW、4 人 Channel、完成采集/下发/分析/导出;T0/T1/T2(线治理)/T4 本轮全绿,重负载 T2 套件与 T3 部分套件按边界声明未跑。
>
> **真实设备结论:可受控试点,不可无人值守直上生产。** 语义/治理层可无缝,协议/标定/回读/数据隔离仍需六步割接。

## 1. 环境与生产安全

| 项 | 值 |
| --- | --- |
| 平台 | `http://127.0.0.1:3300`(未重启,PID 89480) |
| 数据根 | `D:\tmp\aw-idd-rag-e2e-20261030` |
| 既有产线 | `ln-cf47d3b6`(注入线,本轮未改);最终 13/13 DAQ online |
| 本轮新线 | `ln-b8c1d3ac`(`PROTO-文档驱动虚拟线-1031`);5/5 DAQ online |
| 虚拟设备 | HTTP `127.0.0.1:4020`;MQTT/注入模拟器 `127.0.0.1:18830`(最终单实例 PID 106352/8768) |
| 约束 | 未执行 `aw start/stop/taskkill/kill`;未重启平台;只新增 `PROTO-文档驱动-*` 资源 |

## 2. 五层验收矩阵

### T0 静态门禁

| 检查 | 结果 | 备注 |
| --- | --- | --- |
| `npm run lint` | **PASS**(修复后) | 首轮 5 个存量 lint error(`governance-harness-audit.ts` 3 处、`bench-approval-only.ts` 1 处、测试 1 处);拆分语句/补 cause/Reflect.deleteProperty 后全仓 0 error |
| `npm run typecheck` | PASS | — |
| `npm run docs:check` | PASS | — |
| `npm run i18n:check` | PASS | — |
| `npm run readme:lint` | PASS | — |

> lint 修复后已补跑 `typecheck`/`test:unit`(均 exit 0)、`docs:check`/`i18n:check`/`readme:lint`(均 exit 0)、`tests/governance-harness-audit.test.ts`(3 pass / 2 known skip / 0 fail)。

### T1 单元与契约

| 套件 | 结果 |
| --- | --- |
| `npm run test:unit` | 915 tests / 913 pass / 0 fail(2 skipped) |
| `npm run test:mcp` | 14/14 |
| `npm run test:plugin-lifecycle` | 22/22 |
| `npm run test:sdk-surface` | PASS |
| `npm run test:twin-provider` | 5/5 |
| `npm run test:skills` | 147 PASS / 0 FAIL |

### T2 实机核心闭环

| 套件 | 结果 | 证据 |
| --- | --- | --- |
| 产线治理(自隔离实例) | **PASS 44/44** | `logs/t2-line-governance.log` |
| 文档驱动虚拟 E2E | **PASS**(见 §3) | `doc-summary.json`、`task.json`、`dcw-roundtrip.json`、`export-stats.json` |
| 本体真机/模型闭环/优化器/注塑闭环/IDD/UI | **本轮未跑** | 重负载/外部依赖;历史基线 87/54/104/6/36/9;本轮以线治理 + 文档 E2E 为主证据 |

### T3 回归面

| 套件 | 结果 | 说明 |
| --- | --- | --- |
| `npm run test:api-live` | **未通过(环境前置)** | 该套件要求 fresh 实例注册用户;3300 已有用户/注册关闭,报“用户注册失败”并非系统缺陷 |
| 其余 T3 | 未跑 | 本轮以 T2 线治理(自隔离实例,44/44)作回归替代;T3 完整矩阵见历史全量验收 |

### T4 插件与工具面

| 项 | 结果 |
| --- | --- |
| 插件 | 11 个,`failures=0` |
| 工具注册表 | 126 个,`available=false` 0 个 |
| 证据 | `t4-plugin-tools.json` |

## 3. 文档驱动虚拟验证(本轮主演示)

### 3.1 输入文档

`docs/audit/2026-10-31-doc-driven-virtual-validation.md`:
- 6 个点位:箱体温度 PV、箱体温度 SP、SP 回读、壁厚轮廓(64 点向量)、环境温度、环境湿度(MQTT 同 topic 两字段);
- 量程/周期/单步/写后回读要求齐全;
- 虚拟设备:HTTP 4020 + MQTT 18830。

Agent 按文档生成 `blueprint.json` → 供给配置 `provision.json`。

### 3.2 从零供给

```text
建产线 ln-b8c1d3ac
跨线写点冲突预检:既有他线写控 3 节点,冲突 0
DAQ:dn-2441bc04 / dn-ae545180 / dn-e4934f70 / dn-970e00ea / dn-2a0acb1f
DCW:dw-1f825abb(HTTP POST /sp,bodyKey=setpoint)
配方:rc-5b3912d2(DOC-虚拟基线配方,SP=25)
采集总控 running=true
=== 产线供给:11 通过 / 0 失败 ===
```

> 配置偏差已修正:文档给环境点 1s,首轮 provision 写成 3000ms;已 PATCH `dn-970e00ea`/`dn-2a0acb1f` 为 `intervalMs=1000`,并同步更新 `blueprint.json`/`provision.json`。导出证据窗口是修正前采的,数据仍真实;后续采样按 1s。

### 3.3 Channel + worker 角色 + 绑定

| 项 | 值 |
| --- | --- |
| channelId | `6ab6e710-be3d-4961-a8cb-88d4d079d920` |
| 模板 | `chtpl-generic-optimize-default`(lead + 3 workers) |
| 成员 | 生产主管(lead)、数据分析师、知识调优工程师、工艺工程师 |
| 绑定 | worker:0 → 4 个 DAQ;worker:1 → 配方(manual);worker:2 → SP 回读(DAQ) |
| 种子任务 | `0100983c-176c-4d21-8356-8ff66bf86ed1` |
| 任务终态 | **COMPLETED / 100 / deliverable 在册** |

Agent 的交付物(节选)正确报告:
- 5/5 数据通道通过;
- 壁厚按 `/frames` 向量接口判读(64 点/帧),没有误用标量接口;
- SP 回读 25℃ = 配方目标;
- 如实标注“动态写 27 的请求曾被 60s 间隔拒绝,尚未证实动态跟随”——这是正确的边界声明。

### 3.4 动态下发 + 独立回读

| 动作 | 结果 |
| --- | --- |
| 写 SP=27 | `ack=readback-verified`,回读 27 |
| 独立 DAQ `dn-ae545180` | 27(4s 内) |
| 60s 后写回 25 | `ack=readback-verified`,回读 25 |
| 独立 DAQ | 25 |

证据:`dcw-roundtrip.json`。

> HTTP DCW 的 `ack=readback-verified` 来自 POST 响应回显,不是设备级独立回读;真正的独立证实是 `dn-ae545180` 的 27/25。不要把该 ACK 标签当成设备证实——这是 HTTP 写驱动的边界。

### 3.5 导出

| 文件 | 行数 | 值域 |
| --- | --- | --- |
| DOC-箱体温度PV | 134 | 24.5–25.5 |
| DOC-SP回读 | 134 | 25–27 |
| DOC-环境温度 | 275 | 20.5–23.5 |
| DOC-环境湿度 | 275 | 50–60 |
| DOC-壁厚轮廓(向量) | 3456 = 54 帧 × 64 点 | avg≈2.497 |

`export-stats.json`:**19/19 PASS**;manifest 的 `totals` 只统计标量(4 files/818 rows),向量在 `frames/` 单列。

## 4. 实时数据(摘录)

| 节点 | 协议 | 值 |
| --- | --- | --- |
| DOC-箱体温度PV | HTTP | 25.3℃(24.5–25.5 正弦) |
| DOC-SP回读 | HTTP | 25(写 27 时为 27) |
| DOC-壁厚轮廓 | HTTP vector | 64 点,avg 2.497 / max 2.52 mm |
| DOC-环境温度 | MQTT | 22.1℃ |
| DOC-环境湿度 | MQTT | 59% |

## 5. 缺陷与边界(必须如实记录)

1. **平台无内置 PDF/Word/Excel 解析**:本轮文档是 Markdown;真实厂家 PDF/Word/Excel 必须先转文本/CSV,或由 Agent 用文档工具读取。
2. **`provision-line` 的幂等对齐会 PATCH 既有节点**:本轮是新建线,未触碰既有注入线;但复用同一条线时会 PATCH `driverConfig` 并可能清空 DCW 平台值(上一轮已实测),生产上必须先 diff/备份。
3. **虚拟/真实数据无 `environment` 列**:隔离靠 line/run;本轮用独立新线,未污染既有注入线。复用同一条线时必须记录割接窗口。
4. **Agent 自动收口不稳定**:上一轮 PROTO 诊断任务未自动 `complete_task`(人工收口);本轮 4 人优化频道**自动完成**。说明是间歇性/上下文相关问题,需要修调度或加终态 watchdog。
5. **T3 api-live 未能在 3300 复跑**:该脚本头部声明针对 fresh `npm run start` 的 3001 服务;3300 已有用户/注册关闭,报“用户注册失败”。这是环境前置不满足,不是系统缺陷;本轮不宣称 T3 通过,用 T2 线治理(自隔离 44/44)作回归替代。
6. **图像/对象存储未覆盖**:本轮为 HTTP 标量/向量 + MQTT 标量。
7. **T0 修复了 5 个存量 lint error**(governance-harness-audit/bench-approval-only/测试);已跑 governance 测试 3/3 与 typecheck/unit 复跑,非行为变更。
8. **“既有线未改”是推断**:既有节点 `createdAt` 保持 22:08,本轮没有对 `ln-cf47d3b6` 的 PATCH/DELETE 调用;最终 13/13 online。没有逐节点 `updatedAt` 历史可直接证明“零写入”。
9. **T3 api-live 失败根因证据有限**:仅“用户注册失败”一条;fresh-instance 前置来自脚本头注,未在日志中显式打印。

## 6. 真实设备割接可行性

**可以,但只在受控试点条件下。**

无缝的部分:
- 节点 ID/名称/单位/量程/stepLimit/warn-alarm/配方/批次/Channel/worker/绑定/HITL/审计;
- 数据管线、导出、IDD 诊断入口;
- 割接动作只 PATCH `driverConfig`(HTTP URL → 真实 URL、MQTT topic/凭据、Modbus register/byteOrder、OPC UA endpoint/nodeId)。

不能自动无缝的部分:
- 真实 PLC 的标定/量纲(`transform`/`engMin~rawMin`);
- 回读通道是否存在(ACK 从 readback-verified → transport-ack/unverified);
- 凭据/TLS/网络;
- 虚拟/真实数据隔离(无 `environment` 列,必须独立线或割接窗口);
- 没有内置 `driverProfiles: {virtual, real}` 或蓝绿端点,割接靠人/脚本六步。

**判定:受控试点 GO;无人值守生产 NO-GO**,直到补齐环境 profile、数据来源标签、自动收口可靠性和文档解析。

## 7. 证据索引

`docs/audit/evidence/2026-10-31-doc-driven-full-acceptance/`:
- `blueprint.json`、`provision.json`、`provision.log`
- `channel.json`、`channel.log`、`channel-activate.json`
- `task.json`、`doc-summary.json`、`dcw-roundtrip.json`
- `export-job.json`、`export-stats.json`、`t4-plugin-tools.json`
- `logs/t0-static.log`、`logs/t0-lint-final.log`、`logs/t1-unit-contract.log`、`logs/t1-rerun-after-lintfix.log`
- `logs/t2-line-governance.log`、`logs/t3-api-live.log`
- `live-final.json`(最终两条线在线、channel/task/DCW/export/插件工具面快照)
- 虚拟设备脚本:`scripts/_audit/proto-doc-device-20261031.mjs`、`proto-doc-mqtt-20261031.mjs`、`proto-doc-broker-20261031.mjs`

## 8. 独立复核

**APPROVED**(非阻断 caveat 已处理):

- **US-001..US-008 PASS**:T0 logs exit 0;T1 counts 一致;T2 线治理 44/44;文档线为新线(`reused:false`);4 人 Channel + 6 绑定 + 任务 COMPLETED;DCW 27/25;导出 19/19;T4 11 插件 0 failures/126 工具 0 unavailable。
- `live-final.json` 已重生成:doc 5/5 + injection 13/13 online(旧快照 2/13 作废)。
- MQTT 1s 配置偏差已 PATCH `intervalMs=1000` 并同步 blueprint/provision JSON。
- HTTP DCW `ack=readback-verified` 已标注为 POST 回显,独立 DAQ `dn-ae545180` 才是设备证实。
- `export-stats.json` 的 detail 已修正(`3456 vs 54x64`),仍 19/19。
- T0 post-fix 已补:docs/i18n/readme + governance test log;T3 api-live 前置不满足已如实声明,未宣称 T3 通过。
- “既有线未改”改为推断,并给出 `createdAt`/无 PATCH-DELETE/最终 13/13 online 依据。

**复审结论:报告可发布;判定 PASS(受控范围),真实设备受控试点 GO、无人值守 NO-GO。**
