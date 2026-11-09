# RSI 经验进化 · 系统验收报告（2026-11-09）

> 范围：`origin/main@2a640dff`（RSI 13 个 WP，PR #118–#132 全部已合并）
> 执行：按 `aw-system-acceptance` skill 的 T0–T5 分层；隔离实例（`AW_MODE=home` + 临时 `AW_HOME`）。

## 0. PR 合并与验收核对

| PR | 主题 | CI quick-gate | 合并 |
|---|---|---|---|
| #118 | A1 经验数据模型 | pass | MERGED 04:55Z |
| #119 | A2 经验反射器 | pass | MERGED 05:10Z |
| #121 | A3 注入与检索扩展 | pass | MERGED 05:17Z |
| #122 | A4 跨 Channel + memoryPolicy | pass | MERGED 05:23Z |
| #123 | A5 看板 API + 验收脚本 | pass | MERGED 05:32Z |
| #125 | D1 配方证据链 | pass | MERGED 05:40Z |
| #126 | D2 改进提案链 | pass | MERGED 05:48Z |
| #128 | D3/D4/D5 Stage-1D 收口 | pass | MERGED 05:55Z |
| #129 | B1 Harness Profile 版本化 | pass | MERGED 06:01Z |
| #130 | B3/B4 晋升门 + 回滚 | pass | MERGED 06:06Z |
| #131 | C3/C4 元层 + 判据 DSL | pass | MERGED 06:12Z |
| #132 | 状态/交接文档 | pass | MERGED 06:19Z |

本地 `HEAD == origin/main == 2a640dff`；未合并 PR 仅 #21（论文文档，与本轮无关）。

## 1. 分层结果矩阵

| 层 | 套件 | 结果 | 备注 |
|---|---|---|---|
| T0 | lint | **0 error** | 全仓 |
| T0 | typecheck | **PASS** | vue-tsc -b --noEmit |
| T0 | docs:check | **87 通过 / 0 失败** | 含工具数/设置数/站点副本 |
| T0 | i18n:check | **3291 / 3291 PARITY** | unresolved 0 |
| T0 | readme:lint | **通过** | README + README-zh |
| T1 | test:unit | **1325 tests / 1323 pass / 0 fail / 2 skipped**（45 suites） | 基线 1208 → +115 |
| T1 | test:mcp | **14 / 14** | 工具名唯一 |
| T1 | test:twin-provider | **5 / 5** | |
| T1 | test:plugin-lifecycle | **22 / 0** | |
| T1 | test:sdk-surface | **PASS** | agentworkshop@0.10.0 |
| T1 | test:skills | **167 / 0** | 8 个 skill |
| T2 | 科学探索闭环 `acceptance-scientific-loop.ts` | **20 / 20** | 设备层注入 |
| T2 | 科学探索全链 `acceptance-scientific-fullchain.ts` | **21 / 21** | 证据已刷新 |
| T2 | 产线治理 `test:e2e-line` | **44 / 44** | L1–L12 |
| T2 | 注塑闭环 `test:e2e-injection` | **NOT RUN** | 需 `AW_TOKEN` + 外部实例（依赖缺失，未静默跳过） |
| T3 | 鉴权矩阵 `e2e-auth-matrix` | **15 条 401 负例 + P1–P3 全 PASS**；正向多用户抽检 **BLOCKED** | 需 `security.allowRegistration=true`（已有管理员即关闭注册的安全设计；非代码缺陷） |
| T3 | 工具面多 Agent `e2e-tool-surface-multiagent` | **37 / 0** | 含 token 轮换/双作业留痕 |
| T4 | 插件面 | **11 enabled / failures=[]** | |
| T4 | 工具注册表 | **148 total / 127 builtin / 0 unavailable** | 含新增 `improvement_list` |
| T5 | `bin/aw.mjs build` | **EXIT 0** | |
| T5 | 产物冒烟 | `/` **200**；`/api/workshop/aml` **401**；缺 `NUXT_SESSION_PASSWORD` **拒绝启动 (EXIT 1)** | |

## 2. RSI 新增面 · 实机功能验收（隔离生产实例 :3105）

| # | 断言 | 结果 |
|---|---|---|
| R1 | `GET /memories/experience-stats` 无 token → 401 | **PASS** |
| R2 | 带 token → 200 `{total:0,byStatus:{}}` | **PASS** |
| R3 | `POST /harness-profiles {overlay,activate:true}` → v1 **active** | **PASS** |
| R4 | `GET /harness-profiles` → `active.version=1` | **PASS** |
| R5 | 直接 `promote→active`（candidate）→ **ok:false**「仅 shadow 可晋级 active」 | **PASS** |
| R6 | `promote→shadow` → **ok:true** | **PASS** |
| R7 | `shadow→active` **无 bench** → **ok:false**「缺少配对评测结果」 | **PASS** |
| R8 | `shadow→active` 带 `{pValue:0.01,primaryDelta:0.12,costDelta:0.01}` → **ok:true**「配对显著改善」 | **PASS** |
| R9 | 激活后单 active 不变量：`v2:active, v1:superseded` | **PASS** |
| R10 | `rollback:true` → 回退 `v1:active, v2:superseded` | **PASS** |
| R11 | 经验晋升（弱证据 1 任务）→ **ok:false**「独立任务样本不足：1/2」 | **PASS** |
| R12 | 经验晋升（2 独立任务）→ **ok:true**「证据充分（2 任务 / 0 锚点）」 | **PASS** |
| R13 | 看板复读 → `total:2, byStatus:{candidate:1,validated:1}, byScope:{line:2}, byOutcome:{positive:2}` | **PASS** |

### 库级（实例 DB 只读核对）

- `improvement_actions` 3 行：`profile_promote/accepted`、`profile_promote/promoted (Δ=0.12)`、`profile_rollback/rolled_back` — **元层成效表生效**
- `channel_harness_profiles`：`v1 active / v2 superseded` — **单 active 不变量**
- `audit_log`：`harness.profile.shadow` / `.active` / `.rollback` 三条审计 — **晋升/回滚留痕**
- `agent_memories` 新列齐备：`outcome/evidence_json/scope_kind/scope_key/status/expires_at`
- 新表齐备：`improvement_proposals` / `channel_harness_profiles` / `improvement_actions`

### 离线 Gate-1A（`scripts/acceptance-rsi-stage1.ts`）

**13 / 13 PASS**（三触发产出 / 证据链可解析 / 证据 fail-closed / 跨频道同产线正样本 / 异产线·异 owner 负样本 / memoryPolicy 三档 / 注入预算 396≤500 / retired 排除 / DTO provenance / 看板聚合）。

## 3. 计划完成度（如实）

| 阶段 | 完成 | 未完成 |
|---|---|---|
| Stage 0 + 1A | A1–A5 ✅ | — |
| Stage 1D | D1–D5 ✅ | — |
| Stage 2 | B1、B3、B4 ✅ | **B2**（E5-lite 配对评测） |
| Stage 3 | C3、C4 ✅ | **C0**（插件热重载原子化）、**C1**（双盲验证器）、**C2**（advisory 护栏） |

完成 14/18 WP；未完成 4 个，入口与验收口径见 `docs/rsi/STATUS-20261109.md` §4。

## 4. 未覆盖/受限面声明

1. **T2 注塑闭环**：需 `AW_TOKEN` 与外部运行实例，本轮未提供 → NOT RUN。
2. **T3 鉴权矩阵正向段**：需放开 `security.allowRegistration`（生产默认关闭的安全闸门）；401 负例与公开面已全绿。
3. **T2 其余九套件**（e2e-ontology-live / model-loop / optimizer / IDD 结果库 / UI 走查）：需浏览器与外部依赖（IDD/RAG 后端），本轮未执行。
4. **B2/C0/C1/C2 未实现**：因此「shadow→active 的真实配对评测数据」目前只能由人工/脚本传入（B3 门已就绪并验证了「无 bench 拒绝」的 fail-closed 行为）。
5. **Mimosa 安全扫描**：本轮多次未取得完整结论（`scanner_enobufs`）；**不宣称安全**，建议在完整环境重跑全量安全审计。

## 5. 结论

- **功能面无回归**：T0/T1/T4/T5 全绿；T2 可运行的三套（科学闭环 20/20、全链 21/21、产线治理 44/44）全绿；T3 工具面 37/37。
- **RSI 新增面可实测、行为符合设计**：13/13 离线断言 + 13/13 实机 HTTP 断言 + 库级 5 项核对全部符合预期，且**负向路径（无 bench 拒绝、样本不足拒绝、未授权 401）全部按 fail-closed 生效**。
- **计划未 100% 完成**：18 个 WP 完成 14 个；B2/C0/C1/C2 未做，属计划内剩余项，不影响已交付部分的自洽性。
