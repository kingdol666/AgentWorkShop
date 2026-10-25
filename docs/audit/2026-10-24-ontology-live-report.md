# Ontology 真机全链路集成验收报告（2026-10-24 · ralph 第二轮）

> 脚本：`scripts/e2e-ontology-live.mjs` ｜ 证据：`docs/audit/evidence/2026-10-24-ontology-live/`（report.json + 11 张截图）
> 结论：**67/67 断言全绿**。隔离实例（AW_MODE=home 独立端口）上完成 PLC 场景 → 本体全功能 → AML 训练 → 求解器互校 → 数据分析 → 六页真实浏览器渲染走查。
> 回归：524/524 单测、44/44 服务层 e2e、14/14 MCP、五门禁 ALL PASS。

## 1. 执行环境

| 项 | 值 |
|---|---|
| 实例 | `bin/aw.mjs dev` 隔离 home，端口 3992，首注册 admin |
| PLC 场景 | 1 条模拟产线 + 2 数控节点（压力/线速）+ 3 数采节点（压力/膜厚/温区℃）+ 1 配方 + 6 个已完结批次（160 拍/批）+ context segment 确认段 |
| 时序 | 强制 SQLite TSDB（timescale.port 指向关闭端口——隔离纪律，见 §4.2） |
| AML venv | junction 复用本机真实环境，训练真实跑 Python linear_arx |
| 浏览器 | 本机 Chrome（puppeteer-core），1600×1000，全页截图 |

## 2. 结果总览（67 断言）

| 组 | 覆盖 | 结果 |
|---|---|---|
| BOOT | 实例启动 + admin 注册 | 2/2 |
| L1 产线管理/节点绑定 | 产线/数控节点/数采节点/配方 REST 回读；频道绑产线；Agent↔Profile 绑定 | 5/5 |
| L2 本体全功能 | 草稿→文档写入（绑定真实节点）→校验→编译→证据→生命周期→第二人批准→发布→版本/diff/溯源/场景子图/导出；4 类负例 | **20/20** |
| L3 运行时守卫 | 低温+提速阻断 / 高温放行 / 状态未知 fail-closed / 节点级意图面 / 绑定漂移巡检 | **7/7** |
| L4 AML 集成 | spec→数据集(786 行 lineage_verified)→资格→训练 done→模型登记；本体训练先验派生（特征候选 + τ=D/v=20s） | 10/10 |
| L5 求解器集成 | Profile→绑定→solve optimal→零 DCW 写入→crosscheck **pass(maxDev=4.8e-16)**→ontologyRefs Profile v2 求解正常 | 9/9 |
| L6 数据分析 | 频道绑线 → agent-tools/invoke analysis_save → 台账读回 | 3/3 |
| L7 前端渲染 | /ontology 六 tab + 侧边栏入口 + UI 编译预览（四产物+溯源表）；/dcw /daq /aml /optimizer /analysis 五页无 pageerror；11 张截图 | 11/11 |

## 3. 本体模型评估（用户四问的实测回答）

**① 设计如何？** 三层（草稿→不可变版本→运行时上下文）+ 三级证据 + 五态生命周期 + 只收紧编译，在真机上端到端自洽：L2 组 20 断言无一需要绕过治理；同版本不可变、乐观锁、自审禁止、无批准单拒升、未获批拒发全部按设计拒绝。

**② 具体怎么作用？** 三条真实作用路径，全部有真机证据：
1. **约束编译**：`R-BOUND`(硬界) 进 `cvBounds`、`R-RATE` 进 `maxStep`、状态条件 → 运行时守卫；联锁规则显式归 PLC（不伪装成求解约束）。
2. **运行时阻断**：温区 150℃(<180)+提速 → `block_recommendation`；200℃ → 放行；**状态未知+提速 → fail-closed 阻断**；节点级意图面（本体实体→dcw 节点映射）同样生效（L3 全组）。
3. **AML 先验**：从已发布关系自动派生特征候选（压力/线速→膜厚）与时滞先验（显式 lag 45s 一条 + τ=D/v=20s 一条，变速未校验的只作软先验）。

**③ 支持自定义创建/管理/绑定吗？** 支持，且与求解器绑定同构：任意场景可自建本体（REST/工具/UI 三入口）；语义绑定锚定真实 `daq_node/dcw_node/recipe_param`（L2.2 五条绑定含 recipe_param 复合目标全部通过活体校验）；单位量纲校验、写语义独占、漂移巡检（L3.7）都在真机验证。

**④ 运行中真起作用了吗？** 是——但要说清边界：**守卫阻断发生在下发意图面**（`createDispatchCard` 接线，单测+服务层 e2e 断言），本轮真机在 dispatch 前的 L3 组直接验证了同一求值函数；solve 本身不受本体影响（L5.5 证明"本体存在不干扰求解"，符合"Profile 仍是唯一权威"的铁律）。

**实际使用价值（诚实评估）**：
- **已兑现**：语义资产可治理沉淀（谁建的、什么证据、谁批的、哪个版本在跑，全链审计 L2+publish_log）；新人/Agent 可通过 `ontology_scene_inspect`/场景子图秒级理解"这个变量是什么、受哪条规则限制、证据是什么"；训练冷启动拿到有物理意义的特征与时滞先验；危险动作（冷区提速）有可解释的硬拦截。
- **尚未兑现**：solve 的可行域收紧要等 Profile 装配点消费 `ProblemIrDelta`（当前编译预览已验证等价性，接线是下一步）；消融 A-E 未跑，"本体让优化更好"仍待数据；HITL 卡跨域路由、RDF 导出、文档抽取建本体（O4）未做。

## 4. 本轮发现并修复的问题（3 真 2 环境坑）

1. **[平台 bug·已修] TSDB 读路径静默空**：`SqliteTimeSeriesAdapter` 占位实例的浮空 `init()` 在 Windows 下偶发失败被吞，`queryTaggedPage` 对 `!this.db` **静默返回空**（数据面 fail-open）→ 数据集构建非确定性 `AML_NO_USABLE_RUNS`。修复：读路径 `ensureDb()` 惰性自愈 + 初始化失败落日志（`sqlite.adapter.ts` / `storage/index.ts`）。
2. **[平台坑·记录] 隔离实例必须强制 SQLite 时序**：宿主机 `awshop-daq-timescale` 容器常驻在线，config.yml 指向 5432 → 插件启动即切 Timescale（空库），预置 SQLite 样本不可见。optimizer-live 早已注释此坑；本轮补齐 `daq.timescale.port:6543` + `mqtt.port:18830` 覆盖。
3. **[新代码坑·已修] server 侧 shared 相对导入**：nitro dev 打包对 `../../../../shared/*` 解析错位（历史坑"须用 @ 别名"），ontology/physics-spec 的 shared 导入全部改为 `@/shared/*`。
4. **[环境坑] `child.kill()` 杀不净 `aw dev` 进程树**：僵尸服务器占端口导致后续请求打到旧 home。live 脚本改用 `taskkill /T /F` 树杀 + 启动前端口僵尸清理。
5. **[测试设计] 两个测试自愈**：context 窗口需整窗样本（H+maxDelay+5 拍），新鲜尾巴只写 3 拍 → 互校快照 NaN；训练 G4 门需 ≥500 行 → 160 拍×6 批。

## 5. 回归与门禁

| 门 | 结果 |
|---|---|
| `npm run test:unit` | 524/524 |
| `scripts/e2e-ontology.mjs`（服务层） | 44/44 |
| `scripts/e2e-ontology-live.mjs`（真机） | **67/67** |
| `npm run test:mcp` | 14/14 |
| 五门禁（lint/typecheck/unit/i18n/docs） | ALL PASS |

## 6. 遗留（下一轮）

1. Profile 装配点消费 `ProblemIrDelta`（本体界进 solve 可行域）+ 真机 dispatch 守卫断言（需完整 D13 链）。
2. O4 文档抽取建本体（含注入消毒）；OW7 RDF/SHACL 导出；HITL 卡跨域路由；消融 A-E。
3. `/ontology` UI 深交互（规则 DSL 编辑器、版本 diff 可视化）与移动端走查。
