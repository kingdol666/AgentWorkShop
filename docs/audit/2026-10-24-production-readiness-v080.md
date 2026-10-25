# 生产就绪评估（v0.8.0 + 模型管理面）— 2026-10-24

> 问题：当前系统能否投入生产使用？模型管理机制如何？
> 结论分场景给，不给一句“能/不能”：
> **实验室/试点（真实 PLC 或协议模拟器）＝ 可以；车间只读接入 ＝ 可以（需现场联调）；
> 车间写控直接生产 ＝ 有条件（需完成 §3 清单，且首绑 manual、小步放行）；硬实时/安全联锁 ＝ 不属于本系统。**

## 1. 就绪度总表

| 维度 | 状态 | 依据 |
|---|---|---|
| 功能完整度（工业 I/O / 治理 / 优化 / 模型层） | **READY** | 101+2 宿主工具（103）；五协议读写 + 串口插件；HITL/四层限界/回读；本体/AML/Profile 三层模型管理面 |
| 测试证据 | **READY（本机范围）** | 单测 538、服务层 50、本体真机 72、模型闭环真机 54、本体×IDD×RAG 27（本代码变更前的同源轮次，变更未触及该链路）、文档一致性 91、类型检查 0 error、生产构建通过 |
| 数据完整性 | **READY** | 时序列 run/product/recipe 打标、谱系校验、append-only 分析台账、审计三态、写回读 ack |
| 治理与安全 | **READY（默认安全档）** | 写链 fail-closed（未知协议/驱动缺失显式失败）、HITL、审批后 D13 八重复核、本体守卫 409、绑定面越权拒绝、token 脱敏 |
| 可观测/可运维 | **READY** | ops_log/审计/审批/运行台账、WS 实时、备份与保留策略、单实例锁 |
| 升级与回滚 | **READY** | 配置根迁移 + schema 迁移；Profile 版本不可变 + 绑定重绑；本体版本不可变 + 退役；配方/批次回退 |
| 现场适配 | **CONDITIONAL** | **无物理 PLC 联调记录**；本机 122 个端点全部 127.0.0.1（协议模拟器）；见 §3 |
| 安全审计（第三方扫描） | **NOT CERTIFIED** | Mimosa 仅跑过兼容策略（`scanner_enobufs` 未完成），不得宣称“已通过安全审计” |
| 稳定性/长稳 | **PARTIAL** | 有压测/看门狗/堆水位治理；本轮无 24×7 连续跑证 |
| 实时性 | **边界明确** | 秒级监督层；<10ms 硬实时与安全回路必须在 PLC |

## 2. 模型管理机制（本体 / AML / Profile）

### 2.1 三层对象与生命周期

| 层 | 对象 | 生命周期 | 版本与不可变 | 谁能写 | 人怎么把关 |
|---|---|---|---|---|---|
| 本体 | 草稿 → 发布版本（实体/关系/规则/语义绑定） | `proposed → reviewed → validated → approved_for_control → deprecated` | 发布即新版本；四段 diff；退役不删除 | Agent（8+1 工具，草稿/校验/编译预览/提议发布/自动修复）；管理员 REST 发布 | 规则批准单（第二人；单管理员 solo 豁免留痕）；发布仅 admin；自动修复不伪造证据 |
| AML 模型 | 数据集 → 作业 → 实验 → 模型（stage: candidate/shadow/production/retired） | 训练门禁 G1–G3 → 晋升（Twin Gate/UQ/OOD） | 模型工件哈希 + label/description；谱系（线/产品/配方） | Agent（训练/查询/描述 annotate）；晋升 HITL | 晋升卡 + 门禁；描述只改元数据，不改阶段 |
| 求解器 Profile | 草稿 → published（solverRef/template/ProblemIR hash/ontologyRefs） | draft → validated → published → retired | 版本不可变；发布冻结哈希；采纳新版本+自动重绑 | Agent 通过 `optimizer_profile_propose` 提议；REST 建/发/退役 | HITL 单一咽喉；D21 兼容门；拒绝零写；旧版本可回退 |

### 2.2 描述字段（本轮新增/补齐）

- **本体**：文档级 `description`；实体/规则描述缺省由 autofix 补齐（实体←名称，规则←DSL 语义）。`/ontology` 头部展示，Agent 工具可写。
- **AML**：注册时由 `model_name/model_description` 派生 `label/description`；新增 Agent 工具 `aml_model_annotate` 与 `PATCH /aml/models/:id`（label/description）维护；`/aml` 列表行显示描述副行。
- **Profile**：新增 `name`/`description`（DB 列 + 契约 + 列表 API + UI 表单/列）；采纳提议可携带 `profile_name/profile_description`，随版本冻结。
- 三者都**只改元数据**：不影响 ProblemIR 哈希、求解结果、门禁判定。

### 2.3 校验问题的自动修复（本轮新增）

- REST `POST /ontology/drafts/:id/autofix` + Agent 工具 `ontology_draft_autofix` + UI「自动修复」按钮。
- 安全修复 7 类：文档/实体/规则描述、量纲跟随单位（复合单位不主张量纲）、规则/绑定作用域回填、绑定单位与 scale 归一、悬空关系/绑定移除、重复 id 去重或改 `-dupN`、证据不足的控制级状态回退。
- **部分修复可落库**（乐观锁 + 审计），残余错误随回执返回；`validated_control` 证据永不伪造。
- 实测：历史/导入脏草稿 18 项修复后校验通过；证据不足用例修复后仍报错（符合设计）。

### 2.4 模型管理面的证据链

- 审计：`ontology.draft.autofix`、`optimizer.profile.adopt_propose/adopt`、`aml.model.annotate` 等 action 全量入 audit_log（actor 三态）。
- 漂移：`ontologyRefs` 与 ProblemIR 哈希分域；漂移 409。
- 回退：Profile 旧版本保留；本体版本退役；AML 模型 stage 降级/retired；配方/批次回退。

## 3. 投产清单（按阶段，逐级放行）

**P0 实验室/试点（现在可做）**
- [ ] 一台可连 PLC/网关 + 寄存器表/OPC UA 节点表（IP、端口、UnitId、字节序、数据类型、量程）
- [ ] `aw-line-onboarding` 生成 driverConfig → `test-driver` 全过
- [ ] 单点只读 dry-run（DAQ）与写点 dry-run（不落库的 test）
- [ ] **一次受治理写入 + 回读一致**（首绑 manual，HITL 由负责人裁决）
- [ ] 记录时延/丢包基线

**P1 车间只读影子（建议 1–2 周）**
- [ ] 只接 DAQ（不接写控）；跑 IDD/RAG/本体先验/分析台账
- [ ] 观察采样完整性、时钟/时区、断链重连、告警噪声
- [ ] 用真实数据复核本体规则（温区/工艺窗）与阈值

**P2 单点写控（小步）**
- [ ] 仅 1–2 个低风险 SP；绑定 manual；四层限界复核
- [ ] 每次写入回读一致率、拒绝原因分布、审批时延纳入日报
- [ ] 演练回滚（配方回退/批次恢复）

**P3 小批量产**
- [ ] 扩到一条线全部 SP；300s 试验节拍与 60s 锚窗按现场节拍校准
- [ ] 7×24 连续运行 ≥ 1 周，无未解释的 unverified；崩溃/重启自动恢复验证

**P4 产线切换**
- [ ] 变更管理/安全评估签字；安全联锁/急停仍在 PLC
- [ ] 备份、保留策略、账号与 token 轮换、审计导出演练

## 4. 已知阻塞项与风险（如实）

1. **物理 PLC 未联调**：本机全部端点为本机模拟器；现场寄存器/字节序/证书/防火墙未验证（最大风险项）。
2. **OPC UA 写固定 Double**：现场若为 Int16/Word/Struct，需要补类型或改走 Modbus/HTTP/串口。
3. **第三方安全审计未完成**（Mimosa `scanner_enobufs`）——不得对外宣称已通过安全认证。
4. **长稳证据不足**：本轮无 24×7 连续运行数据。
5. **RAG 侧 kb-mcp 权限未授予**：经 Agent 的文档入库内容级写入被外部权限墙拦截（平台治理链正常）。
6. **计划内未实施项**：ProblemIrDelta 作为求解约束、outcome 回写回路、RDF/OWL/SHACL、SW6.x 跨进程租约（独立大项）、Timescale 读侧对等。
7. **单进程写锁/单实例**：多实例部署需外部协调（不是分布式写控系统）。
8. **模拟器稳定性**：历史轮次出现模拟器进程静默退出（已加看门狗），现场需服务化托管。

## 5. 结论

- **可以投入**：作为监督层，在实验室或试点线（真实 PLC）做“只读 + 单点受治理写控”的落地；软件链、治理链、模型管理链与证据链齐备。
- **不建议直接做**：未经现场联调即接入车间写控；把急停/安全联锁交给本系统；把“模拟器验收”当“车间验收”。
- **模型管理机制评估**：三层模型均具备“可创建、可描述、可版本化、可审批、可回滚、可审计、Agent 可控、人类可改”的闭环；本轮补齐了描述字段与草稿自动修复，管理面达到可交付水平。剩余缺口是语义增强（ProblemIR 消费/outcome 回路）而非管理闭环。
