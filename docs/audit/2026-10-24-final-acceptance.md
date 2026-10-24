# 终验报告 —— 本体设计核验 · IDD/RAG 真机联动 · 全量验收 · v0.8.0 发布（2026-10-24）

> 范围：① 核对本体服务设计与实现；② 与 IDD、RAG 的真实集成测试；③ 全量回归；④ 实机演示渲染取证；⑤ 文档/README/VitePress 一致性美化；⑥ 提交、推送、打包发布。
> 结论：**全部通过**（唯一外部边界已在 §5 显式记录：RAG 侧知识库 Agent 的 kb-mcp 权限未授予/540s 硬超时，平台侧链路与治理全部正常）。

## 1. 测试矩阵（本轮实测）

| 套件 | 结果 | 说明 |
|---|---|---|
| 单元测试（`npm run test:unit`） | **531/531** | 含本体 10 个文件 + Profile 采纳 7 例 |
| 服务层本体 e2e（`scripts/e2e-ontology.mjs`） | **44/44** | 编译/守卫/绑定/生命周期/发布/导出 |
| 本体真机 e2e（`scripts/e2e-ontology-live.mjs`） | **72/72** | PLC 场景 + REST 全链 + 运行时守卫 + AML + 求解 + UI（同代码基线轮） |
| 模型闭环真机 e2e（`scripts/e2e-model-loop-live.mjs`） | **46/46** | 孪生创建链 + 两轮模型采纳 + 零设备写入（同代码基线轮） |
| 本体 × IDD × RAG 真机联动（`scripts/ontology-idd-rag-e2e.mjs`，本轮新增） | **27/27** | 真实 PLC 模拟器（5 设备/五协议）+ 真实 IDD(3210) + 真实 RAG(8771) |
| MCP 工具面 | 14/14 | 外部只读三件本体工具镜像 |
| 文档一致性（`node scripts/check-docs-sync.mjs`） | **91/91** | 设置项 126 / live 42 · restart 84 / 版本 0.8.0 |
| 文档站构建（`npm run docs:build`） | **通过** | 中英首页 + 新增本体指南页渲染零错误 |

## 2. 本体设计核验（对照实现）

结论：设计闭环、语义分层正确，无“看起来存在但不生效”的悬空面。

- **数据模型**：10 类实体 × 8 种封闭关系 × 3 级证据 × 5 态生命周期；实体/关系/规则均带证据与作用域（产线/配方/条件），语义绑定区分读写（写绑定互斥）。
- **编译器**：四类产物（ProcessModelDelta / ProblemIrDelta / SceneContractPatch / ControlGuardSet）+ 只收紧不变量 + 逐规则 Rule Trace；联锁 → `PLC_LAYER_REQUIRED`；非线性 QP/线性耦合编译期拒绝。
- **哈希域分离**：`ontologyRefs` 进 Profile 内容哈希、不进 `ProblemIR` 哈希；漂移独立 409（`ONTOLOGY_PACK_DRIFTED`），不触发求解问题误判。
- **运行时真正执行的四点**：下发节点意图守卫（fail-closed）、训练先验派生、孪生场景/守卫补丁、Profile 谱系复核。其余为可审阅元数据（设计如此）。
- **治理**：发布需控制级批准台账（第二人；单管理员审计豁免）；Agent 8 件工具与 REST 同服务；发布后版本不可变、四段 diff 可查。
- 真机佐证：本轮联动用例中 `entities=4 / rules=3 / guards=1`，`ontology_scene_inspect` 与 `rule_explain` 在真实产线上可解释；守卫规则（熔体温度 <200℃ 禁止提速）由真实 daq/dcw 节点绑定生成。

## 3. IDD 集成（真实服务）

链路：平台插件代理 → 产线窗口快照 CSV（真实 DAQ/TSDB）→ IDD `POST /api/diagnosis/tasks`（harness=mock, quick-screen）→ 轮询完成 → `/report` 代理回读 → Agent 写 `analysis_save` 台账（同时引用本体规则与 IDD run id）→ 台账检索命中。

实测断言（全部通过）：`I1` 插件健康+token 被接受 / `I2` 快照 CSV（30 分钟窗，rows≥20）/ `I3` IDD 注册 / `I4` 任务受理 / `I5` mock 引擎完成 / `I6` 报告回读（≥200 字符）/ `I7` 分析台账留痕 / `I8` 台账读回命中锚点。

## 4. RAG 集成（真实服务）

| 断言 | 内容 | 结果 |
|---|---|---|
| R1 | `kb_agent` 异步入库：平台 HITL 审批 → 提交任务（approvals=1） | ✔ |
| R2 | 入库任务达终态；失败归因外部（RAG 侧权限/540s 超时）记录在 `boundaries` | ✔ |
| R2b | **RAG 服务写读直连**：经验 API 写入本体规则锚点 → 经验检索命中（count=7，含本轮 marker） | ✔ |
| R2c | **平台 rag-bridge `/search` 直连 RAG two-stage 检索**（total=36） | ✔ |
| R3 | 检索任务受理（平台 → 知识库 Agent 通道） | ✔ |
| R4 | `kb_agent_status` 异步状态往返 | ✔ |

**外部边界（显式）**：RAG 侧知识库 Agent 的 kb-mcp 工具在本环境返回 `requested permissions — haven't granted it yet`，且 turn 在 540s 硬超时；因此**经 Agent 的文档入库内容级写入**未能完成。平台侧治理链（入库守卫 → HITL 审批 → 异步任务 → 状态轮询 → 失败诚实上报）全部按设计工作；知识库**服务级**写读已由 R2b、读桥由 R2c 真实验证。该边界已写入 `report.json` 的 `boundaries` 字段，不计为平台缺陷。

## 5. 实机演示渲染（截图证据）

平台页面（真实 Chrome，1600×1000，fullPage）：`docs/audit/evidence/2026-10-24-idd-rag-ontology/shots/`

- `ui-ontology-overview.png`、`ui-ontology-versions.png`、`ui-ontology-graph.png` —— /ontology 六 tab、版本台账、关系图
- `ui-plugins-diag.png` —— /plugins 诊断面板（IDD 代理链）
- `ui-analysis.png` —— /analysis 台账（含本轮「本体×IDD 联动分析」marker）
- `ui-dcw.png`、`ui-daq.png`、`ui-optimizer.png`、`ui-aml.png` —— 产线/数采/优化/建模实机页

文档站（构建产物渲染）：`docs-shots/docs-home-zh.png`、`docs-home-en.png`、`docs-ontology-zh.png`、`docs-ontology-en.png`。

另：模型闭环轮的截图见 `docs/audit/evidence/2026-10-24-model-loop-live/page-{optimizer,aml,ontology}.png`。

## 6. 文档与一致性修订

- 版本统一 **v0.8.0**（`package.json` / `config.yml` / README 双语 / 文档站首页 / cli·sdk·plugins 四组声明），`check-docs-sync` 91/91。
- 计数对齐：宿主工具 **101**（原 92）、外部 MCP **41**（原 38）、设置项 126、live 42 / restart 84。
- README 双语新增：`Model loop — AI-first` Highlights 小节 + 详述章节（本体/编译不变量/运行时四点/采纳环/验证/边界）；参考 Vite 与 LangChain README 的排版（badges → 一句话定位 → 分层 highlights 表 → quickstart → 细节→ 验证→ 边界）。
- VitePress：首页新增 ONTO / LOOP 卡片（中英），英文首页补齐此前缺失的 OPT/GOV 卡片；新增 `guide/ontology.md` 与 `en/guide/ontology.md` 并挂入侧边栏；`docs:build` 通过、零 pageerror。

## 7. 发布

- 提交：****7e064feb**（126 文件，已推 `origin/tii-revision-20261017`）**（分支 `tii-revision-20261017`，已推送 origin）
- npm：**agentworkshop@0.8.0** —— **已发布**（`latest`；tarball 41.78 MB / 4187 files；已校验产物内含本体路由与 `ontology_scene_inspect` 工具）
- 构建产物：`prepublishOnly` 触发生产构建（含本体路由与 101 件宿主工具）。

## 8. 遗留（下一轮，非本轮缺陷）

- `ProblemIrDelta` 作为求解约束消费；outcome 回路写入端；本体逐回合 prompt 注入；RDF/OWL/SHACL 导出（沿 ontology 计划遗留清单）。
- RAG 侧 kb-mcp 权限授予/超时调优属外部环境配置（建议在 rag-knowledge 侧为本平台身份授予 ingest 权限后复跑 R1–R2 内容级断言）。
