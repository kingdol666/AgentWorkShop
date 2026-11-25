# 全仓稳定性审查与实机验收报告（2026-11-25）

> 基线：`main` 合并至 `6dc67c53`（PR #297 / #298 / #299 / #300 已合并；#297 `181a46a3`、#298 `4af4c348`、#299 `6518b36e`、#300 `6dc67c53`）。
> 本报告只记录**本轮真实执行**过的命令与观察结果；受限项在 §5 如实标注，不以静态检查替代。

## 1. 审查范围与修复

| PR | 提交 | 主题 | 证据 |
|---|---|---|---|
| #297 | `a8b7c05d` | DAQ 时序库 readiness 门：readiness 对齐真实初始化/降级；在线恢复、离线重试、旧初始化与旧 rollup 竞态；采集 flush 与验收脚本显式等待；Timescale 未初始化写入显式失败、SQLite 直写惰性建表 | 9 个 `tests/tsdb-*` 套件；全量单测 2336 通过 |
| #298 | `feb4d639` | Timescale **必需** schema（表/hypertable/打标列/热路径索引）失败即 init 失败并释放连接池；可选索引与物理策略仅告警 | `tests/timescale-required-schema.test.ts` 14 项，11 个必需步骤逐一断言 reject + pool close + 未标记 initialized；反向突变（恢复 `.catch`）验证测试会变红 |
| #299 | `5df7e271` | CI 补齐：`tests/*.test.mjs`（18 断言）纳入 quick-gate；新增 `build-smoke` 作业（生产构建 + 隔离启动 + 健康/SSR/401/缺密钥拒绝启动） | 首次运行暴露 `omp` 二进制缺失导致 ENOENT → 按“环境不具备即带原因 skip”修正后双绿 |
| #300 | `7deac082` | **实机发现的安全缺陷**：宿主环境变量中的令牌（HF/npm/对象存储密钥）会被 agent 子进程继承并可被 `env` 读取；改为“显式名单 + 名称即秘密规则”，显式 env 在清洗后合并 | `tests/security-b2-secrets.test.ts` 新增泄漏场景断言；突变验证会变红 |

门禁（本地，与 CI 同源）：`typecheck` 通过；`lint` 通过；全量 `test:unit` 2350 通过 / 0 失败 / 1 skip（一次 `http-drivers` libuv 收尾断言为环境瞬态，单独 10/10 通过、复跑全绿）；`i18n:check` 3496/3496；`check:cssvars` 通过；`build-smoke` 本地 6/6×2。

## 2. 实机验收环境

- 候选产物：从提交 `a8b7c05d` 的 **独立 worktree** 构建（`git worktree add --detach`，独立 `node_modules`、独立 `AW_HOME`、端口 3061），不覆盖主工作树正在服务的 `.output`。
- PLC 模拟工况：`plc-node-simulator` 影子树 `--sim-port 4027`（Modbus TCP 37542 / MQTT 35830），归属证明由 `sim-attest` nonce 链成立（`--spawn`），未触碰共享 4010。
- 产线：`ln-cca0c356`（注塑验收线-20261125，simulated=true），写控 `dw-4051b181 机筒温度SP`（150–200℃，stepLimit 5，hold 120s），数采 `dn-442b6100 熔体温度PV`（Modbus TCP 40003，2s），配方 `rc-629684b2`，频道 `3ce41f3b-157b-440b-bb63-3e4edd978bd8`。
- 接入流程：`scripts/onboarding/onboard.mjs`（供给 → 锻造 → V1–V6），**8 通过 / 0 失败**；V6 因未预置受保护线夹具而如实 SKIP（不计入通过）。

## 3. 验收结果

### 3.1 REST 全链（`scripts/api-live-e2e.mjs`）

- **73/73 PASS**（候选产物、持久化管理员 token）。覆盖：channel/agent CRUD、goal 真实交付物收口、loop/pipeline、dispatch/report/complete 状态机、跨频道 403 `SCOPE_VIOLATION`、A2A/mailbox/消息历史、WS 广播、MCP initialize/tools、级联删除。
- 持久化恢复项在首次运行（无历史 channel）按项目语义 SKIP，未伪造通过。

### 3.2 DAQ readiness（本 PR 核心）

写路径（Timescale 后端，`daq-readiness.json`）：**17/17 PASS** —— 启动采集 → 建节点 → 两次 ingest（200）→ `samplesStored` 0→2 且增量恰等于摄入条数（无幽灵计数）→ 15s 桶回读 `cnt=2`、区间覆盖 42.5/43.5 → 停止与清理。
降级路径（不可达 `DAQ_TSDB_URL`，`fallback-path-evidence.txt`）：`/api/workshop/daq` 仍 **200** 且 `meta.tsdb=sqlite-emulated`（readiness 覆盖 fallback 初始化）；infra 如实 `degraded=true`；总控按设计拒绝启动 `DAQ_INFRA_DEGRADED` —— **fail-closed 未被修复削弱**。

### 3.3 AgentPrefab 生命周期与单一绑定（`prefab-binding.json`）

**15/15 PASS**：草稿 → 发布 revision 1 → 绑定真实 worker（rev 1）→ 重复绑定 409 `PREFAB_ALREADY_BOUND` → 过期编辑 409 `PREFAB_EDIT_CONFLICT` → 发布 rev 2 后成员仍固定 rev 1 → 错误 `expectedBindingVersion` 解绑 409 `PREFAB_BINDING_CHANGED` → 正确版本解绑 200 → 归档 200（保留历史）→ 归档后新绑定 409 `PREFAB_ARCHIVED` → revision 1/2 仍可读。

### 3.4 真实作业（omp + 真实通道 + 真实数采）

`ecaaf705`（goal 模式，熔体温度巡检）：SUBMITTED →（约 210s 冷启动）WORKING 45% → COMPLETED 100%，交付物 `deliverable`（`task-final.json`）。交付内容为数据实证：21 个 15s 桶均值 **184.96℃**、桶内极值 184.0–185.7℃、越限 **0/21**、相对 PLC 设定 SP=185℃ 偏差 **−0.04℃**；过程记录分析师 4 次只读 `daq_query` + 组长独立复核一致。

### 3.5 UI 实机走查与截图

- 登录（真实 `x-aw-browser` 会话）+ 8 个主界面：7 个 **0 console error**；`/workshop` 出现一条 `Hydration completed but contains mismatches`，在既有 main 构建实例（:3011）**同现**，判定为既有问题、非本批引入（列入 §5 待办）。
- 场景截图（1600×1000）：`daq-live-real-data.jpg`（熔体温度PV 185.1℃、produced 355/consumed 355/dropped 0/stored 354、批次 rr-f962ab31 运行中，并可见 205℃ 越上限与 60s 频控两条治理拒绝留痕）、`channel-console.jpg`、`settings-prefabs.jpg`、`dashboard.jpg`、`daq-empty-start.jpg`、`town-scene.jpg`。

## 4. 安全扫描（Mimosa）

本轮多次 deep scan 均**封印完成但覆盖不完整**：`completeness=partial`、`runStatus=inconclusive`（最新封印 `sha256:3a4f5604…`，findings 43，303 包离线 advisory 0）。按纪律**不报告为“安全通过”**。人工抽查的高危命中为仓库内实验/论文脚本、i18n 字段名、带 proof-gap 的跨文件静态污点提示；`server/` 侧抽样路径（A2A Zod、Skills `isInside`、参数化 SQL、Python 子进程 `shell:false`）未发现可利用注入。

## 5. 未完成 / 受限（不宣称）

1. **桌面端实机**：本机与两棵依赖树均无 Electron 运行时二进制，环境钩子阻止经 Bash 触发其安装脚本；本批未改动 `desktop/`，桌面实机验收记为受限，需在具备 Electron 的环境补验。
2. **Mimosa 完整覆盖**：仍为 inconclusive（见 §4）。
3. **V6 受保护线夹具**：未预置，按 SKIP 处理。
4. **`/workshop` hydration mismatch**：既有问题，未在本批修复。
5. **进程 guard 语义**（`uncaughtException` 是否一律退进程）：审查后**有意不改**——现有分级为可用性加固（设备断连/引擎边界不拖垮平台），改为一律退出可能引入崩溃循环；需单独设计窗口验证，不在本批冒险改动。
6. **测试告警数据**：DAQ 验收两次 ingest（42.5℃）在 `temp-tc` 告警带下产生 2 条未确认报警（节点已删除），属测试残留事件，非产品缺陷。

## 6. 实机验收发现的安全缺陷（已修复，需运维轮换）

**现象**：真实 omp 任务过程中，agent 的 `bash` 工具执行 `env`，回读到宿主进程环境里的 `HUGGINGFACEHUB_API_TOKEN`、`NPM_TOKEN` 与 `AW_DAQ_OBJECTSTORE_SECRETKEY`（`task-final.json` 中相应值已脱敏为 `<REDACTED>`）。

**根因**：`scrubPlatformSecrets` 只按固定名单剥离平台会话/管理员/隧道变量；引擎子进程仍继承宿主导出的其它令牌，agent 的 shell 工具因此可直接读取。

**修复**（PR #300）：在显式名单之外增加“名称即秘密”规则（`*_TOKEN`、`*_SECRET`、`*_PASSWORD`、`*_API_KEY`、`*_ACCESS_KEY` 等后缀与 `HUGGINGFACE|HF_|NPM_|GITHUB_|AWS_|OPENAI_|ANTHROPIC_|AZURE_` 等前缀；`AW_ENGINE_*` 保留为引擎显式透传）；omp 与逐行 spawn 均改为“先清洗 `process.env`、再合并显式 `options.env`”，保证引擎所需 provider key 不被误剥。回归测试覆盖该泄漏场景并含突变验证。

**处理记录**：原始证据在推送到 GitHub 时被 secret scanning 拒绝；随即在本地将令牌值脱敏、重写提交（未产生远端明文）。**复审补丁（2026-11-25）**：首次脱敏漏掉了 agent `env` 转储中的两处值（`HUGGINGFACEHUB_API_TOKEN`、`ModelScope_API_KEY`），并遗漏了 Claude Agent SDK 子进程仍整份继承 `process.env` 的路径；两处已在后续补丁中修正（证据二次脱敏 + 该 spawn 路径接入同一清洗函数 + `PGPASSWORD`/`MYSQL_PWD` 等名称规则）。Git 历史仍包含脱敏前提交，**相关令牌必须轮换**——代码修复不能使已泄露的凭据恢复安全。
