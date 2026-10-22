# PLC 协议 + 自定义 MES API + aw-line-onboarding skill 验收报告（2026-10-20）

## 0. 结论

本轮按要求先做系统能力基线，再做文档驱动的 skill 作业，全部通过：

| 项目 | 结果 |
|---|---|
| 单元/集成测试 | **253/253 PASS** |
| 系统 MES/DAQ/配方/UI E2E | **25/25 PASS**（`npm run test:mes-agent`） |
| 系统产线治理 E2E | **44/44 PASS**（`npm run test:e2e-line`） |
| 系统产线日志 E2E | **24/24 PASS**（`npm run test:line-log`） |
| PLC/MES 连通预检 | **3/3 PASS** |
| PLC 孪生生成/活性 | **2/2 PASS**，11 信号，tick 活性正常 |
| skill 端到端首次接入 | **6/6 PASS**（连通/供给/频道/V1-V6/冒烟） |
| skill 端到端最终幂等复跑（reviewer 修复后） | **11/11 PASS**（含 4 个 MES 直取节点真实 `mes_fetch` + V1-V6 23/0） |
| skill 规范校验 | **101/101 PASS**（5 个 skill） |
| typecheck / lint / build | 全通过 |

验收对象：隔离实例 `127.0.0.1:3021`（与 3001 同构建），PLC 孪生 Modbus TCP `127.0.0.1:37550`（模拟器 REST `4046`），MES API `127.0.0.1:15062`。未写受保护演示线 `ln-d7e0a2a2`。

## 1. 文档与配置（文档驱动输入）

- 产线控制优化文档：[`docs/onboarding/2026-10-20-coating-line/README.md`](D:/codes/ABO/AgentWorkShop/docs/onboarding/2026-10-20-coating-line/README.md)
  - 产线目标：膜厚 35.0±0.8 µm、横向均匀性 ≤2.5 µm、张力 100~200 N 前提下提升线速。
  - Modbus TCP 11 点寄存器表（4 SP + 7 PV），host/port/unitId/area/dataType/byteOrder/量程/stepLimit 全部显式。
  - 自定义 MES API 四类数据：标量历史、48 点膜厚向量、批次汇总 table、CCD 图像组；含字段字典与分页契约。
  - 验收矩阵 A1-A6、模拟动力学、复现命令、红线。
- 可执行蓝图：[`blueprint.json`](D:/codes/ABO/AgentWorkShop/docs/onboarding/2026-10-20-coating-line/blueprint.json)
- 统一接入配置：[`onboard.json`](D:/codes/ABO/AgentWorkShop/docs/onboarding/2026-10-20-coating-line/onboard.json)
  - 场景 `optimize`；PLC SP 配方；MES 4 节点 `mesFetchGrants` 给数据分析师；HITL manual；种子任务。

意图识别：文档诉求是“在质量窗口内提升产能”，不是只读诊断或边缘微调，因此映射到 `optimize` + `chtpl-generic-optimize-default`（生产主管/数据分析师/知识调优/工艺工程师），配方写绑定给工艺工程师 manual，数据分析师拿 DAQ + MES 只读面。

## 2. 系统能力基线（先于 skill）

### 2.1 端口/协议连通

`test-connection.mjs`：

- 线速SP Modbus TCP 40001 读取 35（首次）/ 45（最终复跑，配方窗口 28~48 内；修复前曾到 49，已由 recipe_propose 配方窗预检拒绝），latency 3-25ms
- 膜厚PV Modbus TCP 40017 读取 35.21/35.86
- MES 熔体温度当前值读取 213.3（首次，旧模拟基线）/ 249.3-251.2（对齐后），latency 8-16ms

结果：**3/3 PASS**。

### 2.2 系统级 E2E

| 套件 | 覆盖 | 结果 |
|---|---|---|
| `npm run test:mes-agent` | Agent recipe_catalog/apply/create、HITL、recipe_log、DAQ 外部数组/图像推送、daq_frames、daq_export、MES 字典/数组/数据集/导出、配方 UI 下发历史 | 25/25 |
| `npm run test:e2e-line` | 开停线 HITL、审批期换线/换批/配方改版 TOCTOU、跨线绑定清理、agent token、DAQ 实采、写控 ACK/步限/60s/量程 | 44/44 |
| `npm run test:line-log` | 产线日志 scope、按产线/配方/时间、Agent ops_log/line_log/recipe_log | 24/24 |

### 2.3 MES 多源异构实测（当前线）

用数据分析师 Agent 调 `mes_fetch`（30 分钟窗）：

- `MES熔体温度`：mean 250.623 ℃，字段字典 `value / ℃ / scalar`。
- `MES膜厚断面`：48 点向量，mean 35.595 µm，range 约 2.19 µm；字段字典含 `profile` + 48 个 `模头点N` 逐点语义；`include_data=true` 返回实际数组。
- `MES批次汇总`：table map 行，逐字段统计（mean_thickness/thickness_sigma/cpk/defect_count）+ 9 个字段字典。
- `MES表面图像`：5 帧自动落盘 PNG，回包只给文件名/大小，字段字典含 data/defects/width/height。

## 3. PLC 孪生与工况一致性

`sim-twin.mjs --blueprint`：

- 设备 `coating-c01`，Modbus TCP，37550，11 信号；**2 PASS / 0 FAIL**；tick 活性 1/1 设备 PV 在动。
- 模拟器 export 的 11 条 driverConfig 与文档寄存器表逐点一致：40001/40003/.../40021，holding/float32/big/unitId=1。
- 因果抽验（写入线速SP 35→37，等待一阶滞后后）：
  - 线速PV 34.9 → 37.0/37.1
  - 膜厚PV 35.158 → 35.043（下降，符合文档负相关）
  - 张力PV 144.4 → 148.1（上升，符合文档正相关）
  - 验证后已恢复 35。
- MES 模拟器使用文档对齐环境变量生成 35 µm 膜厚与 250 ℃ 熔体温度，避免“PLC 35 µm / MES 51 µm”的工况断层。

## 4. skill 端到端结果（aw-line-onboarding）

命令：

```bash
AW_BASE=http://127.0.0.1:3021 AW_TOKEN=<admin> \
node scripts/onboarding/onboard.mjs docs/onboarding/2026-10-20-coating-line/onboard.json --smoke
```

### 4.1 首次接入（目标线不存在 → 自动新建）

- 线：`ln-b3375313`（名称 `流延膜精密产线-C01-20261020`，controlMode=manual）
- 写控节点（4）：`dw-f43a8cba` 线速SP、`dw-c19b22f4` 熔体温度SP、`dw-53be851e` 模头压力SP、`dw-15fed08d` 冷却辊温度SP
- 数采节点（7）：`dn-a4bd132e` 线速PV、`dn-721b938b` 熔体温度PV、`dn-2d19df63` 模头压力PV、`dn-beb59b08` 冷却辊温度PV、`dn-65a0c8dc` 膜厚PV、`dn-6f03fcc4` 膜厚横向均匀性PV、`dn-8a73863c` 膜张力PV
- MES 直取节点（4）：`dw-351e9906` 熔体温度、`dw-8642a554` 膜厚断面、`dw-f0f5435b` 批次汇总、`dw-9dd93bbb` 表面图像
- 主配方（4 SP）：`rc-eb814287` v1，参数窗口 28~48/235~265/55~80/22~34，stepLimit 2/3/3/2
- MES 授权配方：`rc-9f747d63`（4 点，绑定数据分析师 `46cbced7...` manual）
- Channel：`cbf7ab1b-d732-4e64-a687-404cd5eaa6d7`，场景 optimize，4 成员，插件仅 `idd-closedloop-bridge` / `rag-bridge` enabled（其余 9 项显式关闭），种子任务 `7c697b25-3701-49b0-b092-57a52ba3f0be`
- 配方绑定：工艺工程师 `6ccb3e15...` → `rc-eb814287` manual
- V1-V6（首次）：**21 断言 0 失败**；最终复跑在 reviewer 修复后为 **23/0**（V3 逐点 readback 与 probe 一致、V4 4 项配方参数逐项一致、V5 插件隔离、V6 受保护线写锚点 0）
- 冒烟：`recipe_propose` 自动 HITL 批准 → 整批下发 → **1/1 设备证实**，最终 runId `rr-0b32b3bd`（冒烟目标 45，配方窗口 28~48；首次 `rr-4e0c95b6`）

### 4.2 幂等复跑（skill 脚本修复后）

- 线/节点/配方/频道全部复用（`reused:true`），开跑返回“已运行复用”，不重复派发种子任务。
- 新增阶段 3b：4 个 MES 直取节点逐个真实 `mes_fetch`，断言 **rows>0 + 格式（标量/向量 dim=48/表格/图像）+ 字段字典**，全部 PASS（rows=20/20/1/20）。
- V1-V6 再次 **23/0**；冒烟再次批准并设备证实，最终 runId `rr-0b32b3bd`。
- 汇总：**11 通过 / 0 失败**。

## 5. 本轮发现并修复的问题

| # | 问题 | 根因 | 修复 |
|---|---|---|---|
| 1 | `test-connection.mjs` 直接传统一配置时 0 通过/0 失败，静默“全绿” | 只读顶层 `cfg.tests`，不读 `connectivity.tests`；空集合不失败 | 支持两种形状；空测试集显式 ❌ 并退出 1（`scripts/onboarding/test-connection.mjs:18-23`） |
| 2 | `onboard.mjs` 的 verify 插件推导依赖 `Array.prototype.filter.call`，falsy 插件也会被算入 | 表达式错误 | 改为 `Object.entries(...).filter(([,v])=>v===true).map(...)`（`scripts/onboarding/onboard.mjs:164`） |
| 3 | 历史-only MES 节点没有进入 V1-V6，skill 可能“节点建了但 Agent 取不到数” | V1 只覆盖 DAQ；MES 直取不在 V1 | `onboard` 新增阶段 3b：对 `mesFetchGrants` 每个节点真实 `mes_fetch`（`onboard.mjs:119`）；skill 验收段同步说明 |
| 4 | 幂等复跑时“开跑批次”把正常的 CONFLICT 显示成错误文案 | `ok` 把 message 原样展示 | 区分“已运行复用”，明确批次保持运行（`provision-line.mjs:176`） |
| 5 | skill 文档代码围栏写成 ` ```bashnode ... `，命令不可复制 | 文档格式缺陷 | 改为合法 bash 代码块（两份 SKILL.md 同步） |
| 6 | MES 模拟器默认 50 µm/212 ℃ 与本线文档 35 µm/250 ℃ 不一致 | 模拟器固定基线 | 新增环境参数 `MES_THICKNESS_BASE/CENTER/TOL/SHAPE_SCALE`、`MES_MELT_TEMP_BASE`、`MES_MELT_PRESSURE_BASE`、`MES_LINE_SPEED_BASE`；默认值不变，本线显式对齐（`scripts/dev-mes-simulator.mjs:50-54,101-105`） |
| 7 | **空 MES 窗口导致取数崩溃**：`buf[0]` 未定义时读 `.ts`，10 分钟批次窗复现 | vector/image/table/scalar 四处采样下标在空数组时生成 `[0,-1]` | 四处采样下标加 `buf.length > 0` 守卫；新增 scalar/vector/table/image 空窗单测（`mes-controller.ts:585-590,606-612,617-620,656-657`；`tests/mes-datasets.test.ts`） |
| 8 | **阶段 3b 是假阳性**：`行数 0` 也通过，且不验格式/字典/维度 | 断言只匹配 `行数 \\d+` | 改为 `rows>0` + 标量/向量 dim/表格/图像格式 + `字段字典(n 个字段)`；向量追加 `include_data` 断言 `values=[`（`onboard.mjs:119-160`） |
| 9 | **V3 只报 outcome 不比对回读**；V3 探针可能越配方窗口（当前值在上沿时 47+2>48） | 探针只夹节点量程，未夹活动配方窗口；未比 readback | 探针夹「节点量程 ∩ 配方窗口」并优先向窗内走；写后要求 `readback` 数值与 probe 一致；60s/保持窗最多重试 3 次（`verify-line.mjs:42-77`） |
| 10 | **V2 把超时/网络错误也当量程拒绝**；V4 只验配方 id 存在 | 正则含泛化 `超`；V4 未比对参数 | V2 要求 `NODE_RANGE_EXCEEDED`/量程语义且排除超时；V4 逐项比对 nodeId/value/min/max/stepLimit（`verify-line.mjs:43-47,79-91`） |
| 11 | **冒烟自动批准可能批到其他 Agent 的审批单** | 按“最新 recipe-propose 卡”选取；使用 `emergency:true` 绕过频控 | 记录 invoke 前既有卡，只批准“新增 + detail 含 SM-冒烟步”的卡；移除 emergency；在飞单也校验 detail（`onboard.mjs:203-245`） |
| 12 | **Channel 插件隔离未生效**：未配置插件默认启用（live 11 个） | forge 只 PUT true 项，服务端缺省 true | forge 先 GET 全部注册插件，再全量 PUT：仅配置项 true，其余显式 false；V5 增加“未配置插件不得启用”断言（`forge-channel.mjs:63-73`；`verify-line.mjs:97-104`） |
| 13 | 幂等复用只对齐 min/max/stepLimit，寄存器/hold/配方漂移不收敛 | 复用分支只比较三项 | 复用节点对齐 unit/decimals/warn/interval/hold/driverConfig；复用配方逐项比对并 PATCH 参数（`provision-line.mjs:93-140,162-180`） |
| 14 | MES batch/image 无游标，长窗截断；文档称所有历史都分页 | 模拟器未返回 nextCursor | batch/image 增加 `pageSlice` + `nextCursor`；配置补 `nextCursorPath`；文档改为准确描述 |
| 15 | **冒烟/提案可越当前配方窗口**：线速 47→49，而配方上限 48；`recipe_propose` 预检用 `skipRecipe:true` 绕过了配方窗口 | 预检只做量程∩参数∩产品；执行路径沿用 recipe 语义 | `recipe_propose` 预检改为 `skipRecipe:false`（当前活动配方窗口参与）；新增单测「越窗候选在挂审批前拒绝」；`onboard` 冒烟目标夹到配方窗口并新增“冒烟目标在配方窗口内”断言；live 越窗 49 被拒（`recipe-window-guard.log`） |
| 16 | 阶段 3b 对向量维度/图像产物仍是弱断言（任意 dim、通用“产物清单”字样可通过） | 正则过宽 | 向量按 `mesFetchGrants.expectedPoints=48` 精确比对 `dim=48`；图像要求实际 `产物(n...):` 且有帧文件；最终 onboard 4 节点全部通过 |
| 17 | 冒烟卡片仅按 `SM-冒烟步` 子串匹配，仍可能命中并发同名卡 | 未绑定 attempt | 使用本轮精确 `SM-冒烟步(<attempt>)` 标记匹配新增卡与在飞卡 |

## 6. 未覆盖/边界（如实声明）

- 本轮使用 **PLC Modbus TCP 孪生模拟器**，不是真实 PLC；真实设备割接仍需按 skill 阶段 7 做“真实 driverConfig 预检 → 只读浸泡 ≥30min → 单点最小步三方对照 → 全节点 PATCH → V1-V6 重跑”。
- MES API 为本地模拟器实现，验证的是平台映射/字段字典/分页/导出链路；真实 MES 需替换 baseUrl/secretRef 并按真实响应调整 `dictionaryPath`。
- skill 的种子任务只完成“创建并派发”，未等待 omp Agent 自主执行完整个优化 goal；本轮 recipe 控制由 onboard 冒烟步（真实 HITL + recipe_propose + applyRecipe）验证。实际投产仍需产线负责人 judge & taste。
- 受保护演示线未写入；测试只落新线 `ln-b3375313`。V6 在隔离实例 3021 上没有受保护线可对照，其“0 溢出”是隔离结构性成立；共享 3001 的受保护线本轮未执行任何写入，不能把 V6 当作 3001 的实证。

## 7. 复现与证据

- 系统测试命令：`npm run test:unit`、`npm run test:mes-agent`、`npm run test:e2e-line`、`npm run test:line-log`
- skill 测试命令：`node scripts/test-aw-skills.mjs`；`AW_BASE=... AW_TOKEN=... node scripts/onboarding/onboard.mjs docs/onboarding/2026-10-20-coating-line/onboard.json --smoke`
- 本报告证据日志（已随仓库提交）：`docs/audit/2026-10-20-plc-mes-skill-evidence/`
  - `unit.log`（253/253）、`mes-agent.log`（25/25）、`e2e-line.log`（44/44）、`line-log.log`（24/24）
  - `skill-validate.log`（101/101）、`sim-twin.log`（2/2）、`onboard-final.log`（11/0）
  - `verify-v1-v6.log`（23/0，含 V3 readback/V4 映射/V5 隔离）、`recipe-window-guard.log`（越窗 49 被拒）、`connectivity.log`、`connectivity-empty-guard.log`（exit=1）、`typecheck.log`、`build.log`
- 提交：`b4cf76b7`（报告回填 `aa4b41b6`；分支 `tii-revision-20261017`，已推送 GitHub）
