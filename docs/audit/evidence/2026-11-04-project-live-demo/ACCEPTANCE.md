# Project 层实机验收规范（2026-11-04）

> 目标：验证 AgentWorkShop 的「产线集成」与「Project 业务」在真实进程、真实 HTTP、真实 LLM 下可运行；并验证不依赖产线的普通开发任务（贪吃蛇落地页）能由 Project 自主构建并交付。
> 原则：只以可复现命令 + 自动断言 + 工件为证据；人工截图/口头声明只能作辅助证据。任何 P0 缺陷导致的门失败，整条线判 FAIL，不得算“部分通过”。

## 1. 范围与隔离

| 项 | 要求 |
|---|---|
| 实例隔离 | 独立 `AW_HOME` + 独立端口；不得触碰正在运行的生产实例（本机 3300） |
| 数据隔离 | 不读写生产 home 的 `workshop.sqlite`；验收数据只落在验收 home |
| 外部依赖 | 产线线体/通道/配方均由 API 创建；纯开发任务不得绑 `lineId` |
| 真实 LLM | Track B 的 project leader 与 channel lead 必须为 `omp`（非 mock）；允许单回合失败重试，但不得用人工代填计划/成果冒充自主 |
| 手工改库 | 禁止；所有状态迁移必须经 REST/tool 调用完成 |

## 2. Track A：产线集成验收

| 门 | 名称 | 强制 | 通过标准 | 证据 |
|---|---|---|---|---|
| A0 | 隔离实例就绪 | 是 | `GET /api/health` 返回 `status=ok, workshop=ready`；端口不是 3300 | 日志 + health JSON |
| A1 | 产线治理 E2E | 是 | `scripts/e2e-line-governance.mjs` 全部断言 pass；重点覆盖 line_start/stop HITL、审批期换线取消、配方快照、DAQ/DCW 写读、步限/量程、agent token 自证 | 脚本 stdout + summary |
| A2 | 项目 × 产线 E2E | 是 | `scripts/e2e-project-line-acceptance.mjs` `fail=0`；45 pass / 2 blocked 中的 blocked 必须明确是“未实现能力”（UI 完整交互、G6 Live），不得是业务失败 | 脚本 stdout + JSON |
| A3 | 关键不变量抽查 | 是 | line→channel→project 绑定可读；派发 root 带 `source=project` + `projectId` + `projectWorkItemId` + `attemptNo` + `traceId`；办公室频道删除/禁用 409；非 owner/跨线写 403 | E2E 断言 + 手工抽查 |
| A4 | 生产实例未受影响 | 是 | 验收前后 3300 实例仍健康；验收 home 与生产 home 不同 | 端口/进程记录 |

**Track A 判定**：A1/A2 无 fail 且 A3/A4 通过 → PASS；任一强制门失败 → FAIL。

## 3. Track B：纯开发任务（贪吃蛇落地页）

> 目标：不绑产线，创建纯协作 Channel；Project leader（omp）自主提出计划，owner 批准；leader 提案派发；Channel lead（omp）执行并产出可打开的落地页；成果经 leader 复核、owner 验收；项目完成。

| 门 | 名称 | 强制 | 通过标准 | 证据 |
|---|---|---|---|---|
| B0 | 纯协作 Channel + 隔离实例 | 是 | Channel 创建时无 `lineId`；health ready；与 Track A 不同 home/端口 | channel JSON |
| B1 | leader 自主提案 | 是 | 仅通过 Office 群聊 mention 触发；leader 调用 `project_propose_plan`，产生 `plan_approval` + `plan.proposed` decision；计划含 ≥1 交付物；不得人工代填 | chat + approval + decision |
| B2 | owner 批准 + 物化 + 激活 | 是 | 批准后 `planVersion` 增加；交付物落库；`activate` 成功 | project/deliverable JSON |
| B3 | 派发提案 + owner 应用 | 是 | leader 调用 `project_propose_dispatch`；owner apply；work item 创建；root task `source=project` 且带项目上下文 | decision + work item + task JSON |
| B4 | Channel lead 执行 | 是 | root task 进入 COMPLETED；work item 进入 COMPLETED；产物 HTML 写入 Channel workspace | task + FS 工件 |
| B5 | 成果闭环 | 是 | draft → submitted（evidence 非空）→ leader reviewed → 验收审批 → owner approved；deliverable approved | result + approval JSON |
| B6 | 项目完成 | 是 | owner 发起完成审批并批准；project `status=completed` | project JSON |
| B7 | 落地页质量 | 是 | HTML 含 `<canvas>`、JS 游戏循环、键盘控制（方向键/WASD）、得分、开始/暂停/重开；无外部网络依赖；浏览器打开无 `pageerror`；截图成功 | 静态检查 + Playwright 截图 |
| B8 | 审计与权限 | 是 | decisions/events 覆盖 plan/dispatch/result/approval/complete；`traceId` 非空；无手工改库；无自批；审批 payload API 可读 | audit JSON |
| B9 | 流程合理性 | 是 | 无越权写；无重复派发/重复 root；计划版本不被回退；工作项无“未派发即 BLOCKED” | 审计 + 状态检查 |

**Track B 判定**：B1–B9 全通过 → PASS；B4 产物不存在或 B7 渲染失败 → FAIL；若 B5/B6 因已知 P0 缺陷（attempt 不闭合、完成门死锁）失败 → FAIL 并记录缺陷。

## 4. 总判定

| 结论 | 条件 |
|---|---|
| GO（可集成试点） | Track A PASS + Track B PASS；无新增 P0 |
| CONDITIONAL（可演示，需修复） | Track A PASS + Track B 核心通过但存在 P1/P2；给出修复清单 |
| NO-GO | 任一强制门失败，或出现越权写/跨线写/手工改库/自批 |

## 5. 证据清单（落盘）

- `acceptance.json`：逐门 pass/fail/blocked、详情、时间戳、最终判定
- `track-a-line-governance.log` / `track-a-project-line.json`
- `track-b-state.json`：project/channel/deliverable/work item/root/result/approval IDs
- `artifacts/`：从 Channel workspace 复制的 HTML
- `screenshots/snake-landing.png`
- `audit.json`：decisions/events 摘要
- 复现命令：见 `README.md`（本目录）
