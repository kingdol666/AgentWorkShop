# EDA/Data Studio 后续优化作业计划

状态：**pending approval（待用户批准后执行）**
日期：2026-10-21
前置：docs/plans/2026-10-21-data-studio-plan.md（已实施）、docs/plans/2026-10-21-eda-enterprise-plan.md（已实施）
流程：真实性核查（2 Agent，15+7 项逐条代码实证）→ 优化项收集（1 Agent，30+ 项去重）→ 本计划 → Critic 复审

---

## 0. 验收结果真实性核查结论（先回答"测试结果是否属实"）

**结论：属实。** 两个独立核查 Agent 对 22 项声称逐条做了代码级实证（文件:行号锚点），**零虚报**：

- **新功能 15/15 ✅**：批量查询服务与护栏（data-query.ts:21-23,130-155）、导出账本（并发=1/bootedAt 判死/防穿越白名单，data-export.ts:84-93,264-274）、MES 用户面频控与脱敏（mes-console.ts:26-42,121-122）、图表 B4 可见性（chart-repo.ts:77-102）、golden 相位分箱与偏差分（golden.ts:107-131,179-227）、FDC 关账钩子真实接线（dcw-recipe.repo.ts:433→eda-run.repo.ts:86-92→features.ts:119-128）、SPC Nelson 全规则+建限≥25（spc-math.ts:17-67、spc.ts:19,136-153）、共性四因子+lift、OCAP 全生命周期、派生算子白名单、看板 B4 防旁路、run 台账镜像钩子、VM io_spec 对齐+OOD 拒判（vm/predict.post.ts:58-95）、run_segments、UI 三页与导航——全部存在且接线。12 张 eda_* 表真实建表（eda-db.ts:24-205）。
- **先前功能 7/7 ✅**：Agent 绑定端点与隔离双层防线（bindings/index.post.ts:24-106 + tool-verify.ts:132-142）、开停线 HITL 卡（line-tools.ts:62-71,214-220）、审批期 TOCTOU 三连复核（admin-channel.ts:161-171、line-tools.ts:238-244、ops-tools.ts:988-1015）、DCW 写回读/步限/60s/四层限界（write.ts:96-158）、MES HITL 下发（ops-tools.ts:1148,1176）、外部 ingest 形态校验（ingest.post.ts:67-166）、分析台账（schema.ts:757-783）——脚本断言数 7/44/25 与实现机制一一对应。
- 审查员同时确认证据 JSON（24/24、50/50）数字与报告一致、无越界声称。

## 1. 需求覆盖现状与差距总览

用户三大需求均已落地主干，剩余为**深化项**（详见 §2 待办）：
① EDA 可视化+多字段查询+导出+多源异构+实时镜像 → **主干完成**；缺：导出列勾选/xlsx、节点树搜索/虚拟滚动、LTTB。
② 在线抓数据分析+企业级全功能（FDC/SPC/VM/共性）→ **API 层完成**；缺：分析结果 UI 面、违例注入 e2e 种子、alarm_events 桥接、OCAP UI、VM 训练链 e2e、DTW。
③ 按用户保存/权限/看板 → **完成**；缺：看板筛选器、数据集作图表数据源、Agent 深度分析回写、scheduled 派生重建。

## 2. 优化待办（P1 = 10 项核心；P2/P3 见附录清单）

### Wave P1（10 项，覆盖全部高关联缺口）

| # | 项 | 实现要点 | 验收标准（可执行） |
|---|---|---|---|
| P1-1 | 节点树升级（/data 与 /studio 共用组件） | 移植 TownDaqTree 模式：搜索框+templateKey 分面折叠+localStorage 收藏+虚拟滚动 | 500 节点种子（脚本生成）下滚动无卡顿——performance mark/longtask API 断言交互帧无 >300ms 长任务；搜索命中 <100ms（performance.now 计时）；收藏刷新后保留 |
| P1-2a | 导出列勾选（CSV，无条件 P1） | 导出弹窗列 checkbox（映射所选节点） | 导出 CSV 仅含勾选列：列头=勾选列，数据行数不变（文件读回断言） |
| P1-2b | xlsx 格式（**条件 P1**） | exceljs 流式写 | **机器断言**：解析库读回 workbook——数据行数=CSV 数据行数、列数=勾选列数、单元格值抽样相等。供应链门槛：锁定版本+audit 无已知 CVE+维护活跃度，任一不过自动移 P2 并按原则⑤披露（此时本 Wave 按 10 项中的 P1-2a 单独验收，验收总门按 10 项口径——P1-2a 计入、xlsx 移 P2） |
| P1-3 | 看板筛选器 | filters_json 加 node_ids[]/run_id 变量；panel datasource `{{var}}` 插值重查；**插值结果全部参数化进查询绑定，禁止拼接** | 改筛选下拉→≥2 panel 重查且请求参数含新值（网络断言）；含越权负例：筛选注入他线 node_id → panel 查询 403 |
| P1-4 | 数据集作为图表数据源 | studio 数据源树加"数据集"节点；图表 datasource 支持 datasetId（读 mes_datasets/派生 CSV rows 面） | 选派生集建图→保存→重开，**canvas 断言通道**：`echarts.getInstanceByDom(grid)` 读 series[0].data 长度=数据集行数（组件暴露实例或经 getInstanceByDom） |
| P1-5 | 派生集 scheduled 定时重建 | scheduled_tasks 加 kind='derived-rebuild'，执行体复用 derived 服务（纯 TS；与 A-7 不冲突：调度的是**导出产物重建**，特征计算仍走关账钩子）；验收允许注入过期 next_run/手动 tick 触发，避免睡眠等待 | 注入过期 next_run→tick 后 eda_export_jobs 出新 ready 行，产物与上轮一致（行数相等） |
| P1-6 | 一键 Agent 深度分析（真回写） | studio 按钮→channel 发送组装 prompt→Agent 结论经 analysis_save 回写台账；**e2e 用 stub Agent 回复注入信箱做确定性验收**（不依赖真实 LLM 回合） | 注入 stub 回复→analysis 台账出现新 ar- 记录（≤5 分钟轮询） |
| P1-7 | 违例注入 e2e 种子化（**执行顺序：本 Wave 最先**） | e2e 新 seed 阶段：**顺序关账——3 good 批先完成特征计算（REF_MIN_RUNS=3 门槛），再关违例批**（调 warnHigh 注入）；P1-8/P1-9 断言与 P1-10 训练数据均以此为前置 | E3① violated=1、E5① lift>1、E7① 通知 eventId 幂等——3 组断言全绿 |
| P1-8 | alarm_events 桥接（'fdc-zscore' rule，**依赖 P1-7**） | sweep-alarms 扩 rule 枚举，输入=特征行 violated；复用 ack/冷却链 | 违例批→alarm_events 一行(kind='alarm', rule='fdc-zscore')+ack 入审计；**幂等断言：同 run 重复桥接仅一行** |
| P1-9 | OCAP UI 入口 | /operations 加 OCAP 列表+详情（步骤/关单）；告警与 FDC 违例行加"开处置单"按钮 | **DOM/状态断言**：开单→详情页出现新步骤行（渲染断言）→关单后状态列=已关单；告警详情"开处置单"后列表行状态翻转。截图仅作附件 |
| P1-10 | VM 训练链 e2e 种子 | 造特征向量数据集→AML 训练 purpose='virtual_metrology'→门禁→promote→predict；**含失败路径断言**：训练数据不足时门禁拒绝（明确错误码） | predict 返回有限数值；OOD 注入返回 rejectCode；数据不足→明确拒绝而非静默 |

每个 P1 项验收含权限断言（越权负例）或标注 N/A 理由（如纯前端渲染项）。

### Wave P2（6 项）

| # | 项 | 要点 |
|---|---|---|
| P2-1 | EDA 分析 UI 面（/studio 或 /data 加"分析"tab）：SPC 控制图（Nelson 命中标红）+commonality 交叉表+特征违例清单 | 企业级能力的用户可见面 |
| P2-2 | 批次对齐叠加：选 N 个 run→相位桶重采样并列 series+run 图例（golden 复用已有重采样） | 任意两 run 相位对齐比较 |
| P2-3 | annotations/markArea：图表标注编辑→annotations_json→MarkArea 渲染（与 MarkLine 同批注册） | 事件标注 |
| P2-4 | mock/外部帧来源标识：ingest 保留自定义 metrics 键（派生统计加 derived_ 前缀）+ 帧模型 source 字段 | 消除 48/64 点区分的脆弱性 |
| P2-5 | 批次 outcome 自动收敛：特征任务钩子——run 有 violated=1 → 建议 outcome='bad'（golden 的 good 前提不再依赖人工） | golden 数据源自动化 |
| P2-6 | live tail + URL 状态完整序列化 + 数据源树搜索（与 P1-1 同组件） | M4 体验项打包 |

### Wave P3（按需）

LTTB 纯函数降采样、导出流式写、多变量 T²/SPE（AML 升级路径）、public 可见性、xbar_r 子组接线（需段内多特征）、资产相对模板 `{{node}}`、kiosk 大屏、grid-layout-plus 指针拖拽、Timescale 体量探针、B 类健壮性 6 项（dashboard 单测、OOD per-model 阈值、sample_count 用特征行数回填、大图像载荷压测等）、本轮两核查员发现的 10 条小代码问题（死分支/死导出/chamber 契约/弱路径前缀校验/bindings 死代码与文档漂移）——全部列入随手修清单随相邻改动清理。

## 3. 验收总门

1. P1 各项逐条验收标准全绿（新增 UI 断言一律用**渲染产物**而非文案存在；每项含权限/越权负例断言或标注 N/A 理由）。
2. `scripts/data-studio-e2e.mjs` 50 断言 + 新增 seed/VM/OCAP-UI 断言全绿；`npm run test:unit` 全绿（新增 dashboard-repo 单测）。
3. `npm run lint` exit=0；typecheck ✔；i18n PARITY OK（新 UI 文案双语言同补）。
4. 独立审查员按 PRD 逐条复核 APPROVED（沿用本轮"渲染产物断言+网络断言"标准，不接受文案存在式通过）。
5. **条件出口**：P1-2b（xlsx）若未过供应链门槛而降级 P2，本 Wave 验收按 10 项口径（P1-2a 单独计），不阻塞总门。

## 3.5 执行顺序（编号≠顺序）

1. **P1-7 最先**（种子地基）：顺序关账——3 good 批先完成特征计算（`REF_MIN_RUNS=3` 门槛），再关违例批；产出 P1-8 桥接输入、P1-9 演示数据、P1-10 训练数据。
2. **P1-8 随后**（消费 P1-7 的违例行）。
3. **P1-4 → P1-5**（数据集入图是定时重建的消费面前提）。
4. 其余（P1-1/2a/2b/3/6/9）无硬依赖，可并行（P1-9 的**验收数据**依赖 P1-7 种子，实现本身可先行）。

## 4. 风险与缓解

| 风险 | 缓解 |
|---|---|
| P1-7 种子依赖真实采样节拍（批时长） | 用 ingest 补采打标（演示已验证该路径），批窗压缩到 30s 级 |
| P1-6 Agent 回合时长不可控 | e2e 用 stub Agent 回复注入信箱（确定性）；真实使用组装 prompt 直接投 channel 信箱即算送达，回写异步轮询（验收上限 5 分钟） |
| P1-8 alarm 域分裂（采样域 vs run 域） | rule 枚举扩展不动既有采样告警；桥接行以 runId 维度幂等 |
| exceljs 新依赖（供应链） | 锁定版本 + `npm audit` 无已知 CVE + 维护活跃度检查，**任一不过触发 P1-2b 降级路径**（CSV 列勾选照常交付） |
| scheduled 重建 vs 用户导出/特征队列并发写 | 复用 eda_export_jobs 账本以 datasetId 串行化；禁止并行重建同一数据集 |
| 图表渲染为 canvas，DOM 不可计数 | P1-4/P2-1 验收统一走 `echarts.getInstanceByDom` 读 series 数据断言（组件暴露实例或经 DOM 反查），不接受纯截图 |
| P1-3 `{{var}}` 插值是用户可控 JSON 进查询的注入面 | 插值结果全部参数化绑定，禁止字符串拼接（前置计划 §5.4 同款纪律） |
| 范围蔓延 | P2/P3 项未经批准不入本 Wave；每 Wave 完成即独立提交+审查 |

## 5. RALPLAN-DR 摘要

- **原则**：① 渲染产物断言优于文案断言；② 复用既有基建（channel/analysis/scheduled_tasks/alarm 链）优先新建；③ 分析落特征表不落 raw；④ 每项独立可验收、独立提交；⑤ 如实披露降级。
- **决策驱动**：TOP3 = 用户需求①的"导出与异构查询"完整性、需求②的企业级分析用户可见面、验收证据链可信度（种子化）。
- **可选方案**：A) 按 P1 清单串行两 Wave（推荐）；B) 全 30 项一次性排期（否决理由：P2/P3 项价值依赖 P1 地基，且审查轮次成本高）；C) 只做 UI 面不做种子化（否决理由：无违例种子则「EDA 分析 UI 面」与「alarm_events 桥接」展示的是空态，重蹈"截图空态假证据"覆辙）。
- **ADR**：决策=按 Wave P1 十项先行；驱动=需求关联度×基建复用度×验收可信度；备选=全量排期/仅 UI；后果=VM 训练链、批次对齐、DTW 等留 P2/P3；跟进=每 Wave 终了回写本计划状态。
- **与 A-7 的区分**：P1-5 调度的是**导出产物重建**（天然调度驱动）；特征计算仍走关账钩子（确定性、不烧 token），不是走回头路把特征挂上 scheduled_tasks。

## 6. 边界

- 本计划为**后续优化**：不改已验收行为的语义；所有新增 UI 断言沿用"渲染产物+网络"标准。
- 明确仍不做（沿袭 plan §9）：SQL/notebook、多数据源、ChatBI、多人协作、图表插件架构、自由画布、独立告警引擎。

## 7. 评审记录与变更日志

- 真实性核查：2 Agent（新功能 15 项 + 先前功能 7 项）代码级实证零虚报；顺带发现 10 条小代码问题（列入 P3 随手修清单）。
- Critic 第一轮 REVISE（7 条）：P1-2 拆分 2a/2b、P1-9 DOM 断言、P1-4 canvas 通道、风险表补 3 行、执行顺序小节、§5 两处措辞——全部落实。
- Critic 第二轮 **APPROVED**（非阻塞 3 条编辑性小疵已随手修：口径标签统一、§5.4 指向前置计划、P1-9 验收数据依赖注记）。
