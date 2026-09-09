# Plan: AML —— Agent 驱动的自动深度学习拟合 / MPC 影子孪生建模平台

- **状态**: `approved`(2026-09-10 用户批准执行;执行期增强项见 §14)
- **日期**: 2026-09-10
- **模式**: omc-plan Direct(需求已充分细化,跳过访谈)
- **模块代号**: `aml`(Auto Modeling Lab,自动建模实验室)——沿用仓库 daq/dcw/tui/kb 短命名传统
- **目标一句话**: 在现有 MAS 镜像数采系统之上,新增一个由内置深度学习专家 Agent 团队全自主驱动的建模平台:按产线/产品/热 Recipe 隔离拉取时序数据 → 自动清洗 → 自动写代码训练/迭代深度学习代理模型 → 自动测试验证精度门 → 人工 HITL 批准后注册为"影子孪生模型",供后续 Agent 调控参数时通过工具查询预测参考,最终服务于 MPC 闭环。

---

## 1. 需求摘要(Requirements Summary)

来自用户需求的逐条拆解(全部映射到后文设计):

| # | 需求 | 设计落点 |
|---|------|----------|
| R1 | 对 DAQ 时序数据做统计分析 | DatasetBuilder 内置 Node 侧统计引擎(§6.3),`aml_dataset_stats` 工具 |
| R2 | 深度学习拟合,训练出 MPC 可用的代理模型 | 滑窗监督数据集 + 模型 IO 契约(state/control/observation + horizon)(§6.2) |
| R3 | 影子模型孪生,Agent 调参时可参考 | 模型注册表(候选/影子/生产)+ `aml_model_reference` / `aml_predict` 工具(§7.2) |
| R4 | AgentTeam 接手,完全 Agent 驱动自主训练 | 内置 4 角色建模团队 + 场景提示词注入 + AIDE 式迭代协议(§8) |
| R5 | 完整接口,Agent 自己拉数据、自己训练 | REST `/api/workshop/aml/*` + Agent 工具族 `aml_*` 双入口,复用节点绑定权限(§7) |
| R6 | 不同产品/热 Recipe 隔离,防数据噪音 | 数据集硬隔离三元组 (line, product, recipe),按 run 分组切分(§6.1) |
| R7 | 异常数据自动清理 | 清洗管线:state 过滤/量程截断/Hampel 去尖峰/缺口策略(§6.3) |
| R8 | 自动测试验证精度,不断迭代直到达标 | 评测门(单步+多步滚动 NRMSE/泛化差/数据覆盖)+ 排行榜 + 预算内自动迭代(§6.5) |
| R9 | 模型保存到指定位置 | `.AgentWorkShop/data/aml/models/<id>/`,ONNX 可移植格式(§6.4) |
| R10 | 先查论文、学习文献算法再集成 | §3 文献调研:文献算法 → 本设计的映射表 |

**非目标(本轮不做,留接口)**: MPC 求解器闭环控制器(只交付代理模型 + 参考工具 + IO 契约);在线增量学习;图像/向量帧模态建模(只做标量时序)。

---

## 2. 代码库现状事实底座(设计依据,均已在工作树核实)

### 2.1 数据侧(可获取什么)
- 时序存储走 **TsdbPort 六边形端口** `server/services/workshop/daq/storage/tsdb-port.ts:62-77`:`query/queryTagged` 支持 `lineId/productId/recipeId/runId/nodeIds[]/fromMs/toMs/bucketMs`;生产为 TimescaleDB(pg,`DAQ_TSDB_URL`),回退 node:sqlite(`sqlite.adapter.ts:35-48` 的 `daq_samples` 表)。
- **每条样本已带产线/产品/配方/批次打标**:写入路径 `daq-controller.ts:277-320`(`ingestNode` 从 ActiveLineRun 打标,`dcw/line-run.ts:17-27` 为注册表),即 **(line, product, recipe, run) 四维隔离在存储层天然成立**。
- Recipe 节点级绑定与版本史:`dcw-recipe.repo.ts:167-180`(`RecipeView.params[].nodeId`、`daqWindows`、`paramsHistory`);批次冻结参数 `createRun` L352-369(`RecipeRunView.paramsSnapshot`)——训练数据的"控制输入"语义已在。
- 节点模板(量程/单位/语义)注册表:`shared/daq-protocol.ts:15-150`(`DaqTemplateDef.min/max/unit/semantics`)——清洗量程与特征语义可直接引用。
- 现有 Agent 取数工具 `daq_query`(`industrial-tools.ts:262-353`,权限=daq 节点绑定,`daqTargetsOf` L233-259 "只缩不放")是本平台数据权限边界的现成范式。

### 2.2 Agent 侧(团队/工具/审批/归属)
- 团队 = `teams`/`team_members` 表(`team.repo.ts:27-39`、`team-member.repo.ts:9-13`,一队一 lead),部署走 `deployTeamToChannel`(`manager.ts:1834-1856`,空队报 `TEAM_EMPTY`)。
- 提示词注入链:`prompt-builder.ts:70-108` `contextPrefix()` = Channel 场景提示 → 成员 `systemPromptPrefix` → 工业实况 → 循环指南 → 团队花名册。
- 工具面:`.AgentWorkShop/prompts/host-tools.json`(38 工具,`HostToolDef` 形状 `loader.ts:134-140`)→ `host-tool-bridge.ts:30` `HOST_TOOLS`、L69-86 按角色装配、L133-659 `dispatchHostTool` 唯一分发口;实现集中在 `industrial-tools.ts`。
- HITL:`tool-approvals.ts:72-85` `request()` 返回被人工决定 resolve 的 Promise(超时自动拒绝),UI 头部待办 + `POST /api/workshop/hitl/respond`;maker-checker 双人审批走 `server/api/workshop/approvals/`(自批禁止)。
- 操作归属:`ops/ops.ts:57-78` `recordOps`(audit_log + `ops.log` WS 帧),Agent 侧 meta `{source:'agent', actor, actorName}`(`industrial-tools.ts:139-146`)。
- MCP 回程让 14 引擎全家桶(codex/claude/pi/hermes/…)零改造获得新工具:`server/harness/aw-mcp-bridge.mjs:36-66`(`tools/list` 10s 缓存拉 `/api/workshop/agent-tools/list`)。

### 2.3 基础设施侧(怎么跑长任务/落盘/推送)
- **服务器目前零 Python 集成**(全仓 grep 干净);子进程规范工具已备好:`line-spawn.ts`(Windows `.cmd` 的 `cmd /s /c` 尾引号封装 L95-108、`assertPlainExecutable` L17-25)+ 杀进程 `harness-process.ts:125-136`(Windows `taskkill /T /F`)。
- 配置根:`shared/config/home.mjs:74-123` `resolveRunMode()`、`dataDirFor()` L133-137 → 新产物落 `<configRoot>/data/aml/`。
- 主库 node:sqlite,建表内联于 `database.ts:25-282` `SCHEMA_SQL`,加列迁移 `migrateAddColumn` L692-697;`tasks` 表 L83-104 的 `retry_count/progress/artifacts_json` 是训练作业表的现成范本。
- WS 推送扩展点:`scene-events.ts:66-81` `broadcastSceneEvent(type,payload)`(按 `payload.lineId` 逐 peer 过滤);前端 `useTownBus`(`useTownBus.ts:21` globalThis 单例)旁路订阅即可,**无需新 WS 连接**。
- 定时/批处理范式:DAQ 双节拍(`daq-controller.ts:159-176` 250ms sweep + `TSDB_FLUSH_MS` 批量冲刷);永久错误不重试范式(`ws.ts:234-243` FK 毒化缓冲修复)。
- 对象存储端口可复用:`objectstore-port.ts:10-18`(put/get/remove,MinIO + 磁盘回退)。
- UI 约定:`aw-page-head` 页头(`main.css:537-545`)、`pill-btn/ghost-btn/mini-btn` 按钮词汇(`main.css:621-756`)、暗色默认(`app/stores/app.ts:6`)、i18n dicts(`i18n/dicts/<ns>.json` + `scripts/i18n-codemod.mjs`)。
- 假数据发生器范本:`scripts/dev-plc-simulator.mjs:1-19` 一阶惯性 `PV' = PV + (SP−PV)(1−e^(−dt/τ)) + noise` + 调节器死区——e2e 合成产线直接照抄。
- nitro 打包坑:重依赖必须加入 `nuxt.config.ts:117-127` `nitro.externals.external`(现含 pg/mqtt/modbus-serial/node-opcua/minio)。
- API 约定:`defineApiHandler` + `AppError`,响应 `{status,msg,data}`(`server/utils/response.ts`)。

---

## 3. 文献调研:算法 → 本设计映射

用户要求先查论文。检索结论:**"Agent 自主做数据分析与 ML 建模"已是成熟研究方向,以下算法被吸收进本设计**:

| 文献 | 核心算法 | 吸收进本设计的部分 |
|---|---|---|
| **AIDE**(arXiv:2502.13138, Weco AI;"AI-Driven Exploration in the Space of Code") | 把 ML 工程建模为**代码解空间上的树搜索**:草稿/调试/改进三类节点,贪心扩展 + "贪心后回溯(greedy-then-restore)",按验证指标保留 top-k | §8.3 迭代协议:每轮实验 = 树上一个节点;`aml_experiments.parent_id` 构成谱系树;评测反馈写回供 Agent"改进/回溯"决策;预算控制 max_nodes |
| **Data Interpreter**(arXiv:2402.18679, ACL 2025) | **层次化任务图建模 + 动态规划 + 工具集成**,按数据可辨识度做角色指派 | §8.2 团队角色分工(数据工程师→训练工程师→评测工程师)与 lead 动态派工(`dispatch_task`)对齐其"识别子任务→分派→工具执行" |
| **AutoML-Agent**(arXiv:2410.02958, ICML 2025) | 全管线分解为检索→预处理→特征→模型→超参→评估等阶段,**每阶段生成-执行-追踪多代理集成** | 阶段划分即本平台作业状态机 `stage`:prepare→clean→train→evaluate;追踪 = metrics.json 契约 + 排行榜 |
| **MLE-bench**(arXiv:2410.07095, OpenAI) | 75 个 Kaggle 竞赛构成的 ML 工程能力基准,"端到端产出可评测工件" | 评测哲学:模型必须产出**机器可验证的工件**(metrics.json + model.onnx),门禁自动判定,不靠 Agent 自述 |
| **MLE-STAR**(NeurIPS 2025) | **靶向精修**:定位最弱组件(特征/结构/训练策略)只改一处再验证,而非每轮全量重写 | §8.3 提示词规则:每轮实验只允许改动一个组件并在 `aml_job_submit` 的 `change_note` 里声明 |
| **DS-Agent**(arXiv:2402.17453) | **案例推理(CBR)+ 知识库**:过往成功案例检索复用 | 落到现有 `agent_memories`/`save_memory` 工具:评测工程师在收尾把"该产品/配方上有效的结构+超参"存为记忆,下次同 Recipe 建模时召回 |
| **数据科学 Agent 综述**(arXiv:2508.02744) / **TimeSeriesGym**(arXiv:2505.13291) | 领域综述与时序 ML 工程基准 | 确认"沙箱执行 + 工件契约 + 检索增强"为共识架构,本设计与其一致 |
| **神经代理 MPC**(arXiv:2501.07601 增材制造多步 MPC;Royal Phil. Trans. 2025 医疗孪生神经控制;Julia DyadControlSystems 神经代理 MPC 范例) | 用神经网络学 `x[k+1]=f(x[k],u[k])` 作为 MPC 内嵌模型,多步滚动预测误差是可用性关键指标 | §6.2 模型 IO 契约(history window + control horizon → 未来输出)与 §6.5 **多步滚动 NRMSE 门禁**(单步精度好≠MPC 可用) |

**清洗算法**(经典时序预处理,非 Agent 论文,直接工程化):state 位过滤(已有 `state` 列)、模板量程截断(`DaqTemplateDef.min/max`)、**Hampel 滤波**去尖峰(中位数±k·MAD)、按节拍桶均值重采样对齐(`bucketMs` 语义与 TsdbPort 一致)、缺口策略(短缺口线性插值/长缺口丢弃)。

---

## 4. 总体架构

```
                          ┌────────────────────────────────────────────────┐
                          │  内置建模团队(4 Agent, 任一 14 引擎)              │
                          │  lead 数据科学家 ← dispatch_task → 数据/训练/评测   │
                          └──────┬─────────────────────────────────────────┘
                                 │ host tools: aml_* (MCP 回程对 14 引擎透明)
      ┌──────────────────────────▼───────────────────────────┐
      │  AML 服务层 server/services/workshop/aml/             │
      │  ├ dataset-builder.ts  拉数→清洗→对齐→切分→快照         │
      │  ├ stats.ts            统计/相关/滞后估计              │
      │  ├ job-orchestrator.ts 队列/子进程运行器/门禁/WS        │
      │  ├ model-registry.ts   阶段流转/HITL 晋升/ONNX 服务     │
      │  └ permissions.ts      节点绑定复用(daq, 只缩不放)      │
      └───────┬─────────────────────────┬────────────────────┘
              │ TsdbPort.queryTagged     │ spawn(line-spawn.ts)
              ▼                         ▼
   daq_samples(pg/SQLite)        data/aml/jobs/<id>/workspace/
   (line,product,recipe,run 打标)   train.py(Agent 写)+ amlkit.py(平台种)
              │                         │ artifacts: model.onnx + metrics.json
              ▼                         ▼
      data/aml/datasets/<id>/      data/aml/models/<id>/(注册表→HITL 晋升)
                                 ▼
              dcw 调控 Agent: aml_model_reference / aml_predict(影子参考)
```

设计原则:
1. **数据不落地不建模**:训练只允许引用已固化快照的 dataset id,禁止作业运行期临时查询——保证可复现、可审计、防Recipe 串味。
2. **Agent 写代码,平台定契约**:Python 侧只有一份平台种 `amlkit.py`(数据加载+工件校验),Agent 产出的 `train.py` 必须满足工件契约;评测与门禁由平台判定,不信 Agent 自述。
3. **权限沿用存量边界**:数据集节点集 ⊆ 该 Agent 的 daq 绑定;REST 走 `requireLineMode`。
4. **一切副作用过 `recordOps`**:数据集/作业/晋升全留痕,来源=Agent。
5. **长任务全部子进程化**:服务器事件循环零阻塞,崩溃可恢复(作业表持久化)。

---

## 5. 关键设计决策(ADR)

### ADR-1 训练运行时:Python 子进程(主)+ Node 统计(辅)
- **Decision**: 训练执行体为 Python 子进程;服务器首次为该仓引入 Python 桥。共享 venv 位于 `data/aml/runtime/venv`,依赖锁定在 `server/services/workshop/aml/python/requirements.txt`(numpy/pandas/scikit-learn/torch-cpu/onnx/onnxruntime,pin 版本),探测顺序 `uv`(有则 `uv venv`+`uv pip`,快且免管理员)→ `python -m venv` + pip。纯 Node 侧只做统计/清洗(§6.3),不做 DL。
- **Drivers**: 服务器零 Python 现状(§2.3);DL 时序生态只有 Python 可满足"最佳模型"目标;仓内已有成熟子进程规范(`line-spawn.ts`)与杀进程(`harness-process.ts`)。
- **Alternatives**: ① tfjs 纯 Node 训练——被否:时序模型生态弱、算力差、ONNX 导出受限;② 外置 Jupyter/独立服务——被否:违背"单实例、配置根自包含"部署哲学,多一个常驻进程与端口。
- **Consequences**: 无 Python 机器上 DL 训练不可用(接口保留,作业明确报错 `AML_PYTHON_MISSING` 给出安装指引);需要把 torch 等加入安装文档而非运行时强依赖。
- **Follow-ups**: 可选 `AML_STUB=1` 存根运行器(纯 Node 模拟 metrics)保证无 Python 环境 e2e 仍绿(§10)。

### ADR-2 隔离模型:数据集硬绑定 (line, product, recipe),按 run 切分
- **Decision**: `dataset_build` 必填三元组;样本过滤走 `queryTagged` 存储层打标;train/val/test **按 run_id 分组切分**(同批次样本永不跨集),防批次内时间泄漏;跨 Recipe 合并训练默认禁止(`aml.dataset.allowCrossRecipe=false` 设置项,即便打开也要求显式 `pinnedDatasets`)。
- **Alternatives**: 随机按行切分——被否:时序相邻行高度相关,验证指标虚高(泄漏)。
- **Consequences**: 小样本 Recipe(批次<3)无法建模,门禁直接报 `INSUFFICIENT_RUNS`——这是特性不是缺陷(防噪音)。

### ADR-3 自主迭代策略:AIDE 式代码树搜索 + MLE-STAR 靶向精修,预算封顶
- **Decision**: Agent 侧迭代协议(提示词固化,§8.3):基线(ARX/岭回归)→ 经典(GBDT)→ 深度(MLP/LSTM/TCN)逐级;每轮改动一个组件;`aml_experiments.parent_id` 记谱系;作业表带 `budget_json`(max_experiments 默认 12、max_wall_ms 默认 30min),耗尽即停在当前最优,产出对比报告等待人工决策。
- **Alternatives**: 平台内置自动化 NAS/贝叶斯调参器——被否:重复造轮子且剥夺 Agent 的代码级创造力;AIDE 论文已证明 LLM 代码树搜索在 MLE-bench 达金牌水平。
- **Consequences**: 迭代质量依赖团队提示词;缓解=评测工程师角色强制审阅排行榜后才允许下一轮(§8.3)。

### ADR-4 推理服务:ONNX + onnxruntime-node,模型即不可变工件
- **Decision**: 训练工件契约强制 `model.onnx` + `io_spec.json`(输入名/形状/归一化参数/horizon/controlKeys/targetKeys)。服务器用 `onnxruntime-node` 加载生产模型提供预测(不依赖 Python 常驻);模型一经注册不可变,更新=新版本。
- **Alternatives**: Python 常驻推理服务——被否:多一个进程/端口;纯 Node 重写模型——被否:训练/推理一致性风险。
- **Consequences**: `onnxruntime-node` 加入 `nuxt.config.ts:117-127` nitro externals;LSTM 等动态轴模型导出需固定 batch 维为 1+动态时间维(写入 `amlkit.py` 导出辅助)。

### ADR-5 晋升治理:HITL 门 + 生产模型唯一性
- **Decision**: 模型阶段机 `candidate → shadow → production → retired`;`candidate` 由门禁自动产生;`shadow/production` 晋升一律走 `tool-approvals.ts` HITL(复用 dcw manual 审批范式,`industrial-tools.ts:118-136`);**每 (product, recipe, purpose) 至多一个 production 模型**,新晋生产线上的旧模型自动 `retired`(记录于 audit)。调控 Agent 只能看到 production 模型。
- **Alternatives**: 全自动晋升——被否:模型会成为控制参考,属"写"级风险,必须人审。

---

## 6. 核心机制设计

### 6.1 数据集层(DatasetBuilder)

`server/services/workshop/aml/dataset-builder.ts`,输入 `AmlDatasetSpec`:

```ts
interface AmlDatasetSpec {
  lineId: string; productId: string; recipeId: string   // 硬隔离三元组
  runIds?: string[]                                     // 缺省=该配方全部已打标批次
  nodes: { nodeId: string; role: 'control'|'feature'|'target' }[]
  fromMs?: number; toMs?: number
  beatMs: number                                        // 对齐节拍(=bucketMs 语义, ≥1000)
  window: { historySteps: number; horizonSteps: number } // MPC: history≥deadtime, horizon=预测步长
  cleaning: { hampelK?: number; maxInterpMs?: number; maxDropRatio?: number } // 缺省见下
  split: { valRatio: number; testRatio: number; seed: number }  // 策略固定 byRun
  purpose: 'mpc_surrogate' | 'quality_predict'
  note?: string
}
```

流程:权限校验(§7.3)→ `queryTagged` 分节点拉数 → 按节拍对齐(桶均值,内部节点线性插值到公共网格)→ 清洗(§6.3,逐节点进行,清洗参数与命中率记录进报告)→ 滑窗监督张量化(按 run 分组,窗口不跨 run)→ byRun 分层切分 → 落快照。

快照目录 `<configRoot>/data/aml/datasets/<dsId>/`:`spec.json`(含 lineage:节点清单/run 清单/时间窗/清洗参数/行数)、`manifest.json`(数组名→形状→偏移,Float32 小端二进制 `arrays/*.f32`,numpy 侧 `np.fromfile` 直读)、`report.json`(统计报告,§6.3)、`sha256`(spec+data 联合摘要,防篡改)。元数据行入 `aml_datasets` 表(§6.6)。规模护栏:行数上限 `aml.dataset.maxRows=200_000`,超出报错建议加粗 beatMs。

### 6.2 模型 IO 契约(MPC 面向)

`io_spec.json`(由 `amlkit.py` 在训练时按数据集 manifest 生成,Agent 可补充但不可违背):

```json
{
  "purpose": "mpc_surrogate",
  "inputs": {
    "history": { "shape": "[historySteps, nFeatureNodes]", "order": ["<nodeId>", "..."] },
    "controls": { "shape": "[horizonSteps, nControlNodes]", "order": ["<nodeId>", "..."],
                  "sources": { "<nodeId>": { "recipeParam": "<paramKey>", "min": 0, "max": 100 } } }
  },
  "outputs": { "forecast": { "shape": "[horizonSteps, nTargetNodes]", "order": ["<nodeId>", "..."] } },
  "norm": { "<tensor>": { "mean": [...], "std": [...] } },
  "horizonSteps": 12, "beatMs": 5000
}
```

`controls.sources` 把 DCW Recipe 参数(`dcw-recipe.repo.ts` params→nodeId)映射为模型控制输入——这是"Agent 调参可参考"的语义桥:预测工具输入"拟议参数值"即可 what-if。时滞估计(控制→目标互相关峰值)在统计报告(§6.3)输出,提示词要求 Agent 据此设 `historySteps≥deadtime/beatMs`。

### 6.3 清洗与统计(Node 侧,`clean.ts` + `stats.ts`)

清洗管线(顺序固定,全部参数记录进 report):
1. **state 过滤**:`state != 'ok'` 的点剔除(样本状态列由 `daq-runtime.ts:169-197` 派生);
2. **量程截断**:模板 `min/max` 之外的值剔除并计数;
3. **Hampel 去尖峰**:窗口 k 点,`|x−median| > 3·MAD` 判异常点删除(默认 k=5);
4. **重采样对齐**:`beatMs` 桶均值(与 TsdbPort bucket 语义一致,`sqlite.adapter.ts:131-144` 同式);
5. **缺口策略**:缺口 ≤ `maxInterpMs`(默认 3·beatMs)线性插值;单 run 缺失率 > `maxDropRatio`(默认 0.3)整 run 丢弃并告警。

统计引擎(`report.json` 内嵌,同时经 `aml_dataset_stats` 工具暴露):逐节点 mean/std/分位数/缺失率/清洗剔除率;节点对 Pearson 相关矩阵;控制→目标**滞后互相关**(给 IO 契约与提示词用);逐 run 轮廓(均值漂移检测,提示 Recipe 换版断点)。

### 6.4 作业运行器(Job Orchestrator,`job-orchestrator.ts`)

- 作业表状态机:`queued → provisioning(venv) → training → evaluating → gates_passed|gates_failed → done|failed|cancelled|timeout`;`stage/progress`(0-100)/`error` 落 `aml_jobs`。
- 执行:工作目录 `<configRoot>/data/aml/jobs/<jobId>/`;平台种入 `amlkit.py`(单文件,仅依赖 numpy:加载 manifest/张量、训练循环内 `print('##AML', json.dumps({...}))` 进度协议、导出 onnx+io_spec+metrics 契约校验);Agent 通过 `aml_job_code_write` 工具写 `train.py`(路径围栏:拒绝绝对路径/`..`/workspace 外写入,复用 disk.adapter 路径逃逸守卫范式 `disk.adapter.ts:20-23`)。
- 启动:`spawnLineProcess`(`line-spawn.ts:84-117`)运行 `venvPython aml_run.py --job job.json`,cwd=workspace;stdout 全量落 `run.log`,`##AML` 协议行解析为 progress/metrics 并节流广播 WS 帧 `aml.job`(§7.4,`broadcastSceneEvent`,payload 携带 lineId 享逐 peer 过滤)。
- 限制:墙钟超时 `aml.job.timeoutMs`(默认 1800s)→ `killHarnessProcess`(`taskkill /T /F`);并发上限 `aml.job.maxConcurrent=2`(FIFO 队列);日志环形尾 500 行内存上限;进度停摆看门狗(10min 无 `##AML` 行→stalled→kill+告警)。
- 评测:运行结束读取 `artifacts/metrics.json`(单步/多步滚动 RMSE/NRMSE/MAE、val/test),由平台重算门禁(§6.5)而非采信,写入 `aml_experiments` 并更新排行榜。
- 崩溃分类:永久错误(契约校验失败/Python 缺失/数据集 sha 不匹配)不重试直接 `failed`(对齐 ws.ts:234-243 永久错误不重试纪律);进程被杀/超时=可重试(计 `retry_count`,上限 2)。
- 服务器关闭:nitro `close` 钩子杀活作业,`queued/running` 作业重启后置 `interrupted`,可 `aml_job_retry`。

### 6.5 评测门(gates,`gates.ts`,purpose=mpc_surrogate 默认值)

| 门 | 指标 | 默认阈值 | 依据 |
|---|---|---|---|
| G1 单步精度 | test NRMSE | ≤ 0.10 | 代理模型常规可用线 |
| G2 多步滚动 | horizon 步滚动 test NRMSE | ≤ 0.25 | 神经代理 MPC 文献:滚动误差才是可用性指标(§3) |
| G3 泛化一致 | \|test−val\|/val | ≤ 0.20 | 防 Agent 过拟合验证集反复试探 |
| G4 数据覆盖 | rows ≥ 500 且 runs ≥ 3 | — | ADR-2 |
| G5 工件完整 | onnx 可被 onnxruntime 加载 + io_spec 校验 + 试推理 | — | 强制 |

全过 → 实验/模型记 `gates_passed` 自动成为 `candidate`;任一不过 → 报告逐门给出实测值与差距,作为 Agent 下轮改进依据。阈值可按 purpose 在 settings 覆盖(`aml.gates.*`)。

### 6.6 数据模型(workshop.sqlite,SCHEMA_SQL 增段,`database.ts:25-282` 内追加)

```sql
CREATE TABLE IF NOT EXISTS aml_datasets (
  id TEXT PRIMARY KEY, line_id TEXT NOT NULL, product_id TEXT NOT NULL, recipe_id TEXT NOT NULL,
  run_ids_json TEXT NOT NULL, spec_json TEXT NOT NULL, sha256 TEXT NOT NULL,
  row_count INTEGER NOT NULL, from_ms INTEGER, to_ms INTEGER,
  path TEXT NOT NULL, created_by TEXT NOT NULL, created_by_kind TEXT NOT NULL, -- 'user'|'agent'
  note TEXT, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS aml_jobs (
  id TEXT PRIMARY KEY, dataset_id TEXT NOT NULL REFERENCES aml_datasets(id),
  purpose TEXT NOT NULL, status TEXT NOT NULL, stage TEXT, progress INTEGER DEFAULT 0,
  budget_json TEXT, metrics_json TEXT, gates_json TEXT, artifacts_path TEXT, error TEXT,
  retry_count INTEGER DEFAULT 0, agent_id TEXT, channel_id TEXT, task_id TEXT,
  created_at TEXT NOT NULL, started_at TEXT, ended_at TEXT);
CREATE TABLE IF NOT EXISTS aml_experiments (
  id TEXT PRIMARY KEY, job_id TEXT NOT NULL REFERENCES aml_jobs(id),
  dataset_id TEXT NOT NULL REFERENCES aml_datasets(id),
  parent_experiment_id TEXT, change_note TEXT, config_json TEXT,
  metrics_json TEXT, gates_json TEXT, status TEXT NOT NULL, seed INTEGER,
  created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS aml_models (
  id TEXT PRIMARY KEY, experiment_id TEXT NOT NULL REFERENCES aml_experiments(id),
  dataset_id TEXT NOT NULL, product_id TEXT NOT NULL, recipe_id TEXT NOT NULL, purpose TEXT NOT NULL,
  stage TEXT NOT NULL,            -- candidate|shadow|production|retired
  io_spec_json TEXT NOT NULL, metrics_json TEXT NOT NULL,
  path TEXT NOT NULL, created_by TEXT NOT NULL,
  promoted_by TEXT, promoted_at TEXT, note TEXT, created_at TEXT NOT NULL);
```

(全部外部输入查询走参数绑定——Mimosa 约束;建表幂等 `IF NOT EXISTS`,与存量迁移纪律一致。)

---

## 7. 接口设计(双入口)

### 7.1 REST(`/api/workshop/aml/*`,全部 `defineApiHandler`+`AppError`,用户鉴权走 line grants)

| 路由 | 方法 | 说明 |
|---|---|---|
| `/aml/datasets` | GET/POST | 列表(按 line/product/recipe 过滤)/ 构建(POST=同步构建快照,行数大时分页拉取,超时 60s) |
| `/aml/datasets/:id` | GET | 详情+清洗/统计报告 |
| `/aml/datasets/:id/preview` | GET | 采样预览序列(画图用,≤512 点) |
| `/aml/jobs` | GET/POST | 列表 / 提交训练(dataset_id + 初始 code 可选) |
| `/aml/jobs/:id` | GET;`/aml/jobs/:id/logs` GET(尾 N 行);`/cancel` POST | |
| `/aml/experiments` | GET | 排行榜(dataset_id 过滤,按门禁+主指标排序,含谱系 parent) |
| `/aml/models` | GET;`/aml/models/:id/promote` POST(目标 stage,触发审批);`/aml/models/:id/predict` POST | predict 体:`{history, controls}` → `{forecast, modelId, metricsRef}` |

### 7.2 Agent 工具族(内置 host tools,加入 `.AgentWorkShop/prompts/host-tools.json` + `industrial-tools.ts` 实现 + `host-tool-bridge.ts:161-190` 工业分发 switch)

| 工具 | 角色 | 说明 |
|---|---|---|
| `aml_node_catalog` | 数据/训练 | 列出"我可用的 daq 绑定节点 × 其模板语义 × 近 24h 数据量",回答"能建什么模" |
| `aml_dataset_build` | 数据工程师 | 传 AmlDatasetSpec(§6.1),返回 datasetId + 统计报告摘要;节点越权/跨 Recipe 直接报错 |
| `aml_dataset_stats` | 数据 | datasetId → 统计/相关/滞后报告全文 |
| `aml_dataset_preview` | 数据 | 关键序列预览(降采样) |
| `aml_job_submit` | 训练工程师 | datasetId + `change_note`(本轮改动声明,MLE-STAR 纪律)+ 可选 train.py 代码内联写入后提交 |
| `aml_job_code_write` / `aml_job_logs` / `aml_job_status` / `aml_job_cancel` | 训练 | 写码/追日志/查态/取消(写码走路径围栏) |
| `aml_leaderboard` | 评测工程师 | 谱系树 + 门禁逐项实测值 + 最优 | 
| `aml_model_register` | 评测 | 把 candidate 登记入注册表(等价门禁通过的实验自动登记,此工具用于补登/备注) |
| `aml_model_promote` | **lead 专属**(入 `LEAD_ONLY_TOOL_NAMES`,`host-tool-bridge.ts:33-42`) | candidate→shadow→production,内部走 `tool-approvals` HITL |
| `aml_model_reference` / `aml_predict` | 调控 Agent(全员) | 前者:给定 lineId(+可选拟议参数值),自动取 production 模型→拉最近 DAQ 窗口→组装输入→返回预测轨迹+置信参考;后者:显式 what-if(完整输入) |

工具描述走 i18n 习惯直接中文写入 host-tools.json(与现存 38 工具一致);所有工具实现内:`recordOps`(action 如 `aml.dataset.build`,kind `'system'` 扩展 `'aml'`)+ Agent meta 归属(§2.2 范式)。MCP 回程(`aw-mcp-bridge.mjs`)零改动自动暴露给 14 引擎。

### 7.3 权限实现(复用存量)
- 数据集构建:`spec.nodes[].nodeId` ⊆ 该 Agent `daq` 绑定集(`node-bindings.repo.ts` find/byAgent;node 的 `lineId` 必须等于 `spec.lineId`);用户 REST:`requireLineMode(user, lineId, 'readonly')`(`permissions.ts:55-62`)。
- 预测/参考:模型经 (product, recipe) 寻址,同时要求请求方对该 line 有 `readonly` 或对该 line 绑定节点——防止跨产线窥探。
- 晋升:lead 工具 + HITL 人工决定,超时自动拒绝(`security.hitl_timeout_ms`)。

### 7.4 WS 帧(`broadcastSceneEvent`,零新连接)
- `aml.dataset` `{op:'built', datasetId, lineId, rowCount}`;`aml.job` `{jobId, datasetId, lineId, status, stage, progress}`(≥每 2s 或状态变化才发);`aml.model` `{op:'promoted', modelId, stage, product/recipe}`。前端 `useTownBus` 旁路订阅(§2.3),无 lineId 可见权 peer 自动过滤。

---

## 8. 内置建模团队(全自动作业流程)

### 8.1 种子(幂等 seed,`INSERT OR IGNORE` 固定 id,`database.ts:425-451` 范式)
- `agents` 模板 ×4(ownerUserId NULL = built-in,`visibility='built-in'`):
  - **AML-Lead 首席数据科学家**(任一强引擎,建议 claude/codex 级):任务图分解、派工、预算守门、唯一晋升人。
  - **AML-Data 数据工程师**:拉数/清洗质量/统计判读(时滞、漂移、缺失),产出数据集与建模建议。
  - **AML-Trainer 训练工程师**:写 `train.py`、提交作业、读日志排错、按评测反馈改单组件。
  - **AML-Eval 评测工程师**:解读排行榜与门禁差距、对抗性检查(泄漏/过拟合/分布漂移)、通过后存案例记忆。
- `teams` 1 条:`AML 影子建模团队`(成员 lead=AML-Lead),`channel_templates` 不动;部署仍走既有 `POST /api/workshop/teams/:id/deploy`(§2.2,成员先入队纪律不变)。

### 8.2 提示词资产(`.AgentWorkShop/prompts/aml-*.md` + 成员 config.systemPromptPrefix,经 `prompt-builder.ts:70-108` 自动注入)
- `aml-mission-default.md`(Channel 场景缺省):使命模板——"对配方 {recipe}({product})建立 MPC 代理模型,horizon {H} 步;预算 {N} 轮实验;达标后提交晋升申请并等待人工批准;全程遵守数据隔离,禁止跨配方取数"。
- `aml-playbook.md`(四个成员 prefix 共同引用其职责段):
  1. **契约**:只用 `aml_*` 工具;训练代码必须 `import amlkit`,产出契约工件;
  2. **迭代协议**(AIDE 树搜索):首轮必须最简基线(线性 ARX)校准数据可学性 → 逐级升模型族(GBDT→MLP→LSTM/TCN);每轮 `change_note` 只声明一个改动(MLE-STAR);评测变差且两次修复无效 → 回溯到最优父节点换方向(greedy-then-restore);预算耗尽停在最优;
  3. **数据纪律**:先读 `aml_dataset_stats`(时滞→historySteps、漂移→是否需按 run 归一),Hampel 剔除率>5% 或缺失>15% 必须先反馈数据工程师复检;
  4. **停止条件**:门禁全过→`aml_model_promote`(lead)并汇报;两轮无改进→如实报告瓶颈(数据不足/噪声/变量缺失),不虚报精度;
  5. **收尾**:评测工程师 `save_memory` 存"配方×有效结构×超参×陷阱"案例(DS-Agent 式 CBR),下次同 Recipe 自动召回。
- 成员 `systemPromptPrefix` 各 200-400 字,固化角色专长与工具用法(含反模式:"不得在训练代码里访问网络/读 workspace 外路径/改清洗参数绕门禁")。

### 8.3 自主闭环(运行时行为,无需平台新代码,依赖上述提示词+工具)
用户在 Channel 发使命(或预置 scenario)→ lead `dispatch_task` 分派 → 数据工程师建数据集 → 训练工程师循环(写码→submit→读 logs/leaderboard→改)→ 评测工程师把关 → 门禁过 → lead 发起晋升 → **HITL 人工批准** → production 模型可被全厂调控 Agent `aml_model_reference` 引用 → 全程 ops_log 可审计。调度/停摆回收由既有 `scheduler-loop.ts` 看门狗兜底(§2.2:tool 活性重置停摆基线)。

---

## 9. 实施步骤(Implementation Steps)

> 每步独立可验证、可单独提交(遵守本仓 pathspec 限定提交纪律)。行号为当前工作树参考位置。

**P0 运行时底座(0.5d)**
- 新增 `server/services/workshop/aml/python-runtime.ts`:探测 python/uv(`resolveOnPath`,`line-spawn.ts:29-55`)、共享 venv 供给(幂等)、`AML_PYTHON_MISSING` 结构化错误;requirements 固定于 `server/services/workshop/aml/python/requirements.txt`。
- 设置项 `aml.*` 进 `settings.ts`(沿 `daq.sampling` 范式 `settings.ts:179-187`);`config.yml` 增缺省段。
- `onnxruntime-node` 入 `nuxt.config.ts:117-127` externals。

**P1 数据集层(1.5d)**
- `server/services/workshop/aml/{dataset-builder.ts, clean.ts, stats.ts, spec.ts(zod 校验)}`;快照落盘与 sha256。
- SCHEMA_SQL 增 4 表(§6.6)+ 新增 `server/services/workshop/db/aml.repo.ts`(仓库层范式沿 `ops.repo.ts`);`workshop.ts:104-117` 装配。
- REST:`server/api/workshop/aml/datasets/**`(§7.1);权限双检(§7.3);`recordOps` 埋点。
- 单测:合成张量→清洗/对齐/切分确定性(固定 seed 逐字节一致)、隔离(跨 recipe 拒绝)、泄漏(窗口不跨 run)。

**P2 作业运行器(1.5d)**
- `server/services/workshop/aml/{job-orchestrator.ts, runner-protocol.ts, gates.ts}`;`python/amlkit.py` + `python/aml_run.py`(契约校验+进度协议)。
- 队列(并发/重试/永久错误分类/看门狗/nitro close 钩子);WS `aml.job` 帧;REST `jobs/**`。
- REST `aml/datasets` 与 jobs 均过 `caller.ts` 双身份(Bearer 用户或 agent token)。

**P3 模型注册表与预测服务(1d)**
- `server/services/workshop/aml/{model-registry.ts, predictor.ts(onnxruntime-node 懒加载+缓存)}`;阶段机+生产唯一性+晋升 HITL(`tool-approvals` 编程接口);REST `models/**`(§7.1)。
- 单测:晋升状态机(自批拒绝/超时拒绝/生产唯一性)、onnx 试推理门(用 fixture 小 onnx)。

**P4 Agent 工具族(1d)**
- host-tools.json 增 11 工具(§7.2);`industrial-tools.ts` 实现(权限=daq 绑定/line grants);`host-tool-bridge.ts` 两处分发(工业 switch + 角色装配 lead-only 名单)。
- e2e 断言:MCP `tools/list` 对 14 引擎暴露、越权节点报错、ops_log 归属 `来源=Agent`。

**P5 内置团队与提示词(0.5d)**
- 种子迁移(4 模板+1 队,固定 id);`.AgentWorkShop/prompts/aml-*.md`;config_json 注入 prefix;部署冒烟(deploy→成员实例化→prompt 含 playbook 断言)。

**P6 UI `/aml`(1.5d)**
- `app/pages/aml.vue`(±组件):数据集(表+新建向导+统计/清洗报告)、作业(队列卡+进度条+日志尾随)、排行榜(谱系缩进表)、模型(阶段徽标+晋升按钮→审批走头部待办)、预测控制台(what-if 表单+预测曲线)。
- 复用 `aw-page-head`/按钮词汇/暗色;`i18n/dicts/aml.json` + 两 locale 挂载(codemod 流程);`useTownBus` 订阅 `aml.*`。

**P7 测试与 e2e(1.5d)**
- 单测/集成:见各步;存根运行器 `AML_STUB=1`(Node 模拟进度+达标 metrics,不依赖 Python)。
- `scripts/e2e-aml.ts`(沿 `e2e-full-scenario.ts` 进程内范式):合成一阶+死区+噪声+离群点+两次 Recipe 版本切换的产线(run 打标)→ Agent 身份走 host-tool 桥全流程(建集→写码→训练(存根或真 Python)→门禁→HITL 自动批准路径→predict 精度对真值 NRMSE≤0.15)→ 全程审计断言。
- 冒烟:`scripts/e2e-aml-rest.mjs`(对 live 3001,沿 `api-live-e2e.mjs` 计数器范式)。

**P8 文档与真实性审计(0.5d)**
- `docs/` 增 AML 章节(架构/接口/Python 依赖/门禁/治理);按本仓纪律逐声明对照源码防捏造 API;CHANGELOG 条目。

合计约 9.5 人日。关键顺序依赖:P0→P1→P2→P3 串行;P4 依赖 P1-P3;P5/P6 可与 P4 并行;P7 随各步同步写、最后收口。

---

## 10. 验证步骤(Verification Steps)

1. **单元/集成**:`npx tsx scripts/test-aml-*.ts`(固定 seed):清洗确定性、切分无泄漏、隔离拒绝、门禁逐项边界值(阈值±ε)、晋升状态机、存根运行器全状态机迁移。
2. **进程内 e2e**:`npx tsx scripts/e2e-aml.ts` 全绿(25+ 断言):含"Agent 越权取他产线节点被拒""跨 Recipe 合并被拒""假 metrics 不达标→gates_failed→迭代后达标""HITL 拒绝→模型停留 candidate"。
3. **真实 Python 链路**(有 Python 的机器):`AML_REAL_PY=1` 跑同一 e2e,torch LSTM 真训练,验证 onnx 导出与 onnxruntime-node 试推理一致(同输入输出差 < 1e-4)。
4. **观测性**:作业期间 `wscat` 收 `aml.job` 帧进度单调;`/logs` 页与 audit_log 可见 Agent 归属行;作业 kill 后无孤儿 python 进程(`tasklist` 断言)。
5. **回归**:既有 `test:api-live`、`tests/team-plugins-smoke.ts`、`e2e-full-scenario.ts` 不回归;3000/3001 探针与既有端口纪律不破坏(本模块零新端口)。

## 11. 验收标准(Acceptance Criteria,全部可测)

1. `aml_dataset_build` 对未绑定节点返回 403,对跨 Recipe 合并默认拒绝(测试断言)。
2. 同一 spec+seed 两次构建快照 sha256 一致(确定性)。
3. 合成产线(一阶+死区+5% 离群点)上,存根或真实训练在 ≤12 轮实验内通过全部 5 门(G1 test NRMSE≤0.10、G2 滚动≤0.25、G3≤0.20、G4、G5),e2e 断言。
4. 晋升 production 必产生一条 HITL 待办,批准前模型 stage 仍为 candidate;批准后同 (product, recipe, purpose) 旧 production 自动 retired 且 audit 留痕。
5. `aml_model_reference` 端到端延迟 < 2s(生产模型,输入窗口 48×N,p99,本地);`/predict` 同口径 < 500ms。
6. 作业超时/被杀后:python 进程树零残留;服务器重启后作业状态为 `interrupted` 且可重试。
7. 无 Python 环境下:提交作业返回 `AML_PYTHON_MISSING` 指引错误,平台其余功能(数据集/统计/注册表/预测)正常;`AML_STUB=1` e2e 全绿。
8. 14 引擎任一(至少 mock + 一个真实引擎)经 MCP 可列出并调用全部 `aml_*` 工具。
9. 全部 aml 副作用(dataset/jobs/promote/predict-agent-call)在 audit_log 有行,Agent 行为 `actorKind='agent'`、actorName 形如 `Channel/成员`。
10. UI `/aml` 五区块可用:暗色/亮色切换无样式破损;i18n 中英切换无裸 key;无 line 可见权用户看不到对应数据集/作业。
11. 既有回归套件(test:api-live / api-live 64 项 / e2e-full-scenario)零回归。
12. SQL 全参数绑定、无拼接(grep 审查 + 模板注入用例);workspace 路径逃逸用例(`../`、绝对路径、NUL)全部拒绝。

## 12. 风险与缓解

| 风险 | 等级 | 缓解 |
|---|---|---|
| 用户机器无 Python/torch 安装重 | 高 | ADR-1 探测+结构化指引;依赖锁定+可配镜像 index;`AML_STUB` 保证功能链路不依赖 Python;文档给 uv 一键命令 |
| Agent 写出危险/低质代码(python 无硬沙箱) | 高 | 契约:Agent 代码仅 train.py 且路径围栏;墙钟/并发/日志限额;评测门不信自述;晋升人审;文档明示信任边界(可选 OS 级低权用户运行,配置留口);训练默认无网(venv 预置,不装包) |
| 数据泄漏/Recipe 串味导致指标虚高 | 高 | ADR-2 byRun 切分+硬三元组;G3 泛化门;评测工程师对抗性审查职责;e2e 注入"另一配方混入"负例断言 |
| node:sqlite 与作业写入并发 | 中 | aml 表写入低频(状态迁移级);沿 WAL+busy_timeout 现状;进度高频态走内存+WS 不落库 |
| 长日志/大工件撑爆磁盘 | 中 | 行数护栏 maxRows;工件配额 `aml.job.diskQuotaMb`;数据集/模型保留策略并入既有 `retention.ts` 插件 |
| Windows 命令行引号坑 | 中 | 一律复用 `line-spawn.ts`,不自拼命令;venv python 为裸 exe 不触 .cmd 分支 |
| Agent 迭代烧钱(强引擎多轮) | 中 | budget_json 硬上限;存根/廉价引擎可先验流程;每轮 change_note 强制最小改动 |
| onnxruntime-node 原生依赖打包问题 | 中 | P0 即入 nitro externals 并加最小加载冒烟;失败降级=预测服务不可用但训练链路不受影响(明确报错) |

## 13. 后续展望(非本轮)
- DCW `dcw_judge` 接入生产模型:下发前自动 what-if 预测偏离告警。
- MPC 求解层:基于 io_spec 的滚动优化控制器(影子模式先跑,不闭环)。
- 在线监测:生产模型对新批次的残差监控→漂移告警→自动触发再训练使命(复用本团队)。
- 帧/图像模态(vision-cam 质量-工艺联合建模)。

---

## Changelog
- 2026-09-10 v1:初稿(3 探索代理事实核查 + 文献检索),Direct 模式产出,`pending approval`。
- 2026-09-10 v2:用户批准执行。新增 §14 执行期增强项(GC/资源效率/接口健壮性),状态置 `approved`。

## 14. 执行期增强项(资源效率 / GC / 接口健壮性)
1. **GC(防冗余堆积)**:①作业工作区——作业终态后保留 `run.log`+`artifacts`,workspace 中间文件(venv 符号链除外)立即清理;失败作业工作区保留 24h 后清扫。②数据集/模型保留策略挂入既有 `server/plugins/retention.ts`(24h 循环):无任何 aml_models/aml_experiments 引用且创建 > `aml.dataset.retentionDays`(默认 30)的快照目录删除;`retired` 模型工件保留 `aml.model.retiredKeepDays`(默认 90)后删除(注册表行保留,指向已删工件时标记 `artifacts_pruned=1` 并在读取时明确报错而非 500)。③排行榜按 dataset 只保留门禁通过 + 最近 20 条实验行,其余归档删除(避免表膨胀)。④磁盘护栏:构建数据集前检查 `data/aml` 配额(`aml.job.diskQuotaMb`,默认 2048),超限拒绝并提示清扫。
2. **资源效率**:①`queryTagged` 拉数按节点分页+桶对齐在 SQL 层完成(复用 TsdbPort bucketMs),Node 侧不做全量原始点运算;②预测器 onnxruntime session 按 modelId LRU 缓存(上限 4),`retired/pruned` 即时失效;③venv 探测结果缓存(globalThis),探测一次全程复用;④`aml.job.maxConcurrent=2` + 队列 FIFO,防 CPU 争抢;⑤WS 进度帧最小间隔 2s(协议行内部更密也节流)。
3. **接口健壮性**:①所有 REST/工具入参 zod 化(无 zod 则手写校验器),错误码统一 `AML_*` 前缀并带可操作指引;②作业/数据集/模型的读取路径全部容忍工件缺失(报 `AML_ARTIFACT_MISSING` 而非裸 500);③job-orchestrator 幂等:同 job 重复 submit/cancel 幂等返回当前态;④运行器协议对超长行/非法 JSON 行丢弃并计数(不因日志格式炸掉训练);⑤工具层全部走 recordOps 且失败也留痕(fire-and-forget,与 ops.ts 纪律一致);⑥并发竞态:模型晋升与退役用单事务 UPDATE+条件 WHERE(stage 校验在 SQL 层兜底)。
