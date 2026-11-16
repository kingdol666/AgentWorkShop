# 产线文档 → Skill 节点/Channel → 受治理控制优化（模拟验收，2026-11-16）

> 日期：2026-11-16
> 被测源码：`main` @ `24fde131`（v0.11.3 源码快照，未发布）
> 环境：隔离 `AW_MODE=home` + 全新 `AW_HOME=D:/tmp/aw-line-demo-20261116/home`；
> 平台 `:3998`；模拟器独立影子树 `:4052`（未连接共享 `4010` / 他人影子）；
> 五协议模拟器（Modbus TCP/RTU、MQTT、OPC UA、HTTP）；执行模型默认 mock harness。
> 边界：**全部设备为模拟协议栈**。本文是模拟器验收，不是物理 HIL、不是真实 PLC/产线投用批准；
> Mimosa 本轮未取得完整扫描结论，不宣称安全通过。

---

## 0. 结论

按 `aw-doc-to-project` / `aw-plc-sim-twin` / `aw-line-onboarding` 的步骤，用仓库内产线工况文档
（`WC-INJ-2026-1115`，测试夹具口径）完成了一次可复跑的模拟产线接入与控制优化：

- 模拟孪生 **6 设备 / 19 信号 / 五协议**，tick 活性 6/6；
- 平台供给 **20/20**：1 线、5 DCW、9 DAQ、1 配方（5 参数）、批次开跑；
- 频道锻造 **15/15**：`production_line_integrated`、4 成员、9 条绑定、种子任务已派发；
- 接入验收 V1–V6 **25/25**；V6 受保护线 journal 基线非空（1 条），验收后新增 0；
- 一键 onboard + smoke **7/7**：52→54 MPa，HITL 批准、整批下发、设备回读证实；
- 追加一步受治理优化 **54→56 MPa**：HITL 批准，ACK `readback-verified`，克重
  31.618→31.715 g（正向响应）；
- 数据获取覆盖全部五协议；向量帧 raw 48 点经平台模板归一化为 **64 点**；
- 代码/文档门禁全部通过（详见 §5）。

**同时明确未完成项**：克重尚未进入 32.15–32.85 g 目标窗（两步 +4 MPa 只到 31.71 g）；
Channel 的种子任务仍为 `WAITING`，lead 拆出的两个分析/知识子任务为 `WORKING`，
**自主收口未在本轮窗口内完成**；RAG catalog 因 SSRF 防护不可达；物理 HIL 未验证。

---

## 1. 输入与环境

- 工况文档：`docs/audit/evidence/2026-11-15-doc-to-simulated-plc/work-condition-doc.md`
- 蓝图：`docs/audit/evidence/2026-11-15-doc-to-simulated-plc/blueprint.json`
  （本次复制到 `blueprint-4052.json`，仅改 `simPort=4052`）
- 接入配置：`onboard.json`（14 个平台节点的 `driverConfig` 全部来自模拟器
  `GET /api/nodes/:id/export`，治理量程/步长来自文档）
- 平台：`node .output/server/index.mjs`，`AW_MODE=home`、`AW_HOME` 全新目录、
  `PORT=3998`、`NUXT_SESSION_PASSWORD` ≥32 字符、`BACKUP_DISABLED=1`
- 模拟器：`scripts/onboarding/sim-twin.mjs --blueprint ... --sim-port 4052 --shadow ...`
  （未使用 `--restart`；进程命令行确认属于本次 disposable shadow 后才停止）

落袋 id：

```text
line      ln-bf6e8242
product   pd-92a30ff7
recipe    rc-d83ee180
channel   f8583d6a-4a37-4507-aaf4-b085857a7702 (production_line_integrated, 4 members)
dcw       保压压力SP dw-4976345a · 保压时间SP dw-8ad75824 · 料温SP dw-8a3e07fa
          冷却流量SP dw-94ebed0e · 保压压力SP（复检） dw-1893b6a0
daq       熔体压力 dn-2d350de0 · 制品克重 dn-ae0a3103 · 模温 dn-f51f17a8
          缺陷率 dn-5ed45f8d · 视觉置信度 dn-073c61ce · 平均壁厚 dn-4bae51c6
          飞边 dn-be59d8a4 · 节拍 dn-15eea8e8 · 厚度轮廓 dn-dfea5e1e
```

---

## 2. 分阶段结果

### 2.1 模拟孪生（`sim-twin.log`）

- **7 PASS / 0 FAIL**；6 设备、19 信号、五协议；
- MQTT 使用影子私有 broker `:60830`；HTTP 指向 `:4052`；OPC UA `:37548`；
- 每设备 `export` 均返回真实 `driverConfig`，平台侧零手抄寄存器；
- 证据：`evidence/2026-11-16-line-integration-skill-demo/sim-twin.log`

### 2.2 产线供给（`onboard.log`）

- **20 PASS / 0 FAIL**；线 `ln-bf6e8242`、产品 `pd-92a30ff7`、配方 `rc-d83ee180`；
- 5 DCW + 9 DAQ；stepLimit 2 / 0.5 / 3 / 1 / 2；批次 `rr-a7c56c06` 开跑；
- 采集总控启动 `running=true interval=5000ms`。

### 2.3 频道锻造（`onboard.log`）

- **15 PASS / 0 FAIL**；Channel `f8583d6a…`，`channelMode=production_line_integrated`；
- 4 成员、9 条绑定（lead recipe manual；worker DAQ auto；worker DCW manual）；
- 线域授权覆盖 owner+members；种子任务 `caf7330d…` 已派发。

### 2.4 接入验收 V1–V6（`onboard.log`）

- **25 PASS / 0 FAIL**；
- V1：9 个 DAQ 均有真实样本/帧；
- V2：5 个 DCW 越界写全部被拒；
- V3：5 个 DCW 合法写 + 回读一致；
- V4：配方 5 参数映射正确；
- V5：绑线/4 成员/插件隔离；
- V6：`受保护线存在=true->true 本线锚点=10 受保护线新增=0 基线=1`
  （受保护线 `ln-d7e0a2a2` 的 1 条 mock journal 锚点保持不动）。此历史结果仅说明所核对的 journal 无新增锚点，不证明设备物理零扰动，也不验证当前未合并源码。

### 2.5 受治理控制优化（`onboard.log` + `control-step2.json`）

| 步 | 保压压力 | 通道 | 证据 |
|---|---|---|---|
| 配方启动 | 50 MPa | `rr-a7c56c06` | journal `null->50` |
| V3 合法探针 | 52 MPa | manual | journal `50->52` |
| smoke（自动 HITL） | 54 MPa | `rr-deeb989e` / `ap-ee9dd36a` | ACK verified，克重约 31.46 g |
| 第二步（人工批准） | 56 MPa | `rr-d3ff442a` / `ap-2e799660` | ACK `readback-verified`，克重 31.618→31.715 g |

- 第二步提案：`recipe_propose` 携带 `+2 MPa`、依据为“克重低于目标窗口”；
- 第一次尝试被 300s 试验节拍门拒绝（仅差 10s，产线未变更），等待节拍后重提成功——
  这是防连发震荡的预期保护，不是失败；
- journal 锚点 `anc-92485d42`（52→54）与 `anc-ed20dbad`（54→56）均带
  `approvalId` 与 `recipeRunId`，可追溯；
- 克重正向移动但未达目标窗：**控制方向正确，收敛未完成**。

### 2.6 数据获取与下发参数

五协议 DAQ 覆盖（`daq-coverage.json`，2026-11-16 13:27 窗口）：

| 节点 | driver | 最近值 |
|---|---|---|
| 熔体压力PV | modbus-tcp | 55.35 MPa |
| 制品克重PV | modbus-tcp | 31.77 g |
| 模具温度PV | modbus-rtu | 57.36 ℃ |
| 缺陷率PV | mqtt | 0.403 % |
| 视觉置信度PV | mqtt | 95.95 % |
| 平均壁厚PV | opcua | 0.5202 mm |
| 飞边PV | http | 0.196 % |
| 节拍PV | http | 21.7 s |
| 厚度轮廓PV（向量） | http | 帧 64 点 |

- DCW 回读：保压 56 MPa、保压时间 3.5 s、料温 208 ℃、冷却流量 15 L/min；
  HTTP 复检点按设计“仅观测型通道，不支持读取”（`dcw-reads.json`）；
- 向量契约：模拟器 raw 48 点，平台 `daq-thickness-scan` 归一化后 **64 点**
  （`vector-frames.json` 中 `meta.points` 64 点）——交接必须同时记录 raw/normalized，
  不能把 48 与 64 当成数据错误；
- HITL 记录与 journal 均可在报告后回读（`hitl-history.json`、`journal-line.json`）。

---

## 3. Channel 自主作业观察（未完成项）

- 种子任务 `caf7330d…` 状态 `WAITING`；
- lead 拆出的两个子任务（“数据分析…”“知识调优…”）状态 `WORKING`；
- 本窗口内未观察到项目/任务收口；控制优化是通过 skill 的
  `recipe_propose` + HITL 受治理路径完成，不是 Channel 自主收口；
- 这与既有观察一致：新频道 seed task 存在冷启动延迟。验收清单不应把“已派发”
  当成“已执行”；需要观察明确终态，必要时用 Channel 消息 fallback 单独取证。

---

## 4. 边界与未覆盖

| 项 | 状态 |
|---|---|
| 物理 HIL / 真实 PLC 电气安全、急停、寄存器量纲 | **未验证** |
| 目标窗收敛（32.15–32.85 g） | 未达到；两步 +4 MPa 到 31.71 g |
| Channel 自主完成 seed task | 未完成（WAITING/WORKING） |
| RAG catalog | `rag-bridge` 目标被 SSRF 防护拒绝（私网/环回），能力未实测 |
| Mimosa 完整扫描 | 未完成（`scanner_enobufs`），不宣称安全通过 |
| npm / GitHub Release | 本轮未发布、未打 tag；v0.11.3 仅为源码版本 |

---

## 5. 门禁（本轮落盘）

| 门禁 | 结果 | 证据 |
|---|---|---|
| `pnpm build` | PASS | `gates/build.log` |
| `pnpm lint` | PASS | `gates/lint.log` |
| `pnpm typecheck` | PASS | `gates/typecheck.log` |
| `pnpm docs:check` | 101/0 | `gates/docs.log` |
| `pnpm readme:lint` | PASS | `gates/readme.log` |
| `pnpm test:skills` | 176/0 | `gates/skills.log` |
| `pnpm test:unit` | 1787/1787（58 suites） | `gates/unit.log` |
| `pnpm test:mcp` | 14/14 | `gates/mcp.log` |
| plugin lifecycle | 22/22 | `gates/plugin.log` |
| SDK surface | PASS | `gates/sdk.log` |
| twin provider | 5/5 | `gates/twin.log` |
| VitePress build | PASS | `gates/vitepress.log` |

本轮 onboarding：sim-twin 7/7、provision 20/20、forge 15/15、verify 25/25、
onboard+smoke 7/7、额外受治理步 1/1（含节拍重试）。

---

## 6. 复现

```bash
# 1) 隔离平台（生产构建）
AW_MODE=home AW_HOME=<fresh> PORT=3998 NUXT_SESSION_PASSWORD=<≥32字符> \
  BACKUP_DISABLED=1 node .output/server/index.mjs

# 2) 模拟孪生（独立影子，勿用 --restart 盲杀）
node scripts/onboarding/sim-twin.mjs \
  --blueprint docs/audit/evidence/2026-11-16-line-integration-skill-demo/blueprint-4052.json \
  --sim-port 4052 --shadow <fresh-shadow>

# 3) 按 export 生成接入配置后一键接入（V2/V3 仅限隔离模拟线）
AW_BASE=http://127.0.0.1:3998 AW_TOKEN=<token> \
  node scripts/onboarding/onboard.mjs <onboard.json> --skip-connectivity --smoke
```

> 结论只适用于本次模拟协议栈与本次 commit；真实产线须另走停线、维护窗口、
> 只读浸泡、人工批准最小步首验与三方回读，不得把本报告当作物理 HIL 或投用批准。

---

## 7. 内置模拟器随仓库复跑（2026-11-16）

模拟器已从 git submodule 改为主仓库内的普通目录 `plc-node-simulator/`，并加入
pnpm workspace：普通 clone 即包含源码，根 `pnpm install` 会安装其依赖。其许可为
PolyForm Noncommercial 1.0.0，独立于平台 Apache-2.0（见 `plc-node-simulator/LICENSE`）。

为验证迁移后 skill 仍可执行，另起一套全新隔离环境复跑：

- 平台 `:3999`、模拟器 `:4054`、全新 `AW_HOME`，源码来自仓库内 `plc-node-simulator/`；
- sim-twin **7/7**；供给 **20/20**；频道锻造 **15/15**；V1–V6 **25/25**；
- onboard + smoke **7/7**：52→54 MPa，HITL 批准、设备证实，`rr-87a89bae`；
- DAQ 五协议均有样本；DCW 回读 54 / 3.5 / 208 / 15；向量帧 normalized **64** 点；
- Channel `ee0f06d8…` 为 `production_line_integrated`；seed task 仍 `WAITING`，
  lead 子任务 `WORKING`（冷启动未自主收口）。

迁移同时修复了影子启动器的一个 pnpm 兼容问题：影子 `node_modules` 不再整目录
junction（相对链接会在影子路径下断链），改为逐项指向真实路径的绝对 junction，
并用仓库根解析出的 tsx loader 绝对 URL 以单进程方式启动（监听 PID = 启动 PID，
满足影子归属校验）。证据见
`docs/audit/evidence/2026-11-16-line-integration-skill-demo/vendored-rerun/`。

边界与 §4 相同：全部为模拟器证据，不是物理 HIL；本轮未发布 npm/GitHub Release。
