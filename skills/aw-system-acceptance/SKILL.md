---
name: aw-system-acceptance
description: AgentWorkShop 全系统验收测试 skill。当用户要求全功能回归验收、发布前判定、集成测试或新功能合入后确认「系统无回归」时使用,按六层收敛——静态门禁/单元与契约/实机核心闭环(产线治理·本体·模型闭环·优化器·注塑闭环·IDD 结果库·科学探索闭环)/回归面/插件装载与工具注册面/发布产物冒烟。触发词:全功能验收、系统测试、回归测试、发布前验收、全栈验收、集成测试、从抓到下发到学。不适用于:单产线接入验收(见 aw-line-onboarding)、插件开发自验(见 aw-plugin-dev)。
---

# AgentWorkShop 全系统验收测试

> 双位置说明:校验基准副本在仓库 `skills/aw-system-acceptance/`(scripts/test-aw-skills.mjs 校验对象),ZCode 发现副本在 `.agents/skills/aw-system-acceptance/`;改动须两处同步。历史全功能手册见 `docs/full-test-plan.md`(其脚本清单偏旧,以本 skill 与 scripts/ 实存为准)。

六层各 0 FAIL 才能宣告「系统无回归」;任一层红了,修复后**从该层起全量重跑**,不做选择性补测。断言基线为 2026-11-02 全绿真值(基线上浮正常,下降必须逐条解释)。

### 0. 环境与实例纪律(先于一切套件)

- 隔离实例试跑(回归首选):fresh 目录 `AW_MODE=home AW_HOME=<dir> PORT=<port> NUXT_SESSION_PASSWORD=<≥32字符> node .output/server/index.mjs`(先 `npm run build`);首注册即 admin。**缺 `AW_MODE=home` 时 repo 检出目录内启动会把 `AW_HOME` 静默忽略、挂到共享 `.AgentWorkShop` 库**(识别特征:needsSetup=false / activeChannels>0);**生产模式缺 `NUXT_SESSION_PASSWORD` 会拒绝启动(安全屏障,不是缺陷)**。长跑实例用 `node scripts/_audit/detached-start.mjs --port <port>` 真分离。
- 连接检查:`aw_status` 确认 base/鉴权与 `mcpEnabled=true`;未鉴权先 `aw_login`。
- 单测必须 `npm run test:unit`(自带 `--tsconfig .nuxt/tsconfig.server.json --test-force-exit`);裸 tsx --test 会因路径解析挂掉。
- 注塑闭环前置:平台进程 env `AW_TRIAL_INTERVAL_MS=0`(试验节拍门),设完必须**重启进程**才生效。
- 基准模式:`AW_BENCH_MODE=1` **必须**配 `AW_BENCH_ACK=1`,否则自动忽略(安全设计);生产验收**不要**开。
- UI 走查(Puppeteer):等页事件用 domcontentloaded——SSE 长连接下 networkidle 永不触发;dev 实例久跑 OOM 重启带 `NODE_OPTIONS=--max-old-space-size=6144`;被强杀残留 `.runtime/aw.lock` 先删。
- 端口纪律:3001=aw start、3300=演示、4010=共享模拟器(影子树绝不指向它);对 127.0.0.1 的调用带 `NO_PROXY='127.0.0.1,localhost'`。

### 1. 静态门禁层(T0)

```bash
npm run lint && npm run typecheck && npm run docs:check && npm run i18n:check && npm run readme:lint
```

任一红即止。docs:check 同时校验:文档版本号 = package.json、宿主工具数、设置项数(含 live/restart 拆分)、站点副本与源文档逐字一致。改动设置描述符(`shared/config/schema.json`)后**必须**同步 README/CLI/站点计数,否则 docs:check 必红。

### 2. 单元与契约层(T1,基线 990/992)

```bash
npm run test:unit        # tests/*.test.ts 全量(含本体/优化器/结果库/科学探索面)
npm run test:mcp         # MCP 服务面契约(工具名唯一)
npm run test:plugin-lifecycle
npm run test:sdk-surface
npm run test:twin-provider
npm run test:skills      # skills/ 目录规范校验(含本 skill)
```

科学探索面专项单测(已含在 test:unit,便于单点复跑):

```bash
npx tsx --tsconfig .nuxt/tsconfig.server.json --test tests/identifiability.test.ts        # 可辨识性引擎 + 事故回放
npx tsx --tsconfig .nuxt/tsconfig.server.json --test tests/intervention-ledger.test.ts    # 干预台账 + 写咽喉挂钩
npx tsx --tsconfig .nuxt/tsconfig.server.json --test tests/action-coverage-g6.test.ts     # G6 动作覆盖 + ARX 敏感度
npx tsx --tsconfig .nuxt/tsconfig.server.json --test tests/experiment-plan-p4.test.ts     # 真实线 DoE 分级/执行/安全
npx tsx --tsconfig .nuxt/tsconfig.server.json --test tests/cross-check-p5.test.ts         # 双通道互审 + 强制下发门
npx tsx --tsconfig .nuxt/tsconfig.server.json --test tests/ontology-learning-p6.test.ts   # 证据回灌 + 因果断言标注
```

### 3. 实机核心闭环层(T2,发布判定主证据)

| 套件 | 命令 | 覆盖面 | 基线 |
| --- | --- | --- | --- |
| **科学探索全链** | `npm run test:e2e-scientific` | 采集(TSDB 分页/打标)→真实 buildDataset(v2/G6)→ARX 训练作业→注册模型→动作敏感度→真实线 DoE(HITL/执行)→判读回填→本体证据→互审阻断(设备层 mock/响应注入,如实标注);证据落 docs/audit/evidence/2026-11-02-scientific-fullchain | **21/21** |
| **科学探索闭环** | `npx tsx --tsconfig .nuxt/tsconfig.server.json scripts/acceptance-scientific-loop.ts` | 真实线 DoE 分级→HITL 批准→随机化执行→逐步判读→本体证据回灌→双通道互审→G6;含跨线注入负例 | 20/20 |
| **端到端作业演示** | `node scripts/demo/e2e-optimization-demo.mjs --base .. --line .. --dcw .. --daq ..`(需模拟器孪生 + 已供给实例) | 观测→DoE(HITL)→判读→证据→按实测增益下发→重量入窗;设备层为模拟孪生 | **15/15** |
| 产线治理 | `npm run test:e2e-line` | L1-L12:开停线 HITL/审批期 TOCTOU/换线清理/Agent token 自证/写限界与 60s 频控 | 44/44 |
| 本体离线 | `npx tsx --tsconfig .nuxt/tsconfig.server.json scripts/e2e-ontology.mjs` | ON 全流程服务层:草稿→校验→编译→批准→发布→守卫→diff→退役 | 尾行 0 失败 |
| 本体真机 | `npx tsx --tsconfig .nuxt/tsconfig.server.json scripts/e2e-ontology-live.mjs` | L1-L7:本体全生命周期+运行守卫+AML 先验/求解器集成+邻接子图+前端六 tab | 87/87 |
| 模型闭环 | `npx tsx --tsconfig .nuxt/tsconfig.server.json scripts/e2e-model-loop-live.mjs` | M0-M6:本体→孪生冻结→训练进化 v1→v3→求解器→管理面→前端走查 | 54/54 |
| 优化器 | `npx tsx --tsconfig .nuxt/tsconfig.server.json scripts/e2e-optimizer-live.mjs` | R1-R3+U1:REST 全链/负例契约/Agent 工具面/浏览器五 tab | 104/104 |
| 注塑闭环 | `npm run test:e2e-injection` | recipe_trial 多轮寻优→HITL→工艺响应→复测→达标固化(真实 PLC 模拟) | 6/6 |
| IDD 结果库 | `node scripts/e2e-idd-results.mjs` | A2-A13:11 查询参数/详情截断/属主 403/探针版本检测/网络错映射 | 36/36 |
| 结果库 UI | `node scripts/e2e-idd-results-ui.mjs` | 面板列表/详情抽屉/编辑闸门(admin)真浏览器走查 | 9/9 |

裁决:脚本尾行「结论:PASS(n/n)」+ 本轮证据目录(evidence/ 下按「日期-套件」命名,内含 report.json)双证;只认本轮证据。外部依赖缺失(IDD/RAG 后端)时如实标注,不得静默跳过。

### 3.1 三段式能力验收(「看到 → 控制 → 学得好」)

审计「从抓到下发到学」是否真的闭环,按下表逐段取证,**每段都要有本轮命令输出**:

| 段 | 判据 | 取证命令 |
| --- | --- | --- |
| 看到(抓取) | DAQ 实采样本进 TSDB,`daq_query` 按活动批次取回并带物理语义;数据集构建产出 v2 manifest 含 `actionCoverage` | `npm run test:e2e-line`(采集段)+ `action-coverage-g6` 单测 |
| 控制(下发) | 所有下发经写咽喉:量程/步长/60s/保持窗联锁;manual 挂 HITL;auto 必带 hypothesis;**真实线 DoE 需单卡批准且节点归属校验** | `test:e2e-line` + `experiment-plan-p4`(A4-6..9) |
| 学得好(经验) | 每步判定回填台账;负结论可断言;证据回灌本体;互审能拦「模型有效应但本体无路径」 | `acceptance-scientific-loop.ts` + `cross-check-p5` + `ontology-learning-p6` |
| 失败即证据 | 负向断言全绿:跨线计划拒/欠功效不得声称效应/未批准执行拒/冲突下发拒/无证据锚因果断言标 anecdotal | 上述套件负例 |

红线:**不得以「AI 说有效应」代替统计判定**;窗口不足(UNDERPOWERED)时的正确输出是"不可辨识",不是"无影响"也不是"有影响"。

### 4. 回归面(T3,发布前至少抽三)

```bash
npm run test:api-live                          # REST 面
node scripts/_audit/aw-mcp-live-e2e.mjs        # MCP 实机冒烟
node scripts/e2e-agent-team.mjs                # Team 协调
node scripts/e2e-hitl-live.mjs                 # HITL 挂起/批准/超时默认拒
node scripts/e2e-tool-surface-multiagent.mjs   # 多 Agent 工具面与身份拦截
node scripts/e2e-template-isolation.mjs        # 模板克隆隔离
node scripts/e2e-auth-matrix.mjs               # 角色权限矩阵
node scripts/e2e-timezone-settings.mjs         # 时区三态一致/设置热切换
node scripts/e2e-rest-robustness.mjs           # REST 鲁棒性
node scripts/e2e-crash-cycle.mjs               # 崩溃→重启→断点恢复
```

### 5. 插件装载与工具注册面(T4)

1. `aw_plugin_list`(或 GET /api/workshop/plugins):全部 enabled 且 `failures=[]`。
2. 工具注册表 GET /api/workshop/tools:builtin **107** + plugin 全部 available(`available=false` 多因陈旧 dev 进程反向同步污染共享库——杀树重启即恢复)。
3. 工具面抽真:`aw_agent_tool_invoke` 实调 `diag_results`/`diag_status`/`aw_dcw_snapshot`/`aw_task_list`;科学探索面抽 `daq_identifiability`(只读预检)与 `intervention_history`(台账回读)回包形状。

### 6. 发布产物冒烟(T5)

```bash
node bin/aw.mjs build
AW_MODE=home AW_HOME=<fresh> NUXT_SESSION_PASSWORD=<≥32字符> PORT=<port> node .output/server/index.mjs
# 期望:GET / → 200;GET /api/workshop/aml → 401(鉴权正确);缺 NUXT_SESSION_PASSWORD 时拒绝启动
npm pack --dry-run     # 清单含 .output/.AgentWorkShop/prompts 等;核对 files 列表
```

发版追加:`npm publish --registry=https://registry.npmjs.org`(默认 registry 可能是镜像且无 token;首发可能返回 `PUT 202` 异步受理,约 10 分钟后才出现在 registry——用 `npm pack agentworkshop@<ver>` 验证可安装)。发完打并推 tag。

### 7. 裁决与报告纪律

- 范围:全量按 0→6 顺序;按变更面裁剪时 T2 相关套件必跑。
- 负向断言是资产:欠功效拒/跨线拒/冲突拒/越界 400 点名约束层/跨用户 403/停线后写被拒——**报错才是对的**。
- 报告=每套件一行(套件/断言数/结论)+ 证据目录路径;结论含外部依赖状态与未覆盖面声明。
- Mimosa 安全扫描未完成不宣称安全(全仓基线存在已知存量命中;本轮改动文件应 0 命中);本 skill 只裁决功能面。

## 验收清单

- [ ] T0-T5 六层各 0 FAIL,本轮证据目录已生成
- [ ] T2 九套件全绿;外部依赖缺项如实标注(不静默跳过)
- [ ] 三段式(看到/控制/学得好)各有本轮命令输出,失败即证据负例全绿
- [ ] 插件 failures=[] 且工具注册表 builtin 107 全 available
- [ ] 发布产物冒烟通过(`/` 200、鉴权 401、密钥屏障生效、pack 清单正确)
- [ ] UI 走查截图存档(本体六 tab/优化器五 tab/结果库三屏/AML 探索面)
- [ ] 结论一句话:套件矩阵 × 外部依赖状态 × 未覆盖面声明

## 治理红线

- 测试自动裁决仅限测试语义 HITL;不代用户宣告投产。
- 共享/演示实例禁破坏性操作(清库/删线);回归套件一律自带隔离实例。
- 环境污染(陈旧进程/锁/端口)先清理再判红:不把环境污染当系统缺陷,也不把缺陷当污染。
- 断言数下降或套件被移除必须逐条解释来历,禁止「删测试保绿」。
