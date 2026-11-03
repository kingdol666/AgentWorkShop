# 多源异构数据 & MES API 接入面 · 核查结论与优化计划(2026-11-03)

> 背景:用户问——系统如何处理多源异构数据(向量/图片)?MES API 怎么接入?能否实现 MES API
> 数据 export?API 的 req/res 格式有什么要求?是否真正"配置驱动自定义配置 API,让 Agent
> 调用外部 API 获取数据"?本文逐面给出**代码级核查结论**(每条带文件锚点)与**优化计划**。
> 状态:计划待批准(编号 H1–H8);结论部分为当前事实。

---

## A. 核查结论(现状事实,全部实测/代码锚点)

### A1. 数据形态闭合:scalar / vector / image(不可插件扩展,设计如此)

| 形态 | 存储 | 查询 | 导出 | Agent 面 |
|---|---|---|---|---|
| scalar | TSDB `daq_samples`(Timescale/SQLite 双适配器,run/product/recipe 打标) | samples API 分页/按批次过滤 | CSV(merge/分节点) | `daq_query` |
| vector | `daq_frames`(meta.points 存全点列,Timescale JSONB)+ 模板 resample(如 16→64 标准网格) | frames API + preview | `frames/<id>.csv`(逐帧行) | `daq_query`(标量面回查帧)· `daq_export` 帧文件 |
| image | 像素进对象存储(MinIO,时钟偏差时降级本地磁盘),`daq_frames.meta` 存 objectKey/sha256/size | frames API + 缩略图(thumbPng) | `frames/<id>.png` 原始文件 + manifest | 同上 |

锚点:`daq/daq-controller/ingest.ts`(标量/帧双管线)、`daq/frames.ts`(下沉处理器:derive-metric/thumbnail/quality-gate)、`eda/data-export.ts:140-150`(readFrames/readFrameContent 注入)、`agents/industrial/daq-export.ts:155-220`(vector→逐点 CSV,image→PNG + MIME)。
**结论:三形态端到端(采集→存储→查询→导出→Agent)已闭合;数据类型不可插件扩展是文档明示的闭合设计,不是缺陷。**

### A2. MES API 接入 = 真正的配置驱动自定义 REST 映射(能力存在且相当完整)

`dcw/drivers/mes-rest.ts`(817 行)用**声明式三原语映射**把任意 MES REST 端点接成 DCW 点位:

| 原语 | 配置(text 表单 JSON 字符串) | 要点 |
|---|---|---|
| readMap | `method/path/query/headers` + `response.valuePath/tsPath(tsFormat: epoch_s/epoch_ms/iso)/dictionaryPath` | 当前值快照;字段字典随响应缓存 |
| writeMap | `method/path/query/headers` + `bodyTemplate({{value}} 插值)` + `successOn 状态码` + `ackPath` | 受理判定/回执路径 |
| historyMap | `rowsPath/valuePath/tsPath` + **`format: scalar|vector|image|table|event`** + `valuesPath(向量)/dataPath+mimePath(图像)/nextCursorPath` + `pageSize/maxPages` | 分页拉全量历史 |

**req/res 要求**(即"API 需要什么格式"):任意 REST 均可——
- 请求:method/path/query/headers 任意组合;`headersJSON` 值支持 `{{SECRET:REF}}` 插值;凭据**零明文**(`secretRef` 只存引用名,token 从 `AW_MES_<REF>_TOKEN` env 或运行时设置 `mes.secret.<ref>` 解析);
- 响应:JSON,用 valuePath/rowsPath 等路径声明取值位置(不做整包格式约定);时间戳支持 epoch_s/epoch_ms/iso 三种;字典(字段名/单位/量程/向量点数)可选随响应或配置;
- 安全:baseUrl 强制 http/https;DNS 解析后任一 IP 落私有/环回段需显式 `allowPrivateHost='true'`;同实例令牌桶限速(默认 5 req/s);坏映射 safeParse 配置期拒绝,不进请求链路;
- 子进程钩子四类:`mesDataHook/mesRequestHook/mesWriteHook/mesWriteCheckHook`(响应改写/请求改写/写前变换/写前复核)。

**数据 export:存在且完整**——
- `mes_fetch`(Agent 工具):当前值快照 / 同步内联(≤2000 行)/ 异步 CSV 数据集(>2000 行,带 `*.manifest.json` 字段字典+批次归属);护栏代码级:仅绑线点位、窗≤7 天、行≤5000、60s 内≤6 次;**铁律:MES 行级原文不进 prompt**(只给统计摘要 + ≤3 行采样,全量落 `datasets/<id>.csv`);
- `mes_export`(Agent 工具):CSV/JSONL/图像文件 + manifest + README 到指定目录,产物含字段级物理语义,离线可用;
- `mes_catalog / mes_dataset_read / mes_datasets`:目录检索(按可读产线严格过滤)与数据集读取/清单。

**结论:用户问的四件事全部成立**——异构(五格式)、export(三工具)、req/res(路径声明式,无强格式)、配置驱动让 Agent 取数(是;且授权/限速/原文不进 prompt 的治理都在代码级)。

### A3. 通用 HTTP(非 MES)自定义 REST 也配置驱动

- DAQ 读:`daq/drivers/http.ts` — GET/POST + bodyTemplate + jsonPath + secretRef + SSRF 同口径;
- DCW 写:`dcw/drivers/http.ts` — POST JSON + `{{value}}` 模板 + `{{SECRET:REF}}` 头插值 + timeoutMs(1–60s);
- MQTT:fields 多子字段展开 + jsonKey 下发 + readTopic 回读(10-31 实测 15/15);
- Agent 还可经 `code-exec`/插件 MCP 桥接外部 API,但**平台面**的标准路径就是上述驱动配置。

### A4. 本轮顺带核实的已知边界(非新缺陷)

1. **MES 历史不进平台 TSDB**:mes_fetch/数据集独立落 CSV;AML 数据集构建(`aml/datasets`)只吃 TSDB(`fetchNodeSeries`),MES 数据**不能直接进模型训练/EDA 数据面**——需先经 mes_export → 平台外/再导入,或走 E2 批次。这是设计边界(原文不进 prompt/库),但阻断了"MES 数据 → 闭环优化"的直达链。
2. **向量 resample 网格固定**:模板 thickness-scan 按 `resample n=64` 归一;上游点数≠配置点数时报"向量帧点列非法"(P3 修复的正是其错误残留)。网格尺寸不可按点位配置。
3. **export 无 environment 列**(历史审计已记):导出 CSV 列不含产线环境元数据;对比分析需靠 manifest。
4. **图像质量门**:quality-gate 只算亮度/对比度进 metrics,无缺陷检测语义(由 Agent/EDA 侧消费)。

---

## B. 本轮已修复(同 PR,均有测试)

| ID | 修复 | 锚点 | 测试 |
|---|---|---|---|
| **P2** | DoE 创建/执行前**步限可达性校验**(水平间隔 + 当前值→最近水平,口径与 write() 三层取最小一致);执行器改**蛇形可行随机序**(控制量内单调、repeat 边界 Δ=0,跨控制量种子交织保留打散) | `process-model/plan-safety.ts`(+step 检查)、`experiment-runner.ts`(buildExperimentSteps) | `tests/experiment-plan-p4.test.ts` 19/19(新增 4 例:间隔拒/可行序/增益口径/runner 透出) |
| **P3** | 帧路径成功解析即清 `node.lastError`(与标量 applyReading 自愈同语义;state=warn 是模板警告带的正确判定,不属缺陷) | `daq/daq-runtime.ts`(onSample frame 分支) | 代码审查 + 既有 daq 套件 |
| **P4** | Lead 监督回合被中止(external cancel / hard timeout)时,把在办任务转显式 **cancel 决策**(带原因、可重派),不再静默返回空决策留任务 WORKING;上游已取消的任务命中终态守卫自然 no-op | `agents/omp-agent/tools-steer.ts`(abortTurn) | 类型/lint 验证(omp client 栈难以单测;观察路径=调度器 execute cancel 分支既有守卫) |
| **P5** | 增益估计只信**可辨识步**:新增 `estimateGainFromRows`(intervention-ledger 纯函数,underpowered/confounded/负结论/Δ=0 一律排除并如实给 excluded 分母),runner 结果透出 `estimatedGain/gainSamples/gainExcludedSteps`;demo 脚本消费执行器估计(旧口径回退) | `aml/intervention-ledger.ts`、`process-model/experiment-runner.ts`、`scripts/demo/e2e-optimization-demo.mjs` | p4 套件内 2 例(纯函数口径 + runner 经真实写咽喉端到端) |
| 夹具 | `e2e-hitl-live.mjs` / `e2e-auth-matrix.mjs` 支持 `AW_BASE`(消除 T3 端口不匹配) | scripts/ | — |

---

## C. 优化计划(H1–H8,按价值排序;待批准后实施)

| ID | 项 | 动机(现状→目标) | 建议工作量 |
|---|---|---|---|
| **H1** | **MES 历史 → 平台 TSDB 桥**(可配置开关) | MES 数据现在到不了 AML/EDA 数据面;桥接后"MES 数据 → 数据集 → 训练 → 优化闭环"直达。做法:mes-rest historyMap 拉取 → 经既有 ingest 管线按 scalar/vector 打标入 TSDB(image 仍走对象存储);限速/窗口护栏复用 mes-controller | 2–3 天 |
| **H2** | **向量网格按点位可配** | resample n 固定 64,上游 16 点需模板级适配;把 resample 目标尺寸下沉到节点/模板配置(缺省不变) | 0.5 天 |
| **H3** | **export 增 environment/工况列** | 导出 CSV 增加产线/批次/工况上下文列(或 manifest 增强),免人工对表 | 0.5 天 |
| **H4** | **abortTurn 决策补单测** | P4 修复目前靠类型/审查;把 tools-steer 的 abort→cancel 决策抽成纯函数并测(中止原因 → 决策映射) | 0.5 天 |
| **H5** | **MES 图像历史落对象存储统一面** | mes_fetch 的 image 帧已自动落盘但与 daq_frames 元数据面分离;统一到 frames 检索面后,图像类分析(CCD)可与 DAQ CCD 同路径复用 | 1–2 天 |
| **H6** | **mes-rest 限速/并发配置化** | 5 req/s 写死在驱动实例;按点位/目标主机可配(生产 MES 吞吐差异大) | 0.5 天 |
| **H7** | **export 流式分页** | 大窗口导出一次性 query(limit 50 万);改分页游标流式写,降低内存峰值 | 1 天 |
| **H8** | **plugin 化 mes-rest 映射模板** | 常见 MES(如 Siemens Opcenter/自研)做成映射模板库,接入从"写三段 JSON"降为"选模板+填端点" | 1–2 天 |

## D. 明确不做(记录原因)

- **不把 MES 原文进 prompt/进 LLM 上下文**:既有铁律(统计摘要 + 采样行),维持;
- **不为 mes-rest 增加 SOAP/私有二进制协议**:映射已覆盖 REST 全谱;非 HTTP 协议走插件驱动面(有 serial 模板);
- **不动 vector/image 三形态闭合设计**:已端到端闭合,扩展点在处理器/模板而非类型系统。
