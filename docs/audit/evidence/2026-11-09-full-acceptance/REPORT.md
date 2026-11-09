# 全系统功能验收 · RSI + Project + Session 隔离（2026-11-09）

- 代码版本：`625eb906617bd18552ecf3a65ecd03a023064990`（`origin/main`，本地/远端一致）
- 运行方式：生产构建 `.output` + 隔离 `AW_HOME`（每个套件独立临时 home，`NUXT_SESSION_PASSWORD` 随机 ≥32 位、`BACKUP_DISABLED=1`）
- Harness：`omp` @ `ustc/deepseek-flash`（真实 LLM；provider 实测单回合 40s–4min）
- 判定：**功能面 PASS**；已知限制见 §6（不宣称安全，不宣称全 T2 套件覆盖）

## 1. 静态与契约层（T0/T1）

| 门禁 | 命令 | 结果 |
| --- | --- | --- |
| 代码规范 + RSI 红线 | `npm run lint` | ✅ 0 error；红线扫描 18 个学习环文件 0 处设备写 |
| 类型 | `npm run typecheck` | ✅ 通过 |
| 文档一致性 | `npm run docs:check` | ✅ 87 通过 / 0 失败 |
| i18n | `npm run i18n:check` | ✅ zh/en 3293/3293，unresolved 0 |
| README | `npm run readme:lint` | ✅ 全部通过 |
| 单元 | `npm run test:unit` | ✅ 1358 tests / 1356 pass / 0 fail / 2 skip |
| MCP 契约 | `npm run test:mcp` | ✅ |
| 插件生命周期 | `npm run test:plugin-lifecycle` | ✅ 22/22 |
| SDK 出口面 | `npm run test:sdk-surface` | ✅ |
| Twin provider | `npm run test:twin-provider` | ✅ |
| skills 规范 | `npm run test:skills` | ✅ 167 PASS / 0 FAIL |

## 2. RSI 真实环境端到端（主证据）

- 脚本：`scripts/acceptance-rsi-live-e2e.mjs`（生产构建 + 隔离 home + 真实 HTTP/SQLite + DCW/DAQ mock 产线）
- 结果：**32/32 PASS**
- 覆盖：任务→经验自动沉淀（candidate）、经验门 fail-closed（单任务拒晋级）、项目任务实例 + write_intent + HITL（line_start/recipe_trial 设备证实）、C1 独立回读 mismatch 阻断 L1 review、match 正向放行、评审经验 + kb_ingest、证据合并→validated、同线跨 Channel 可读/异线零命中、B2 配对评测、B3 shadow→active 门、B4 回滚、C3 元层成功率、C1 台账、DB 审计、学习环 0 设备写红线。
- 证据：[report.md](2026-11-09-rsi-live-e2e/report.md) / [report.json](2026-11-09-rsi-live-e2e/report.json) / [运行日志](rsi-live-e2e.log)
- 报告内代码版本自证：`625eb906…`

## 3. Project 全链（两种执行面）

### 3.1 mock 执行面（前端 + 内核 + 验收门）

- 脚本：`scripts/_audit/project-landing-live.mjs`
- 结果：**39/39 PASS**（本轮同 commit 复跑）
- 覆盖：蓝图三频道（产品设计/前端开发/质量走查）→ 实例化 active → W1 设计规范 artifact → 对账 draft → 提交 → L1 → **technical 门 409 实证** → W2 落地页 HTML → W3 走查报告 → L2 签核 → completed；列表 summary 3/3、observability 全 accepted；浏览器入口/侧栏高亮/五 tab/390px 无横向溢出/零 pageerror。
- 证据：[2026-11-09-project-landing](../../2026-11-09-project-landing/project-landing-live.md)

### 3.2 omp/ustc-deepseek-flash 真实 LLM 执行面

- 脚本：`scripts/_audit/omp-project-single-live.mjs`
- 结果：**13/13 PASS**
- 覆盖：omp Channel（provider/model/effort 落库）→ Project（Leader=omp）→ 绑定 → 交付物/工作项 → 激活 → 计划门 v1 → 派发到任务实例 → **LLM 619s 完成并交付 artifact（PROJECT-SINGLE-OK）** → 对账 draft → 提交 → 独立 admin L1 → L2 签核 → completed。
- 证据：[omp-single-report.json](omp-single-report.json) / [运行日志](omp-single.log)

### 3.3 Project 手工创建的两个易踩门（已验证）

- 手工项目默认 `draft`：**必须先 `POST /projects/:id/activate`**（≥1 绑定频道 + ≥1 必选交付物）才能派发。
- 默认 `planApprovalRequired=1`：**必须先 request→approve plan v1** 才能派发；审批计划体不要携带 `deliverables/work_items`，否则 plan alignment 会物化出重复工作项（实机踩坑：2 手工 + 2 对齐 = 4 项）。

## 4. Session 隔离（真实 LLM）

- 脚本：`scripts/_audit/omp-channel-project-session-live.mjs`（会话段通过；双工作项段因 provider 延迟改为单工作项长预算补证）
- 结果：会话段全 PASS
  - 同 Channel 建 2 个会话，`memberMap` 克隆 ID 互不相同
  - 会话 A 收到 `ALPHA-… 已收到。`、会话 B 收到 `BETA-… 已收到。`（**真实模型输出**）
  - A 历史无 B token、B 历史无 A token（零串扰）
  - 关闭会话释放 clone runtime
- 任务实例隔离：两个工作项 → 不同 instance Channel / 不同 session / 不同 task（O17 PASS）；单工作项长预算运行中完成 artifact 且无跨任务污染。
- 证据：[omp-channel-session-partial.log](omp-channel-session-partial.log) / [omp-channel-project-session/report.md](../../2026-11-09-omp-channel-project-session/report.md)（若存在）

## 5. 回归面 / 插件工具面 / 发布冒烟

| 项 | 结果 |
| --- | --- |
| 鉴权矩阵 `scripts/e2e-auth-matrix.mjs` | ✅ 29 pass / 0 fail（1 skip：game 端点已移除） |
| REST 鲁棒性 `scripts/e2e-rest-robustness.mjs` | ✅ ALL PASS（校验/鉴权/作用域/8 并发闭环/幂等/级联） |
| 插件清单 `/api/workshop/plugins` | ✅ 11 plugins 全 enabled、0 error、21 plugin tools |
| 工具注册表 `/api/workshop/tools` | ✅ 148 total（127 builtin + 21 plugin），全部 available |
| 发布冒烟 | ✅ `GET /`=200；`GET /api/workshop/aml`=401；缺 `NUXT_SESSION_PASSWORD` 生产模式拒绝启动（exit 1，安全屏障） |

## 6. 已知限制 / 未覆盖面（如实声明）

1. **provider 延迟**：`ustc/deepseek-flash` 单回合 40s–4min（reasoning）；并行多个 omp 进程会互相拖慢。双工作项并行版本因超预算中止（非产品失败），已用单工作项 25 分钟预算补证 13/13。
2. **T2 全量套件未全跑**：科学探索/本体/优化器/注塑/IDD 结果库等依赖外部模拟器或后端，本轮按变更面（RSI/Project/Session/前端）裁剪；未跑不等于通过。
3. **安全**：Mimosa 深度扫描为静态边界（`static_only_no_runtime_execution`），全仓存在存量命中；本轮改动文件 0 新增命中，但**不宣称系统安全**。
4. **ultragoal**：`.omc/ultragoal` 计划/账本保留；checkpoint 协议要求 Claude `/goal` 快照，本环境无该命令，未伪造快照，故未推进账本状态。
5. **前端交互演示**：[interactive-demo.gif](interactive-demo.gif)（17.6s，项目中心→详情→计划看板→交付物→事件流）+ [demo-final-frame.png](demo-final-frame.png)。截图集见 `2026-11-09-project-landing/`。

## 7. 复现命令

```bash
# 0) 基线
git fetch origin && git rev-parse HEAD   # 期望 625eb906
npm run build

# 1) 静态/单元
npm run lint && npm run typecheck && npm run test:unit
npm run docs:check && npm run i18n:check && npm run readme:lint
npm run test:mcp && npm run test:plugin-lifecycle && npm run test:sdk-surface && npm run test:twin-provider && npm run test:skills

# 2) RSI 全链
node scripts/acceptance-rsi-live-e2e.mjs

# 3) Project（mock 执行面）
node scripts/_audit/project-landing-live.mjs

# 4) omp 真实 LLM（Channel/会话隔离；单工作项长预算）
node scripts/_audit/omp-channel-project-session-live.mjs
node scripts/_audit/omp-project-single-live.mjs
```
