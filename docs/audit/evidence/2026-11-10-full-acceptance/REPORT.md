# 全功能实机验收报告（2026-11-10 · main `91b1f116`）

> 覆盖：PR #126（WP-D2 改进提案链）与 #127（验收证据）合并后的最新主干；Plan 新增功能全量回归、
> Project 模式 + 多 Channel session 隔离、多 harness 引擎适配、Agent 生命周期对象隔离、
> 前后端交互演示 + **computer use 实机桌面作业**。
> 实例：隔离 home `.deep-home-20261110`（复制自 2026-11-08 原始库）+ **:4013**；设备层为 PLC 模拟器孪生（:4011）。

## 一、合并与部署

| 项 | 结果 |
|---|---|
| PR #126（WP-D2 改进提案链） | **已合并**（CI quick-gate pass） |
| PR #127（2026-11-09 验收证据 + docs 修复 + 驱动修正） | **已合并**（CI quick-gate pass） |
| 最新 main | `91b1f116`（本地分支已 ff 同步） |
| 构建 | `npm run build` ✔（v0.10.0，logs/t5-build.log） |
| 实例 | `:4013` health 200 / workshop ready / 139 channels；**工具面 148 = 127 builtin（+1 improvement_list）+ 21 plugin，全 available** |

## 二、本轮结果（全部在 main `91b1f116` 构建上）

| 套件 | 结果 | 证据 |
|---|---|---|
| T0 lint / typecheck / docs:check / i18n / readme:lint | **全过**（docs 87/0 · i18n PARITY） | `logs/t0-*.log` |
| T1 unit | **1302 pass / 0 fail / 2 skip**（较上轮 +49：#126 improvement 契约测试） | `logs/t1-unit.log` |
| T1 mcp / plugin / sdk / twin / skills | 14 pass · 22:0 · ✔ · 5 pass · 167 PASS | `logs/t1-test-*.log` |
| Channel 多 harness + 对象隔离 | **24/24** | `harness-isolation.json` |
| Channel 模板多会话（并行真 LLM + HITL 写） | **20/20** | `channel-multisession.json` |
| Project 记账软件交付（3 频道/3 工作项/真实 Python） | **58/58** | `bookkeeping.json` |
| Project 蓝图一键实例化 + technical 门 | **PASS（17 步，final=completed）** | `blueprint/blueprint-live.json` |
| 产线文档 → Channel → Project（涂布线） | **48/48** | `doc-to-project/doc-to-project.json` |
| CAL-3 四期真实产线递进 | **78/78 全绿** | `cal3/staged.json` + `logs/cal3.log` |
| T3 api-live / agent-team / template / robustness | **75/75 · 25/25 · 38/38 · ALL PASS** | `logs/t3-*.log` |
| T4 插件/工具/harness | 11/11 enabled、failures=[]；148 工具全 available；14/14 harness | `t4-surface.json` |
| T5 pack / nopass 屏障 / prefix | 4714 files；`NODE_ENV=production` 缺密码 exit 1；隔离 prefix 0.10.0 | `logs/t5-*.log` |
| UI 交互（headless Chrome） | **12/12** | `ui/ui-results.json` |
| **computer use 实机桌面作业** | **3 屏**（登录→Channel 控制台→Project 详情） | `ui/desktop-cu-*.png` |

### 2.1 CAL-3 78/78（上轮 77/78 红项关闭）

本轮 W2 下发后距 W3 取证窗口更长（文档约束等待 123s + 300s 闸），PV 有足够沉降，`W3-t3` 通过——结合 11-09 两轮 77/78（28s 窗 783.2 / 沉降窗 773.0），证实 **W3-t3 是调度时序敏感的判据**，不是写控缺陷：设备 SP 始终精确写中（W2-t4）、零写保持（W3-t2）。300s/60s 节拍闸本轮继续真实生效（等待 123s / 57s）。

### 2.2 Project + 多 Channel session 隔离（本轮实测）

- 模板实例化频道 → 双会话克隆成员（cloneId 互异、绑定面继承）→ 双会话**并行真 LLM 对话**（omp）→ 会话 A 内 `recipe_trial` HITL 批准 → 设备回读收敛 → 关闭 B 后 B 克隆全部 `enabled=0` 且 invoke 被拒，A 与基础成员不受影响。
- 记账软件 Project：需求/开发/测试三频道 + W1→W2→W3 dependsOn 链，L1（独立 admin）→ L2（owner）双签 → `completed`，真实 `ledger.py` Python 执行 PASS。
- 蓝图：保存 → `instantiate` 直接 `active` + 3 工作项 → 未 review 上游派发 **409 TECHNICAL_REVIEW**（负例）→ 全链到 `completed`。
- computer use 实机页面同时可见：Project 会话目录 4 个 session（1 project + 3 task 收口分支）、任务实例频道、周报与项目快照（100%/100%）。

### 2.3 computer use 实机桌面作业（本轮新增）

真实桌面 Chrome（非 headless、非 CDP 注入），通过 computer use 完成：
1. **实机登录**：AX 定位登录表单 → `setValue` 邮箱/密码 → 点击「登 录」→ 进入工作区（`ui/desktop-cu-login.png`）；
2. **Channel 控制台**：键盘导航到 `/workshop/w/...?channel=...`，控制台完整渲染（会话列表 13 频道、mock lead 回复、composer、OPEN seq 23）→ `ui/desktop-cu-channel.png`；
3. **Project 详情**：打开 completed 项目（W1/W2/W3 全部已验收、100%/100%、Leader 对话、周报、4 session）→ `ui/desktop-cu-project.png`。

## 三、发现（如实）

| # | 发现 | 定性 |
|---|---|---|
| F1 | completed Project 持有频道绑定导致 409，本轮仍手工解绑 6 个频道 | **P0 保持**（自动释放未实现） |
| F2 | CAL-3 W3-t3 判据调度时序敏感（77/78×2 → 78/78） | 判据不稳，非写控缺陷；建议判据改为“SP 精确 + 方向/工艺带” |
| F3 | 工具面 126→**127** builtin（+improvement_list），48 工具/服务契约测试 +49 | #126 新面按预期落地 |
| F4 | unit 在并发实例下曾出现 http-drivers flake（上轮）；本轮全量 1302/0 一次过 | 测试隔离建议保持 |
| F5 | 本轮未重跑 ontology/model loop/optimizer/IDD（上轮 87/53/105/36 全绿） | 范围外，未回归 |
| F6 | Mimosa 未在本轮重跑（上轮 inconclusive/partial） | 不宣称安全通过 |

## 四、证据索引

```
docs/audit/evidence/2026-11-10-full-acceptance/
├── REPORT.md
├── harness-isolation.json · channel-multisession.json · bookkeeping.json
├── blueprint/blueprint-live.json · doc-to-project/doc-to-project.json
├── cal3/staged.json (78/78) · t4-surface.json
├── ui/  (u1-u9 + ui-results.json + desktop-cu-login/channel/project.png)
└── logs/ (t0/t1/t3/t5/cal3/instance 全套)
```

## 五、结论

- **Channel**：多 harness 适配、多会话隔离、Agent 生命周期对象隔离全部通过（24/24、20/20）。
- **Project**：交付全链、蓝图、文档→项目全部通过（58/58、PASS、48/48）；CAL-3 四期 **78/78**。
- **#126 新功能**：improvement 面随主干落地（127 builtin、+49 契约测试、迁移在实例启动生效）。
- **computer use**：登录、Channel 控制台、Project 详情三屏实机桌面作业完成并截图归档。
- **不宣称**：Mimosa 未重跑（上轮 inconclusive）；绑定生命周期 P0 未修复；范围外的 4 个 T2 套件本轮未重跑。
