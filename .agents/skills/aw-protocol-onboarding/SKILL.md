---
name: aw-protocol-onboarding
description: AgentWorkShop 协议与异构数据接入 skill。当用户给出厂家接口文档、MQTT/Modbus/OPC UA/MES REST/串口协议说明,需要在已运行实例上自动生成数采/写控节点配置、用模拟端点跑通镜像采集、验证入库与导出,并在协议或数据类型不支持时开发插件适配、热加载应用、再从虚拟端点无缝割接到真实产线时使用。触发词:协议接入、接口文档接节点、模拟跑通、镜像采集、插件适配、热加载、虚拟转真实、按文档建节点。不适用于:纯频道编排(见 aw-line-onboarding)、全系统回归(见 aw-system-acceptance)。
---

# AgentWorkShop 协议与异构数据接入

> 双位置说明:校验基准副本在仓库 `skills/aw-protocol-onboarding/`,ZCode 发现副本在 `.agents/skills/aw-protocol-onboarding/`;改动须两处同步。脚本实体在 `scripts/onboarding/`。

从厂家文档到真实产线只走一条确定性路径:**预检 → 蓝图 → 能力匹配 → 配置 → 模拟跑通 → 导出验收 → 插件适配 → 割接**。任何一步没有证据,不进入下一步。

## 最高红线:运行中的实例一律按生产对待

- 先跑 `node scripts/onboarding/preflight.mjs --json`。只要 `running=true` 且没有显式 `--test-instance`,就按 `treatAsProduction=true` 处理。
- **禁止**:`aw start`、`aw stop`、`taskkill`、`Stop-Process`、`kill`、`pkill`、`docker compose down`、在同一 `AW_HOME` 或同一端口再起一个实例、停/启 DAQ 采集总控、改删既有线/节点/配方/频道、为让插件生效而重启进程。`aw start` 会自动停止既有实例(aw.lock),不是“启动失败”。
- **允许**:只读查询、创建带 `PROTO-<时间戳>` 前缀的资源、专用测试线、project/user 级插件热加载、只 PATCH 本次新建节点的 `driverConfig`。
- 原因:`aw start` 读 aw.lock 会 `terminatePid` 旧实例再重启;直接 `node .output` 同数据目录会被 data.lock 拒绝。强杀会在飞采样/HITL/写控中断,真实产线可能停在半动作状态。需要重启才生效的 builtin 插件/核心改动,移交维护窗口,不在本次作业内做。
- 生产实例的隔离方式是**命名空间**,不是新进程:独立测试线 + 独立节点名前缀 + 本次创建的 id 清单;收尾只按清单逆序清理。

> **虚拟/真实数据隔离**:虚拟验证用独立测试线(或 `simulated=true` 线);`daq_samples`/`daq_frames` 没有 environment 列,隔离靠 line/run。不要把虚拟样本混进真实生产线的分析窗;复用同一条线时,记录割接时间点/批次并在分析时按窗口排除。

### 0. 连接与生产判定

`aw_status` 确认 `AW_BASE`、鉴权与 `mcpEnabled=true`;未鉴权先 `aw_login`。MCP 开关在「系统设置 → MCP 集成」或平台进程 env `AW_MCP_ENABLED=true`;未开启时除 `aw_status` 外全部工具被拒,先引导用户开启,不要绕过。

预检输出 `instances[]`(home/mode/port/pid/pidAlive/portListening/stale)与 `forbiddenActions`;把它写进作业记录。再用 `aw_request GET /api/health` 读 `activeChannels`/`wiredAgents`(频道明细在 `/api/workshop/channels`):任一 >0 时,按生产附加模式作业。若 `running=false`,允许用**不同端口 + 不同 AW_HOME** 启影子实例;绝不复用生产 home。

### 1. 文档 → 点位蓝图

先判断资料类型,再逐点提取;缺字段停下来问用户,禁止猜测。必问项:量程/单位、SP 可写还是 PV 只读、单步上限、采样周期、认证方式与凭据归属、期望值/判据。

| 资料 | 提取目标 |
| --- | --- |
| Modbus 寄存器表 | host/port/unitId/register/area/dataType/byteOrder;SP 建 DCW,PV 建 DAQ |
| OPC UA 节点表 | endpoint、每点 `ns=;s=` nodeId、securityMode、证书 |
| MQTT 主题表 | 遥测 topic + jsonPath(多字段用 `fields`);命令 topic + jsonKey/jsonTemplate |
| MES REST 文档 | readMap/writeMap/historyMap、认证 secretRef、分页 nextCursorPath |
| HTTP 轮询 | url/method/headers/bodyTemplate/jsonPath;图像/数组走模板 signalKind |
| 串口/私有总线 | 插件 kind、帧格式、校验、应答;必要时走第 5 步插件适配 |

输出 `blueprints[]`,每项至少:`{name, direction:read|write, protocol, address, dataType, unit, min, max, stepLimit, intervalMs, expectedValue}`。蓝图是后续所有配置与断言的唯一输入;不要把文档原文直接塞进 `driverConfig`。

> **文档格式前提**:平台没有内置 PDF/Word/Excel 解析。先把文档转成 Markdown/CSV/JSON(点位表按行导出),扫描件先 OCR;只有原始 PDF/Word 时,让 Agent 用可用的文档工具读取,或请用户提供文本/CSV。不要把"能读文档"当成平台内核能力。

各协议的完整字段表与“哪些形态内置支持/哪些要插件”见 `references/protocol-matrix.md`。

### 2. 能力匹配:内置优先,插件兜底

对照 `references/protocol-matrix.md` 判定三件事:

1. **协议 kind 是否存在**:`aw_request GET /api/workshop/daq` 的 `drivers[]` 与 `/api/workshop/dcw` 的 `drivers[]`;插件驱动带 `plugin:true`。也可以用 `aw_plugin_list` 看已装载插件。
2. **载荷能否落到 scalar/vector/image**:标量走 `jsonPath`;MQTT 数组走 `pointsPath`、图像走 `imagePath`/binary;HTTP 数组走 `jsonPath`(vector 模板)、图像看 Content-Type 或 JSON `png`/`blob`;私有结构用 `decoder`。三种都套不上 → 第 5 步。
3. **写侧是否需要自定义封装**:`jsonKey`/`jsonTemplate` 不够(多动态值、二进制帧、校验和、会话) → 第 5 步写 `DcwWriteDriver`。

匹配结果写成表:`点位 → 内置 kind/模板 → 结论(内置/插件/不支持)`。**“不支持”不是失败,是第 5 步的输入**;但数据类型超出 `scalar/vector/image` 时必须如实告诉用户:这是核心扩展,不是插件能独立完成的。

### 3. 在运行实例上生成配置

先连通性,再建节点,最后才碰频道:

- 批量连通预检:`node scripts/onboarding/test-connection.mjs <config.json>`;单点用 `aw_request POST /api/workshop/daq/test-driver`。任一失败即停,回报原始 message(超时/拒绝/404),修正 `driverConfig` 后重跑。
- 建线:`aw_line_create`(专用测试线,名字带 `PROTO-<时间戳>`),或复用用户明确指定的测试线;不要用生产主线做试验。
- 建节点:`aw_daq_create` / `aw_dcw_create`。DAQ 必带 `templateRef`;DCW 服务端只强制 `templateRef`,但生产接入必须显式给 `min/max/stepLimit/holdIntervalMs` —— 缺省时 `stepLimit` 会被推导为 `max(10^-decimals, 2% 量程)`(不是 fail-closed),等于把步长交给默认值。
- 建配方:`aw_recipe_create`;节点引用用 id,不用名字。
- **本阶段不建 Channel**。频道会拉起 Agent 与工具面,在镜像采集/导出验收通过前创建,等于把未验证的数据源接进生产作业面。

统一配置式批量供给可用 `node scripts/onboarding/provision-line.mjs <config.json>`;它按指纹幂等复用,但只应指向本次测试线。请求返回 400 先看 `message` 定位字段;401 是鉴权/行权限;409 多为重名或在飞写;超时先确认实例是否被别的作业占用,不要重启。

### 4. 模拟通信跑通镜像采集

目标不是“节点建出来了”,而是**文档里的值真的从端点流进了时序库**。

1. 用 `aw-plc-sim-twin` 或厂家提供的 sandbox 起模拟端点;没有现成模拟器时,用 `POST /api/workshop/daq/:id/ingest` 主动推送构造报文(支持 scalar/points/image base64)。
2. 把节点 `driverConfig` 指向模拟端点;确保采集总控 running(生产实例上先问用户,不要擅自 stop/start)。
3. 等 2~3 个采样周期,用 `aw_daq_samples` 或 `aw_request GET /api/workshop/daq/:id/samples` 看真实样本;向量/图像看 `/frames`。
4. 用确定性断言收口:`node scripts/onboarding/verify-mirror.mjs --node <id> --kind scalar --expect '{"value":25.3,"tolerance":0.2}'`。它校验窗口内样本、期望值、时间戳单调;向量校验点数/指标/首末点;图像校验 objectKey/MIME/宽高/内容字节。
5. 同一 topic 的多个字段用 MQTT `fields` 一次展开;验收时每个子节点都要有样本,且同一报文的时间戳应重合。

只有第 4 步全绿,才允许进入导出验收。

### 5. 插件适配(仅当第 2 步判红)

按“最小扩展面”选择,不要一上来写驱动:

| 缺口 | 扩展面 | 入口 |
| --- | --- | --- |
| 私有 JSON/二进制结构 | `ctx.daq.registerDecoder(name, fn)` | 同步纯函数 → scalar/vector/image |
| 新传输协议(读) | `ctx.daq.registerDriver(driver)` | `available/sample/test/subscribe?/meta` |
| 新传输协议(写) | `ctx.dcw.registerWriteDriver(driver)` | `write/test/read?/canRead?/fetchHistory?` |
| 向量/图像后处理 | `ctx.daq.registerProcessor(kind, name, fn)` | 仅 vector/image 帧会执行 |
| 新节点模板 | `ctx.daq.registerTemplate(def)` | 含 sink/metrics |
| 新数据类型(text/file/音频) | **核心扩展** | 不是插件面;如实告知用户 |

实现规范、完整接口签名、示例与测试口径见 `aw-plugin-dev` skill 与 `docs/plugins.md`。

热加载:project 级插件放 `.AgentWorkShop/plugins/aw-matrix-plugin/` 同款目录结构,user 级放 `~/.AgentWorkShop/plugins/<name>/`;用 `aw_plugin_toggle { name, enabled:true }`(或触碰 `plugins-state.json`)触发 ~1s 全量重载,`aw_plugin_list` 确认无 `failures`。**builtin 插件 entry 也会随状态文件重载,但内部 helper 模块可能被 ESM 缓存,且 builtin 优先级遮蔽 project 同名副本;验证不生效时移交维护窗口,不要重启生产进程**。改完代码保存后重新 toggle 一次,确认行为更新;不要用重启来“试试看”。

### 6. 导出正确性验收

插件/协议适配完成后,导出链要单独验收,不能只看页面有数:

- **值**:导出样本的字段值 = 模拟端点构造值(容差内),不是 0/常量/上一批残留。
- **量**:窗口内行数与采样周期匹配;向量点数 = 模板声明;图像帧数 ≥ 预期。
- **时间**:时间戳在窗口内、单调;同一报文的多个字段时间戳重合。
- **标识**:`line_id/product_id/recipe_id/run_id` 与当前测试线/批次一致;图像 `meta.objectKey` 可被内容端点取回且字节非空。
- **清单**:DAQ 导出的 manifest 只记录窗口/节点元数据/行数/truncated,不含 sha256 与列名;CSV 列名与行数需直接核对文件(标量 `ts_iso,ts_ms,value,state`;向量长表 `ts_iso,ts_ms,point_index,value`),sha256 需自行计算。不要用“文件存在”代替“内容正确”。

可用 `verify-mirror.mjs --json` 的输出作为机器可读证据;把它和节点 id、时间窗、期望值一起写进交接记录。

### 7. 虚拟 → 真实割接

只在模拟端点全绿后执行,六步逐步放行:

| 步 | 动作 | 通过判据 |
| --- | --- | --- |
| 1 | 真实 `driverConfig` 重跑连通预检 | 全绿 |
| 2 | 只读浸泡 ≥30min(只接 PV) | 量程/噪声/漂移符合文档;恒值/跳变先查接线与量纲 |
| 3 | 单点最小步写入首验 | 「写控 \| 设备 \| 镜像回读」三方一致 |
| 4 | 其余节点 PATCH `driverConfig`(配方/绑定/限界不动) | 只改端点,不重建节点 |
| 5 | `scripts/onboarding/verify-line.mjs` V1-V6 重跑(V2/V3 会真实写入,需批准) | 全绿 |
| 6 | 交付割接清单(端点/凭据变更 + 首验三方记录) | 投用仍由产线负责人 judge & taste |

割接时 `secretRef` 在视图里是 `******`;PATCH 必须显式给真值,或不要动该字段。不要在割接窗口新建/删除节点或频道。

## 红线

- 文档没写的字段不猜;量程/方向/凭据不明停下来问。
- 不碰既有资源;只改本次创建 id;清理按 id 逆序。
- 不重启、不杀进程、不换生产 home、不启第二个写者。
- 插件不得绕过治理面直写 PLC/数据库;凭据只进 secretRef/env,不进对话与配置文件。
- 数据类型超出 scalar/vector/image 时,不假装插件能解决。

## 验收清单

- [ ] `preflight.mjs --json` 已记录;生产实例处于附加模式,无任何停止/重启动作
- [ ] 蓝图逐点有来源(文档/设备 export/用户确认),缺项已问
- [ ] 能力匹配表完成:内置/插件/不支持三分类清楚
- [ ] 连通性预检全绿(失败项已修正并重跑)
- [ ] 模拟端点下每个节点都有真实样本;`verify-mirror` 全绿(scalar/vector/image 按形态)
- [ ] 导出值/行数/时间戳/标签/objectKey 五项核对通过
- [ ] 插件(如有)已热加载且 `aw_plugin_list` 无 failures;未重启生产进程
- [ ] 割接六步有记录;真实端点只改 `driverConfig`,节点/配方/限界未重建
- [ ] 收尾只清理本次创建的 id;交接记录含节点 id/窗口/期望值/证据路径
