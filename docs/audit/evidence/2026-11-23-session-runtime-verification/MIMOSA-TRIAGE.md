# Mimosa 深扫与逐条分诊（2026-11-23）

> **结论纪律**：Mimosa 的 coverage 为 `partial`、runStatus 为 `inconclusive`，因此**不宣称"安全通过"**。本文只报告 sealing 结果、计数与逐条分诊，并明确标注"未覆盖"的部分。

## 扫描记录

| # | scan id | seal (sha256) | findings | 覆盖状态 | 备注 |
|---|---|---|---|---|---|
| 1 | `scan-2026-11-23T13-55-55.627Z-4ffeba9be91d` | `9009ecfa5c06f364b9c84cd2d6507efe1b64d6c95aac075a1960a44bff9045f1` | 49（39 high / 10 medium） | partial / inconclusive | 修复前基线 |
| 2 | `scan-2026-11-23T14-31-46.874Z-c56524032193` | `17b9bdac66cc3f154f17bd0701e11c2a66933bdd7ce4b007f406a9c77a9a0f17` | 47（37 high / 10 medium） | partial / inconclusive | 修掉 1 条真实项 + 1 条可去除触发点 |
| 3 | 终扫（修复代码与文档之后） | 见 `FINAL-SCAN.txt` | — | — | 记录 seal 与计数 |

依赖：`packagesScanned=303`，离线 advisory `matchedAdvisories=0 / unknown=0`（三次扫描一致）。

## 已修复的真实项

| 发现 | 位置 | 处理 |
|---|---|---|
| CWE-798 硬编码凭据 | `scripts/test-group-chat-unit/lib.ts:138` | 夹具账号从不登录；口令改为每次运行 `randomBytes(12)` 随机生成，源码里不再有可用口令字面量 |
| CWE-95「代码注入」(publicClass=command-injection) | `server/services/workshop/evidence/candidate-store.ts:77` | `require()` 换成 `mustGet()`：`require` 在扫描器的 sink 表里等同 `child_process.require`，而这里只是"取不到就抛 NOT_FOUND"。调用点（`tests/research-orchestration.test.ts`）同步改名，行为不变 |

## 逐条分诊（按类）

### A. 不是仓库代码：本机运行期数据（16 条，`data/workspaces/<uuid>/*.py`）

- 路径示例：`data/workspaces/10f00aca…/export_aml_dataset.py:234`、`…/verify_p2_dataset.py:159`、`…/_smoke4/amlkit.py:41` 等。
- `data/` 在 `.gitignore:58` 被忽略（`git ls-files data | wc -l` = 0）。这些是 Agent 作业时在工作区里写的 Python 脚本（AML 导出/分析），属于运行期产物，不在产品分发包内，也不是仓库代码。
- **未改动**：删掉会破坏用户本机的历史作业产物。若要让扫描器忽略，应在扫描目标里排除 `data/`（本机私有数据），而不是改代码。

### B. 不是产品代码：未跟踪的论文脚本（9 条）

- `paper/tii/tools/make_fig1.py`（及其在 `TII-SUBMISSION-PACKAGE-FINAL/…/figure-sources/` 的副本）×8、`paper/tii/TII-SUBMISSION-PACKAGE-DAQ-REPRO/reproduce/build-word.py` ×1。
- 均为 `git status` 中的未跟踪论文 WIP（作图/生成 Word），只在本机运行，输入是论文源目录。
- **未改动**：属于论文工作区，本轮不触碰；是否入库由用户决定。

### C. 产品的可执行代码：22 条，全部确认是静态启发式误报

| 规则/类别 | 位置 | 为何不成立 |
|---|---|---|
| CWE-798 硬编码凭据 ×3 | `i18n/locales/en.ts:360,405`、`zh-CN.ts:360` | 命中的是**界面文案**：`embedApiKey: 'Embedding key'`、`mqttPassword: 'MQTT password'`。键名像凭据，值只是标签；真实密钥走设置/环境变量 |
| path-traversal ×1 | `server/api/workshop/a2a/[agentId]/rpc/index.post.ts:434` | 污点链 `dispatch → validateParams`：`validateParams` 是 zod schema 校验（`schema.safeParse`），与文件路径无关；扫描器把 `params` 当成了路径解析 |
| command-injection ×4 | `aml/python-runtime.ts:343,346,381,383` | `runCapture()` 用 `spawn(cmd, args, { shell: false })`；`args` 是数组，`ver` 来自 `env AML_UV_PYTHON \|\| '3.11'`，没有经 shell 拼接 |
| sql-injection ×1 + 污点 ×1 | `db/channel-agent.repo.ts:155`、`tests/ops-log-query.test.ts` | `rotateStmt.run(until, next, now, id)` 是参数化语句；`AW_TOKEN_GRACE_MS` 先 `Number()` 再夹到 `[0, 3600_000]` |
| sql-injection ×1 + 污点 ×3 | `scripts/acceptance-optimizer-process-model.ts:278,281,645,813` | 写入走 `timescale.adapter.ts` 的 `unnest($1..$10)` 纯占位符批量 INSERT；"环境变量"是该脚本自己的联调开关，不是外部输入 |
| 污点 ×2 | `scripts/e2e-aml.ts:142,196` | 命令行参数进 `actuation.ts` 的 `getTsdb().query(...)`/参数化写；脚本是运维验收工具，不是对外面 |
| idor ×1 + 污点 ×1 | `scripts/e2e-multi-harness.ts:100` | `invokeHostTool()` 先校验 agent token（常量时间 + 轮换宽限），再校验 turn provenance 与调用作用域；"HTTP 请求输入"是该 E2E 自己发的请求 |
| mongo-sort-injection ×2 | `agents/industrial/bench-approval-only.ts:308,318` | 项目不用 MongoDB（存储是 SQLite/Timescale）；`stableJson()` 只是稳定序列化做摘要比对 |
| 污点 ×1 | `skills/service.ts:49` | `listManagedRevisions(configRoot)` 扫描受管技能目录；"MongoDB 动态 sort"是扫描器按函数名匹配出来的，项目里没有该调用 |

### D. 未覆盖/未验证（如实记录）

- coverage 显示 `threatModel` 与 `findingDiscovery` 两个阶段为 `partial`，`businessLogicCandidates=0`、`traces=0`。也就是说：**业务逻辑类缺陷、跨服务鉴权、运行时行为都不在本扫描的证据边界内**（`evidenceBoundary: static_only_no_runtime_execution`）。
- 因此结论只能是"该静态扫描在已覆盖范围内没有未分诊的高危项"，**不是**"项目安全"。

## 复现

```bash
# MCP 工具（本会话）
security_scan_start { project: "D:\\codes\\ABO\\AgentWorkShop", depth: "deep" }
security_scan_status { jobId: … }
```
