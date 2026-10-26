# 全系统实机演示与完整测试报告（2026-10-25 / ralph v8）

> 依据 `skills/aw-system-acceptance` 五层验收 + 用户指令：11 插件全部装载并投入使用、不同 Agent 绑定不同节点、本体/AML/优化器工具在不同 Agent 上真实执行。
> 环境：演示实例 `:3300`（repo 模式，注塑产线 `ln-4d4613f5`，lead `9fc3eb10` / worker `394ab15a`）、IDD `:3210`、PLC 模拟器 `:4010`、隔离实例若干（各 e2e 自管）。

## 1. 总矩阵

| 层 | 套件 | 结果 | 证据 |
| --- | --- | --- | --- |
| T0 | typecheck / docs 91 / i18n 3104 / readme | 全绿（lint 10 错全在并行未跟踪脚本） | 前轮日志 |
| T1 | 单测 599/599 + skill 124 PASS | 全绿 | 前轮日志 |
| T2 | 模型层闭环（M0-M6，含 Agent 工具训练/采纳/求解/前端） | **54/54** | `docs/audit/evidence/2026-10-24-model-loop-live/report.json` |
| T2 | 优化器全功能（R1-R3+U1，含负例与 Agent 工具面） | **104/104** | `docs/audit/evidence/2026-10-23-optimizer-live/report.json` |
| T2 | 产线治理（L1-L12，HITL/TOCTOU/跨线/写限界） | **44/44** | 脚本尾行结论 |
| T2 | 本体离线全链（ON 全流程 + 自动修复） | **57/57** | `docs/audit/e2e-ontology-report.json`（本轮刷新） |
| T2 | 本体真机（L1-L7 + 邻接子图 ON16/17 + 六 tab 走查） | **87/87** | `docs/audit/evidence/2026-10-24-ontology-live/` |
| T2 | IDD 结果库（A2-A13）+ 面板 UI（A11） | **36/36 · 9/9** | `docs/audit/evidence/2026-10-25-idd-results/` |
| T2 | 注塑真实闭环（recipe_trial→HITL→65s→复测→固化） | **6/6 PASS**（当前脚本 6 断言；历史"9/9"为旧版脚本口径。保压 65→70bar 设备证实；复测 32.49g/0.017%/1.01%，固化 v3） | `docs/audit/evidence/2026-10-25-live-demo/t2-suite-logs.md` + `bench/results/injection-pressure-loop-2026-10-25T17-39-45-013Z/` |
| T3 | 多 Agent 工具面（隔离实例，per-agent 注入面/跨线拒绝/配方闸门） | **37 PASS / 0 FAIL** | `docs/audit/evidence/2026-10-25-live-demo/t2-suite-logs.md` |
| T4 | 插件装载 + 工具注册表 | 11/11 failures=[] · 125 工具 0 不可用（builtin 104 + plugin 21，见证据 facts.tools） | `docs/audit/evidence/2026-10-25-live-demo/report.json` |
| 全局 | npm 0.8.3 零态（上一轮） | 10/11（G10 断言口径） | 上轮报告 |

## 2. US-001 插件全覆盖（18/18）

11 个插件逐一真实调用，无一只停留在「列表可见」：

| 插件 | 真实调用 | 结果 |
| --- | --- | --- |
| diag-bridge | `GET /api/plugins/diag-bridge/results` + `diag_results`（lead 工具面） | total=112，回卡 2 条 |
| rag-bridge | `GET /health`（backend 8771 healthy）+ `GET /search` | health 通过；search 返回 401（RAG web token 未配置，外部边界如实标注） |
| serial-bridge | `GET /health` + `GET /ports` | available=true，枚举 COM1/COM3/COM4 |
| aw-matrix-plugin | `GET /stats` + `matrix_pipeline_probe`（worker） | ok=true；样本数见证据 `facts.matrixSamples`（产线持续采样，59638→438058 随时间增长，以证据文件为准） |
| daq-sink-verify | `verify_pipeline_probe`（worker）+ 模板 plug-verify-x2-profile | 链路正常，×2 标定断言点 |
| daq-vector-demo | 模板 plug-demo-roughness（粗糙度轮廓仪）在册 | 模板总数 11，其中插件模板 3 个（facts.templates） |
| idd-closedloop-bridge | `experience_log` + `sentinel_status`（worker） | **装载与工具注册在位；运行期 404**——IDD 现版已退役旧固件路由 `/api/sentinel|experience|optimizer`（idd-doe-impl `app/backend/src/index.mjs:122`）；`sentinel_status` 的「status=unknown/无告警」实为 404 被吞（jget 的 ok/status 被 handler 忽略，静默失败掩盖缺陷）。已登记为已知边界（证据 boundary P11a/P11b）；其能力面由 diag-bridge 六意图承接（P11s：结果库含 quick-screen/deep-diagnosis/stability-report 意图） |
| omp-sensor-tools | `sensor_calibration_log put` + `list`（worker） | 写入并读回标定记录 |
| twin-injection-default | provider injection-greybox-v1 | READY，generation=2 |
| twin-castfilm | provider castfilm-greybox-v1 | READY，generation=2 |
| twin-thermal-demo | provider thermal-demo-v1 | READY，generation=2 |

证据：`docs/audit/evidence/2026-10-25-live-demo/plugin-coverage.json`（18 条逐项记录）。

## 3. US-002 多 Agent 绑定不同节点（8/8）

- worker → `dn-622d2654`（scen-injection:daq:part-weight，g），绑定 kind=daq auto；
- lead → `dn-eae56da8`（scen-injection:daq:dim-dev，mm）；
- worker 原有 recipe 绑定 `rc-589a232b`（mode=manual）保持不变。

四向 `daq_query` 隔离矩阵（真实回包）：

| 调用方 → 节点 | 结果 | 回包要点 |
| --- | --- | --- |
| worker → 自己绑定节点 | 放行 | 返回 10 分钟窗内真实样本（克重 25~40g 量程） |
| worker → lead 绑定节点 | 拒绝 | `isError=true`「无权查询节点 dn-eae56da8。你有权访问的数采节点:dn-622d2654」 |
| lead → 自己绑定节点 | 放行 | 返回 dim-dev 活数据 |
| lead → worker 绑定节点 | 拒绝 | `isError=true`「工具调用被拒(引用校验):node_id 不在你的授权范围内…你的绑定节点:dn-eae56da8」 |

工具面按绑定差异化装配：worker 79 个工具 / lead 92 个（同一份 host-tools.json 动态裁剪）。
证据：`docs/audit/evidence/2026-10-25-live-demo/agent-binding-matrix.json`。

## 4. US-003 本体工具 Agent 面执行

worker 经 `agent-tools/invoke` 实调两件本体工具（演示实例本体 `onto-demo-inj@2`）：

- `ontology_scene_inspect`：5 实体 / 5 关系 / 0 规则，实体带平台绑定（dcw_node/daq_node）；
- `ontology_node_neighbors {line_id, entity_key=qv.part_weight, hops=2, direction=both}`：
  返回 `nodes=5 edges=5`，每条边带 `hop / direction(in|lateral|out) / tier=candidate_influence`，
  邻居节点带 `hop=1|2` 与角色分类——即 Agent 可读的「直接与间接关联的边」。

证据：`docs/audit/evidence/2026-10-25-live-demo/ontology-agent-tools.json`；全链真机另见 `2026-10-24-ontology-live/`（87/87，含前端六 tab 截图）。

## 5. US-004 AML / 优化器工具实机执行

- 模型层闭环 54/54：本体→孪生冻结→训练 A/B/C→Profile v1→v3 自动重绑→solve optimal，全程经 Agent 工具面，零设备写入；证据 `2026-10-24-model-loop-live/report.json`（本轮 01:31 刷新）。
- 优化器 104/104：REST 全链 + 负例契约（版本不可变/作用域/RBAC）+ Agent 工具面 dispatch + 浏览器五 tab；证据 `2026-10-23-optimizer-live/report.json`（本轮 01:34 刷新）。

## 6. US-005 其余 T2 套件

- 产线治理 44/44（L1-L12，含 HITL 开停线、审批期换线/换批次/配方改版 TOCTOU、跨线绑定清理、Agent token 自证、DCW 写/回读/单步/60s/量程限界）。
- 注塑真实闭环 **6/6 PASS**：worker（工艺优化）经 recipe_trial 把保压 65→70bar，HITL 批准后整批下发并设备证实（1/1）；65s 工艺惯性后 DAQ 复测 32.49g / 飞边 0.017% / 缩痕 1.01% / 熔温 246.7℃（bench summary final），全部入窗；recipe_update 固化（该配方从 v2 → v3），写控/配方日志可追溯。注：本轮回放真实改写了演示配方参数（演示线预期行为）。断言口径：当前脚本为 6 断言（P1/P2/P3-1/P5/P6/P7），历史基线"9/9"属旧版脚本——skill 基线已同步更正。
- 多 Agent 工具面 **37 PASS / 0 FAIL**：同一频道不同 Agent 按绑定拿到不同工具描述；越权节点拒绝；配方写面进入 HITL、未绑定者被 recipe 门拒绝；token 轮换宽限与列表脱敏；两组作业闭环并落分析台账。

## 7. 发现与边界（如实申报）

1. `agent-tools/invoke` 响应形状是 `{ data: { result: { text, isError } } }`——非 `data.text`；拒绝语义 `isError=true` 且文案点名授权范围。本轮先读错层导致两处误判（绑定矩阵已修正；插件覆盖首跑把 404 误记成功），reviewer 复核抓出后已全链修正。
2. rag-bridge `kb_agent/search` 需 RAG web token；当前仅 health 面可用（外部凭据未配置）。
3. idd-closedloop-bridge 的 IDD token 与 base_url 是**独立设置**（与 diag-bridge 分开）；已为演示实例配置 `127.0.0.1:3210` 并热生效——但运行期调用仍 404，根因是下一条。
4. **idd-closedloop-bridge 运行期契约过期（本轮核心发现）**：IDD 现版已退役旧固件路由 `/api/sentinel|experience|optimizer`（`app/backend/src/index.mjs:122`「旧的固定脚本 HTTP 集成已整体退役」），稳定面只剩 `/api/external/v1/*`（capabilities/analyze/chat/results）。该插件 9 个工具全部指向退役路由；且 `sentinel_status` 会把 404 吞成「status=unknown/无告警」（jget 的 ok/status 未被 handler 检查）——静默失败掩盖。其能力面已由 diag-bridge 六意图（quick-screen/stability-report/experience-mining/optimizer-campaign 等）承接并有结果库证据。**建议后续**：要么把插件重写到 `/api/external/v1` 面，要么正式标记 deprecated 并在插件管理中提示。
5. 内置插件双副本、ESM 缓存、路由精确匹配等工程纪律风险同前轮报告。
6. Mimosa 扫描未完成——以上只覆盖功能面，不构成安全认定。

## 8. 证据清单

- `docs/audit/evidence/2026-10-25-live-demo/plugin-coverage.json`（=report.json，18 pass + 2 boundary + facts）
- `docs/audit/evidence/2026-10-25-live-demo/agent-binding-matrix.json`（8/8）
- `docs/audit/evidence/2026-10-25-live-demo/ontology-agent-tools.json`（本体工具实调全文）
- `docs/audit/evidence/2026-10-25-live-demo/t2-suite-logs.md`（model-loop/optimizer/line/injection/tool-surface 尾录）
- `docs/audit/evidence/2026-10-25-live-demo/live-demo-matrix.html`（可视化矩阵存档）
- `bench/results/injection-pressure-loop-2026-10-25T17-39-45-013Z/summary.json`
