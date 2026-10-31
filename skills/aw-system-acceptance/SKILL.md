---
name: aw-system-acceptance
description: AgentWorkShop 全系统验收测试 skill。当用户要求全功能回归验收、发布前判定、集成测试或新功能合入后确认「系统无回归」时使用,按五层收敛——静态门禁/单元与契约/实机核心闭环(产线治理·本体·模型闭环·优化器·注塑闭环·IDD 结果库)/回归面/插件装载与工具注册面。触发词:全功能验收、系统测试、回归测试、发布前验收、全栈验收、集成测试。不适用于:单产线接入验收(见 aw-line-onboarding)、插件开发自验(见 aw-plugin-dev)。
---

# AgentWorkShop 全系统验收测试

> 双位置说明:校验基准副本在仓库 `skills/aw-system-acceptance/`(scripts/test-aw-skills.mjs 校验对象),ZCode 发现副本在 `.agents/skills/aw-system-acceptance/`;改动须两处同步。历史全功能手册见 `docs/full-test-plan.md`(其脚本清单偏旧,以本 skill 与 scripts/ 实存为准)。

五层各 0 FAIL 才能宣告「系统无回归」;任一层红了,修复后**从该层起全量重跑**,不做选择性补测。断言基线为 2026-10-25 全绿真值(基线上浮正常,下降必须逐条解释)。

### 0. 环境与实例纪律(先于一切套件)

- 隔离实例试跑(回归首选):fresh 目录 `AW_MODE=home AW_HOME=<dir> PORT=<port> NUXT_SESSION_PASSWORD=<≥32字符> node .output/server/index.mjs`(先 `npm run build`);首注册即 admin。**缺 `AW_MODE=home` 时 repo 检出目录内启动会把 `AW_HOME` 静默忽略、挂到共享 `.AgentWorkShop` 库**(识别特征:needsSetup=false / activeChannels>0;2026-10-28 实测,见 aw-line-onboarding 前置条件)。长跑实例用 `node scripts/_audit/detached-start.mjs --port <port>` 真分离,别挂在会话后台里。
- 连接检查:`aw_status` 确认 base/鉴权与 `mcpEnabled=true`(false 则引导开「系统设置 → MCP 集成」,不要绕过);未鉴权先 `aw_login`。
- 单测必须 `npm run test:unit`(自带 `--tsconfig .nuxt/tsconfig.server.json --test-force-exit`);裸 tsx --test 会因路径解析挂掉。
- 注塑闭环前置:平台进程 env `AW_TRIAL_INTERVAL_MS=0`(试验节拍门),设完必须**重启进程**才生效。
- UI 走查(Puppeteer):等页事件用 domcontentloaded——SSE 长连接下 networkidle 永不触发;dev 实例久跑 OOM 重启带 `NODE_OPTIONS=--max-old-space-size=6144`;被强杀残留 `.runtime/aw.lock` 先删(`aw stop` 亦可清理)。
- 端口纪律:3001=aw start、3300=演示、4010=共享模拟器(影子树绝不指向它);对 127.0.0.1 的调用带 `NO_PROXY='127.0.0.1,localhost'`(本机代理拦截)。

### 1. 静态门禁层(T0)

```bash
npm run lint && npm run typecheck && npm run docs:check && npm run i18n:check && npm run readme:lint
```

任一红即止。docs:check 校验全仓文档版本号一致;i18n:check 校验中英键 parity。

### 2. 单元与契约层(T1,基线 599/599)

```bash
npm run test:unit        # tests/*.test.ts 全量(含本体/优化器/结果库面单测)
npm run test:mcp         # MCP 服务面契约(42 工具,名字唯一)
npm run test:plugin-lifecycle
npm run test:sdk-surface
npm run test:twin-provider
npm run test:skills      # skills/ 目录规范校验(含本 skill)
```

### 3. 实机核心闭环层(T2,发布判定主证据)

| 套件 | 命令 | 覆盖面 | 基线 |
| --- | --- | --- | --- |
| 产线治理 | `npm run test:e2e-line` | L1-L12:开停线 HITL/审批期 TOCTOU/换线清理/Agent token 自证/写限界与 60s 频控 | 44/44 |
| 本体离线 | `npx tsx --tsconfig .nuxt/tsconfig.server.json scripts/e2e-ontology.mjs` | ON 全流程服务层:草稿→校验→编译→批准→发布→守卫→diff→退役(无需实例) | 尾行 0 失败 |
| 本体真机 | `npx tsx --tsconfig .nuxt/tsconfig.server.json scripts/e2e-ontology-live.mjs` | L1-L7:本体全生命周期+运行守卫+AML 先验/求解器集成+邻接子图(ON16/ON17)+前端六 tab | 87/87 |
| 模型闭环 | `npx tsx --tsconfig .nuxt/tsconfig.server.json scripts/e2e-model-loop-live.mjs` | M0-M6:本体→孪生冻结→训练进化 v1→v3→求解器→管理面→前端走查 | 54/54 |
| 优化器 | `npx tsx --tsconfig .nuxt/tsconfig.server.json scripts/e2e-optimizer-live.mjs` | R1-R3+U1:REST 全链/负例契约(版本不可变·作用域·RBAC)/Agent 工具面/浏览器五 tab | 104/104 |
| 注塑闭环 | `npm run test:e2e-injection` | recipe_trial 多轮寻优→HITL→工艺响应→复测→达标固化(真实 PLC 模拟;AW_BASE/AW_TOKEN 指向已供给的注塑实例) | 6/6(当前脚本;旧版 9) |
| IDD 结果库 | `node scripts/e2e-idd-results.mjs` | A2-A13:11 查询参数/详情截断/属主 403/探针版本检测/网络错映射(需 IDD 后端) | 36/36 |
| 结果库 UI | `node scripts/e2e-idd-results-ui.mjs` | 面板列表/详情抽屉/编辑闸门(admin)真浏览器走查 | 9/9 |

裁决:脚本尾行「结论:PASS(n/n)」+ 本轮生成的证据目录(形如 `docs/audit/evidence/2026-10-25-idd-results/report.json`)双证;只认本轮证据,不吃历史报告。外部依赖缺失(IDD/RAG 后端)时如实标注,不得静默跳过。

### 4. 回归面(T3,发布前至少抽三)

```bash
npm run test:api-live                          # REST 面:任务状态机/token 作用域/订阅/WS 广播
node scripts/_audit/aw-mcp-live-e2e.mjs        # MCP 实机冒烟
node scripts/e2e-agent-team.mjs                # Team 协调(信箱/群聊/跨 Channel)
node scripts/e2e-hitl-live.mjs                 # HITL 挂起/批准/超时默认拒
node scripts/e2e-tool-surface-multiagent.mjs   # 多 Agent 工具面与身份拦截
node scripts/e2e-template-isolation.mjs        # 模板克隆隔离
node scripts/e2e-auth-matrix.mjs               # 角色权限矩阵
node scripts/e2e-timezone-settings.mjs         # 时区三态一致/设置热切换
node scripts/e2e-rest-robustness.mjs           # REST 鲁棒性(非法参数/负 limit)
node scripts/e2e-crash-cycle.mjs               # 崩溃→重启→断点恢复
```

### 5. 插件装载与工具注册面(T4)

1. `aw_plugin_list`(或 GET /api/workshop/plugins):全部 enabled 且 `failures=[]`——当前 11 插件(7 project + 4 builtin)。
2. 工具注册表 GET /api/workshop/tools:builtin 104 + plugin 21 全部 available;`available=false` 会触发 channelToolGate「当前未注册」拒绝,多为**陈旧 dev 进程反向同步污染共享库**——杀树(taskkill //T //F)重启即恢复,别误判成插件缺陷。
3. 工具面抽真:`aw_agent_tool_invoke` 实调 `diag_results`(结果库查询)与 `diag_status`(后端连通);`aw_dcw_snapshot`/`aw_task_list` 抽查节点面与任务面回包形状。

### 6. 裁决与报告纪律

- 范围:全量按 0→5 顺序;按变更面裁剪时 T2 相关套件必跑。
- 负向断言是资产:探索门控拒/越界写 400 且点名约束层/跨用户 403/未注册工具被拒/停线后写被拒——**报错才是对的**,不要修到「不报错」。
- 报告=每套件一行(套件/断言数/结论)+ 证据目录路径;结论含外部依赖状态与未覆盖面声明。
- Mimosa 安全扫描未完成不宣称安全;本 skill 只裁决功能面。

## 验收清单

- [ ] T0-T4 五层各 0 FAIL,本轮证据目录已生成(evidence/<日期>-<套件>)
- [ ] T2 八套件全绿;外部依赖缺项如实标注(不静默跳过)
- [ ] 插件 failures=[] 且工具注册表 builtin+plugin 全 available
- [ ] UI 走查截图存档(本体六 tab/优化器五 tab/结果库三屏)
- [ ] 结论一句话:套件矩阵 × 外部依赖状态 × 未覆盖面声明

## 治理红线

- 测试自动裁决仅限测试语义 HITL;不代用户宣告投产。
- 共享/演示实例禁破坏性操作(清库/删线);回归套件一律自带隔离实例。
- 环境污染(陈旧进程/锁/端口)先清理再判红:不把环境污染当系统缺陷,也不把系统缺陷当环境污染。
- 断言数下降或套件被移除必须逐条解释来历,禁止「删测试保绿」。
