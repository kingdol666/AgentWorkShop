# AW-IndustrialBench · 可执行测试流水线（Pipeline）

> **本文是执行合同**：任何 Agent / 人类**只读本文**，按 §0 执行卡的命令顺序逐条执行，即可对
> AgentWorkShop 完成一次**真实跑通**的可复现能力评测，产出 **MD + HTML** 评分报告（`bench/results/<runId>/`）。
> 规范背景见 `bench/README.md`（场景/任务/故障/指标定义），实验总策划见 `docs/experiments/01-test-and-benchmark-master-plan.md`。
>
> **三条铁律（先读）**
> 1. 一切结论必须来自**真实启动的服务与真实执行的命令**；任何一步不满足判据 → **停止并如实报告原因**，禁止伪造通过、禁止"平均一下还行"、禁止用脚本绕过本卡的检查点。
> 2. 环境不具备时（实例不可达、端口被占、缺依赖）→ 按 §1.6 的失败语义**诚实 skip 并写明原因**，skip 不计分也不算失败；伪造通过 = 全部作废。
> 3. 本卡所有命令都在**仓库根目录**执行；端口一旦选定，**所有后续命令都用同一个端口**（§1.2）。

---

## 0. 执行卡（把这一段整段派发给任意 Agent 即可）

```text
你是测试执行 Agent。严格按以下步骤顺序执行，每一步都有"命令 / 预期 / 判据"。
不要改写命令，不要跳过判据，不要因为某步耗时较长就中断它（每步都标注了预期耗时）。

────────────────────────────────────────────────────────────────
第 0 步 · 环境与一次性准备（首次约 1–3 分钟，之后跳过）
────────────────────────────────────────────────────────────────
  判据: node -v           → v20 或更高
  命令: pnpm install && pnpm build       # 平台产物 .output/；bin/aw.mjs start 需要它
  命令: git submodule update --init plc-node-simulator && \
        cd plc-node-simulator && npm install && cd -   # PLC 模拟器以子模块随仓分发；
                                                       # 旧布局（同级检出 ../plc-node-simulator）同样受支持
  环境变量（每个新 shell 都要重设，本机 7890 类代理会拦截 localhost）:
    export NO_PROXY=127.0.0.1,localhost no_proxy=127.0.0.1,localhost
  Windows Git Bash 注意: 杀进程用 taskkill //PID <pid> //F；
  不要用「& 后台作业」长挂服务——Agent 回合结束/作业被回收时服务会一起死（§1.6）。

────────────────────────────────────────────────────────────────
第 1 步 · 选定端口并验证「服务身份」（约 10 秒，必做）
────────────────────────────────────────────────────────────────
  默认端口 3001，但它可能被别的项目占用。对候选端口逐个探测并分类：
    curl --noproxy '*' -s --max-time 5 http://127.0.0.1:<候选>/api/users/setup-status
  分类规则（按 body 判，不看状态码）:
    · 200 且 body 是 AgentWorkShop 形状 {"code":0,...,"data":{"needsSetup":...}}
        → 该端口上有一个健康的 AW 实例，可直接复用（跳过第 2 步的启动）。
    · 连接拒绝 / 超时
        → 端口空闲，可用于冷启动（第 2 步方式 A 会在这里把平台拉起来）。
    · 200 但 body 形状不同（如 {"detail":"Not Found"}）、或非 JSON
        → 被别的服务冒名占用，换下一个候选端口。
        ⚠️ bench 的在线探针只认「HTTP 200 + JSON」，分辨不出冒名者，这一步必须人工判。
  候选端口顺序: 3001 → 3005 → 3010 → 3050 → 3060（避开 3000/3001/3002）。
  二次确认（可选）: AgentWorkShop 的 /api/health 会返回 "app":"AgentWorkShop"。

  选定 P 后，本 shell 里固化一次，后面所有命令都会读它:
    export AW_BASE=http://127.0.0.1:P

  ⚠️ 端口被冒名占用的两个后果（这就是为什么要做本步）:
    · 流水线把假服务当平台，后续全部报错且原因难懂；
    · 若占用者恰好也是 AgentWorkShop，评测会打到别人的实例上，证据不可信。

────────────────────────────────────────────────────────────────
第 2 步 · 启动被测系统（推荐方式 A：单命令自举）
────────────────────────────────────────────────────────────────
  方式 A（推荐）: 什么都不手动起，直接执行第 4 步的第 1 条命令——
    流水线的 P0 会自动探测并【分离启动】模拟器(:4010)与平台($AW_BASE)，
    任一自举失败 → 整体 FAIL，不会部分通过。分离启动的服务在 Agent 回合结束后仍存活。

  方式 B（需要手动起服务时，例如要单独重启平台）:
    平台:   node scripts/_audit/detached-start.mjs --port P --log ../aw-bench.log --wait 90
    模拟器: cd ../plc-node-simulator && NO_PROXY=127.0.0.1,localhost npm run dev   # :4010
    ⚠️ 消融层（第 4 步第 5 项）要求平台以 AW_BENCH_MODE=1 启动。该环境变量必须在
    「平台进程启动的那一刻」就存在——用方式 A 时在执行流水线命令的同一 shell 里 export；
    用方式 B 时写在 detached-start 命令行里。平台已在跑但没带这个变量 → 必须重启平台，
    否则消融的 no-interlock 臂会表现得和 full 一模一样（6/6），这是已知的假绿形态。

  就绪判据（两条都必须返回 AgentWorkShop 形状的 JSON）:
    curl --noproxy '*' -s http://127.0.0.1:P/api/users/setup-status
    curl --noproxy '*' -s http://127.0.0.1:4010/api/nodes
  鉴权: 首启实例会自动注册 admin（admin@awshop.local）；已有实例用
    export AW_ADMIN_EMAIL=... AW_ADMIN_PASS=...

────────────────────────────────────────────────────────────────
第 3 步 · 评测套件（按序执行，每项独立判据；任何一项 FAIL → 停）
────────────────────────────────────────────────────────────────
  ① 静态层（约 10 秒）——论文-代码一致性，先于一切动态实验
     node bench/run.mjs --tier static --seed 42
     判据: 退出码 0；s2 论文一致性 = 100%。s2 < 85% → 停止，先修论文/代码失真。
     产物: bench/results/<runId>/report.md + report.html + run.json

  ② 一体化集成流水线（冷启动约 8–11 分钟，勿中断）——全功能主战役
     NO_PROXY=127.0.0.1,localhost AW_BENCH_MODE=1 \
       node bench/pipeline.mjs --profile integrated --seed 42 --cl-seeds 3
     判据: 退出码 0，且 stdout 末行「✅ PASS（pass 71 · fail 0 · 阶段 fail 0）」。
       自举行应出现「模拟器未在线 → 自动启动」「平台未在线 → 分离启动 pid=...」。
     覆盖: 五协议多产线供给 → 数采/数控写+回读 → F5 拦截 → Agent 工具闭环 3 轮收敛 ×4 线 →
       **AgentTeam 优化任务（任务板下达目标→daq_query 时段读数→受治理下发→物理随动→达标收口）** →
       优化记录/回退/参数台账 → HITL 审批 → 治理只读面 → 配方生命周期 → cast-film 闭环寻优
       (3 seeds) → 向量/图像帧 → 跨场景可移植(film-line, 0 代码改动) → 系统兜底 drilling →
       **双拉产线 P10（biax 全线 9 设备五协议 49 信号:探测补建→多节点建线→AgentTeam ≥3 执行节点
       闭环寻优厚度 25.0±0.7μm）** → 团队调度/团队记忆/引擎注册表。
     可选真引擎: 同命令加 `--agent omp`（或 opencode/codex/…）→ 两层智能证据：
       P5 规定步闭环（daq_query→dcw_control→观察→dcw_judge→交付哨兵→complete_task）；
       P5b **目标驱动闭环寻优**——cast-film 孪生线以起始工况开跑，任务只给输出目标值
       （厚度 52.0±0.8 μm）与写次数上限，Agent 按标准工况 SOP 逐步执行：
       读数→分析→查历史→自定参数下发→复测→迭代，直到达标，再把最佳工艺用
       recipe_update 版本化存入配方。两者完整执行轨迹分别落
       `bench/results/<runId>/agent-loop-<harness>.log` 与 `agent-goal-loop-<harness>.log`；
     产物: bench/results/<runId>/{run.json, summary.json, report.md, dashboard.html, metrics.csv}

  ③ 真实协议层（约 1–2 分钟）——能力评分面板（含 F2 冻结报警、断链恢复）
     node bench/run.mjs --tier plc --seed 42
     判据: 退出码 0；13 项检查全部 pass、0 fail；api-3 的 intercept_rate=1 且 false_block_rate=0。
     （可选加跑接口层: node bench/run.mjs --tier api --seed 42；判据同 exit 0、9 项 pass。）

  ④ E1a 四臂消融（约 2–3 分钟）——治理机制的归因证据
     node bench/e1-lite.mjs --seed 42 --repeats 3
     判据: 退出码 0；full 与 no-readback 拦截 6/6，no-interlock 与 ungated 4/6 且
       windowBreach>0（越窗写被执行并入账），四臂 falseBlock 恒 0。
     ⚠️ 若 no-interlock 也 6/6 → 平台没带 AW_BENCH_MODE=1（§第 2 步方式 B 的警告），结果作废，重启平台重跑。
     产物: e1-lite.csv / run.json / report.md / report.html / figure-*.svg

  ⑤ 全系统功能普查（约 1–2 分钟）——API 全功能面
     node scripts/api-live-e2e.mjs
     判据: 退出码 0，末行「★ ALL PASS」。
     覆盖: Agent 模板 CRUD / Channel CRUD+装配 / task goal·loop·pipeline 三模式 /
       dispatch·report·complete·cancel 状态机 / token 作用域 403 / A2A+mailbox+消息历史 /
       WebSocket Hub / MCP initialize+tools/list / 级联删除。
     说明: 「持久化恢复」一节依赖上一轮遗留数据，无遗留时按项目语义诚实 SKIP（不算失败），
       跨重启持久化由第 6 步的重启演练单独验证。

────────────────────────────────────────────────────────────────
第 4 步 · 复现验证（标准流程的收尾，必做）
────────────────────────────────────────────────────────────────
  ① 与冻结基线出机器判定（判定类指标逐位一致 = REPRODUCIBLE，退出码 0）:
     node bench/compare.mjs --baseline 20260914-baseline/run-plc-fx0    --b <第 3 步③ 的 runId>
     node bench/compare.mjs --baseline 20260914-baseline/run-e1lite-4arm --b <第 3 步④ 的 runId>
     判据: 两个都退出码 0。harnessHash 若不同只会出现 NOTE（源码演进合法），
       但必须核对「逐项 pass→pass、判定指标逐位一致」——这正是指纹存在的目的。
  ② 门槛自检（阴性对照，证明门槛有牙）:
     node bench/compare.mjs --selftest
     判据: 退出码 0，且输出「SELFTEST PASS（门槛正确拒绝篡改）」并列出被捕获的篡改项。
  ③ 流水线层复现（可选，同命令再跑一次得第二个 runId）:
     NO_PROXY=127.0.0.1,localhost AW_BENCH_MODE=1 \
       node bench/pipeline.mjs --profile integrated --seed 42 --cl-seeds 3
     对比两次 summary.json 的 verdict 必须同为 71/0/0；closedloop.agg 的 ratio 区间
       必须都落在 [0.966,0.973]；portability.agg 五协议构成必须逐字段一致
       （J0/Jend 采样值允许环境性浮动）。

────────────────────────────────────────────────────────────────
第 5 步 · 全系统重启持久化演练（可选但推荐，约 2 分钟）
────────────────────────────────────────────────────────────────
  1) 注册测试用户并建一个带 lead 的 Channel（POST /api/workshop/users/register、
     POST /api/workshop/channels，body 带 leadAgent），记下 token 与 channelId。
  2) 重启平台（方式 B 的 detached-start，先 taskkill 旧进程）。
  3) 重启后用同一 token: GET /channels 应仍能看到该 Channel →
     GET /channels/:id 应返回成员 → GET /runtime 应看到 lead 被懒加载装配（wiredAgents≥1）。
  4) 删除该 Channel 清理。
  判据: 三次读取全部成功。这是「项目正常启动 + 数据落盘可恢复」的直接证据。

────────────────────────────────────────────────────────────────
第 6 步 · 产物与交付
────────────────────────────────────────────────────────────────
  每次运行落在 bench/results/<runId>/（UTC 时间戳命名，永不覆盖）:
    run.mjs 层   → run.json / report.md / report.html / config-hash.txt
    pipeline 层  → run.json / summary.json / report.md / dashboard.html / metrics.csv / agentteam-mission.log / agentteam-biax.log（--agent 时另有 agent-loop-<harness>.log）
    e1-lite 层   → run.json / e1-lite.csv / report.md / report.html / figure-*.svg
    compare 层   → compare-*.md（写进 bench/results/ 根）
  交付物 = 各层的 report.md + report.html（或 dashboard.html）。
  需要对外展示时，把选中的 report.md / report.html / dashboard.html 复制到一个独立目录，
  并保留其来源 runId。⚠️ 永远不要删除 bench/results/ 或 bench/baselines/——
  冻结基线与「与基线逐位一致」的复现声明都以它们为前提。

  若任何一步不满足判据: 停止，如实报告「哪一步、哪条判据、实际输出、你的诊断」。
  禁止继续后续步骤，禁止降低判据，禁止伪造。
```

---

## 1. 必须知道的判据与陷阱（Agent 速查）

### 1.1 平台身份判别（防冒名）
`bench/lib/platform.mjs` 的在线探针只检查 `HTTP 200 + JSON`，**不校验是不是 AgentWorkShop**。
端口被其它服务占住且恰好返回 JSON 时，流水线会把它当平台，之后所有检查以难懂的方式失败。
所以执行卡第 1 步的人工判别不可省：body 必须是 `{"code":0,...,"data":{"needsSetup":...}}`。
AgentWorkShop 的健康面（`/api/health`）会返回 `"app":"AgentWorkShop"`，可用于二次确认。

### 1.2 端口规则
- 默认 3001（仓库 `config.yml`）；被占/被冒名时按 3005→3010→3050→3060 顺延。
- **选定后所有命令用同一端口**：`run.mjs`、`pipeline.mjs`、`e1-lite.mjs`、`scripts/api-live-e2e.mjs`
  都支持 `--base`，也都读环境变量 `AW_BASE`——推荐 `export AW_BASE=...` 一次到位。
- `compare.mjs` 不需要端口（只读 run.json 文件）。
- 平台进程被占端口顺延（start.mjs 会 +1）**不会**被流水线感知：流水线只认 `--base` 指定的那个。

### 1.3 AW_BENCH_MODE=1 的时序
该变量只在**平台进程启动时**被读取。已在跑的平台不会因为之后 export 而获得消融开关。
漏掉的典型症状：e1-lite 的 no-interlock 臂拦截也是 6/6（应 4/6）——这是假绿，整份消融作废。
生产构建默认恒 full（旁路开关被 env 门控），所以生产演示不受影响。

### 1.4 判定类指标 vs 环境类指标
- **判定类（同 seed 必须逐位一致）**：F5 拦截/误拦、边界值、Eq.(1) 双分支、归因、回读一致性、
  SP 设定点回读、静态 20 锚点、产线/协议构成、portability 聚合、E1a 拦截率/越窗数/误拦数。
- **环境类（只记录、不设门槛）**：写时延 p50/p95、采样计数、数采新鲜度、闭环 J0/Jend 采样值
  （由采样过程变量计算）、wall time。
复现判定只看判定类。时延或采样数变化**不是**复现失败。

### 1.5 假绿陷阱（全部实测踩过）
1. **mock harness 不能做工具级闭环**：工具桥只回退协作工具族并抛「不支持该协作工具」——
   文本看着像调通了，工具根本没到。P4 默认 `--tool-harness opencode`（直调 host 工具、不经 LLM）。
2. **`dcw_judge` 的入参是 `record_id` 不是 `node_id`**：record_id 从 `dcw_control` 回包的
   「优化记录 `<id>` 已开窗」里解析。
3. **写入值必须 ≠ 当前值**：值未变化时 `recipe-rollback-manager.afterWrite` 直接返回 null，
   不产生优化记录 → 后续判定无从做起。闭环写值取窗口内非中心位置。
4. **连续写要换方向**：回退护栏对同向重写有 300 s 冷却，同向返回 isError 且无记录。
5. **manual 模式要并发发起**：`dcw_control` 在服务端阻塞等审批，必须「并发 invoke → 轮询审批 →
   裁决 → await 回执」，顺序写会死锁到超时。

### 1.6 长跑服务的分离启动
Agent 工具的后台作业在回合结束/被回收时会连子进程一起终止——把平台/模拟器挂在 Agent 的
后台作业里，就会出现「日志停在半路、无 fatal 行、端口释放」的假死。
- 流水线自举的平台是 `detached:true + unref` + 日志重定向，Agent 回合结束不影响它；
- 需要手动起平台时用 `scripts/_audit/detached-start.mjs`（真分离，日志落文件，`--stop` 可停）；
- 手动起模拟器时确认它不挂在会被回收的作业里，重启后用 `/api/nodes` 探活。
- 陈旧锁：平台异常死亡会留下锁文件，`detached-start.mjs --stop` 或按手册清理后再启动。

---

## 2. 命令与参数速查（全部支持 `AW_BASE` / `--base`）

| 工具 | 常用参数 | 说明 |
|---|---|---|
| `bench/pipeline.mjs` | `--profile integrated\|quick` `--seed N` `--cl-seeds N` `--base URL` `--lines N` `--preset <名>` `--tool-harness <名>` `--agent <引擎> --provider <p> --model <m>` `--cl-write governed\|rest` `--cl-iters N` `--no-autostart` `--no-autostart-platform` | 一体化集成评测；`--agent` 跑真实 LLM 闭环（需模型凭据）；`--no-autostart*` 只复用在线服务 |
| `bench/run.mjs` | `--tier static\|api\|plc\|full` `--seed N` `--base URL` `--repeats N` | 能力评分面板（report.md+report.html）；`full` = static + api×N 轮 |
| `bench/e1-lite.mjs` | `--base URL` `--seed N` `--repeats N` | E1a 四臂消融（需平台带 `AW_BENCH_MODE=1`） |
| `bench/compare.mjs` | `--baseline <label[/sub]> --b <runId 或运行目录>` `--a A --b B` `--selftest` | 复现判定 / 任意两次对比 / 阴性对照；不需要端口（只读 run.json） |
| `scripts/api-live-e2e.mjs` | `AW_BASE=URL`（可选 `AW_E2E_TOKEN` 沿用身份） | 全系统 API 功能普查 |

---

## 3. 阶段编排（一体化流水线的 14 个阶段）

| 阶段 | 内容 | 为什么必须如此 |
|---|---|---|
| **P0 自举** | 探测/分离拉起**模拟器(:4010)与平台($AW_BASE)** → 平台鉴权 | 消除"人工先起两个服务"的前置；任一自举失败直接 FAIL（不会部分通过） |
| **P1 工艺模型** | 应用预设 → 拉 W\*（离线最优 ground truth）→ 切 steady | 量化需要基准真值 |
| **P2 多产线供给** | 每协议一台设备：有 DCW 导出者自成产线（line+product+DAQ+DCW+recipe+开跑）；无 DCW 导出者作**卫星数采**挂靠主产线 | 见下方「平台硬约束」 |
| **P3 集成** | 真实驱动数采落库（20s 有界等待窗，防冷启动首采慢的假 warn）+ 数控写/回读时延 + F5 越界写治理拦截（**穿透/误拦 = 检查 fail**，非仅掉 KPI） | E1 动态核在**多协议**下复验 |
| **P4 工具级闭环** | 用「有引擎」harness 直调 `daq_query → dcw_control → dcw_judge` **3 轮收敛**逼近窗口中心（每轮判定关记录——Agent 作用域同时只允许一条 open 记录；**不经 LLM**，确定性） | 见「平台硬约束」② |
| **P4m AgentTeam 优化任务** | 任务板下达优化目标 → 派发 worker → 经工具面 `daq_query`(from/to/bucket 时段读数) 分析 → `dcw_control` 受治理下发(开记录) → 物理随动轮询 → `dcw_judge` 收口 → 账本归因核验 → 达标判定(\\|PV−目标\\|≤容差) → report/complete/父任务聚合。**策略确定性（免模型凭据）；LLM 变体=可选 P5** | 「给 AgentTeam 一个优化目标,团队读写节点达成它」这一核心功能的直接测评 |
| **P4b 回退与优化记录** | 优化记录判定 keep/rollback + **判定与执行分离** + 节点级单步回退 + 参数台账 | Sec. V 的调控闭环 |
| **P4c HITL 审批** | manual 绑定 → 下发**挂起** → 审批面板可见 → 裁决 → 解阻塞且 PLC 生效（换线执行，避开 P4b 回退冷却） | 审批门是论文核心机制 |
| **P4d 治理只读面** | 参数账本 journal（按 source）+ 审计 + 运维日志 + 报警 | 可追溯性的直接证据 |
| **P4e 配方管理** | 版本化（编辑→+1 版）→ 标记已知良好 → 回退历史版本（非破坏）→ 基准恢复 → 一键下发。**刻意排在 P4d 之后**：rollback-good 留下的回退锚（300s 同向冷却）若在 P4b 之前生成，会拒绝优化记录生命周期的上行写（实测踩过） | 配方全生命周期是治理主张的组成部分 |
| **P5 LLM 闭环**（可选） | 真实引擎+模型跑完整 Agent 任务，核对交付哨兵 | 端到端智能体能力 |
| **P6 闭环优化 benchmark** | cast-film 孪生（6 执行器 + 5 传感器）多 seed 闭环寻优（受治理写路径），输出 J/J\*、迭代数、写次数、拒绝数 | **主指标**：闭环优化质量 vs 离线最优 W\* |
| **P7 多形态数采** | 向量轮廓帧 + 图像帧落库 | 数采不只标量 |
| **P8 跨场景可移植** | 切换第二个产线场景预设（如 film-line），用**同一套**委托/治理代码路径重跑 export→建线→数采→受治理写→F5 拦截→回读 | 框架主张「适配新产线=配置任务而非集成项目」的直接度量（0 代码改动） |
| **P8b 系统兜底 drilling** | 在第二场景刚体上：清场 open 记录 → Agent(auto) 开优化记录 → manual 冻结 DAQ 于窗外 → 等系统兜底（观察窗 120s + 30s 节拍 + 越限 3 采样）自动判定 rollback 并恢复记录基线 → 解冻并恢复第一场景 | 论文 I3（有界自治）的**动态证据**：system 判定 + 值回基线；时延属环境类 |
| **P10 双拉产线全节点** | biax(BOPET) 全线数字孪生 9 设备五协议 49 信号（30 SP + 19 PV 全带工艺描述）：① 以预设蓝图 dry-run 为工程清单，对现场做按 id/信号/端口的**差分探测——缺失补建、漂移修复、停机拉起，不整包重置**（与 cast-film 现场共存）→ 热态装载 biax 物理引擎；② 平台按真实 driverConfig 建一条全线产线（30 DCW + 19 DAQ，描述进 semantics→Agent 语义卡），配方 30 参数全窗纳管开跑；③ AgentTeam 任务板下达厚度目标 25.0±0.7μm → worker 在 ≥3 个执行节点（铸片速度/纵拉快辊/出口轨宽）上轮流受治理写 → 物理随动（运输滞后+一阶收敛）→ dcw_judge → 达标收口 | 「更接近真实双拉产线」的多节点闭环诉求直接测评；「PIPELINE 识别缺节点→自动补建」的工程化建线能力 |
| **P9 平台子系统** | 团队调度（mock lead+2 worker 未指派任务→派发→完成）+ 团队记忆 dedupKey 幂等 + 引擎注册表枚举/可用性探测 | MAS 协作、记忆、多引擎资产的可复现基准 |

### ⚠️ 闭环优化的三个反直觉约束（实测踩过，务必遵守）

1. **写入值必须不同于当前值**：`recipe-rollback-manager.afterWrite` 对 `prevValue === eng` 直接 `return null`，
   不产生优化记录 → 拿不到 `record_id`（后续 `dcw_judge` 无从判定）。
2. **连续写要换方向**：回退护栏对「同向重写」有冷却，同向会返回 `isError` 而无记录。
3. **manual 模式要并发发起**：`dcw_control` 在服务端 `await approvals.request()` **阻塞**等待裁决，
   因此必须「并发发起 invoke（不 await）→ 轮询审批面板 → 裁决 → 最后 await 回执」，顺序写会死锁到超时。
4. **DAQ 样本点形状**：`GET /daq/:id/samples?bucketMs=` 桶化返回 `{at, avg, min, max, cnt}`（`ORDER BY at DESC`），
   非桶化返回 `{at, value, state}`——读均值取 `avg ?? value`，取 `v` 之类字段恒 undefined →
   「有数据却读到 null」的静默失败（P10 首跑实测踩过）。
5. **biax 收敛别调太快**：双拉厚度三旋钮（铸速/快辊/轨宽）系数取保守值（0.5/0.35/0.3），
   一轮全修正会 1~2 轮达标、多节点覆盖不足；且测厚仪在 TDO 出口下游 12m + 链速驻留，
   写后 **≥12s 才允许判稳**（运输滞后），过早读数会把上一步的 PV 当成本步效果。

### 两条平台硬约束（流水线已内化，勿踩）

1. **采样受「活动产线批次」门控**：`daq-controller.sweep` 仅在 `lineRun.activeRun(node.lineId)` 为真时采样；
   而「开跑」要求配方**归属本产线产品且含工艺参数**。纯采集设备无法自成可开跑产线 →
   建模为**卫星数采**（DAQ 节点挂到主产线 lineId，随其批次采样）。
2. **工具级闭环必须用「有引擎」harness**：`mock` 走 MockAgentImpl，工具桥只会回退到协作工具族并抛
   「不支持该协作工具」（**假绿陷阱**：文本像"调通了"实则工具压根没到）。故 P4 默认 `opencode`
   （仅直调 host 工具、不经 LLM、不需模型凭据），并先做 `my_industrial_nodes` 工具面自检。
   `--tool-harness` 可换 omp/codex/dsh/qwen/pi/… （实测除 mock 外全部支持）。

### 复现性

同 `--seed` 下**判定类指标逐位一致**（F5 拦截/误拦、闭环达成数、数采非空、产线/协议构成）；
时延与采样计数属环境性波动，只记录不设门槛。run.json 自带 `seed / harnessHash / gitCommit / reproCmd`。

---

## 4. 三层执行模型（诚实降级）

| Tier | 名称 | 前置条件 | 测什么 | 失败语义 |
|---|---|---|---|---|
| **static** | 静态层 | 无（只要仓库） | 能力清单、**论文-代码一致性**（20 个常量锚点）、治理管线阶段顺序 | fail = 论文或代码失真，必须修 |
| **api** | 接口层 | 运行中的平台实例 | 真实 REST 夹具、语义卡、**F5 越界写+边界值+Eq.(1)双分支**、回读闭环+归因、数采新鲜度 | 实例不可达 = 全层诚实 skip（不伪造分数） |
| **full** | 统计层 | 同 api + `--repeats N` | static + **api×N 轮**（每轮独立夹具），合并报告：判定类指标取最严、逐轮 status/score 存档于 run.json.reps | 任一轮 fail → 合并 fail，退出码 1 |
| **plc** | 真实协议层 | api 前置 + **plc-node-simulator**（:4010） | 五协议真实连通(导出 driverConfig)→**真实 Modbus 采样落库**→SP→PV 物理闭环→**真实链路 F5+边界**→断链-恢复演练 | 模拟器不可达 = plc 层诚实 skip |
| **E1a 消融** | 四臂跑批(独立脚本) | 实例以 `AW_BENCH_MODE=1` 启动 | `node bench/e1-lite.mjs --seed 42 --repeats 3` → full/no-interlock/no-readback/ungated 四臂×3轮，拦截/越窗/边界/时延 + 论文级 SVG 图 | 任一臂判定异常 = fail |

**原则**：环境不具备时宁可 skip 并写明原因，绝不伪造通过。每份报告自带 seed、configHash、复现命令。

---

## 5. 执行手册（分阶段详解）

### 阶段 A · 静态评测（任何环境立即可跑）

```bash
node bench/run.mjs --tier static --seed 42
```

- **预期**：9 项子检查（s1 能力清单 7 项 + s2 论文一致性 20 锚点 + s3 管线顺序 2 链）。
- **判定**：退出码 0 且 `s2` 得分 = 100% → 通过；`s2` < 85% → **停止后续实验**，先修复论文-代码失真（这对论文真实性是硬门槛）。
- **产物**：`bench/results/<runId>/report.md` + `report.html` + `run.json`。

### 阶段 B · 启动平台实例与 PLC 模拟器（api/full/plc 层需要）

首选 §0 第 2 步方式 A（流水线自举）。手动启动时：

```bash
# 0) PLC 模拟器(plc 层前置;独立项目,真实五协议从站+薄膜产线物理引擎)
cd ../plc-node-simulator && NO_PROXY="127.0.0.1,localhost" npm run dev   # http://127.0.0.1:4010
# 1) 依赖服务（Timescale/MinIO/MQTT，可选——缺失时平台自动降级仍可测）
docker compose up -d
# 2) 平台实例（首次启动自动注册 admin；或用已有实例）
pnpm build && pnpm start          # 或 aw start；端口以 --port / config.yml 为准
# 3) 鉴权（二选一）
export AW_ADMIN_EMAIL=admin@awshop.local AW_ADMIN_PASS=<密码>
```

**就绪判据**：`curl --noproxy '*' -s http://127.0.0.1:<P>/api/users/setup-status` 返回
`{"code":0,...,"data":{"needsSetup":...}}`，且 `curl --noproxy '*' -s http://127.0.0.1:4010/api/nodes`
返回 JSON。plc-0 检查会自动应用「film-line」预设（五协议设备 + SP→PV 一阶物理联动）。
（本机代理环境务必 `NO_PROXY=127.0.0.1,localhost`，参见仓库排障惯例。）

### 阶段 C · 接口层评测

```bash
node bench/run.mjs --tier api --seed 42     # AW_BASE 已导出时无需 --base
```

- 检查链（依次执行，前一环失败后续自动诚实跳过）：
  `api-0 连通鉴权 → api-1 夹具（产线+配方窗+数采）→ api-2 语义卡/账本面 → api-3 F5 越界写+边界值+双分支（核心）→ api-4 回读闭环+归因 → api-5 数采新鲜度`
- **核心判定（E1 动态核）**：`api-3` 的 `intercept_rate` 必须 = **100%**、`false_block_rate` = **0%**——这是论文不变式 I1 的动态证据；任何穿透 = 治理失效，立即停止并报修，不允许"平均一下还行"。
- 运行结束自动 teardown（停线/停采），数据留存于实例中可追溯。

### 阶段 D · 统计层（重复实验）

```bash
node bench/run.mjs --tier full --seed 42 --repeats 3    # 论文级建议 --repeats 20
```

static 跑 1 次 + api 层跑 N 轮（每轮独立夹具，tag 含轮次）：判定类指标（拦截/误拦/归因/回读）在固定 seed 下**逐位一致**，`run.json.reps` 存每轮明细；合并报告中判定取最严、时延类按轮波动如实呈现。版本指纹：`run.json.env.harnessHash` + `gitCommit`，存档结果可追溯到产生它的确切代码。

### 阶段 E · 读取报告

| 文件 | 用途 |
|---|---|
| `report.html` / `dashboard.html` | 可视化评分面板：总体分/等级、KPI 条、阶段时间线、维度卡片、检查明细、可展开证据 |
| `report.md` | 同内容纯文本，直接贴 PR / 审计 |
| `run.json` / `summary.json` | 机器可读全量结果（含每项 metrics 与 evidence），供后续聚合与论文表格生成 |

### 阶段 F · 复现验证（标准流程收尾，必做）

```bash
node bench/compare.mjs --baseline 20260914-baseline/run-plc-fx0    --b <plc层新runId>
node bench/compare.mjs --baseline 20260914-baseline/run-e1lite-4arm --b <e1lite新runId>
node bench/compare.mjs --a <runIdA> --b <runIdB>        # 或任意两次运行对比
node bench/compare.mjs --selftest                        # 阴性对照：门槛必须有牙
```

- **退出码 0 = REPRODUCIBLE**：所有检查 id 集合一致、每项 status 一致、判定类指标（拦截率/误拦率/边界/归因/回读/SP 设定点回读/静态锚点/PLC 离散结果）逐位一致。
- **退出码 1 = NOT REPRODUCIBLE**：报告列出全部门槛失败明细。物理残差/采样计数/时延/新鲜度类指标只记录差异不设门槛（环境性波动），差异清单写入 `bench/results/compare-*.md`。
- 若 `harnessHash` 或 `gitCommit` 不同会以 NOTE 标出（harness 版本演进合法，但须确认改动不影响判定逻辑——这正是指纹存在的目的；实证方法就是看判定类指标是否仍逐位一致）。
- 判定契约表在 `bench/compare.mjs` 的 `JUDGE` 常量中维护：新增检查时必须同步登记其判定类指标，否则该检查默认全部判定类。

### 基线存档约定

`bench/baselines/<label>/` 存放"可信基线"快照（永不覆盖、只增不改），每个基线含：

- `run-plc-*/`：`--tier plc` 完整运行的 run.json + report.md + report.html；
- `run-e1lite-*/`：E1a 四臂消融的 run.json + CSV + 论文级 SVG 图；
- `BASELINE.json`：清单（来源 runId、harnessHash、gitCommit、判定类指标指纹）。

当前基线 **`20260914-baseline`**（plc 全绿 13/13、overall 100.0、git `d6c824d`；e1-lite 四臂 ×3 轮）。审稿人/用户只需执行执行卡第 3–4 步即可验证"结果与基线一致"。
历届报告的对外存档放 `bench/reports-archive/<标签>/`（只增不删）；`bench/results/` 与 `bench/baselines/` 任何情况下不得删除。

---

## 6. 评分模型（透明、可审计）

- 每个检查产出 `score ∈ [0,1]` 与权重（F5 攻击/归因/论文一致性权重=3 或 2，抽样类=1）。
- 维度分 = 该维度下检查加权平均；总体分 = 全部非 skip 检查加权平均；等级 A≥90 / B≥75 / C≥60。
- **skip 不计分也不扣分**，单独列出原因——分数只反映"真实测到的东西"。
- 流水线层阶段权重：P0=1 P1=1 P2=2 P3=3 P4=3 P4m=3 P4b=2 P4c=2 P4d=1 P4e=2 P6=3 P7=1 P8=3 P8b=3 P10=3 P9=1；
  硬门禁：任一检查 fail 或任一阶段 fail → 总评直接 FAIL（分数只作参考）。
- 维度映射：D0 论文-代码一致性 / D1 数采 / D2 写控治理 / D3 智能体 / D7 审计归因 / D8 性能（D4/D5/D6 由 §8 全量实验覆盖，静态+接口层不虚评）。

---

## 7. 复现合同

1. 一切随机来自 `--seed`（mulberry32，与产线模拟器同族 PRNG）；
2. 每次运行落盘 `bench/results/<runId>/`，**永不覆盖**（runId 为 UTC 时间戳），含 configHash=sha256(tier+seed+only+repeats)；
3. 夹具 tag 隔离（`awb<seed><ts>`），重复运行零冲突；teardown 只停不删，证据链留存；
4. 平台版本 tag + Node 版本 + 时间戳写入 run.json；
5. 复现 = 同命令重跑 + `node bench/compare.mjs` 出机器判定：判定类指标必须逐位一致，时延类允许环境性波动、只报告不设门槛。

---

## 8. 从 E1-mini 到 E1–E9 全量实验（Agent 后续任务路线）

当前 `bench/run.mjs` 覆盖 **E1 的动态核**（F5 拦截 + 回读 + 归因）。全量论文实验按 `docs/experiments/01-test-and-benchmark-master-plan.md` 推进，Agent 执行顺序：

| 步骤 | 任务 | 前置开发项（00-MASTER-PLAN） | 命令形态 |
|---|---|---|---|
| 1 | P0 插桩：decision_log 表 + 写控四段耗时戳 + 保留期≥90d | D1/D2（服务端） | —（跑一次闭环任务后 SQL 验收） |
| 2 | bench/lib 补齐：fault-injector（F1–F6）/ metrics.mjs / stats.mjs | D3 模拟器控制端口、D6 | `node bench/run.mjs --config configs/e1-main.yaml`（待接入） |
| 3 | E1 全矩阵（4 治理臂 × W1/W3 × T1–T4 × N20） | D8 消融开关 `AW_BENCH_MODE` | 夜间批跑 → table-e1-main.csv |
| 4 | E2/E3/E4 | D9/D10 开关 | 对应 configs/*.yaml |
| 5 | E5 检测 + TEP/SWaT 回放 | D11-A 算法实现、D12 replay driver | configs/e5-anomaly.yaml |
| 6 | E6 HIL | D13 真设备 | configs/e6-hil.yaml |
| 7 | E7 框架基线（AutoGen/LangGraph/CrewAI 经 MCP 挂同工具） | B2 适配器 | 等token预算协议，见 master-plan §4.2 |
| 8 | E8 HITL 语义（sim-operator + 真人轨） | B4 | τ-bench 范式 |
| 9 | E9 跨引擎（codex/claude/gemini/qwen/opencode/pi） | 注册表已就绪 | 同模板同工具，invariant_pass 必须=100% |
| 10 | paper-gen：CSV → `paper/tii/results-macros.tex` 宏替换 | — | **论文零手敲数字** |

统计协议（全实验通用）：每配置 N≥20（mock）/ N≥10（真 LLM）；Mann-Whitney U 双侧 + Holm 校正；中位数 + bootstrap 95% CI；表脚注记录 harness/模型版本/温度/prompt 哈希/日期/硬件。

---

## 9. 排障速查

| 症状 | 处置 |
|---|---|
| `api-0` skip: 实例不可达 | 确认实例端口；`NO_PROXY=127.0.0.1,localhost`（本机 7890 代理会拦截 localhost） |
| api-live 报「用户注册失败」即退出 | 忘了 `export AW_BASE=...`，脚本默认打到 3001——所有工具都读 `AW_BASE`，先 export 再跑 |
| 平台"在线"但所有请求 404/形状不对 | **端口被别的服务冒名**——回 §0 第 1 步做身份判别，换端口 + `AW_BASE` 重跑 |
| `--base` 指定的端口起不来 | start.mjs 发现端口被占会自动 +1 顺延，但流水线只认 `--base` 写的端口 → 换一个确定空闲的端口 |
| 消融的 no-interlock 臂也是 6/6 | 平台没带 `AW_BENCH_MODE=1`（必须在平台进程启动前 export），重启平台重跑 |
| 鉴权失败 | 首启实例未注册时 preflight 会自动注册 admin；已有实例用 `AW_ADMIN_EMAIL/AW_ADMIN_PASS` |
| `api-1` 某步 4xx | 看证据里的 `code/message`（BIZ 错误透传）；常见：模板 key 重复（tag 已随机化，重跑即可） |
| `api-3` 出现穿透 | **停止实验**——这是产品级治理缺陷，先修复 dcw-controller 联锁，再重跑 |
| samples 为空 | mock 采样需数秒起稳（检查器已内置等待）；确认 gateway/enable/start 已调用；确认产线批次已开跑（硬约束①） |
| 服务在 Agent 回合结束后消失 | 服务被挂进了会被回收的后台作业——改用流水线自举或 `detached-start.mjs`（§1.6） |
| 端口占用 | 与既有实例/探针冲突（避开 3000/3001/3002）；`AW_BASE`/`--base` 指向实际端口 |
| compare 报 harnessHash NOTE | 源码在两次运行间有改动，合法；核对判定类指标是否仍逐位一致，一致即可放行 |
