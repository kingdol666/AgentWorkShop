---
name: aw-live-acceptance-round
description: AgentWorkShop 实机集成验收轮(TSA) workflow。当用户要求对当前构建做完整真实作业演示测试——产线数采数控、Channel 治理下发、RSI/经验记忆、AML、Project 编排、跨频道通讯、缺陷回归——按 L1–L8 分层执行并产出证据化报告。触发词:实机验收轮、集成实测、TSA、真实作业测试、全功能演示测试。单产线接入见 aw-line-onboarding,静态+单元六层回归见 aw-system-acceptance。
---

# AgentWorkShop 实机集成验收轮(TSA)workflow

> 本 workflow 是「系统真实功能演示作业测试」的可复用流程:每轮以实际执行输出、commit 和
> evidence 目录为唯一真值;历史基线只作日期化参考。轮次脚本在 scripts/experiments/ 下
> (tsaN-*.mjs 命名)随轮次演进;新轮次克隆最新一轮脚本、只改「轮次常量」小节列出的标识符。

## 环境与实例纪律(先于一切)

- 隔离工作树:git worktree add -b acceptance/tsaN 加 origin/main SHA,CI=true pnpm install 加 npm run build。
- 实例启动:AW_MODE=home、AW_HOME=持久home、AW_ALLOW_PRIVATE_OUTBOUND=1、BACKUP_DISABLED=1、
  NUXT_SESSION_PASSWORD≥32字符(不回显),经 scripts/_audit/detached-start.mjs 真分离启动。
- MCP 前置:确认 `aw_status` 返回 base/鉴权与 `mcpEnabled=true`;未鉴权先 `aw_login`。
  缺 AW_ALLOW_PRIVATE_OUTBOUND=1 时 diag-bridge 对 127.0.0.1 的健康检查被 SSRF 防护拒绝(设计行为)。
- 对 127.0.0.1 的调用带 NO_PROXY='127.0.0.1,localhost'。共享服务(IDD :3210、RAG :8770/:6789、
  MQTT 1883、Timescale 5432)只复用不重启;共享平台实例(3001/3300/4001)禁杀。
- 杀进程前必须 PowerShell Get-CimInstance 核对 CommandLine 归属;只杀本轮拥有的进程树。
- 凭据只从环境变量/私有目录文件读取,不写入源码与证据。

## 轮次常量(每轮必改)

BASE(实例端口)、AW_HOME、频道/线/配方/节点 id、证据目录 docs/audit/evidence 下按
日期-轮次-构建命名的目录、私有工作目录。建模三元组从 home/data/dcw-recipes.json 解析。

## 标准轮次步骤(L1–L8)

### 1. L1 栈健康与桥接

`node scripts/experiments/tsa4-phase-s.mjs`:断言 /api/health 版本号=当前构建;
experience-stats 200 加未鉴权 401;sim twin 可达加归属证明在;重铸 IDD/RAG token 热配双桥;
`aw_plugin_list` failures=[];`aw_status` 工具面计数(桥/通讯/记忆工具)。

### 2. L2 产线治理下发作业

`node scripts/experiments/tsa4-phase-c.mjs`(状态机可断点续跑):C0 装备 → C1 只读巡检
(`daq_query` 经 `aw_agent_tool_invoke` 由 lead 真实取数判读)→ C2/C3 受控调参各一步
(recipe_propose → HITL 卡 → 批准 → 下发 → `aw_dcw_read` 加 `aw_dcw_snapshot` 回读一致)。

### 3. L3 重启对账与写尝试(write-attempt)台账

`node scripts/experiments/tsa4-reconcile.mjs before` → 重启实例 → after:ledger 行数与
outcome 分布重启前后一致,对账日志出现且**绝不自动重发**任何未闭环写。
未闭环分类路径由单测覆盖,本层不伪造中断写。

### 4. L4 治理评测门

`node scripts/experiments/tsa4-bench-gate.mjs`:真实测量 perSeed 落库;伪报汇总值必须 400 拒;
promote→active 无 benchRunId 必须 BENCH_PROVENANCE_REQUIRED;candidate→active 被生命周期门拦;
shadow 晋级成功。`node scripts/experiments/tsa4-bench-hostgate.mjs`:
shadow→active 引用客户端 run 必须 BENCH_NOT_HOST_PROVENANCED。
注意 decision-in-body 语义:断言 body.ok 而非 HTTP 状态码。

### 5. L5 AML 腿

line stop(owner 操作,零写关闭当前 run)→ line start 重开;`node scripts/experiments/tsa4-aml.mjs`:
真实批次数据集(质量报告含覆盖/缺口门)+ hybrid_residual 内置参考训练器小预算作业轮询到终态;
终态与产物分离如实记录。

### 6. L6 Project 编排腿

依赖门是资产:派发被 DEPENDENCY_NOT_READY(上游 FAILED/上游无成果/重试满)拦截属**正确**。
历史缺口重试满项的正解是新建工作项(同 deliverable/channel,新 resultKey/dedupeKey)再派发。
`node scripts/experiments/tsa4-project-dispatch.mjs` 加 `node scripts/experiments/tsa4-project-industrial.mjs`;
后台并行 `node scripts/experiments/tsa4-planwatch.mjs`(计划卡审批)与
`node scripts/experiments/tsa4-projectwatch.mjs`(终态轮询加 planProgress 快照)。

### 7. L7 跨频道通讯与记忆

`node scripts/experiments/tsa4-xchannel.mjs`:send_cross_channel_message → 目标频道到达 → 回执。
phase-c 续跑:C4 RSI 治理语义(experience-stats 加逐条治理投影加单条晋升门加负证据合并人拒晋升)、
C5 save/search_memory 会话记忆、C6 负例(越量程 400、跨用户 403)。

### 8. L8 缺陷回归探针

`node scripts/experiments/tsa4-rtu-probe.mjs`:对已知缺陷(如 RTU 池 pending 泄漏)受控复现
——基线读、并发突发、延迟复读加健康面观察;如实判定缺陷是否仍在、新增可观测面是否覆盖。
楔死后按已知运维恢复法收尾并记入报告。

### 9. L9 插件工具腿(2026-11-21 新增)

`node scripts/experiments/tsa5-plugin-check.mjs`:插件注册的自定义 Agent 工具四断言——
跨构建持久装载(plugins 清单 enabled)、注册表含全部工具、未配置时 fail-closed(给可操作
指引,零外呼)、worker 工具面只含只读工具(注入层角色边界;执行层 dispatch 另有 roles 硬校验)。
参考实现:`sdk/examples/mes-tool-bridge/`(外接系统接 Agent 的模板)。

### 10. L10 AgentPrefab / Skills / MCP 腿(2026-11-21 新增)

`node scripts/experiments/prefab-acceptance.mjs --base <url> --home <AW_HOME> --user-home <隔离用户目录> --evidence <dir>`:
在**全新实例**上完成 Skill 发现(`~/.agent/skills`)/不可变导入/启用 → Prefab 草稿/发布 →
Channel 成员固定 revision 绑定 → 工具目录收窄 + `activate_skill` low-trust 正文 →
未选能力 dispatch 拒绝 → Session clone binding/快照 → 发布新 revision 不自动升级 →
Skill 撤销即时拒绝 → MCP 非 HTTPS/无 secret/失败有界。正向外部 MCP 联通和真实 OMP 模型
作业若未跑,分别记 PARTIAL/BLOCKED;单测/fake 不能替代实网/真实模型证据。

## 受控步断言与 override 语义(2026-11-21 沉淀)

- **回读一致 ≠ 步进有效**:受控步验收必须加「目标值≠写前值」断言(F-TSA4-1 的 7→7 no-op 教训);
  指令模板要求 agent 以**设备实读值**为基准(不是配方存储参数)。
- **人工 override 模板**(agent 证据性反驳时):「知情 override(测试语义,责任在人工)」+ 审批注释
  + 方案依据三处留痕;agent 的反驳必须保留在记录中,不得抹掉。
- **整包审批卡不挂发起频道**:按 channelId 过滤 /hitl/pending 会漏卡(F-TSA5-2),轮询用**全局队列**;
  同配方单飞互斥与 60s 下发频控会拒绝重复提案(返回指引文本,不是错误)。

## 验收清单

- [ ] L1–L8 各层 0 FAIL,证据目录内逐文件 JSON 加脚本尾行 RESULT JSON 双证
- [ ] 报告回答四能力问题:产线数采数控 / Project 编排 / Channel 内部与间通讯 / 经验记忆管理
- [ ] 缺陷回归对照表:缺陷 id / 上轮状态 / 本轮实测 / 是否修复
- [ ] NOT_RUN 与 PARTIAL 如实标注;模拟器证据不是物理 HIL;软件 PASS 不是安全认证
- [ ] 收尾生成 REPORT.md 加 manifest.json(参考 tsa4-report-manifest.mjs 的 digest 风格)
- [ ] Project 面看 `aw_task_list` 终态与 planProgress 一致

## 裁决纪律与红线

- 每层 0 FAIL 才继续;红了修复后从该层起重跑,不做选择性补测;被拒/超时/400 是资产。
- 学得好红线:负结论可断言、合并的负证据不得晋升 validated、欠证据如实拒绝。
- 边界红线:不代用户宣告投产;Mimosa 结论只报封印加计数加 run status。

## workflow 更新

1. 新发现或新修复 → 先改轮次脚本(TDD:先红后绿),再纳入对应 L 层小节。
2. 改 SKILL.md 后:node scripts/test-aw-skills.mjs 与 tests/live-acceptance-workflow.test.ts 必须全绿。
3. 每轮结束把轮次常量与证据路径写进下一轮克隆说明;旧轮脚本保留不删(历史轮可复现)。
