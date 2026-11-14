# AgentWorkShop 系统全局测评报告

> 日期:2026-11-15
> 评测对象:`main b6847187`(含 PR #214–#218)
> 评测口径:代码 review(bugbot 式 + security)+ 全量门禁 + 真实 IDD/RAG/Channel 作业 + 产线工况案例 + Mimosa 终扫
> 设备边界:**模拟产线(mock DCW/DAQ)**;物理 HIL 未执行。Mimosa 仍为 partial/inconclusive,不是安全通过。

---

## 0. 结论摘要

| 判定 | 结论 |
|---|---|
| 代码完整性 / 合并状态 | **通过**。main = `b6847187`,无 open PR;所有 plan PR 已合并,工作树干净 |
| ESLint / 类型 / 单测 | **通过**。lint + RSI 红线 21 文件 0 设备写;typecheck;unit **1663/1663** |
| 产线治理 / DCW 写控 | **通过(模拟)**。line governance **44/44**,HITL→单步/60s/量程/回读全链 |
| 优化器 / 过程模型 | **通过(模拟)**。optimizer live **105/105**,OSQP optimal、审批→D13→下发→回读一致 |
| 科学探索 / AML / 虚实闭环 | **通过(模拟边界)**。scientific full chain **21/21** |
| 本体 | **通过(离线)**。ontology offline **57/57** |
| RSI Beta | **通过(只读)**。矩阵 **31/31**;最终 build 真实模拟产线探针 **7/7** |
| IDD 集成 | **部分通过**。quick-screen 完成并落盘(19.8KB 报告);deep-diagnosis 40min `omp_timeout` |
| RAG 集成 | **通过(有可用性缺陷)**。报告入 KB、向量/插件检索命中;大库后台重建时 API 被阻塞 |
| Channel Agent 全链 | **通过(有编排风险)**。omp+ustc/deepseek-flash:lead 拆分→worker 执行→lead 独立复核→任务 COMPLETED;根任务曾因默认 10min 停滞被取消 |
| 物理 HIL / 真实设备写控 | **未执行 / 不宣称** |
| Mimosa 安全结论 | **不可用**。partial/inconclusive(34 静态 findings,依赖 0),不是安全通过 |

**总判断:系统已经具备“受控试点(Pilot)”能力 —— 只读诊断、知识沉淀、HITL 治理下的调优与优化器求解可以落地;但“全自主深度诊断 + 物理闭环写控”尚不具备无条件生产落地证据。**

---

## 1. 测评方法与证据

1. **代码 review**:按 `review-bugbot` 与 `review-security` 的同一范围,用只读评审代理对 `f4f4d8dc..b6847187` 做两轮正确性/安全审查;共发现 15 项(含 2 项 Medium 资源/证据完整性问题),PR #218 修复并加回归测试;第二轮复审又抓出 4 项(tagged 截断方向、/adapter 能力真相、缺失审计端口、matrix host),已在 #218 第二提交修复。
2. **静态/单元/契约**:lint + RSI 红线、typecheck、docs、i18n、README、cssvars、frontend lifecycle、unit、MCP、plugin/diag/RSI、SDK、twin、skills。
3. **实机(隔离)**:line governance、scientific fullchain、ontology offline、optimizer live、RSI compatibility matrix、production `.output` 启动 smoke。
4. **真实外部系统**:IDD `:3210`(omp/ustc-deepseek-flash)、RAG `:8771` + web `:6789`(aw-industrial KB)、AgentWorkShop `:3994`;真实 HTTP token、真实任务、真实报告、真实 KB 入库/检索。
5. **真实 Channel 作业**:omp lead + omp worker,双插件(diag/rag),绑定模拟产线,完成“取数/导出→IDD 诊断→知识库检索→复核验收”。
6. **Mimosa**:deep scan,1841 文件解析,34 findings,依赖 0;覆盖状态 partial/inconclusive。

---

## 2. 面向产业目标的架构映射

| 产业需求 | 现有机制(代码锚点) | 实测证据 | 成熟度 |
|---|---|---|---|
| Agent 操控实际工况 | Channel/Session/Project 运行时;DCW `write()` 单点咽喉;HITL/权限/审计;执行模式 observe/manual/auto | line 44/44;optimizer 105/105;Channel lead/worker 真实任务 | M2(模拟)/M3(治理架构) |
| 实时 + 历史数据 | DAQ 驱动族(mock/Modbus/OPC UA/RTU/MQTT/HTTP)、TSDB(Timescale/SQLite)、latest/history/tagged/frames、保留期 | scientific 21/21;IDD 数据集 609 点/节点;RSI evidence 探针 | M3 |
| 参数调控下发 | 配方/参数/节点写控;四层限界、步长、60s、活动配方窗;ACK/回读;D13 复核 | line 44/44;optimizer W7 verified、W8 readValue=48 | M3(模拟) |
| 自定义配置驱动/产线管理 | 驱动注册表 + 插件 `ctx.daq/dcw.registerDriver`;模板/节点/产品/配方/绑线 | 驱动注册/重载测试;矩阵建线全链 | M3(单协议需逐项验证) |
| RSI 机制(绑定节点/产线学习) | ResearchOrchestrator + CandidateEvidenceStore + ContextRuntime scope + read adapters;Beta 只读 | RSI runner sim+baseline PASS;矩阵 31/31;final build 探针 7/7 | M2(只读 candidate) |
| 自动数据建模 + 虚拟求解 | AML dataset/job/gates/models;ProcessModel;OSQP 线性 MPC;twin/scene | scientific 21/21;optimizer live 105/105(OSQP optimal) | M3(模拟标定) |
| 闭环优化/数据分析 | 优化记录→判读→回退/调优;EDA/分析报告;科学探索 DoE | scientific 21/21;optimizer 审批→下发→回读;IDD 快筛 | M2/M3 |
| 本体自动构建/工况理解 | Ontology draft/validate/publish/semantic bindings;IDD ontology builder | ontology offline 57/57;IDD deep-run 卡在 ontology wait(超时) | M2(自动构建未闭环) |
| 物理规律/多维驱动 | ProcessModel/物理 spec、twin physics spec、证据门 | scientific 21/21(注入响应,非物理);physical HIL 未跑 | M1/M2 |
| IDD 深度诊断 | diag-bridge:task/async/sync/report/results;IDD 9 阶段/14 引擎 | quick-screen 完成;deep 40min omp_timeout | M2 |
| RAG 知识沉淀 | rag-bridge:ensureKB/kb_agent/search/experience;RAG 向量+图谱 | 报告 36 chunks 入库;向量/插件检索命中;大库重建阻塞 | M2 |
| Channel/Project/Session 集成 | Channel 成员/任务/消息/HITL;Project Leader/工作项;Session 上下文 | lead→worker→复核→COMPLETED;KB 审批;消息轨可回溯 | M2/M3 |

**关键结论**:架构上“数据→证据→决策→治理写控→回读→学习”的主干是完整的,并且是**单点收敛**的(写控走 DCW write 咽喉、证据走 CandidateEvidenceStore、授权走 ContextRuntime)。短板不在“有没有模块”,而在**长时任务可靠性、外部服务可用性、物理标定与自动本体闭环**。

---

## 3. 实测结果明细

### 3.1 静态与单元(T0/T1)

| 门禁 | 结果 |
|---|---|
| lint + RSI 红线 | PASS(21 文件 / 0 设备写调用) |
| typecheck | PASS |
| docs:check | 87/0 |
| i18n | 3328/3328,unresolved 0 |
| README lint / cssvars / frontend lifecycle | PASS / 161 引用 / 3/3 |
| unit | **1663/1663** |
| MCP | 14/14 |
| plugin/diag/RSI | **72/72** |
| SDK / twin / skills | PASS / 5/5 / 167/167 |

### 3.2 实机与端到端

| 套件 | 结果 | 边界 |
|---|---|---|
| line governance | 44/44 | 隔离 host + mock DCW/DAQ |
| scientific full chain | 21/21 | mock 设备/夹具响应 |
| ontology offline | 57/57 | 服务层直驱 |
| optimizer live | **105/105** | 模拟标定 + 真实浏览器 UI + HITL |
| RSI compatibility matrix | **31/31** | isolated AW_HOME + mock;off/on 全链 |
| production `.output` smoke | 18/18 | `/`、`/daq`、`/optimizer`、`/plugins` 水合,0 pageerror |
| RSI final-build real-line probe | **7/7** | 既有模拟产线;只读 evidence/DCW 回读/DAQ 历史 |
| IDD/RAG/Channel E2E | **7/7**(有边界) | 真实 IDD/RAG 服务 + 模拟产线 |

### 3.3 IDD/RAG/Channel 真实作业

- IDD quick-screen `064cb296`:**completed**,报告 19,815 B,数据 609 点/节点;结论:温度未越限/未冻结/无真实漂移;压力节点**元数据错配导致越限 UNDETERMINED**。
- IDD deep-diagnosis `954d6fa7`:**failed / omp_timeout**(40min 预算耗尽)。
- Channel:lead 创建根任务 `3fd608bb` 并拆分 worker 任务 `a6952741`;worker 完成,lead 独立复算并给出“最终验收通过”;任务 `a6952741` **COMPLETED**。根任务因默认 10min 停滞被 CANCELED(实例已将 `workshop.harness_stall_timeout_ms` 调至 30min)。
- RAG:报告进入 `aw-industrial` KB(36 chunks),向量检索与 rag-bridge 插件检索均命中;KB 入库审批 `ap-5b091f47` 经人工批准。
- **真实数据质量发现**:压力节点误用温度模板(`unit=℃`、量程 150–185、semantics 复用),IDD 拒绝猜测并给出竞争集;这是“自定义配置错配”场景下有价值的真实诊断,不是脚本造假。

### 3.4 安全扫描

- Mimosa:`scan-2026-11-14T16-31-23.108Z-b901d3247eac`,seal `sha256:c2478c…`,1841 文件解析 0 失败,34 findings(23 high/11 medium,依赖 0),**partial/inconclusive**。
- 新增/改动的 RSI、diag、RAG、matrix 文件未被 findings 命中;三项历史 P1(serial probe 任意写、diag 跨线快照、导出路径穿越)已在前轮修复并有回归测试。
- 结论:**ESLint 全绿;Mimosa 不是安全通过**,不能对外宣称“安全验收通过”。

---

## 4. 真实缺陷与处置

### 4.1 本轮 review 发现并修复(PR #218)

1. **帧 `meta.points` 泄漏**:预览 points 截断但 meta 携带完整向量/图像 blob → 已剔除并限制字符串/数组。
2. **无总预算/不可取消**:observe 可一次拉 50 节点 × 5000 点 × 100 帧;15s 超时不停止工作 → 加 20k 点/200 帧/2MiB 预算、逐节点 abort 检查、跳过空 DAQ 的 tagged 全表扫描。
3. **审计 fail-open**:`listInterventions` 把 DB 错误吞成 `[]`,证据把“台账不可读”伪装成“零写入” → `listInterventionsStrict` + `writeAuditAvailable/writeAuditError`。
4. **无授权 fail-open**:直接构造 adapter 且 boundLineIds 为空时读全 line → 强制非空宿主绑线。
5. **metadata foreign scope 误报 UNBOUND** → `SCOPE_FORBIDDEN`/visible false;UNBOUND 仅限“未带 scope 且无 kv 约束”。
6. **能力真相**:`/adapter` 曾回静态 ALLOWED(含 simulate/replay/verify)→ 与 metadata 统一为注册 adapter 真实能力;无 adapter 时为空。
7. **research 接线失败误杀 adapter** → adapter 保持注册,research 只标记不可用。
8. **矩阵自证断言** → 严格 readValue、审计契约、panel 文本、foreign metadata、显式 127.0.0.1 绑定。

### 4.2 外部/运行层发现

- **IDD deep-diagnosis 超时**:40min `omp_timeout`;quick-screen 成功。需要按意图设置预算/更快模型/分阶段执行。
- **Channel 根任务 10min 停滞取消**:默认 `workshop.harness_stall_timeout_ms=600000`;长回合 lead 会被取消,子任务可继续。建议按任务配置 30–60min,或让 lead 优先异步拆分。
- **RAG 大库重建阻塞**:验收期间 RAG 对大型 KB 后台重建,健康/检索出现 HTTP 000/超时;需要索引队列与读面隔离。
- **插件路由启动竞态**:health ready 后约 2s 内 rag-bridge `/health` 曾 404;探针/前端应做重试。
- **IDD 自身算法问题**(报告披露):C4 马氏距离在双参数场景被误判病态跳过;稳健 z 多乘 0.6745,`n_outliers=0` 不可作为无离群证据。

---

## 5. 落地判定

| 能力 | 判定 | 说明 |
|---|---|---|
| 只读诊断 + 知识沉淀 | **可试点** | IDD quick-screen 完成、报告落盘、RAG 检索命中、Channel 回执;需解决 deep-run 预算与 RAG 索引隔离 |
| HITL 治理下调优/优化器求解 | **可试点** | optimizer 105/105、D13 复核、回读一致;物理标定后可按线推广 |
| 自定义驱动/多产线管理 | **可试点** | 驱动插件化、模板/绑线完整;每种协议需独立联调与故障注入 |
| RSI 学习/候选证据 | **机制可用,推广受限** | candidate-only、只读、默认关闭;无 promotion/actuation,需人工治理闭环 |
| 自动本体构建/工况理解 | **部分** | 离线 57/57;IDD deep-run 卡在 ontology wait,自动构建未闭环 |
| 全自主深度诊断 + 物理闭环写控 | **尚不可宣称** | physical HIL 未跑;deep-run 超时;长回合编排与 RAG 可用性未达标 |

**推荐落地路径**:先做 1 条模拟/影子线的“只读诊断 + 知识库 + HITL 调优”试点 → 接入真实 PLC 的只读镜像 → 物理 HIL 授权窗口下验证 ACK/回读/步限 → 再开放 supervised 写控 → 最后评估 auto 模式。Beta 的 read-only/candidate-only 边界应保持,直到 promotion/actuation 有独立治理与证据门。

---

## 6. 风险与路线图

### P0(上线前必须)
1. **物理 HIL 授权与安全验证**:真实 PLC/DCW/DAQ 的 ACK、回读、步限、量程、60s、急停/回退,在授权窗口完成;当前全部设备证据是 mock。
2. **IDD deep-run 预算/容量**:按意图拆分 9 阶段,设置可观测的子阶段超时与断点续跑;避免 40min 整体超时。
3. **RAG 索引隔离**:大库重建走队列/后台 worker,读 API 与索引解耦;提供健康降级与重试。

### P1(试点前)
4. **长回合编排**:默认 stall 10min 对工业长任务偏短;提供按 Channel/任务配置、心跳与子任务优先策略。
5. **节点元数据校验**:上线前强制 unit/range/warn/semantics 一致性检查(本次 IDD 案例已证明错配会让越限判读失效)。
6. **插件启动就绪**:health 与插件路由注册就绪分离,提供 `/ready` 或重试语义。
7. **RSI 治理闭环**:candidate→人工评审→受控 promotion 的独立门与审计;当前无 promotion。

### P2(持续)
8. 帧 meta 递归净化、默认审计端口 DB 故障测试、更多协议驱动故障注入、Mimosa 完整覆盖(扫描器侧)。

---

## 7. 证据索引

- 总账:[2026-11-15-final-gates.json](evidence/2026-11-15-final-gates.json)
- IDD/RAG/Channel:[report.json](evidence/2026-11-14-idd-rag-channel-e2e/report.json) / [REPORT.md](evidence/2026-11-14-idd-rag-channel-e2e/REPORT.md)
- 兼容矩阵:[report.json](evidence/2026-11-14-rsi-compatibility-matrix/report.json)
- optimizer live:[report.json](evidence/2026-11-15-optimizer-live/report.json)
- production smoke:[2026-11-14-final-production-smoke.json](evidence/2026-11-14-final-production-smoke.json)
- RSI runner:[simulation](evidence/2026-11-15-final-rsi-simulation.json) / [baseline compare](evidence/2026-11-15-final-rsi-baseline-compare.json)

---

## 8. 最终声明

**可以宣称**:main `b6847187` 的全部 plan PR 已合并;ESLint/typecheck/unit/实机/优化器/矩阵/production 启动均通过(模拟边界);IDD/RAG/Channel 真实服务集成已跑通并有可复核证据;review 发现的 high/medium 问题已修复。

**不可以宣称**:物理 HIL 通过;真实产线闭环写控安全;Mimosa 安全通过;全自主深度诊断可靠;RAG 在大规模索引下的生产可用性。
