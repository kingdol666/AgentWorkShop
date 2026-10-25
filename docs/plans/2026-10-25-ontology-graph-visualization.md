# 本体模型可视化与关联查询增强计划(v2 · 四 Agent 审查后修订)

状态:**approved for execution**(用户 2026-10-25 指示"确保 plan 可实施且设计完整后开工作业")
依据:2026-10-25 四路只读核查(后端/前端/工具面/验收)结论;v1 的 5 个 Blocker 已在本版修正

## 0. v2 相对 v1 的关键修正

| v1 问题 | 证据 | v2 修正 |
|---|---|---|
| 图数据源冲突:页面画草稿,`/scene` 只读已发布 | `app/pages/ontology/index.vue:533,541`;`scene.ts:14-20`;`ontology.service.ts:752` | 新增**草稿子图端点** `GET /drafts/:draftId/subgraph`;`/scene?entity=` 保留给 Agent/MCP(已发布面) |
| 返回契约缺 `edge.hop`/`nodes[].role`/`center.description` | v1 `:30` vs `:39` | 契约补齐(见 §2) |
| 边语义未定义(诱导边 vs 遍历树边) | v1 `:38-42` 互相矛盾 | 定为**已访问节点之间的诱导边**,`edge.hop=max(端点hop)`,`direction∈out/in/lateral/loop` |
| `limit` 默认 50 vs 端点默认 200 冲突 | `scene.ts:18` | entity 分支缺省传 `undefined`(得 50);无 entity 分支逐字符保留原表达式 |
| A1/A2/A9 依赖演示实例临时数据 | 仓库无 `onto-demo-inj` | 改为**仓内纯 fixture**(`buildGraphDoc` 5/5 + edge-case),不依赖任何运行实例 |
| A5「逐字节等价」不可测 | 单测无法 import `scene.ts`(#imports) | 拆 A5a(服务层 golden 单测)+ A5b(live e2e 双请求比较) |
| 默认 SVG 打挂现有 L7.3 | `e2e-ontology-live.mjs:698-716` | L7.3 改为 `[data-node-key]/[data-edge-id]` + 切表格后断言两表 |
| `references chained line_id→ontology` 不存在 | `tool-reference-spec.ts:20` 无 `line` 链 | 改为 `refs:[{param:'line_id',kind:'line',mode:'read'}]` |
| `role` 三列映射错误(7 role) | `contracts.ts:32`;`compiler.ts:66-70` | 按编译器口径分道:MV(control/disturbance/feature)/CV(target/observation)/结构+状态(state/guard/无 role) |
| 证据档只写 2 档 | `contracts.ts:38` 三级 | 三档样式 + 图例 |
| `circle/path` 计数被 marker/选中环污染 | — | 只用 `data-node-key`/`data-edge-id` |

## 1. 需求

1. 前端把节点、边可视化出来(当前 graph tab 是两张表格)
2. 查看某节点相关联的边、以及间接关联(多跳)的节点与边
3. Agent 能取到节点为中心的结构化邻接数据

## 2. 后端契约(v2 定稿)

```ts
type SubgraphDirection = 'both' | 'out' | 'in'
interface SubgraphAround {
  ontologyId: string; version: number; lineId: string
  center: { key; kind; name; description; unit; role?; hop: 0; bindings: SubgraphBinding[] }
  nodes: Array<{ key; kind; name; description; unit; role?; hop: number }>   // 含 center
  edges: Array<{ id; kind; srcKey; dstKey; evidenceTier; hop: number
                 direction: 'out' | 'in' | 'lateral' | 'loop' }>
  truncated: boolean
}
```

语义(全部确定性):
- `nodes` 含 center(`hop=0`);`limit` 统计含 center,默认 50、上限 200
- `edge.hop = max(hop(src), hop(dst))`;`direction` 由两端 hop 差决定;自环=`loop`
- `direction=both` → 返回已访问节点之间的**全部诱导边**(含 lateral);`out` → 只保留 `hop(src) ≤ hop(dst)`;`in` → 只保留 `hop(dst) ≤ hop(src)`
- `kinds` 同时过滤遍历与输出;`kinds` 缺省=全部
- `truncated=true` 仅表示**因 limit 未纳入可达节点**;hops 边界/kinds 过滤不置位
- 排序:`nodes` 按 `(hop, key)`,`edges` 按 `(hop, id)`(测试与布局都需要确定性)
- 自环、平行边(同端点不同 predicate)均保留,按 `relation.id` 去重

错误码(422/404,`AppError`):
| 输入 | code |
|---|---|
| `entity` 空/非字符串 | `ONTOLOGY_ENTITY_REQUIRED` |
| `hops` 非整数或 ∉[1,3] | `ONTOLOGY_SUBGRAPH_HOPS_INVALID` |
| `direction` ∉ both/out/in | `ONTOLOGY_SUBGRAPH_DIRECTION_INVALID` |
| `kinds` 含未知关系类型 | `ONTOLOGY_SUBGRAPH_KIND_INVALID` |
| `limit` 非整数或 ∉[1,200] | `ONTOLOGY_SUBGRAPH_LIMIT_INVALID` |
| 该版本无此实体 | `ONTOLOGY_SUBGRAPH_ENTITY_NOT_FOUND` |
| 产线无已发布本体(entity 模式) | 200 `{active:false, subgraph:null}` |

REST:
- `GET /api/workshop/ontology/scene?lineId=&entity=&hops=&direction=&kinds=&limit=`(已发布;无 `entity` 时**原路径逐字符不变**)
- `GET /api/workshop/ontology/drafts/:draftId/subgraph?entity=&...`(草稿;供 UI,沿用草稿 owner/admin 权限)

## 3. 实施步骤

### P1 后端(纯核心 + 服务 + 两个路由)
- `server/services/workshop/ontology/subgraph.core.ts`(新):零 DB 依赖的 `buildSubgraphAround` + `parseSubgraphOptions` + `SUBGRAPH_*` 常量 + 类型
- `server/services/workshop/ontology/subgraph.service.ts`(新):`loadVersionGraph` / `subgraphAroundForLine` / `subgraphAroundForVersion` / `subgraphAroundDoc`
- `server/api/workshop/ontology/scene.ts`:加 `entity` 分支(无 entity 分支原样保留)
- `server/api/workshop/ontology/drafts/[draftId]/subgraph.ts`(新)
- `ontology/index.ts` barrel 追加 `export * from './subgraph.core'` 与 `./subgraph.service`

### P2 Agent 工具(只读)
- `ontology-tools.ts`:`toolOntologyNodeNeighbors`(先 `assertLineInScope` → `subgraphAroundForLine` → 结构化文本:节点/边/hop/证据档/truncated)
- `host-tool-bridge/tools/industrial.ts` handler + `industrial/index.ts` 导出
- `.AgentWorkShop/prompts/host-tools.json` 第 104 条(riskClass=read,`references.refs=[{param:'line_id',kind:'line',mode:'read'}]`)
- `mcp/aw-mcp-server.mjs` 只读面 3→4(显式 `entity: args.entityKey` 映射)
- 不改 grant-guard(只读自动 readonly 复核)、不改 tool-verify

### P3 前端
- `app/components/ontology/OntologyGraph.vue`(新,显式 import):自绘 SVG,role 分道、三档证据样式、`data-node-key`/`data-edge-id`、键盘可达、长 key 截断 + `<title>`
- `app/pages/ontology/index.vue`:graph tab 图/表 segmented(默认图)、点击节点右侧抽屉(节点详情+绑定+邻接清单+1/2 跳切换)、>60 节点降级为搜索聚焦
- `app/pages/ontology/types.ts`:`SubgraphAroundDto`
- `i18n/locales/{zh-CN,en}.ts`:`ontology.graph.*` / `ontology.drawer.*`

### P4 测试与文档
- `tests/ontology-subgraph.test.ts`(新,≥14 用例:方向/跳数/环/自环/平行边/limit/排序/错误码)
- `tests/ontology-tools-surface.test.ts`:EXPECTED 9→10、总数 104、MCP 4 只读
- `scripts/e2e-ontology.mjs`:ON14(服务层邻接 + 参数错误)
- `scripts/e2e-ontology-live.mjs`:ON16(entity REST 422/404 + 草稿子图)、ON17(Agent 工具)、L7.3 重写(默认 SVG → 切表格)
- `docs/site/guide/ontology.md` + en、README/README-zh 工具计数、`docs/site/index.md` + en

## 4. 验收矩阵(可执行)

| ID | 载体 | 断言 | 种子 |
|---|---|---|---|
| A1 | 单测 | hops=1/both: nodes 排序=[mv.hold_pressure,pv.melt_temp,qv.flash_rate,qv.part_weight];edges=[r-hp-f,r-hp-mt,r-hp-w,r-mt-w];center.hop=0;truncated=false | G |
| A2 | 单测 | hops=2: 新增 mv.hold_time(hop2)、r-ht-w(hop2);r-mt-w.hop=1;5 节点/5 边 | G |
| A3 | 单测 | 孤立实体: nodes=[{iso.only,0}],edges=[],truncated=false | E |
| A4 | 单测+live | 非法 hops/direction/kinds/limit → 422 对应 code;未知 entity → 404;无 entity 带新参数仍被忽略 | G + live |
| A5a | 单测 | `sceneSubgraph('ln-graph-01')` 与 golden 字符串完全一致 | publishSnapshot(G) |
| A5b | live | 无 entity 两次请求(带/不带 hops…)`JSON.stringify(data)` 相等;graph 顶层键不变 | live line |
| A6 | live | 工具 `ontology_node_neighbors`: `isError!==true`;hops=1 文本含 4 节点 key + 4 边 id;hops=2 含 `mv.hold_time ... hop=2` 与 `r-ht-w ... hop=2` | live + 主 Channel |
| A7 | 单测 | ontology 前缀工具集合精确=10;总数=104;riskClass=read;MCP 只读=4;写面不暴露 | host-tools.json |
| A8 | live | 有绑定但未发布本体的产线 → 文本含「尚未发布任何本体」+ `ontology_draft_create` | 第二空产线 |
| A9 | live UI | `[data-node-key]` 数 === `GET /drafts/:draftId` 的 `doc.entities` 数;`[data-edge-id]` 同理;均 >0 | live draft |
| A10 | live UI | 抽屉 `[data-neighbor-key]` 唯一集合={pv.melt_temp,qv.flash_rate,qv.part_weight};`[data-edge-id]`={r-hp-f,r-hp-mt,r-hp-w,r-mt-w};切 2 跳后出现 mv.hold_time/r-ht-w | live draft |
| A11a | live UI | 节点均在 SVG 内、两两不重叠、无 pageerror | live |
| A11b | 人工 | 截图目检(控制室配色、无装饰堆砌) | — |

自动化率:11/12(91.7%)。

## 5. 验证命令

```
npm run test:unit                     # 538+新增
npx tsx --tsconfig .nuxt/tsconfig.server.json scripts/e2e-ontology.mjs
node scripts/e2e-ontology-live.mjs
npm run lint && npm run typecheck && npm run i18n:check && npm run docs:check
```

## 6. 边界(不做)

- 图上编辑(写仍走草稿/发布治理链)
- RDF/OWL 导入导出
- 外置 MCP 产线级授权收紧(与既有 `ontology_scene_inspect` 同口径,单独议题)
- 观察面(exp-miner/line-doctor)工具注入策略调整(单独议题)

## 7. 执行记录(2026-10-25)

| 阶段 | 交付 | 验证 |
|---|---|---|
| P1 | `subgraph.core.ts` / `subgraph.service.ts` / `scene.ts` entity 分支 / `drafts/[draftId]/subgraph.ts` / barrel | 单测 18/18;服务 e2e ON14 7/7(57/57) |
| P2 | `ontology_node_neighbors` + host-tools 104 条 + handler/导出 + MCP 4 只读 | 工具面结构断言 21/21(含总数 104、只读不进写族) |
| P3 | `OntologyGraph.vue`(自绘 SVG/三道分列/三档证据) + 图/表 segmented + 节点抽屉(1/2 跳) + i18n | live e2e L7.3a-c 通过;截图 `docs/audit/evidence/2026-10-25-ontology-graph/` |
| P4 | ON16(8 条 REST)/ON17(3 条工具)/L7.3 重写;指南中英 + README/站点计数 | live e2e **87/87**;单测 **585/585**;docs:check 91/91;i18n parity OK;typecheck 通过 |

验收矩阵结果:A1-A10 + A11a 全部自动化通过(11/12);A11b 截图目检通过(控制室配色、三道分列、无装饰堆砌)。
