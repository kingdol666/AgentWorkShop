# AgentWorkShop 全链路验收测试报告（2026-10-16）

> **【2026-10-16 下午补遗：KB 检索遗留项已翻案】** 昨日报告的 2 项 KB 遗留经复查**均非 KB 系统缺陷**：
> ①「双树割裂 0 命中」的真相 = 本机 KB 栈本命配套是 **web 6789 + 后端 8771（ClaudeGPT 树，存储/检索同源）**，8771 一直在跑且 chroma 25 集合含 aw-industrial 全量向量；我从 tmp 树拉起的 8770 是**空库冒名实例**，恰好骗过平台插件缺省 base=8770 的健康检查。已处置：杀掉 8770 冒名实例 + 平台设置热更 `plugins.rag-bridge.base_url=http://127.0.0.1:8771`（免重启，插件健康即绿）。
> ②「540s 同步检索超时」为满载偶发（平台+模拟器+IDD+KB 并发跑批时的 CPU 争用）：空载复测 **sync 38s 完整命中**。
> **纯外部 API 逐级检索复测全绿**（不经 AgentWorkShop，脚本 `tmp-e2e/kb-harness-retrieval-20261016.mjs` + `kb-r1-auth-20261016.mjs`）：直查级向量命中 6 条（top score 0.796）、两阶段命中、经验库 global-search 命中、图谱面可用（该关键词 0 命中属图谱索引范围，容受）；agent 检索 **sync 38s ✅ / async task 约 6.5min completed ✅**，任务返回自带逐级检索执行轨迹：`查询改写 → 经验通道优先(experience_search_smart, KB 限定) → 向量广网(kb_search_vector, top_k=30) → Laya 验证闸(33 段过 32) → 逐字复核(experience_read)`，最终逐字命中《注塑线快速筛查经验-e2e1016》(exp-f365ca1a9ea5) 并附引用。后端 8771 开着鉴权（直查需 register→login→tokens 三步取 token）；跨库隔离跳过（目录仅 aw-industrial 一个适配库）。



> 版本基线 v0.7.65（构建 63a14fd，本地生产实例 3001）· 执行方式：aw-line-onboarding / aw-plc-sim-twin skill 标准作业流 + 脚本化 E2E（`tmp-e2e/final-e2e-20261016.mjs` 及两轮补验）
> 结论先行：**onboarding 标准流 58/58 全绿；主 E2E + 两轮补证收敛后，全链路（数采→分析台账→IDD 诊断→KB 沉淀→配方 HITL→审计）核心链路全通**；遗留 2 项 KB 检索相关问题（1 项本机环境双树割裂、1 项 KB agent 引擎超时），均为非平台代码缺陷。

---

## 一、环境拓扑（本轮全部冷启动）

| 组件 | 端口 | 来源 | 状态 |
| --- | --- | --- | --- |
| AgentWorkShop 平台（repo 模式） | 3001 | `node scripts/start.mjs`（.output 构建 2026-10-15，v0.7.65） | ✔ workshop ready |
| PLC 模拟器（injection-line 预设，5 设备/25 信号，跨 5 协议） | 4036 | `bench/lib/sim.mjs` 影子树（`plc-node-simulator-bench-4036`，端口偏移 +26000） | ✔ tick 活性正常 |
| IDD 工业深度诊断后端 | 3210 | `D:/codes/myskills/industrial-deep-diagnostic`（`npm start` = `ind-diag start --all`） | ✔ database ok |
| RAG 知识库后端 | 8770 | `D:/codes/tmp/rag-knowledge/backend`（venv python main.py） | ✔ healthy |
| RAG web（IDD `--all` 附带拉起的 RAG 引擎） | 6789 | `D:/codes/ClaudeGPT/rag_project/rag-knowledge/web` | ✔ 21 个知识库 |
| diag-bridge / rag-bridge 插件 | — | 平台内置 `.AgentWorkShop/plugins/`（diag-bridge 带未提交的六意图改动） | ✔ 双桥远端 ok、token 接受 |

受测产线：**注塑验收线（模拟4036）`ln-dd4d6163`** —— 4 写控（机筒一区温度SP/模具温度SP/保压压力SP/冷却水温SP，modbus-tcp·modbus-rtu·opcua·mqtt）+ 7 数采（含 http 检测站 2 点），配方「注塑基线配方」`rc-fb3371f8` v1（240/40/45/24）。
受测频道：**注塑验收线优化频道(4036) `bab03588…`**（通用闭环优化模板，lead=生产主管 + 数据分析师/知识调优工程师/工艺工程师，绑定 worker:2→recipe manual、worker:0→daq auto×7，插件 diag-bridge+rag-bridge 双开）。

## 二、执行流程（skill 标准作业流）

1. **设计梳理**：`aw-line-onboarding`（接入六阶段 + 割接纪律）与 `aw-plc-sim-twin`（孪生/tick 自检）两份仓库内 skill 为作业基准；本次用预设产线（injection-line），未走孪生生成路径。
2. **阶段 2 连通性预检**：从模拟器 `GET /api/nodes/:id/export` 逐点拉取 driverConfig（禁止手抄），`test-connection.mjs` 逐驱动实测 —— **11/11 绿**（modbus-tcp 1-14ms / rtu 0-1ms / opcua 1-72ms / mqtt 订阅收值 1.9-4s / http 2-15ms）。
3. **阶段 3 产线供给**：`provision-line.mjs` 幂等建线+节点+产品+配方 —— **15/15 绿**（跨线写点冲突预检 0；DCW/DAQ 节点强制 templateRef；温度/压力用内置模板，制品重量/成型周期新建 2 个自定义语义模板走 `POST /api/workshop/daq/templates`）。摘要：`{lineId:ln-dd4d6163, recipeId:rc-fb3371f8}`。
4. **阶段 4 频道锻造**：`forge-channel.mjs` 场景=optimize —— **11/11 绿**（模板实例化→双插件开关→9 条 v2 绑定→种子任务派发）。
5. **阶段 5 接入验收**：`verify-line.mjs` V1-V6 —— 首轮 13/8（V1 全红 + V3-MQTT 命令点无探针）。根因=**未开产线不采样是平台设计**；`POST /dcw/lines/:id/start`（run rr-93e6ee43，SP 写穿 240 回读一致）后重跑 —— **21/21 全绿**（V1 七节点样本落库、V2 越界全拒、V3 合法写回环、V4 配方在册、V5 频道+双插件、V6 受保护线零扰动）。
6. **主 E2E**（脚本 `final-e2e-20261016.mjs`，三轮迭代 + 两轮补证 `final-e2e-fixup/fixup2`）：S0 健康→S1 分析台账→S2 IDD 诊断→S3 知识闭环→S4 配方 HITL→S5 负路径→S6 审计。

## 三、测试结果

### 3.1 数据分析 → analysis_reports 台账（S1，7/7 绿）
- `daq_query`（数据分析师）取到真实时窗统计（熔体温度 PV n=61，均值 248.0℃）；REST 采样统计佐证一致。
- `analysis_save` 留痕 `ar-9a6a80aa`（结论=真实统计、metrics 结构化）；REST `GET /api/workshop/analysis/:id` 取回全文（信封为 `data.report`）；`GET /api/workshop/analysis?line_id=` 按线检索命中；工具面 `analysis_query` 按 report_id 全文 / 按线列表双查通过；**越权产线（受保护演示线）留痕被拒**。
- 台账最终 5 份报告（1 份脚本 + **4 份由频道 Agent 自主产出**，见 3.5）。

### 3.2 IDD 诊断链（S2，完成语义已证）
- `diag_run`（quick-screen 意图，line 模式 20min 窗）受理；`diag_status` 观测到 **completed**，IDD 侧报告落盘（`workspace/diagnostic-runs/202610160217092_ln-dd4d6163_diag`，41 行 × 8 列，sha256 留痕）。
- 报告含数据证据；契约判定 `undetermined（窗口<100 稳态行）`——**无基线不做假判定的诚实口径**，符合 IDD「永不编造」设计。
- 备注：①首轮用 sync 模式撞客户端 undici 300s 响应头超时（长任务应一律 async 提交+轮询）；②桥面「一线一活跃诊断」串行门在孤儿 invoke 后需一次 `diag_status` 才收敛（轻微状态滞后，非阻塞）。

### 3.3 知识闭环（S3，入库实锤 / 检索遗留）
- **入库 ✔**：`kb_agent(mode=async)` 提交 → 任务完成 → 落盘为结构化经验条目 `exp-f365ca1a9ea5`「注塑线快速筛查经验-e2e1016」（scenario/tags/量化指标/vetted，进入 `.experience-index.yml`，库内累计 49 条经验）。
- **检索 ⚠️**：`kb_agent(mode=sync)` 检索任务 **540s agent turn 超时失败**（KB 侧 LLM 回路慢）；直查向量检索 0 命中——根因是**本机 rag-knowledge 双树并存**：6789 web（文档存储）在 `ClaudeGPT/rag_project/rag-knowledge` 检出，而 8770 后端（向量库）是我从 `codes/tmp/rag-knowledge` 拉起的另一检出 → **存储面与检索面割裂**（环境问题）。历史单树环境（2026-10-13 扎线轮）检索命中已验证过。

### 3.4 配方链 + HITL 写穿（S4 + 补证，全通）
- **拒绝路径**：`recipe_trial` 大步候选（240→290，应急豁免频控）→ HITL 卡建立 → 人工拒绝附指导（「步幅过大…≤5℃」）→ **指导逐字回流 Agent** + PLC 设定值分毫未动。
- **固化路径**：`recipe_update` 小步（240→245）→ 卡 → 批准 → **v2 落库**；`recipe_versions` 版本史可见；`recipe_apply` → 卡 → 批准**附人工附言回流** → 整批下发（批次 rr-40dcf）。
- **分级 ACK（设计语义）**：下发证实 3/4 —— 冷却水温SP 为 MQTT 只写命令点（无读回通道），终态 `transport-acked/unverified`，回执自带「请人工核实」指引。属 DCW 分级真值的正确行为，非缺陷。
- **物理因果**：`recipe_rollback(version=1, dispatch=true)` → 批准 → 配方落 v3（回退非破坏版本化）+ **PLC 整批恢复（机筒 SP=245→240 回读一致）**；熔体温度 PV 随后 6 分钟**因果下行**，向 240 基线回归（回退前 248.0 → 回退后窗均下行超阈）。
- **频控**：apply 后窗内再次 apply 被拒（配方级 opIntervalMs 60s，锚=审批时刻）。

### 3.5 负路径 / 授权面 v2（S5，4/4 绿）
- `param_control` 被拒（fail-closed，引导走配方/映射面）；未绑定 `dcw_control` 被拒（kind=dcw 直绑已废除）；无配方绑定成员 `recipe_update` 被拒（绑定门）；REST 越界写被拒（四层限界联锁，报文含约束层说明）。

### 3.6 审计与日志（S6，全绿）
- `ops-logs`（产线维度）63 行：`analysis.save[agent]×5`、`recipe.update.agent[agent]`、`recipe.apply[agent]×2`、`recipe.trial[agent]`、`recipe.revert[agent]`、`recipe.dispatch.ack[system]×4`、`dcw.write.recipe[system]×17`、`dcw.write.manual[user]×11`、`dcw.write.rejected×12`、`line.start/create`、`daq.node.create×7` —— **agent 归因 10 行，人/机/系统三向分流清晰**。
- 写控 journal 本线 16 条锚点（trial/update/apply/回退源可追溯）；`GET /api/workshop/audit` 总览 300 行可查；REST 版本史 ≥2 版（v1→v2→v3[回退]）。

### 3.7 意外收获：频道 Agent 团队的自主闭环（活体证据）
种子任务 90 分钟预算内，通用优化频道**真实自主跑完了一轮知识增强闭环**：知识调优工程师检索知识先验（保压压力-克重增益 0.0574 g/bar）→ 设计单变量 `recipe_trial`（步长=min(单步限幅, 知识上限)）→ 试验批次 rr-2e2fc → 滑窗显著性判读（Δ+0.0966g≈2.5σ + 三温控通道归因）→ 反算本线增益 0.0537 g/bar（偏差 −6.5%）→ 提交 `recipe_update` 固化申请 → **人工未批准 → 按治理「审批被拒不绕行」主动统一回退** → 全程沉淀为经验条目 `exp-18ee668522fa` 入库。治理面（HITL 门、审批不绕行、回退纪律）全部按设计生效。

## 四、断言汇总

| 套件 | 结果 |
| --- | --- |
| onboarding 阶段 2（连通预检） | 11/11 |
| onboarding 阶段 3（产线供给） | 15/15 |
| onboarding 阶段 4（频道锻造） | 11/11 |
| onboarding 阶段 5（verify-line V1-V6） | 21/21（开线后） |
| 主 E2E S0-S6（34 断言） | 26/34 直接绿，8 红中 6 项为脚本口径/参数问题（补证后绿：S1.3 信封路径、S2.1 受理语义、S4.4/S4.7 分级 ACK、S4.5 由 PV 因果下行替代证明、S4.7a rollback 需显式 version）、S6.1 动作名前缀 |
| 补验轮 F（7 断言） | 4/7（F1/F4/F5 绿；F2=KB 检索超时；F3a 客户端超时后被 fixup2 取代） |
| 终轮补证 G（4 断言） | 2/4（G1b PLC 恢复 ✅、G2 PV 因果下行 ✅；G3 双树检索割裂） |

**综合判定：核心链路（数采→分析台账→IDD 诊断→经验入库→HITL 配方写穿→回退→审计）全部可用；2 项遗留均为 KB 检索相关（环境双树 + KB 引擎超时），不阻塞平台功能。**

## 五、发现与建议

1. 【环境】rag-knowledge 双树并存导致检索/存储割裂：建议统一 checkout，或将 8770 后端切到 ClaudeGPT 树启动（`web.backend_url` 已指向 8770）。
2. 【KB 性能】kb_agent 同步检索 540s turn 超时：LLM 网关慢或 QDCVR 管线过重，建议给检索类 prompt 降档（轻量检索路径）或调低超时上限提前失败。
3. 【呈现建议】只写命令点（MQTT command topic）使 apply/rollback 证实永远 3/4（终态 unverified）——分级真值正确，建议 UI 对无读通道参数加「免证实」徽标，避免「未全绿」误读。
4. 【测试方法】频道种子任务预算内活 Agent 会与脚本化验收并行操作同一产线（本轮出现 Agent 试验/固化申请/回退申请与脚本互相干扰）：验收期建议用零种子任务频道，或先收线种子任务再跑脚本。
5. 【工具面】diag_run sync 模式 >300s 撞客户端响应头超时；长分析一律 async 提交 + diag_status 轮询（与工具描述一致）。孤儿 invoke 后桥面「运行中」状态需一次 diag_status 收敛。

## 六、产物与复现

- 测试脚本：`tmp-e2e/final-e2e-20261016.mjs`、`tmp-e2e/final-e2e-fixup-20261016.mjs`、`tmp-e2e/final-e2e-fixup2-20261016.mjs`、`tmp-e2e/_onb-gen-20261016.mjs`（配置生成器）
- onboarding 配置：`tmp-e2e/_onb-{connect,provision,forge,verify}.json`（跨会话幂等指纹可复跑）
- 关键 id：线 `ln-dd4d6163` · 配方 `rc-fb3371f8` · 频道 `bab03588-11da-4481-9390-c65527c506bc` · 分析 `ar-9a6a80aa` · 经验 `exp-f365ca1a9ea5` / `exp-18ee668522fa` · IDD run `46cc5e12`
- 环境保持运行中（3001/3210/8770/6789/4036），可直接打开 `http://127.0.0.1:3001` 目视复核（产线/数据分析台账 /analysis/运维日志 /logs/诊断报告面板）。

---

## 附:插件集成正确性与连接检测专项(2026-10-16 下午第二轮)

> 任务:确保 IDD/RAG 插件集成为「用户配置 API+token → 按配置集成 → 检测功能(调 health+传 token)→ 前端渲染检测结果 → 系统内真实可用」。

### 设计审查结论
- 配置面/health 后端本已完备:两插件均有 settings 声明(base_url/web_url/token,分组+热更+host 白名单守卫);`GET /api/plugins/<id>/health` 都会「调远端 health + 拿用户配置 token 实测受保护端点」并返回三态(accepted true/false/null)。
- **缺口在前端**:无显式「检测连接」动作与明细渲染;diag 面板连连接状态都没有(只有运行表)。
- 发现一处副本漂移:runtime(.AgentWorkShop)diag 面板缺「报告」弹层(builtin 反而更新)。

### 实施(增强)
1. rag-bridge/client.mjs:+「检测连接」按钮 → 调 /health → 结构化渲染(后端/Web/Token 三态/知识库/结论+耗时)。
2. diag-bridge/client.mjs:+连接状态行(30s 轮询)+「检测连接」明细(远端/Token/引擎/记录分布/结论+耗时);**合并回 builtin 版的报告弹层**(运行时补齐丢失功能)。
3. 两份 i18n.json 中英补齐;4 文件同步 server/plugins-builtin(发布一致性;两处副本自此一致)。

### 验收与结果
- **V2 检测三态**(REST 实测):正确配置→双插件全绿(token accepted=true);错 token→accepted=false+修复指引(diag 附 hint);错地址→backend.ok=false/remote unreachable+accepted=null(未知,语义正确);恢复→全绿。
- **修复阻断性平台 bug**:验收中发现前端通知护栏并发竞态(await 窗口放行全部并发调用方)→ `/api/workshop/notifications` **2.3 万次/15s 洪泛**、Chrome ERR_INSUFFICIENT_RESOURCES,整页请求被饿死(插件面板也被拖垮)。修复 `app/stores/workshop/notifications.ts` guardedFetch(唤醒后复查 + 10 次/10s 熔断 + 30s 冷却),重建生产包;复测 15s 内通知请求 23321→**17**。
- **V3 前端渲染**(puppeteer,`tmp-e2e/plugin-check-ui-20261016.mjs`):**9/9 绿** —— 双面板挂载、两处「检测连接」点击出明细、结论=连接正常+耗时、设置页两插件配置分组与 token 字段在渲染;截图 `tmp-e2e/_plugin-check-shots/1-4.png`。
- **V4 真实可用**(经平台工具桥,`tmp-e2e/plugin-real-accept-20261016.mjs`):11/11 绿 —— health 基线;rag `/search` 真实命中 68 条;diag `/runs` 台账 7 条;**kb_agent sync 检索命中**;**kb_agent async 入库**(task kbt_mvahvihu_2fbbfc45 完成);**diag_run quick-screen**(run b5fd514c)→ IDD 侧真实 completed(约 33 分钟),报告含真实数据证据(236 行 DAQ 快照、7 参数、20 分钟窗、契约结论)。
- 勘误:A5b 首判为假绿(轮询条件被运行中文案的「报告」字样提前击穿),已收紧两处脚本判定为显式 completed 并等待真实终态确认。

---

## 附:IDD/RAG 异步执行语义专项验收(2026-10-16 深夜第三轮)

> 任务:验证「异步受理即返 → 外部服务后台执行 → Channel worker 随时查进度 → 等待期不阻塞 → 终态与回执」的真实使用执行逻辑。脚本 `tmp-e2e/async-semantics-accept-20261016.mjs`。

### 结果:16/16 全绿(R4d 修正断言面后)

| 验收项 | 实测 |
| --- | --- |
| R0 连通性 | rag/diag health 全绿(token accepted);runs 台账 8 条可读;worker 在册 |
| R1.1 kb_agent async 受理即返 | **29ms** 返 task_id(kbt_mvaipgs8_b0a6ac46) |
| R1.2 diag_run async 受理即返 | **660ms** 返 run_id(e7e84250) |
| R2.1 后台执行可见 | diag_status 显示 running(idd 侧真实跑批) |
| R2.2-2.4 等待期不阻塞 | 同一 worker 在 IDD 执行期间并发完成 daq_query + analysis_save + **kb_agent sync 检索(另一插件长调用)**,150s 内全部成功 |
| R2.5 真并行 | 三件完成后 diag 仍在 running |
| R3 kb 异步终态 | kb_agent_status → completed + 结果 |
| R4a/b diag 终态 | diag_status 显式 completed(非 running),报告含评分/结论/路径/数据证据 |
| R4c 台账收敛 | 平台 runs 台账(sweep 15s)收敛 completed |
| R4d 频道回执 | **频道信箱收到 [异步回执] 消息**(tool=diag_run, job=run_id, 含报告总结与 kb_agent 入库指引);b5fd514c 与 e7e84250 两 run 各恰一条 |

### 异步机制确认(代码+实测双证)
- `diag_run(mode=async)`:提交到 IDD 后立即返回 run_id,不占调用方;后台 sweep 每 15s 轮询 IDD 任务面。
- 完成回执 = **先到先得、恰一次**:sweep 投递频道信箱(platform-notice 落 messages 表,空闲唤醒)与 `diag_status` 亲自看到终态时的 `notify.claim` 竞争同一 claim 键(`tool:jobId`)——谁先到谁生效,不重不漏(e7e84250:sweep 15s tick 抢先投递;b5fd514c:无人轮询,回执正常落箱)。
- `kb_agent(mode=async)` + `kb_agent_status(task_id, wait_seconds≤120)`:受理即返 → 任意时刻查进度/结果。
- Worker 等待期可继续任意工具调用(数据/台账/另一插件),实测零阻塞。

### 勘误与脚本修正
- R4d 首判红 = 断言面写错(查了**用户通知**,回执实际落在**频道信箱 messages**);已修正断言并人工取证双 run 回执内容(含评分/结论/总结/report_md_path + kb_agent 入库指引)。
