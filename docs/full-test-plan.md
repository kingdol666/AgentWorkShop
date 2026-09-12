# AgentWorkShop 全功能测试流程 Plan

> 版本无关的常备测试手册（撰写时基线 v0.7.36）。用途：后续直接指令 agent
> 「按 docs/full-test-plan.md 执行 Phase 0–N」即可完成全功能测试。
> 断言数为历史全绿基线（2026-09 上旬各轮验收），以脚本实际输出为准；括号内数字仅用于识别明显回退。
> 最后核对：2026-09-12（脚本清单逐一经 `scripts/` 实存核对）。

---

## 0. 总则

**通过标准**：本 plan 内列出的脚本全部全绿（0 failed）+ 服务日志无新增未解释 error + 关键页面目视无破版。任何红项：先定位修复，再复跑该阶段全量确认。

**执行纪律（每轮必守）**：
- 本机 7890 代理会拦截 localhost：所有对 127.0.0.1 的 curl/node 调用带 `NO_PROXY='127.0.0.1,localhost'`（或 `NO_PROXY='*'`）。
- 探针避开 3000/3001 冲突：dev=3000、生产 `aw start`=3001、隔离实例=3021。
- `.ts` 脚本必须 `npx tsx --tsconfig .nuxt/tsconfig.server.json`（先 build 过一次）。
- 测试账号（勿改动）：admin@awshop.local / admin123（生产零种子 admin）；perf-runner@awshop.io（admin）；read-verify@awshop.io（plain）。老脚本默认 `E2E_USER ?? 'zhangwei@awshop.io'`，对生产须显式传 env。
- 凭据纪律：脚本从 env / `/api/system/settings` 运行时读取，不写可用凭据字面量。
- Bash 写源码/配置会被 Mimosa hook 拒绝 → 用 Write/Edit 工具；git add 源码路径同样被拒。
- commitlint：subject 首字符不得大写（中文开头最稳），body 每行 ≤100 字符。本仓库有并行会话共享 git index：commit 必须 pathspec 限定，提交后 `git log` 核对没被卷走。
- 共享实例有累积脏数据（数百产线/未结批次）：判断「数采没采」前先确认产线批次门控（见 §8 排障表）。

**报告产物**：`docs/test-report-<版本>.md`，逐阶段列脚本 → 断言数 → 结果 → 失败详情与处置。

**两档执行模式**：
| 档位 | 范围 | 约耗时 |
|---|---|---|
| 冒烟（quick） | P0 + P1 + P2核心(api-live/perms/config-groups) + P3(protocol-matrix) + P4(agent-team) + P6(aw-start-smoke) + P7 抽查 | ~40 min |
| 全量（full） | P0–P7 全部 | ~2.5–3.5 h（4 引擎真实 LLM 占 ~40 min） |

---

## Phase 0 环境准备（全部后续阶段的前置）

| # | 动作 | 命令/检查点 |
|---|---|---|
| 0.1 | 生产实例 :3001 | `cd D:/codes/ABO/AgentWorkShop && NO_PROXY='127.0.0.1,localhost' node bin/aw.mjs start`（后台）；健康门 `curl --noproxy '*' -s http://127.0.0.1:3001/api/health` 返回 ok |
| 0.2 | dev 实例 :3000（仅 P4 部分/TUI 需要时再起） | `npm run dev`；健康门同上换 3000 |
| 0.3 | 协议模拟器五件套 | `node scripts/dev-protocol-simulators.mjs`（MQTT:1883 / HTTP:1889 / ModbusTCP:1502 / ModbusRTU:15030 / OPC UA:4840）+ `node scripts/dev-plc-simulator.mjs`（PLC 涂布线 :15040，PV 40001 / 可写 SP 40021） |
| 0.4 | PLC 节点模拟器（独立项目，挤出流延） | PLC 项目目录启动（API :4010 + Modbus TCP :16040，40001=熔体温度/40021=加热区1SP，float32 big-endian）；`curl --noproxy '*' http://127.0.0.1:4010/health` |
| 0.5 | rag-knowledge | KB 后端 :8770（e2e-plc-plugin-closedloop 缺省 8771，见各脚本 KB_BASE）；健康门含 `vector.ready=true`、`embedding_available=true`；挂死（/health 30s+ 超时）→ 在 rag 项目根 `node command/ragctl.js restart backend`；检索 0 命中且 hnsw 报 "Nothing found on disk" → reindex（force 重建） |
| 0.6 | 工业深度诊断 | API :3210 + RAG 引擎 :8764（降级容忍但须存活）；`curl http://127.0.0.1:8764/health` → status healthy |
| 0.7 | admin token | 浏览器或 REST 登录 admin@awshop.local 取 token → `export AW_E2E_TOKEN=<token>`（多数 3001 脚本依赖） |
| 0.8 | 快速健康门 | `node bin/aw.mjs doctor` / `node bin/aw.mjs status`；插件清单 `node bin/aw.mjs plugin list`（rag-bridge、diag-bridge 为 enabled） |

⚠️ 0.3–0.6 任一不可用：对应依赖它的 Phase 3/5 项标记 SKIP 并在报告注明原因，不得静默当绿。

---

## Phase 1 服务层静态回归（无需任何服务在跑）

| 脚本 | 覆盖 | 基线 |
|---|---|---|
| `node scripts/test-data-root.mjs` | 单一数据根 `.AgentWorkShop/data` +「最新者胜」迁移 | 52 |
| `node scripts/test-rollback-index.mjs` | DCW 回滚账本索引化：结果一致 + 热路径更快 | 19 |
| `node scripts/_dbg-configroot-audit.mjs` | 配置根解析：`./.AgentWorkShop` 优先 / `~` 兜底，start/dev-guard/直跑 .output 三路一致 | 18 |
| `npm run test:plugin-lifecycle` | 插件生命周期 | 全绿 |
| `npm run test:sdk-surface` | SDK 面 | 全绿 |

---

## Phase 2 生产实例 API/UI 回归（对 :3001）

前置：0.1 + 0.7。

| 脚本 | 覆盖 | 基线 |
|---|---|---|
| `AW_E2E_TOKEN=… NO_PROXY='127.0.0.1,localhost' node scripts/api-live-e2e.mjs` | 持久化恢复/模板/频道/任务三模式/agent-tools | 64 |
| `NO_PROXY='127.0.0.1,localhost' node scripts/_dbg-perms-e2e.mjs http://127.0.0.1:3001 admin123` | 产线权限矩阵（默认无权→readonly/operate 授权逐项） | 20 |
| `NO_PROXY='127.0.0.1,localhost' node scripts/_dbg-audit-neg-e2e.mjs` | 越权负向（start/stop/samples/WS 无鉴权） | 9 |
| `NO_PROXY='127.0.0.1,localhost' node scripts/_dbg-render-regression.mjs http://127.0.0.1:3001 admin@awshop.local admin123` | 关键页渲染回归 | 29 |
| `AW_E2E_TOKEN=… NO_PROXY='127.0.0.1,localhost' node scripts/e2e-config-groups.mjs` | 配置分组系统 + 两桥接插件正确/错误 token·URL 实测 | 58 |
| `E2E_USER=admin@awshop.local E2E_PASS=admin123 NO_PROXY='127.0.0.1,localhost' node scripts/_dbg-groups-ui-verify.mjs` | 设置页分组 UI（浏览器实测） | 16 |
| `node scripts/_dbg-daq-rowstyle-verify.mjs` | 数采行样式 + 设置页三节拍 | 10+6 |
| `node scripts/_dbg-daq-intervals-func.mjs` | 三节拍（采集/WS下发/趋势刷新）独立热生效 + 下限钳制 + 详情页按节拍实测重拉 | 13 |
| `node scripts/_dbg-town-smoke.mjs` | 数字孪生画布/场景钩子/帧推进 | 5 |

---

## Phase 3 协议与数采/数控全栈（真实模拟工况，对 :3001）

前置：0.1 + 0.3 + 0.4 + 0.5 + 0.6 + 0.7。

| 脚本 | 覆盖 | 基线 |
|---|---|---|
| `NO_PROXY='*' node scripts/_dbg-protocol-matrix.mjs` | 5 协议 DAQ 读取 + 4 路 DCW 读/写闭环（modbus-tcp SP→PV 真收敛） | 全绿 |
| `NO_PROXY='127.0.0.1,localhost' node scripts/_dbg-live-line-e2e.mjs http://127.0.0.1:3001` | S1 夹具→S2 协议连通→S3 数采落库→S4 五路数控→S5 Agent 闭环(CLOSEDLOOP-OK)→S6 HITL 真实写入 | 37 |
| `AW_E2E_TOKEN=… NO_PROXY='127.0.0.1,localhost' node scripts/e2e-plc-plugin-closedloop.mjs` | A 插件健康 / B 产线供给 / C 数采交叉核对 / D 真实诊断 / E 知识闭环 / F 参数逐键热生效 / G Channel 级开关 | 71 |
| `AW_E2E_TOKEN=… NO_PROXY='127.0.0.1,localhost' node scripts/production-closed-loop-e2e.mjs` | 生产闭环增强：事件自动诊断(source=auto)→kb_search→dcw_control(HITL)→回写 | 23 |
| `AW_E2E_TOKEN=… NO_PROXY='127.0.0.1,localhost' node scripts/three-system-e2e.mjs`（可选 `--full` 走 omp 真实诊断） | AW × 深度诊断 × rag-knowledge 三系统；插件启停热重载 | 52 |

---

## Phase 4 Agent / Harness 多引擎（真实 LLM，最耗时）

前置：0.1 + 0.7；zhipu 配额 429 时当日 12:45 重置后重跑。

| 脚本 | 覆盖 | 基线 |
|---|---|---|
| `NO_PROXY='127.0.0.1,localhost' node scripts/e2e-agent-team.mjs --base http://127.0.0.1:3001` | 团队 CRUD/批量部署/lead 分发/worker 真实执行/409 冲突 | 25 |
| `KEEP=1 node scripts/_dbg-opslog-agent-e2e.mjs`（自起隔离实例 :3021；占用则先清理） | Agent 归属(actor=Channel/成员) + ops_log/recipe_log 工具注入 + **四引擎真实 LLM**（omp/codex/dsh/opencode 全 COMPLETED） | 39；耗时 ~11 min |
| `NO_PROXY='127.0.0.1,localhost' node scripts/_dbg-multiharness-live-e2e.mjs` | 四引擎并行真实 Modbus：OMP-CLOSEDLOOP-OK / CODEX-WRITE-OK / DSH-DAQ-OK / OC-RECIPE-OK + PLC 回读断言 | 四标记全出现 |
| `NO_PROXY='127.0.0.1,localhost' node scripts/e2e-hitl-live.mjs` | HITL 实时审批链 | 全绿 |

**验收要点**：所有任务终态必须 COMPLETED。出现 CANCELED/FAILED 即回归（历史根因：codex 无 host 工具面+600s 停滞误杀；dsh 无 MCP client 靠交付兜底收口——已修，勿再引入）。交付物必须含各场景 OK 标记。`KEEP=1` 保留现场便于查证，查完清理。

---

## Phase 5 子系统专项

| 脚本 | 前置 | 覆盖 | 基线 |
|---|---|---|---|
| `npx tsx --tsconfig .nuxt/tsconfig.server.json scripts/e2e-aml.ts`（真实链路加 `--real`，首次数分钟） | 0.1 + 0.7 | AML：数据集→隔离拒绝→训练→门禁→排行榜→晋升/预测守卫→审计 | 全绿 |
| `AW_E2E_TOKEN=… node scripts/aml-ui-smoke.mjs` | 0.1 | AML UI 冒烟 | 全绿 |
| `NO_PROXY='127.0.0.1,localhost' node scripts/_dbg-recipe-e2e.mjs`（自起隔离实例 :3021） | 0.1 | Recipe 版本流/归因/Agent 更新与回滚/line_context | 24 |
| `SIM_BASE=http://127.0.0.1:4010 NO_PROXY='127.0.0.1,localhost' node scripts/experiment-castfilm-closedloop.mjs` | 0.4 | 挤出流延孪生闭环优化实验 | 收敛达标(J≈96%) |
| rag 专项（手工三项） | 0.5 | ① `/health` vector.ready=true；② kb_search 用语料词法重叠词命中>0（无重叠 0 命中是设计）；③ kb_store 后可检索回 | 三项过 |

---

## Phase 6 TUI / CLI / 打包链路

| # | 动作 | 命令/基线 |
|---|---|---|
| 6.1 | TUI 无头 e2e（dev :3000） | `node scripts/tui-smoke.mjs --base http://127.0.0.1:3000`（生产时 `AW_TUI_EMAIL=admin@awshop.local AW_TUI_PASSWORD=admin123`） |
| 6.2 | 全局 `aw tui` 真实路径 | 全局包已装时：`node scripts/e2e-aw-tui-global.mjs --base http://127.0.0.1:3001` |
| 6.3 | CLI 面 | `aw doctor` / `aw status` / `aw config get <key>` 输出与文档一致；`aw plugin disable rag-bridge` → 1s 内路由+工具消失 → `enable` 恢复（热生效实测） |
| 6.4 | aw start 打包冒烟 | `AW_E2E_TOKEN=… NO_PROXY='127.0.0.1,localhost' node scripts/aw-start-smoke.mjs`（前置 0.1 + dev-plc-simulator :15040）基线 26 |

---

## Phase 7 浏览器目视验收（Puppeteer 截图逐页过目）

覆盖页：登录/仪表盘/产线管理/数采列表+详情（趋势图在动）/数控/数字孪生（帧推进+无黑屏）/设置（分组渲染+折叠+来源徽标）/插件/运维日志 /logs/AML/AgentTeam。
工具：`scripts/ui-screenshot.mjs`、`scripts/_dbg-audit-all-pages.mjs`（全页 console error 扫描=0）。截图存 `.e2e-shots/` 逐张目视；破版/白屏/控制台报错即红项。

---

## Phase 8 发布链路（仅当次有版本变更时执行）

1. `npm run build` 通过；2. commit（pathspec 限定）+ push（`git -c http.proxy= push`）；3. `npm publish --no-proxy --https-proxy=null --proxy=null`（本地 7890 会拦 PUT；CDN 传播 5–7 min，期间安装 404 属正常）；4. `npm i -g agentworkshop@latest --no-proxy`；5. 全局 `aw start`（home 模式）健康门 + 抽样回归（P2 的 api-live + P3 的 protocol-matrix）；6. 复核 npm 页面版本与 tarball 内容（`files` 白名单）。

---

## §8 排障速查（历史实锤，先查这里再动手）

| 症状 | 真相与处置 |
|---|---|
| 产线报「运行中」但数采不采、start 返回 CONFLICT | 重启后旧批次 LineRun 丢失不自动恢复采样（设计现状）→ 该产线 **stop→start** |
| produced 恒 0 | 数采受批次门控：无活动批次不采样是设计，非故障 |
| 部分节点 value=null 且 lastError 为空（静默不采） | 曾是网关 sweep 额度饿死（已修 isDue+游标+并发64）；复现先看节点在表的位置与并发额度 |
| rag /health 超时 30s+，连带闭环 Stage E 全线超时 | rag 后端挂死 → rag 项目根 `node command/ragctl.js restart backend`；恢复后 ~170ms |
| kb_search 0 命中但系统正常 | 两阶段检索 stage1=BM25 词法；查询与语料无词法重叠时**有意** 0 结果；换语料词重试 |
| hnsw "Nothing found on disk" | 进程被杀时 embeddings_queue 未落盘（数据丢失）→ reindex force 重建；健康面应显示 vector.ready=false 预警 |
| LLM 任务 FAILED with 429 | zhipu 配额限流，当日 12:45 重置后重跑；勿改代码 |
| codex/dsh 终态 CANCELED 但交付物完整 | 已根修（codex 无条件 CODEX_HOME 种子+停滞 1800s；dsh 交付兜底收口）。复现即回归，查是否有新提交动过 agents/runtime |
| 工具调用报「未知工具」集中在插件重载窗口 | 插件热重载空窗（已修：注销延后）；复现即回归 |
| agent-tools/invoke 404 或参数不识别 | body 键是 **args**（非 arguments）；agentId 用 channel 成员**实例 id**（非模板 id） |
| api-live 持久化段被清 | 脚本预清理吞 `api-e2e-*` 前缀频道；夹具勿用该前缀 |
| 双绑定 15030 竞态 / 3002 全局包陷阱 / mini-slave 须回显事务 id | 协议模拟器纪律，见协议驱动记忆 |
| npm publish/install 被 7890 拦 | `--no-proxy --https-proxy=null --proxy=null`；git push 用 `-c http.proxy=` |
| dev 起服务 500 找不到 `D:\shared\*.mjs` | nitro 相对导入打包坑：须 `@/` 别名（勿用裸相对路径） |
| tsx 报类型/import 错 | 必须带 `--tsconfig .nuxt/tsconfig.server.json` |

---

## 执行指令模板（给 agent 下达时用）

- 全量：「按 docs/full-test-plan.md 执行 Phase 0–7 全量测试，产出 docs/test-report-<版本>.md」
- 冒烟：「按 docs/full-test-plan.md 执行冒烟档（§0 两档执行模式）」
- 单阶段：「按 docs/full-test-plan.md 只跑 Phase 4」
- 失败处置约定：阻断性失败（服务起不来/P0 环境缺）→ 停下修复后再继续；单脚本红 → 先按 §8 排障表定位，能修则修复并复跑该脚本+相邻脚本；不能修 → 报告标注 FAIL+根因假设，继续后续阶段。
