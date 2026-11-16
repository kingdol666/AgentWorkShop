# Round-2 全系统测评：复现问题修复验证 × IDD 优化 skill × RAG × omp Channel（2026-11-16）

> 日期：2026-11-16（第二轮，合并后验收）
> 被测源码：`main` @ `900ad228`（PR #228 合并后；当日第三轮完整测评）
> 环境：隔离 `AW_MODE=home` + 全新 `AW_HOME=D:/tmp/aw-round2-live-20261116/home`；
> 平台 `:3997`；五协议模拟器影子 `:4055`（`:4058` 触发 broker 端口推导溢出，
> 印证文档已知上限：`18830+(port-4010)×1000` 在 ≥4058 时 >65535）；
> 真实 IDD `:3210`、rag-knowledge `:8771`/`:6789`；Channel LLM：omp + `ustc/deepseek-flash`。
> 边界：全部设备为模拟协议栈；不是物理 HIL；Mimosa 仍 `inconclusive`。

---

## 0. 结论摘要

| 判定项 | 结果 | 说明 |
|---|---|---|
| 上一轮 4 个真问题的修复 | **全部落地并实测验证** | PR #228（watchdog/HITL/rag/V6），unit **1799/1799** |
| 代码门禁 | **通过** | lint / typecheck / build / docs 101 / README / Skills 176 / MCP 14 / plugin 22 / SDK / twin 5；CI quick-gate PASS |
| PR 状态 | **0 开放** | #225-#228 全部 MERGED，本地 `main`=origin/main=`900ad228` |
| 产线文档接入 | **通过（模拟）** | sim-twin 7/7；供给 20/20；锻造 15/15；V1–V6 **25/25 首跑即绿**；冒烟 7/7（`rr-7db1f4fa`） |
| omp Channel 治理闭环 | **通过** | HITL `ap-64dbc251` → run `rr-a98db72c` **ack=readback-verified 1/1** → journal `anc-08696336`（54→56，agent） |
| **P0 修复实测** | **成立** | 40+ 分钟长治理回合：**0 次看门狗 abort**（上一轮 600s 即炸）、主消息 `consumed`（上一轮 dead）、同一 prompt 仅投递 **1 次**（上一轮重放 ×3）、无看门狗连坐取消 |
| IDD 优化 skill | **通过** | R001 window_seed 31.7875→32.2155→**32.5611 g**（incumbent，D=0.825，in_target）；R002 GP-EI 预测 32.443 / 实测 32.315（CI 内）；**gate 13/13 PASS** |
| RAG 集成 | **通过（直连）/ 部分（内部 agent）** | 直连 search 20-58 条；优化结论入库 5 chunks、检索**排名第 1**；kb_agent 异步回执成功 1 次（19:26）；同步路径 7s 快速失败且**如实透传 RAG 内部引擎错误**（不再误导） |
| Mimosa | **不构成安全通过** | `scan-2026-11-16T11-02-08.883Z-fcfdde7b4434`：47 findings、`inconclusive`、本轮 7 个改动文件 **0 命中** |
| 外部条件 | **预算 2 次打满** | USTC key $30/3h：19:45 起再次 `ExceededBudget` → 种子任务 FAILED（熔断按设计收口）；主任务治理链在此之前已完成 |

**总判断**：上一轮的 P0（看门狗误杀）在本轮真实长回合中**未再发生**，P1/P2 修复全部按预期工作；系统在「文档→五协议孪生→产线接入→治理闭环→优化 skill→知识沉淀」主链上再次全绿。剩余未闭环项不变：物理 HIL、RAG 内部 agent 稳定性（外部仓库）、LLM provider 预算容量（外部配额）。

---

## 1. 复现问题 → 修复 → 实测验证（逐条）

### 1.1 P0：消息看门狗误杀（PR #228 核心）

| 项 | 上一轮（修复前） | 本轮（修复后） |
|---|---|---|
| 看门狗 abort 次数 | 2 次（600s 固定死线） | **0 次**（40+ 分钟回合，含 4 分钟 HITL 等待） |
| 主任务消息终态 | `dead`（重投 3 次） | `consumed`（1 次投递） |
| 同一 prompt 重放 | 3 次 | 1 次 |
| 连坐取消其它任务 | 种子任务被误取消 | 无（种子任务 FAILED 系预算熔断，见 §4） |

修复内容：活动窗口（任何 harness 事件重置，纯函数 `message-watchdog.ts`）+ 挂起 HITL 视为合法等待 + timer 在取得 execLock 后才起表 + abort 带结构化 `message watchdog` reason（omp 不合成 cancel 决策）。回归：`tests/message-watchdog-decision.test.ts`（5 例）+ `supervision-decision` 归一（1 例）。

### 1.2 P1：HITL 到期权威收口 + 终态通告

到期 timer 不再被 pending 表项摘除短路（以审批单 `status==='pending'` 为准），到期落定 expired 并向发起 agent 与线域发「⛔ 审批已超时自动拒绝」。回归 `tests/hitl-expiry-authoritative.test.ts`（3 例：权威收口/先批后到/先到后到竞态）。

### 1.3 P1：rag-bridge kb_agent 失败分类

401/403 → 「token 过期请轮换」；超时/abort → 「改 async + kb_agent_status」；断连 → 「检查 web/backend 健康」。误导性统一文案删除。**实测**：本轮一次 `kb_agent` 同步调用 7s 快速失败，返回的是 RAG 内部引擎的**真实错误**（`agent turn ended with error`，外部 rag-knowledge 仓库问题），不再把人引去检查活着的 web。过期 project 副本已与 builtin 同步。

### 1.4 P2：V6 fresh home 假失败

`verify-line.mjs`：受保护线不存在 → SKIP + 预置指引（不计入 fail）；线在但基线空 → 仍 FAIL。本轮因夹具预置正确（`dw-a680acb4` 写 42 → `anc-cf9a98c7`），V6 真实通过（基线=1，新增=0）——SKIP 与 FAIL 两条路径都已定义。

---

## 2. 全新隔离环境实测

### 2.1 环境
- 平台 `:3997`（main `900ad228`，PR #228 修复在内）、模拟器 `:4055`（全新影子）、全新 home。
- 受保护线夹具预置：线（启动前写 `dcw-lines.json`）+ DCW + 锚点。
- 插件：diag-bridge / rag-bridge（新 token，health `accepted:true`）。

### 2.2 接入（aw-plc-sim-twin + aw-line-onboarding skill）
- sim-twin **7/7**（6 设备/19 信号/五协议，tick 活性 6/6）；
- onboard **首跑全绿**：供给 20/20、锻造 15/15、V1–V6 **25/25**、冒烟 7/7（52→54，`rr-7db1f4fa`）；
- 落袋：线 `ln-da75ea3d`、配方 `rc-27da4639`、频道 `be90373a-…`（4 成员）、受保护线新增锚点 0。

### 2.3 omp Channel 治理闭环（R2-VERIFY）
- 预算探针 19:11 通过（181s 回复；种子任务随之在团队内流转）；
- 任务 19:14 下发 → lead 派发数据分析师/知识调优工程师 → 19:20 HITL `ap-64dbc251`（54→56，basis 引用本线实测）→ 监视器批准 → **run `rr-a98db72c`：ack=readback-verified，verified 1/1** → journal `anc-08696336`（source=agent）；
- 克重响应：31.4x → **31.78 g 稳态**（方向正确；目标窗未达，+0.08 g/MPa 增益与既往一致）；
- kb_agent 异步回执 **19:26「知识库任务完成」**（job `kbt_mwj69d74_5fa8e…`）——KB 链路本轮真实跑通一次；
- **未完成项（如实）**：lead 未输出最终「Round-2 闭环作业汇总」文本——19:45 起 USTC 预算再次打满（$30.39/$30/3h），lead 后续回合 422 → 熔断；治理链（下发/回读/journal）在预算耗尽前已完成并经平台侧独立复核。

### 2.4 IDD 优化 skill（非根因诊断）
- `OPT-20261116-101`：objective（克重 32.15–32.85，4 因子，安全限 ≤85 MPa）；
- R001 window_seed：**31.7875 → 32.2155 → 32.5611 g**（T01 incumbent，D=0.825，in_target=true）；
- R002 GP-EI：62.54/3.40/208.9/17.95 → 预测 32.443 g / 实测 **32.315 g**（CI95 内）；phase=exploring，GP 无 fallback；
- **optimizer_gate 13/13 ALL PASS**（OG1–OG8 含 schema/枚举/溯源）；
- 执行全程走平台 DCW 治理（量程∩步限∩60s，journal 留痕）；期间平台**正确拒绝一次 0.601s>0.5s 的越步写**——四层限界在真实作业中生效的又一实证。

### 2.5 RAG 集成
- 直连检索：`/api/plugins/rag-bridge/search` 20–58 条，TopN 相关；
- 优化结论入库：`aw-industrial/IDD-OPT-20261116-R2-ln-da75ea3d.md`，5 chunks；
- 入库后检索**排名第 1**（score 0.716）——「分析→存储→按需取回」闭环成立；
- kb_agent：异步回执成功 1 次；同步失败为 RAG 内部引擎错误（外部），平台如实透传。

### 2.6 Mimosa
`scan-2026-11-16T11-02-08.883Z-fcfdde7b4434`（seal `sha256:1abc6a7f…`）：47 findings、`runStatus=inconclusive`；本轮 7 个改动文件 **0 命中**。**不宣称安全通过**。

---

## 3. 门禁与合并

| 门禁 | 结果 |
|---|---|
| lint（含 RSI 红线）/ typecheck / build | PASS |
| unit | **1799/1799**（+9 回归：watchdog 5、归一 1、HITL 3） |
| docs / README / Skills | 101/101 / PASS / 176/176 |
| MCP / plugin / SDK / twin | 14/14 / 22/22 / PASS / 5/5 |

PR：#228（本轮修复）已合并（`900ad228`），#225-#227 此前全部合并；开放 PR = 0。

---

## 4. 仍存在的问题（如实，含新观察）

| 级别 | 问题 | 状态 |
|---|---|---|
| 外部 | USTC key $30/3h 预算 2 次打满（17:13、19:45），熔断 fail-closed 正确但频道停摆 | 外部配额；对策=多 key/预算告警（未实施） |
| 外部 | rag-knowledge 内部 agent 同步路径失败（`agent turn ended with error`）；异路径曾成功 1 次 | 外部仓库问题；平台已如实透传 |
| 平台 | lead 本轮未产出最终汇总文本（预算耗尽打断合成回合） | 待观察；治理链证据完整 |
| 平台 | 种子任务以 FAILED 收口（预算熔断） | 预算外部条件的连带 |
| 平台 | 消息面 2 条 `pending` 为 lead 广播消息（toAgentId=null，设计如此不入信箱） | 非缺陷，记录口径 |
| 未变 | 物理 HIL 未验证；RSI promotion/actuation 仍关闭；本体仍手动发布 | 长期项 |

---

## 5. 复现与证据

```bash
# 平台（合并后 main）
AW_MODE=home AW_HOME=D:/tmp/aw-round2-live-20261116/home PORT=3997 \
  AW_ALLOW_PRIVATE_OUTBOUND=1 BACKUP_DISABLED=1 node .output/server/index.mjs
# 孪生（注意 broker 推导上限：sim-port ≤ 4056）
node scripts/onboarding/sim-twin.mjs --blueprint <bp> --sim-port 4055 --shadow <fresh>
# 接入
AW_BASE=http://127.0.0.1:3997 AW_TOKEN=<t> node scripts/onboarding/onboard.mjs <cfg> --skip-connectivity --smoke
# 优化 skill
uv run --project <IDD>/.claude/shared/scripts python \
  <IDD>/.agents/skills/industrial-optimizer-loop/scripts/optimizer.py init|design|ingest --run-dir <run>
node <IDD>/.agents/skills/industrial-optimizer-loop/scripts/optimizer_gate.mjs <run> \
  --skill-path <IDD>/.agents/skills/industrial-optimizer-loop --shared-path <IDD>/.claude/shared
```

证据：`D:/tmp/aw-round2-live-20261116/`（platform.log、onboard.log、sim-twin.log、monitor.log、run-opt-r1/r2.log、messages-final.json、context.json）；
优化 run：IDD `workspace/aw-exchange/opt-r2-20261116/`；Mimosa：`D:/tmp/aw-mimosa-round2-20261116/`；门禁日志：`D:/tmp/aw-round2-20261116/gates/`。

> 本报告只适用于本次模拟协议栈、`main@900ad228` 与当日外部服务实例；不构成物理 HIL 或生产投用批准。
