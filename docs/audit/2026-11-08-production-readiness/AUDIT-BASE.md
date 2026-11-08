# 生产就绪审计底稿（2026-11-08 · :4001 隔离实例 + main 84670613 代码）

> 方法：8 项外部指控逐项核验（3 个并行探查代理 + 主审计亲验）+ 全局生产风险扫描 + 活体复现。
> 所有结论带 文件:行号 或实测记录。证据分「静态代码」与「活体实测」两档。

## 一、八项指控裁决总表

| # | 指控 | 裁决 | 级别 | 关键证据 |
|---|---|---|---|---|
| 1 | 插件热重载非原子/6秒空窗/无回滚 | **部分真实** | P1 | reload.mjs:33-96 全量 clear→load 实证；实测 POST enable/disable 各阻塞 ~6.06s；omp 工具面已有「先载新集后清旧」缓解（reload.mjs:72-96 注释自认曾致生产 Stage D 失败）；插件 HTTP 路由/manifest/daq-dcw 驱动在窗口期缺位（实测 drivers 10→9→10，未归零）；rollback.mjs 仅单插件半装载回滚，**宿主级版本快照回滚不存在** |
| 2 | watcher 监听错目录/外部热载失效 | **真实** | P1 | snapshot.ts:29-30 非递归 watch(root) + watch(root/data 遗留布局)；生效配置在 `<root>/.AgentWorkShop/runtime-settings.json`（home.mjs:93）→ 外部/CLI 写入永不触发；CLI 却打印「实时生效」（cli/commands/config.mjs:111，虚假确认）；无手动 reload HTTP 端点；schema 143 键中 96 个 restart，harness.* 12 键全 restart |
| 3 | Harness 构造顺序 bug/one-shot 崩溃 | **真实** | **P0** | base-agent.ts:83 构造器调 refreshIdentity→this.harnessId；one-shot-cli-agent.ts:141-143 getter 读 this.spec（super 返回前未赋值）→TypeError；registry per_turn 家族 6/14 引擎（gemini/copilot/cursor/crush/goose/pi）全中；**活体实测**：gemini lead 创建→activate 返回 500 且阻塞 43.4s，进程未死但引擎完全不可用；restore() 路径（schedules.ts:34-41 无逐 channel 兜底）可 unhandledRejection→启动崩溃循环；回归引入 6c590494(2026-10-31)，8 天无拦截=零契约测试（tests/ 零命中，CI 只跑 lint+unit） |
| 4 | Codex provisioning mkdir 在 copy 后 | **部分真实** | P1 | codex-agent/client.ts:113-129：copyFileSync(:123) 先于 mkdirSync(:129) 属实，首用必触发；但 try/catch(:125) 吞掉→**静默种子丢失**非崩溃；次生更重：CODEX_HOME 在 spawn 前计算（:43-49）而 codexHome 到 :119 才写入→首回合跑全局 ~/.codex 且无 MCP 桥（host 工具闭环断裂，:108-111 注释自认桥是唯一入口）；显式 codexHome 者免疫 |
| 5 | 成果提交时序缺口/项目卡死 | **真实** | P1 | releaseTaskInstance(service.ts:1361+) 置 `UPDATE channels SET enabled=0`(:1393)；requireAgentContext(:4069) 之后对实例成员全关；draft 依赖 ensureDraftFromTask→**实例 lead 的提交窗口在 root 终态微任务链内关闭**，仅剩 owner/admin REST（integrator 路径）；自主模式（owner 不值守）下成果永远 draft→交付物门不放行→项目卡 completed 之前。多会话验收轮已用 owner REST 绕过（驱动证据佐证） |
| 6 | 事件协议无结构化 Block | **真实** | P1 | a2a.ts:9-13 Part 仅 text/data/url/raw；omp event-mapping.ts:70,103,112 `🔧`文本+300字符截断；各 harness 文案互不一致（claude 无参数预览/opencode 成功即静默/cursor `✓`）；前端 classify.ts:7 + ClusterTool.vue:14-21 正则反解，omp 结束行「🔧 bash ✅ 完成: …」正则失配退化为通用 tool；完整审计仅 opt-in 环境变量（AW_AGENTTEAM_EVENT_LOG/AW_GOV_HARNESS_EVENT_LOG 默认关） |
| 7 | UI 与后端能力不一致 | **部分真实** | P2 | 后端 registry 14 引擎（registry.ts:127-268）+ 动态接口 /api/workshop/harnesses 已存在且模板管理页已消费；但三处硬编码：Project Leader 选择 4 项（projects/index.vue:124-139，缺 10）、Channel 默认 LLM 4 项（ChannelSettingsModal.vue:351，缺 9）、泳道添加成员 3 项（AddMemberModal.vue:21）；终端 omp-only 是三层一致的能力声明（registry terminal:true 仅 omp + LaneHeader.vue:143）=设计而非缺陷 |
| 8 | Project 默认 leaderHarness:mock | **真实** | P1 | service.ts:609 `input.leaderHarness ?? 'mock'`（+628,3888 三处）；API schema 仅 optional 无约束；用户不选即静默得到测试替身做生产 leader |

## 二、全局扫描附加发现（非指控清单内）

| 发现 | 级别 | 证据 |
|---|---|---|
| 备份任务在定时器内同步遍历+同步拷贝（dirBytes/cpSync） | P1 | backup.ts:21-80,261；大 daq-objects 目录冻结事件循环（既往实测：实例启动须 BACKUP_DISABLED=1） |
| 无全局 HTTP 限流 | P1 | 仅 MES 模板配置内部有 rateLimitPerSec 概念；406 个 workshop 端点暴露无节流 |
| Timescale 缺省口令 'awshop' | P2 | server/plugins/daq.ts:71 `password: raw?.timescale?.password ?? 'awshop'`（内网默认凭据） |
| activate 类长阻塞请求无超时上限 | P1 | 实测 43.4s；调用方/网关层若 30s 超时会误判失败而服务端继续 |
| 设置热更主链路 OK（3s TTL 内存生效） | 正面 | settings.ts:18-45；settingsPath guard 空/短密钥 fail-loud（security.ts:43-48） |
| SQLite WAL+busy_timeout 4s+BEGIN IMMEDIATE 事务 | 正面/已知 | open.ts:18, transaction.ts:20 |
| 迁移机制完备（migrations.ts 系列幂等） | 正面 | db/database/ |

## 三、活体实测记录摘要
1. 插件 toggle：POST 6.06s×2；并发探测 daq drivers 无归零（10→9→10，9=禁用插件驱动移除的合法态）；enable 后 773ms 内驱动再注册窗。
2. one-shot 复现：gemini lead 创建 200→activate 500/43.4s→进程存活；队列残留 idle lead 行。
3. （初报纠正：插件列表「归零」系审计脚本解析错键（该端点无 data 包裹），已撤销；教训入方法论。）

## 四、待专家评审问题
1. P0（6/14 引擎不可用+启动恢复风险）是否应在上线前阻断？修复窗口多长合理？
2. 指控5 的正解取向：扩宽提交窗口（release 延迟/宽限期） vs owner REST 为准绳+自主模式补自动 integrator？
3. 结构化工具块（指控6）的最小可行改法（不动 A2A 全协议的增量方案）？
4. 我方扫描是否有被忽略的生产阻断项？
