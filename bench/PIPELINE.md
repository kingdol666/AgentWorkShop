# AW-IndustrialBench · 可执行测试流水线（Pipeline）

> **本文是执行合同**：任何 Agent / 人类**只读本文**，按 §0 执行卡的命令顺序逐条执行，即可对
> AgentWorkShop 完成一次**真实跑通**的可复现能力评测，产出 **MD + HTML** 评分报告
> （`bench/results/<runId>/`，审稿人级跨层总报告见 §0 第 5 步）。
> 规范背景见 `bench/README.md`（场景/任务/故障/指标定义），
> 实验总策划见 `docs/experiments/01-test-and-benchmark-master-plan.md`。
>
> **被测故事线（评测即真实投产路径，14 个阶段按此展开）**：
> 启动 PLC 节点模拟器（五协议从站 + 薄膜产线物理引擎）→ 平台连接节点（driverConfig
> 实测导出）→ 产线/节点绑定（line+product+DAQ+DCW+recipe 建线，卫星数采挂靠）→
> AgentTeam 创建与任务下达（任务板目标 → lead 派发 → worker 经工具面读写）→
> 闭环优化与过程监控（受治理写 → 物理随动 → 判定 → 账本归因 → 达标收口；双拉产线
> 全节点 9 设备 49 信号）→ 治理只读面与系统兜底。集成报告含**模拟产线画像**与
> **AgentTeam 闭环调优 walkthrough** 两个展示专章（§0 第 3 步②）。
>
> **四条铁律（先读）**
> 1. 一切结论必须来自**真实启动的服务与真实执行的命令**；任何一步不满足判据 → **停止并如实报告原因**，禁止伪造通过、禁止"平均一下还行"、禁止用脚本绕过本卡的检查点。
> 2. 环境不具备时（实例不可达、端口被占、缺依赖）→ 按 §1 的失败语义**诚实 skip 并写明原因**，skip 不计分也不算失败；伪造通过 = 全部作废。
> 3. 本卡所有命令都在**仓库根目录**执行；端口一旦选定，**所有后续命令都用同一个端口**（§1.2）。
> 4. warn 不是 fail：流水线对"任务级失败"的既定语义是降级为 warn（§1.8）；单次 run 出现 warn 时按第 3 步②的重跑协议处置并如实写进报告，**禁止把 warn 改判成 pass**。

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
  基准端口默认 3005（隔离冷启专用位；3001 通常是常驻实例，不要动它）。
  对候选端口逐个探测并分类：
    curl --noproxy '*' -s --max-time 5 http://127.0.0.1:<候选>/api/users/setup-status
  分类规则（按 body 判，不看状态码）:
    · 连接拒绝 / 超时 → 端口空闲，可用于隔离冷启动（第 2 步）。
    · 200 且 body 是 AgentWorkShop 形状 {"code":0,...,"data":{"needsSetup":...}}
        → 该端口上已有一个健康的 AW 实例。⚠️ 只有当它确实是本次基准实例
          （例如上一轮跑卡留下的 3005）才可复用；其余端口一律换位。
    · 200 但 body 形状不同（如 {"detail":"Not Found"}）、或非 JSON
        → 被别的服务冒名占用，换下一个候选端口。
        ⚠️ bench 的在线探针只认「HTTP 200 + JSON」，分辨不出冒名者，这一步必须人工判。
  候选端口顺序: 3005 → 3010 → 3050 → 3060（避开 3000/3001/3002）。
  二次确认（可选）: AgentWorkShop 的 /api/health 会返回 "app":"AgentWorkShop"。
  模拟器身份（$SIM_BASE，默认 :4011 专用实例）:
    curl --noproxy '*' -s --max-time 5 $SIM_BASE/api/nodes
    · 返回 JSON 数组 → 健康（在线即复用；缺失设备由流水线差分探测自动补建）。
    · 返回 HTML 或非 JSON → 该端口被别的服务占用：换 SIM_BASE（如 4012）并
      重新 export SIM_BASE，或停掉占位服务；自举会以 SIM_PORT 在该端口拉起专用实例。
    ⚠️ 不要把 SIM_BASE 指到 4010 除非你确认它就是基准专用实例——共享 dev 模拟器
    被并行会话重置是 P10 断膜假象的实测根因（§1.8）。

  选定 P 后，本 shell 里固化一次，后面所有命令都会读它:
    export AW_BASE=http://127.0.0.1:P

────────────────────────────────────────────────────────────────
第 2 步 · 启动被测系统（标准方式 A：隔离根 + 单命令自举）
────────────────────────────────────────────────────────────────
  方式 A（推荐，2026-09 起为标准）: 在执行流水线命令的同一 shell 里 export
  【隔离环境块】，然后直接执行第 3 步②的流水线命令——P0 会自动探测并【分离启动】
  模拟器($SIM_BASE)与平台($AW_BASE)，任一自举失败 → 整体 FAIL，不会部分通过。

    # ── 隔离环境块（每次新 shell 都要重设）────────────────────────
    export NO_PROXY=127.0.0.1,localhost no_proxy=127.0.0.1,localhost
    export AW_BASE=http://127.0.0.1:3005            # 第 1 步选定的端口
    export SIM_BASE=http://127.0.0.1:4011           # 基准专用模拟器（4010 常是其他会话的共享 dev 模拟器，
                                                    #  被外部 preset/重启会清 SP → P10 每写必断膜,勿复用）
    export AW_BENCH_HOME="${AW_BENCH_HOME:-$PWD/../aw-bench-home}"
    export AW_HOME="$AW_BENCH_HOME"                 # 基准实例独立配置根（全新库）
    export AW_MODE=home                             # 强制 home 模式 → 配置根=AW_HOME
    export AW_BENCH_MODE=1                          # 消融开关：必须在平台进程启动前存在
    export NUXT_SESSION_PASSWORD="aw-bench-isolated-2026"   # 隔离根冷启须注入会话密钥
    # ────────────────────────────────────────────────────────────

  隔离语义（为什么必须这样做）:
    · AW_HOME 指向独立目录 → 基准实例有独立的锁/SQLite/运行时设置，
      **与同仓库常驻实例（3001 等）互斥锁不相遇**：生产实例零接触、零重启。
    · 全新库首启 needsSetup=true 是**正常形态**：流水线 P0 鉴权会自动走
      「首注册即 admin」（admin@awshop.local / admin123，bench 惯例凭据）。
    · 共享配置根的旧路（不设 AW_HOME）仍可用，但同根旧实例会被自动顶替停止，
      且顶替竞态可能触发一次 disk I/O error 崩溃（自愈逻辑见 §1.7）——
      除非你明确知道自己在做什么，否则一律走隔离根。
  方式 B（手动起服务时，例如要单独重启平台）:
    平台:   在上面隔离环境块已 export 的同一 shell 里
            node scripts/_audit/detached-start.mjs --port 3005 --log ../aw-bench-home.log --wait 90
    模拟器: cd plc-node-simulator && NO_PROXY=127.0.0.1,localhost SIM_PORT=${SIM_BASE##*:} npm run dev   # 跟随 $SIM_BASE
    ⚠️ 消融层（第 4 步④）要求平台以 AW_BENCH_MODE=1 启动。该环境变量必须在
    「平台进程启动的那一刻」就存在（写在同一 shell 的 export 里）。平台已在跑但
    没带这个变量 → 必须重启平台，否则消融的 no-interlock 臂会表现得和 full
    一模一样（6/6），这是已知的假绿形态。
  自愈说明: bench/lib/platform.mjs 的自举带崩溃感知重试——平台进程秒崩（日志含
  fatal 且 pid 已死）时自动等 5s 重试一次；两次都失败才判 FAIL。

  就绪判据（两条都必须满足）:
    curl --noproxy '*' -s http://127.0.0.1:P/api/users/setup-status
      → 200 且 JSON（隔离新库时 data.needsSetup=true）
    curl --noproxy '*' -s $SIM_BASE/api/nodes → JSON 数组

────────────────────────────────────────────────────────────────
第 3 步 · 评测套件（按序执行，每项独立判据；任何一项 FAIL → 停）
────────────────────────────────────────────────────────────────
  ① 静态层（约 10 秒）——论文-代码一致性，先于一切动态实验
     node bench/run.mjs --tier static --seed 42
     判据: 退出码 0；s2 论文一致性 = 100%。s2 < 85% → 停止，先修论文/代码失真。
     产物: bench/results/<runId>/report.md + report.html + run.json

  ② 一体化集成流水线（隔离冷启约 8–11 分钟，勿中断）——全功能主战役
     （隔离环境块已 export 的同一 shell 里）
     node bench/pipeline.mjs --profile integrated --seed 42 --cl-seeds 3
     判据: 退出码 0，且 stdout 末行「✅ PASS（pass 75 · warn 0 · fail 0）」。
       自举行应出现「模拟器未在线 → 自动启动」与
       「平台未在线 → 分离启动 pid=... 隔离配置根 ...」。
     ⚠️ 重跑协议（对 warn 的既定处置）: 若末行为「pass 73 · warn 2 · fail 0」且
       warn 全部落在 P10 双拉使命（biax-mission-*），这是已知的双拉物理层残余
       非确定性（断膜级读数触发守卫后如实终止，§1.8）——不算 FAIL，但必须
       同命令重跑一次：重跑得到 75/0/0 → 首轮照实记为 warn-run 并写入报告
       「限制」小节；重跑仍 warn → 如实报告并停止，不得第三次盲跑。
       任何其他阶段的 warn/fail → 按失败处理，停止并诊断。
     覆盖（真实投产路径的 14 阶段）: 五协议多产线供给与节点绑定 → 数采/数控写+
     回读 → F5 拦截 → Agent 工具闭环 3 轮收敛 ×4 线 → 工艺参数映射层 P4f →
     AgentTeam 优化任务（任务板下达目标→daq_query 时段读数→受治理下发→物理
     随动→达标收口）→ 优化记录/回退/参数台账 → HITL 审批 → 治理只读面 →
     配方生命周期 → cast-film 闭环寻优(3 seeds) → 向量/图像帧 →
     跨场景可移植(film-line, 0 代码改动) → 系统兜底 drilling →
     双拉产线 P10（biax 全线 9 设备五协议 49 信号：探测补建→多节点建线→
     AgentTeam ≥3 执行节点闭环寻优厚度 25.0±0.7μm）→ 团队调度/团队记忆/引擎注册表。
     报告专章（论文 exp 与对外展示直接引用）:
       report.md 内含 **Simulated production line profile**（模拟产线画像：场景工艺
       叙事、每台 PLC 的协议与端点、SP 可调控参数/PV 过程量全清单含单位/量程/精度/
       策略、平台侧 DCW/DAQ 节点映射）与 **AgentTeam closed-loop tuning
       walkthrough**（组队→绑定→目标下达→逐轮调优轨迹表 biax/P6→治理写与拒绝→
       收口）两章；line-profile.json 为同一画像的机器可读版。
     可选真引擎: 同命令加 `--agent omp`（或 opencode/codex/…）→ 两层智能证据
       （P5 规定步闭环 + P5b 目标驱动寻优；需模型凭据，轨迹落
       agent-loop-<harness>.log 与 agent-goal-loop-<harness>.log）。
     产物: bench/results/<runId>/{run.json, summary.json, report.md,
       dashboard.html, metrics.csv, line-profile.json, agentteam-mission.log,
       agentteam-biax.log}

  ③ 真实协议层（约 1–2 分钟）——能力评分面板（含 F2 冻结报警、断链恢复）
     node bench/run.mjs --tier plc --seed 42
     判据: 退出码 0；13 项检查全部 pass、0 fail；api-3 的 intercept_rate=1 且
       false_block_rate=0。
     （可选加跑接口层: node bench/run.mjs --tier api --seed 42；判据同 exit 0、9 项 pass。）

  ④ E1a 四臂消融（约 2–3 分钟）——治理机制的归因证据
     node bench/e1-lite.mjs --seed 42 --repeats 3
     判据: 退出码 0；full 与 no-readback 拦截 6/6，no-interlock 与 ungated 4/6 且
       windowBreach>0（越窗写被执行并入账），四臂 falseBlock 恒 0。
     ⚠️ 若 no-interlock 也 6/6 → 平台没带 AW_BENCH_MODE=1（§1.3），结果作废，
       重启平台重跑。
     产物: e1-lite.csv / run.json / report.md / report.html / figure-*.svg

  ⑤ 全系统功能普查（约 1–2 分钟）——API 全功能面
     node scripts/api-live-e2e.mjs 2>&1 | tee bench/results/apilive-<runLabel>.log
     判据: 退出码 0，末行「★ ALL PASS (60 passed)」。
     覆盖: Agent 模板 CRUD / Channel CRUD+装配 / task goal·loop·pipeline 三模式 /
       dispatch·report·complete·cancel 状态机 / token 作用域 403 / A2A+mailbox+
       消息历史 / WebSocket Hub / MCP initialize+tools/list / 级联删除。
     说明: 「持久化恢复」一节依赖上一轮遗留数据，无遗留时按项目语义诚实 SKIP
       （不算失败），跨重启持久化由第 6 步的重启演练单独验证。

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
  ③ 流水线层复现（必做：同命令再跑一次得第二个 runId）:
     node bench/pipeline.mjs --profile integrated --seed 42 --cl-seeds 3
     然后用流水线专用判定器（不要用 compare.mjs——它对 pipeline run.json 空转）:
     node bench/tools/compare-pipeline.mjs --a <首个 runId> --b <第二个 runId>
     判据: 退出码 0（REPRODUCIBLE，判定类 0 失败）。两次 verdict 同为 75/0/0；
       closedloop.agg 的 ratio 区间必须都落在 [0.966,0.973]；portability.agg
       五协议构成必须逐字段一致（J0/Jend 采样值与 biax 写数允许环境性浮动）。
       若首跑是 warn-run（§第 3 步②重跑协议），判定器会把两次差异如实列为判定类
       失败——此时以「干净跑 vs 干净跑」为准重比，并在报告中保留 warn-run 的
       差异明细作为非确定性披露。

────────────────────────────────────────────────────────────────
第 5 步 · 报告产出（审稿人级 MD + HTML，必做）
────────────────────────────────────────────────────────────────
  ① 各层单机报告已自动落盘（无需手工生成）:
     集成流水线 → bench/results/<runId>/report.md + dashboard.html
       （含模拟产线画像 + AgentTeam 闭环调优 walkthrough 两专章）
     plc / static → bench/results/<runId>/report.md + report.html
     e1a        → bench/results/<runId>/report.md + report.html + figure-*.svg
     需要重渲时: node bench/tools/render-bench-report.mjs <runDir|runId>
  ② 跨层总报告（一次完整执行卡 = 一份）:
     node bench/tools/build-final-report.mjs \
       --static <静态层 runId> --pipeline <集成干净跑 runId> \
       --plc <plc 层 runId> --e1lite <e1a runId> \
       --api-live-log bench/results/apilive-<runLabel>.log \
       --out bench/reports-archive/<UTC日期>-<标签>-final
     产物: report.md + report.html（零手敲数字，全部读自各层 run.json/summary.json）。
  ③ 报告质量清单（对照审稿人/期刊的期待，逐项自查后才算交付）:
     □ 钢印 verdict 与硬门禁结论（75/0/0、13/13、消融判据、REPRODUCIBLE 判定）
     □ 七证据层表：17 阶段 → 7 层 → 75 检查的完整映射与主结果
     □ 产线画像：场景工艺叙事、五协议端点、SP/PV 全清单（单位/量程/精度/策略）
     □ 闭环优化质量：J/J* 三种子、离线最优 W* 为分母、迭代/写次数/拒绝数
     □ AgentTeam 使命轨迹：组队→绑定→目标下达→逐轮调优→治理写→达标收口
       （agentteam-mission.log / agentteam-biax.log 摘录）
     □ 治理归因：E1a 四臂差异、24/24 拦截 0 误拦、参数账本 Agent 归因
     □ 诚实限制：双拉残余非确定性（含 warn-run 披露，如有）、三个 skip 子检查、
       J* 同源模拟器、仿真层级边界
     □ 复现命令与指纹：seed、git commit、harness hash、复现步骤原文
  ④ 版式自查: 用浏览器打开 report.html / dashboard.html——钢印、表格、KPI 条、
     时间线渲染正常，无溢出/乱码；打印预览一页宽度不破版。

────────────────────────────────────────────────────────────────
第 6 步 · 收尾与现场恢复（必做）
────────────────────────────────────────────────────────────────
  1) 停基准实例（隔离根实例，用与启动时相同的 --log 找 pid 文件）:
     node scripts/_audit/detached-start.mjs --port 3005 --log ../aw-bench-home.log --stop
     然后 curl 确认 $AW_BASE 已不可达。隔离根语义下常驻实例（3001 等）全程未被
     触碰，无需恢复。
  2) 若使用了共享配置根旧路：恢复原实例必须 netstat 按端口取 PID 后 taskkill，
     再按原端口原方式重启（勿用 --stop 盲杀，会误杀同根另一实例）。
  3) ⚠️ 永远不要删除 bench/results/ 或 bench/baselines/——冻结基线与
     「与基线逐位一致」的复现声明都以它们为前提。历史 runId 永不覆盖。

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
模拟器同理：`/api/nodes` 必须是 JSON 数组；HTML = 冒名（别的 web 服务占位）。

### 1.2 端口规则
- 基准默认 **3005**（隔离冷启专用位；3001 通常是常驻实例）；被占/被冒名时按 3010→3050→3060 顺延。
- **选定后所有命令用同一端口**：`run.mjs`、`pipeline.mjs`、`e1-lite.mjs`、`scripts/api-live-e2e.mjs`
  都支持 `--base`，也都读环境变量 `AW_BASE`——推荐 `export AW_BASE=...` 一次到位。
- `compare.mjs` / `compare-pipeline.mjs` 不需要端口（只读 run.json 文件）。
- 平台进程被占端口顺延（start.mjs 会 +1）**不会**被流水线感知：流水线只认 `--base` 指定的那个。

### 1.3 AW_BENCH_MODE=1 的时序
该变量只在**平台进程启动时**被读取。已在跑的平台不会因为之后 export 而获得消融开关。
漏掉的典型症状：e1-lite 的 no-interlock 臂拦截也是 6/6（应 4/6）——这是假绿，整份消融作废。
生产构建默认恒 full（旁路开关被 env 门控），所以生产演示不受影响。

### 1.4 判定类指标 vs 环境类指标
- **判定类（同 seed 必须逐位一致）**：F5 拦截/误拦、边界值、Eq.(1) 双分支、归因、回读一致性、
  SP 设定点回读、静态 20 锚点、产线/协议构成、portability 聚合、E1a 拦截率/越窗数/误拦数。
- **环境类（只记录、不设门槛）**：写时延 p50/p95、采样计数、数采新鲜度、闭环 J0/Jend 采样值
  （由采样过程变量计算）、双拉写次数与终值、wall time。
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
6. **DAQ 样本点形状**：`GET /daq/:id/samples?bucketMs=` 桶化返回 `{at, avg, min, max, cnt}`
   （`ORDER BY at DESC`），非桶化返回 `{at, value, state}`——读均值取 `avg ?? value`。

### 1.6 长跑服务的分离启动
Agent 工具的后台作业在回合结束/被回收时会连子进程一起终止——把平台/模拟器挂在 Agent 的
后台作业里，就会出现「日志停在半路、无 fatal 行、端口释放」的假死。
- 流水线自举的平台是 `detached:true + unref` + 日志重定向，Agent 回合结束不影响它；
- 需要手动起平台时用 `scripts/_audit/detached-start.mjs`（真分离，日志落文件，`--stop` 可停）；
  `--stop` 按启动时 `--log` 旁边的 pid 文件找进程，**必须传同一个 --log**；
- 手动起模拟器时确认它不挂在会被回收的作业里，重启后用 `/api/nodes` 探活。
- 陈旧锁：平台异常死亡会留下锁文件，`detached-start.mjs --stop` 或按手册清理后再启动。

### 1.7 配置根语义与隔离冷启（2026-09 起的标准路径）
- 配置根由 `AW_HOME`（env）决定；基准用独立根（默认 `$PWD/../aw-bench-home`）+ `AW_MODE=home`
  → 锁/SQLite/运行时设置完全独立，**同仓库常驻实例零接触**。
- 隔离新库首启 `needsSetup=true` 是正常形态：P0 鉴权自动「首注册即 admin」
  （admin@awshop.local/admin123）。已有库则照常 login。
- 隔离根冷启必须注入会话密钥（`NUXT_SESSION_PASSWORD`，bench 惯例值见执行卡）。
- 共享配置根旧路的两个坑（隔离后天然消失，仅供维护者参考）：
  ① 同根已有实例时 `start` 会**自动顶替**（停旧起新）——打生产实例前必须知道这一点；
  ② 顶替竞态下旧进程句柄未放净，新进程可能在 `initWorkshopDb` 处 disk I/O error 崩溃——
  `platform.mjs` 已带崩溃感知重试（fatal+进程死 → 5s 后重试一次）自愈；手动场景等旧进程
  死透再启即可。

### 1.8 双拉产线残余非确定性与 warn 语义
- **共享模拟器是头号禁忌（2026-09-20 sr8 实测根因）**：4010 上的共享 dev 模拟器被并行
  会话 preset 重置/重启会把全部 SP 清掉，表现为「每次受治理写后厚度立即塌 0、warm 复位
  后又复现」——与植物侧真实断膜难以区分。因此基准**必须用专用模拟器实例**（隔离环境块
  的 `SIM_BASE=:4011`），自举会以 `SIM_PORT` 跟随端口拉起专用实例。
- 根因史：cast-film 预设的 `feedDriftPerMin` 随机游走曾致同 seed 成败交替；已由
  「热态装载后清零扰动 + 断膜守卫」确定性化根修（`bench/lib/biax.mjs`）。断膜守卫
  （起跑健康门与使命中途卫兵共用 `recoverFilmBreak`）：warm 复位（零漂移，引擎会把
  运输线预填稳态 h0）+ 配方基线重下 + 每 5s 一拍等膜重成形（至多 60s，读数回 ≥15μm），
  每处至多 2 拍、全使命至多 2 个恢复事件；额度用尽仍断膜才如实终止（物理层残余随机，
  非治理缺陷）。恢复成功后任务照常收敛，判定不受影响。
- 处置协议：见执行卡第 3 步②重跑协议——warn 仅限 P10 biax-mission-* 时重跑一次；
  报告必须披露 warn-run 的存在与证据（`biax-mission-attained` 的 evidence 数组）。
- 机器判定：`compare-pipeline.mjs` 把 warn 视为判定类漂移（设计如此，防早期信号）——
  用干净跑 vs 干净跑比对；warn-run 的差异明细留作非确定性披露材料。

### 1.9 比对工具分工（用错 = 空转的 REPRODUCIBLE）
| 工具 | 适用层 | 说明 |
|---|---|---|
| `bench/compare.mjs` | `run.mjs`（static/api/plc）与 `e1-lite` 的 run.json | 判定契约表 JUDGE；对 pipeline 的 run.json **空转**（按 e1-lite 形状比出空表） |
| `bench/tools/compare-pipeline.mjs` | `pipeline.mjs` 的 run.json | 执行卡第 4 步③的机器化；用法 `--a <runId> --b <runId>`（位置参数会报错） |
| `bench/compare.mjs --selftest` | 阴性对照 | 证明门槛有牙，每次必跑 |

### 两条平台硬约束（流水线已内化，勿踩）

1. **采样受「活动产线批次」门控**：`daq-controller.sweep` 仅在 `lineRun.activeRun(node.lineId)` 为真时采样；
   而「开跑」要求配方**归属本产线产品且含工艺参数**。纯采集设备无法自成可开跑产线 →
   建模为**卫星数采**（DAQ 节点挂到主产线 lineId，随其批次采样）。
2. **工具级闭环必须用「有引擎」harness**：`mock` 走 MockAgentImpl，工具桥只会回退到协作工具族并抛
   「不支持该协作工具」（假绿陷阱）。故 P4 默认 `opencode`
   （仅直调 host 工具、不经 LLM、不需模型凭据），并先做 `my_industrial_nodes` 工具面自检。
   `--tool-harness` 可换 omp/codex/dsh/qwen/pi/… （实测除 mock 外全部支持）。

### 复现性

同 `--seed` 下**判定类指标逐位一致**（F5 拦截/误拦、闭环达成数、数采非空、产线/协议构成）；
时延与采样计数属环境性波动，只记录不设门槛。run.json 自带 `seed / harnessHash / gitCommit / reproCmd`。

---

## 2. 命令与参数速查（全部支持 `AW_BASE` / `--base`）

| 工具 | 常用参数 | 说明 |
|---|---|---|
| `bench/pipeline.mjs` | `--profile integrated\|quick` `--seed N` `--cl-seeds N` `--base URL` `--lines N` `--preset <名>` `--tool-harness <名>` `--agent <引擎> --provider <p> --model <m>` `--cl-write governed\|rest` `--cl-iters N` `--no-autostart` `--no-autostart-platform` | 一体化集成评测；`--agent` 跑真实 LLM 闭环（需模型凭据）；`--no-autostart*` 只复用在线服务 |
| `bench/run.mjs` | `--tier static\|api\|plc\|full` `--seed N` `--base URL` `--repeats N` | 能力评分面板（report.md+report.html）；`full` = static + api×N 轮 |
| `bench/e1-lite.mjs` | `--base URL` `--seed N` `--repeats N` | E1a 四臂消融（需平台带 `AW_BENCH_MODE=1`） |
| `bench/compare.mjs` | `--baseline <label[/sub]> --b <runId>` `--a A --b B` `--selftest` | 复现判定 / 任意两次对比 / 阴性对照；不需要端口 |
| `bench/tools/compare-pipeline.mjs` | `--a <runId> --b <runId> [--out <md>]` | 流水线层专用判定器（判定类/环境类两分；warn 计入判定漂移） |
| `bench/tools/build-final-report.mjs` | `--static --pipeline --plc --e1lite --api-live-log --out` | 跨层总报告（英文 MD+HTML，零手敲数字） |
| `bench/tools/render-bench-report.mjs` | `<runDir\|runId>` | 从 run.json 单一事实源重渲单层报告 |
| `scripts/api-live-e2e.mjs` | `AW_BASE=URL`（可选 `AW_E2E_TOKEN` 沿用身份） | 全系统 API 功能普查 |

---

## 3. 阶段编排（一体化流水线的 14 个阶段 = 真实投产路径）

| 阶段 | 内容（真实场景动作） | 为什么必须如此 |
|---|---|---|
| **P0 自举** | 探测/分离拉起**模拟器($SIM_BASE)与平台($AW_BASE)** → 平台鉴权（隔离新库自动注册 admin） | 消除"人工先起两个服务"的前置；任一自举失败直接 FAIL（不会部分通过） |
| **P1 工艺模型** | 应用预设 → 拉 W\*（离线最优 ground truth）→ 切 steady | 量化需要基准真值 |
| **P2 多产线供给（节点连接与绑定）** | 每协议一台设备：有 DCW 导出者自成产线（line+product+DAQ+DCW+recipe+开跑）；无 DCW 导出者作**卫星数采**挂靠主产线 | 真实投产的"建线与绑定"动作：节点接入、驱动实测、产线/产品/配方绑定 |
| **P3 集成** | 真实驱动数采落库（20s 有界等待窗，防冷启动首采慢的假 warn）+ 数控写/回读时延 + F5 越界写治理拦截（**穿透/误拦 = 检查 fail**） | E1 动态核在**多协议**下复验 |
| **P4 工具级闭环** | 用「有引擎」harness 直调 `daq_query → dcw_control → dcw_judge` **3 轮收敛**逼近窗口中心（每轮判定关记录；**不经 LLM**，确定性） | Agent 工具面的确定性核 |
| **P4m AgentTeam 优化任务** | 任务板下达优化目标 → 派发 worker → 经工具面 `daq_query`(from/to/bucket 时段读数) 分析 → `dcw_control` 受治理下发(开记录) → 物理随动轮询 → `dcw_judge` 收口 → 账本归因核验 → 达标判定(\|PV−目标\|≤容差) → report/complete/父任务聚合 | 「给 AgentTeam 一个优化目标,团队读写节点达成它」核心功能的直接测评 |
| **P4f 工艺参数映射层** | 用户/Agent 只按「工艺参数」读写工程量：参数面自动生成且无寄存器/dataType 泄漏 → 基准限界(常驻)+产品限界(活动批次)+配方窗口四层收窄联锁（越层 400 点名约束层）→ 参数写/读回 → Agent `param_control`(语义寻址/越层拒绝/未绑定拒绝/记录收口) | 「用户和 Agent 只管设工艺参数、边界逐层收窄」核心治理面的直接测评 |
| **P4b 回退与优化记录** | 优化记录判定 keep/rollback + **判定与执行分离** + 节点级单步回退 + 参数台账 | Sec. V 的调控闭环 |
| **P4c HITL 审批** | manual 绑定 → 下发**挂起** → 审批面板可见 → 裁决 → 解阻塞且 PLC 生效（换线执行，避开 P4b 回退冷却） | 审批门是论文核心机制 |
| **P4d 治理只读面** | 参数账本 journal（按 source）+ 审计 + 运维日志 + 报警 | 可追溯性的直接证据 |
| **P4e 配方管理** | 版本化（编辑→+1 版）→ 标记已知良好 → 回退历史版本（非破坏）→ 基准恢复 → 一键下发。**刻意排在 P4d 之后**：rollback-good 留下的回退锚（300s 同向冷却）若在 P4b 之前生成，会拒绝优化记录生命周期的上行写（实测踩过） | 配方全生命周期是治理主张的组成部分 |
| **P6 闭环优化 benchmark** | cast-film 孪生（6 执行器 + 5 传感器）多 seed 闭环寻优（受治理写路径），输出 J/J\*、迭代数、写次数、拒绝数 | **主指标**：闭环优化质量 vs 离线最优 W\* |
| **P7 多形态数采** | 向量轮廓帧 + 图像帧落库 | 数采不只标量 |
| **P8 跨场景可移植** | 切换第二个产线场景预设（film-line），用**同一套**委托/治理代码路径重跑 export→建线→数采→受治理写→F5 拦截→回读 | 框架主张「适配新产线=配置任务而非集成项目」的直接度量（0 代码改动） |
| **P8b 系统兜底 drilling** | 在第二场景刚体上：清场 open 记录 → Agent(auto) 开优化记录 → manual 冻结 DAQ 于窗外 → 等系统兜底（观察窗 120s + 30s 节拍 + 越限 3 采样）自动判定 rollback 并恢复记录基线 → 解冻并恢复第一场景 | 论文 I3（有界自治）的**动态证据**：system 判定 + 值回基线 |
| **P10 双拉产线全节点** | biax(BOPET) 全线数字孪生 9 设备五协议 49 信号（30 SP + 19 PV 全带工艺描述）：① 以预设蓝图 dry-run 为工程清单，对现场做按 id/信号/端口的**差分探测——缺失补建、漂移修复、停机拉起，不整包重置**（与 cast-film 现场共存）→ 热态装载 biax 物理引擎（清零随机漂移）；② 平台按真实 driverConfig 建一条全线产线（30 DCW + 19 DAQ，描述进 semantics→Agent 语义卡），配方 30 参数全窗纳管开跑；③ AgentTeam 任务板下达厚度目标 25.0±0.7μm → worker 在 ≥3 个执行节点（铸片速度/纵拉快辊/出口轨宽）上轮流受治理写 → 物理随动（运输滞后+一阶收敛）→ dcw_judge → 达标收口 | 「更接近真实双拉产线」的多节点闭环诉求直接测评；「PIPELINE 识别缺节点→自动补建」的工程化建线能力 |
| **P9 平台子系统** | 团队调度（mock lead+2 worker 未指派任务→派发→完成）+ 团队记忆 dedupKey 幂等 + 引擎注册表枚举/可用性探测 | MAS 协作、记忆、多引擎资产的可复现基准 |

### ⚠️ 闭环优化的反直觉约束（实测踩过，务必遵守）

1. **写入值必须不同于当前值**：`recipe-rollback-manager.afterWrite` 对 `prevValue === eng` 直接 `return null`，
   不产生优化记录 → 拿不到 `record_id`（后续 `dcw_judge` 无从判定）。
2. **连续写要换方向**：回退护栏对「同向重写」有冷却，同向会返回 `isError` 而无记录。
3. **manual 模式要并发发起**：`dcw_control` 在服务端 `await approvals.request()` **阻塞**等待裁决，
   因此必须「并发发起 invoke（不 await）→ 轮询审批面板 → 裁决 → 最后 await 回执」，顺序写会死锁到超时。
4. **DAQ 样本点形状**：桶化返回 `{at, avg, min, max, cnt}`，非桶化返回 `{at, value, state}`——
   读均值取 `avg ?? value`，取 `v` 之类字段恒 undefined。
5. **biax 收敛别调太快**：双拉厚度三旋钮（铸速/快辊/轨宽）系数取保守值（0.5/0.35/0.3），
   一轮全修正会 1~2 轮达标、多节点覆盖不足；且测厚仪在 TDO 出口下游 12m + 链速驻留，
   写后 **≥12s 才允许判稳**（运输滞后），过早读数会把上一步的 PV 当成本步效果。
6. **biax 随机漂移清零 + 断膜恢复门**：cast-film 预设的 `feedDriftPerMin`(0.15, gauss 随机游走)
   会被双拉引擎继承 → 热态装载后立即 `plant/reset {warm,disturbances:{feedDriftPerMin:0}}` 清零
   （确定性根修）；任务首写前检测断膜（读数 <10μm），恢复=复位+配方重下并**等待 ≥运输滞后**
   （读数回 >15μm 或 60s，至多 2 次）。偏离目标的稳态（如 28μm）是合法起点，交给闭环写收敛。
   残余非确定性与 warn 语义见 §1.8。

---

## 4. 三层执行模型（诚实降级）

| Tier | 名称 | 前置条件 | 测什么 | 失败语义 |
|---|---|---|---|---|
| **static** | 静态层 | 无（只要仓库） | 能力清单、**论文-代码一致性**（20 个常量锚点）、治理管线阶段顺序 | fail = 论文或代码失真，必须修 |
| **api** | 接口层 | 运行中的平台实例 | 真实 REST 夹具、语义卡、**F5 越界写+边界值+Eq.(1)双分支**、回读闭环+归因、数采新鲜度 | 实例不可达 = 全层诚实 skip（不伪造分数） |
| **full** | 统计层 | 同 api + `--repeats N` | static + **api×N 轮**（每轮独立夹具），合并报告：判定类指标取最严、逐轮 status/score 存档于 run.json.reps | 任一轮 fail → 合并 fail，退出码 1 |
| **plc** | 真实协议层 | api 前置 + **plc-node-simulator**（跟随 $SIM_BASE,基准惯例 :4011） | 五协议真实连通(导出 driverConfig)→**真实 Modbus 采样落库**→SP→PV 物理闭环→**真实链路 F5+边界**→断链-恢复演练 | 模拟器不可达 = plc 层诚实 skip |
| **E1a 消融** | 四臂跑批(独立脚本) | 实例以 `AW_BENCH_MODE=1` 启动 | `node bench/e1-lite.mjs --seed 42 --repeats 3` → full/no-interlock/no-readback/ungated 四臂×3轮 + 论文级 SVG 图 | 任一臂判定异常 = fail |

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

首选 §0 第 2 步方式 A（隔离根 + 流水线自举）。手动启动时：在隔离环境块已 export 的
shell 里执行 `node scripts/_audit/detached-start.mjs --port 3005 --log ../aw-bench-home.log --wait 90`；
模拟器 `cd plc-node-simulator && NO_PROXY="127.0.0.1,localhost" npm run dev`；
依赖服务（Timescale/MinIO/MQTT，可选）`docker compose up -d`——缺失时平台自动降级仍可测。

**就绪判据**：`/api/users/setup-status` 返回 `{"code":0,...,"data":{"needsSetup":...}}`
（隔离新库 needsSetup=true），且 `$SIM_BASE/api/nodes` 返回 JSON。plc-0 检查会自动应用
「film-line」预设（五协议设备 + SP→PV 一阶物理联动）。
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
| `report.md` | 同内容纯文本，直接贴 PR / 审计；集成跑另含产线画像与 AgentTeam 专章 |
| `run.json` / `summary.json` | 机器可读全量结果（含每项 metrics 与 evidence），供后续聚合与论文表格生成 |
| `line-profile.json` | 模拟产线画像的机器可读版（场景/协议/端点/SP-PV 全清单/节点映射） |
| `bench/reports-archive/<label>-final/` | 跨层总报告（§0 第 5 步）：审稿人级英文 MD+HTML |

### 阶段 F · 复现验证

见执行卡第 4 步。判定契约表在 `bench/compare.mjs` 的 `JUDGE` 常量中维护：新增检查时必须
同步登记其判定类指标，否则该检查默认全部判定类。

### 基线存档约定

`bench/baselines/<label>/` 存放"可信基线"快照（永不覆盖、只增不改），每个基线含：
`run-plc-*/`（`--tier plc` 完整运行的 run.json + report.md + report.html）、`run-e1lite-*/`
（E1a 四臂消融的 run.json + CSV + 论文级 SVG 图）、`BASELINE.json`（清单）。
当前基线 **`20260914-baseline`**（plc 全绿 13/13、overall 100.0、git `d6c824d`；e1-lite 四臂 ×3 轮）。
审稿人/用户只需执行执行卡第 3–4 步即可验证"结果与基线一致"。
历届报告的对外存档放 `bench/reports-archive/<标签>/`（只增不删）；
`bench/results/` 与 `bench/baselines/` 任何情况下不得删除。

---

## 6. 评分模型（透明、可审计）

- 每个检查产出 `score ∈ [0,1]` 与权重（F5 攻击/归因/论文一致性权重=3 或 2，抽样类=1）。
- 维度分 = 该维度下检查加权平均；总体分 = 全部非 skip 检查加权平均；等级 A≥90 / B≥75 / C≥60。
- **skip 不计分也不扣分**，单独列出原因——分数只反映"真实测到的东西"。
- 流水线层阶段权重：P0=1 P1=1 P2=2 P3=3 P4=3 P4f=3 P4m=3 P4b=2 P4c=2 P4d=1 P4e=2 P6=3 P7=1 P8=3 P8b=3 P10=3 P9=1；
  硬门禁：任一检查 fail 或任一阶段 fail → 总评直接 FAIL（分数只作参考）。
- 维度映射：D0 论文-代码一致性 / D1 数采 / D2 写控治理 / D3 智能体 / D7 审计归因 / D8 性能（D4/D5/D6 由 §8 全量实验覆盖，静态+接口层不虚评）。

---

## 7. 复现合同

1. 一切随机来自 `--seed`（mulberry32，与产线模拟器同族 PRNG）；
2. 每次运行落盘 `bench/results/<runId>/`，**永不覆盖**（runId 为 UTC 时间戳），含 configHash=sha256(tier+seed+only+repeats)；
3. 夹具 tag 隔离（`awb<seed><ts>`），重复运行零冲突；teardown 只停不删，证据链留存；
4. 平台版本 tag + Node 版本 + 时间戳写入 run.json；
5. 复现 = 同命令重跑 + `bench/compare.mjs`（static/api/plc/e1a 层）或 `bench/tools/compare-pipeline.mjs`（流水线层）出机器判定：判定类指标必须逐位一致，时延类允许环境性波动、只报告不设门槛。

---

## 8. 从 E1-mini 到 E1–E9 全量实验（Agent 后续任务路线）

当前 `bench/run.mjs` 覆盖 **E1 的动态核**（F5 拦截 + 回读 + 归因）。全量论文实验按
`docs/experiments/01-test-and-benchmark-master-plan.md` 推进：E1 全矩阵（4 治理臂 × W1/W3 ×
T1–T4 × N20）→ E2/E3/E4 → E5 检测 + TEP/SWaT 回放 → E6 HIL → E7 框架基线
（AutoGen/LangGraph/CrewAI 经 MCP 挂同工具）→ E8 HITL 语义 → E9 跨引擎
（codex/claude/gemini/qwen/opencode/pi，invariant_pass 必须=100%）→ paper-gen：CSV →
`paper/tii/results-macros.tex` 宏替换（**论文零手敲数字**）。
统计协议（全实验通用）：每配置 N≥20（mock）/ N≥10（真 LLM）；Mann-Whitney U 双侧 + Holm
校正；中位数 + bootstrap 95% CI；表脚注记录 harness/模型版本/温度/prompt 哈希/日期/硬件。

---

## 9. 排障速查

| 症状 | 处置 |
|---|---|
| `api-0` skip: 实例不可达 | 确认实例端口；`NO_PROXY=127.0.0.1,localhost`（本机 7890 代理会拦截 localhost） |
| api-live 报「用户注册失败」即退出 | 忘了 `export AW_BASE=...`——所有工具都读 `AW_BASE`，先 export 再跑 |
| 平台"在线"但所有请求 404/形状不对 | **端口被别的服务冒名**——回 §0 第 1 步做身份判别，换端口 + `AW_BASE` 重跑 |
| 平台启动秒崩「disk I/O error」 | 共享配置根顶替竞态；`platform.mjs` 自举已自动重试一次自愈；手动场景等旧进程死透再启；根治=隔离根（§1.7） |
| `needsSetup:true`（以前是 false） | 隔离新库的**正常形态**，P0 会自动注册 admin；不是故障 |
| 消融的 no-interlock 臂也是 6/6 | 平台没带 `AW_BENCH_MODE=1`（必须在平台进程启动前 export），重启平台重跑 |
| 鉴权失败 | 隔离新库走自动注册（admin@awshop.local/admin123）；已有库用 `AW_ADMIN_EMAIL/AW_ADMIN_PASS` |
| `api-1` 某步 4xx | 看证据里的 `code/message`（BIZ 错误透传）；常见：模板 key 重复（tag 已随机化，重跑即可） |
| `api-3` 出现穿透 | **停止实验**——这是产品级治理缺陷，先修复 dcw-controller 联锁，再重跑 |
| samples 为空 | mock 采样需数秒起稳（检查器已内置等待）；确认 gateway/enable/start 已调用；确认产线批次已开跑（硬约束①） |
| P10 出现 2 warn（73/2/0） | §1.8 双拉残余非确定性：按执行卡第 3 步②重跑协议处置并披露，不算 FAIL |
| compare.mjs 对流水线跑出"空表 REPRODUCIBLE" | 用错工具：流水线层用 `bench/tools/compare-pipeline.mjs --a --b`（§1.9） |
| 服务在 Agent 回合结束后消失 | 服务被挂进了会被回收的后台作业——改用流水线自举或 `detached-start.mjs`（§1.6） |
| 端口占用 | 与既有实例/探针冲突（避开 3000/3001/3002）；`AW_BASE`/`--base` 指向实际端口 |
| compare 报 harnessHash NOTE | 源码在两次运行间有改动，合法；核对判定类指标是否仍逐位一致，一致即可放行 |
