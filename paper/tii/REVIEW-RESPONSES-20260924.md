# 审稿攻击点 × 项目真实机制对照答复（2026-09-24）

> 方法：五路并行代码考古（写入治理 / 审批与回退 / 证据链 / LLM与语义面 / 评测资产），每条结论落到 `文件:行号`。
> 标记：✅ = 机制/资产在手，可正面答复（多数是论文没写出来的）；🟡 = 部分在手，需收敛措辞或补小 drill；🔴 = 项目确无对应物，答复方向 = 如实限定 + 给出最小工程/实验动作。
> 配套：攻击点定义见 `REVIEW-ATTACK-SURFACE-20260924.md`；本文件每一条答复都必须能追溯到本仓库代码，禁止引用不存在的设计。

---

## 全局利好发现（先看这五条，多个攻击被代码直接反驳）

1. **审批超时 = fail-closed 默认拒绝。** `tool-approvals.ts:73-82`：超时即 `approved:false`，工具返回"指令未执行"，不产生任何写入，过期记录持久化。红队追问的"expiry 后行为"答案是：**abort**。
2. **backstop 的补偿写入有回读确认。** `recipe-rollback-manager/03-rollback.ts:164-175`：回退经写网关下发，`outcome.ok===false` 即抛"回退下发未通过回读校验"；`rolled-back` 状态只在回读通过后落定，失败停在 `judged` 并把原因写进 judge.reason。审稿人"补偿无设备侧确认"的攻击不成立——**机制在，论文没写**。
3. **binding 模式切换有产线级权限门，且 agent 身份无法触达。** `binding-authz.ts:39-57` `requireBindingAccess`：文件头注释明写修复动机是"任意登录用户可把 manual 改成 auto，即摘掉人类审批闸门"；现在 dcw 绑定需 operate、admin/editor 才放行。agent 工具 token 只能调用工具，没有 binding 写 API——"被治理者自我开通免审通道"的路径比审稿人描述的窄。
4. **AW_BENCH_MODE 只能旁路软层，硬量程结构性不可旁路。** `05-write.ts:43` `includeSoft:false` 只旁路 param/product/recipe 三层；node 硬层（L46 跳过条件仅 `skipRecipe`）+ `dcw-node.ts:113-119` validateEng 双保险恒在。且旁路口只有 manual REST 一条（`write.post.ts:22-26`），agent 工具路径无 benchArm 透传。
5. **治理开销差分臂其实已经跑过。** `bench/e1-lite.mjs` 四臂（full / no-interlock / no-readback / **ungated**）每臂每轮 20 笔计时写——full 与 ungated 的延迟差就是治理开销，数据在归档 CSV/JSON 里可直接导出。"无开销分母"的攻击可以现答。

---

## S 级攻击对照

### S1 全链路自指评测
**真实资产：**
- 四臂消融含 ungated 真无治理臂（上，利好 5）；`bench/lib/checks/api-3-interlock-f5.mjs`：6 类 seed 化攻击 + 3 窗内合法对照 + **3 个边界值探针（窗沿 max / max+0.1 / min−0.1，L57-61）** + Eq.(1) 双分支覆盖（停线后全局量程接管，L71-80）。e1-lite 全程 = 12 组 × 72 攻击 × 36 边界探针。"没有边界探针"的攻击不成立。
- 多 seed：`bench/pipeline.mjs --cl-seeds`；归档 `bench/reports-archive/20260922-paper-perfect/benchmark-report.md`：3/3 seeds 收敛、J/J* ∈ [0.968, 0.971]（mean 0.969）。
- **Oracle 可披露可复现**：castfilm `plant-model.ts:282-300` `gridSearchOptimum`（GET /api/plant/optimum）；biax `biax-model.ts:256-257` 闭式解网格（约 12 万点，<1s）。J* 不是黑箱。
- 策略与仿真器隔离：确定性策略输入 = DAQ 观测通道 + 写网关，不读引擎真值（truth*.jsonl 只落盘作审计）。
- **套件能抓真 bug 的实证**：`dcw-controller/03-crud.ts:72-81` 审计记录 decimals=101 → PLC 已写但无锚点无写历史，被检查套件抓出并修复（decimals 收紧为 0..6）——"author-defined checks 只能证明代码对"的反例。
- 真实 LLM 归档含失败轮（天然阴性对照）：`20260922162616-x78` 第一轮三线全部未达标且**保留失败对照轮**（20260922160301-10u4）；`20260922224947-12q8` 注塑 COMPLETED 但带外+缩痕违约、WWTP CANCELED——"task 状态与达标分离"有真实实例归档。

**答复方向：** 给出 J* 网格定义与边界探针证据；用 x78/12q8 失败轮论证"判据会失败且被如实记录"；策略盲性声明（只经治理 API 观测）。
**缺口：** 🔴 TEP/SWaT 无任何代码（仅 `bench/configs/e5-anomaly.yaml` 路线图占位）——要么补一个 replay 臂，要么把引用降为 future work；🟡 初始态随机化只有噪声 seed（plantReset 回同一蓝图起点）——`POST /api/plant/reset` 支持 params 覆盖，扩初始态是小活。

### S2 Agent-Team 品牌与证据倒置
**真实资产：**
- LLM 归档四路 jsonl（timeline / worker-stream / setpoints / quality）：`term.init` 帧含 `harness:"omp"`，消息帧含 `provider:"ustc", model:"deepseek-flash"`——**引擎与模型身份可从归档直接读出**，"匿名"攻击可用归档反驳。
- 权限门控逐条拒绝的实测证据：`wwtp-timeline.jsonl:29`（越权请求被逐条拒绝的全记录）。
- 冲突自愈：`FINAL-REPORT.md` 记录多频道同写一条产线时 agent 自发停写避撞。
- 14 引擎注册表与热切换属实：`agents/registry.ts:109-236`（恰 14 个）、`runtime/manager/10-admin-agents.ts:219-243`（探测+卸载重载）。

**答复方向：** 论文从归档披露引擎/模型；明确"governed path 为主语、team loop 为演示"的证据边界；引 wwtp-timeline 越权拒绝与冲突自愈作 agent 层行为证据。
**缺口：** 🔴 lead 分解/N-plan/检索命中等 team-level LLM 指标无——需一次跑在有归档谓词的 mission harness 内的 LLM mission（平台侧已支持：optloop.mjs 通道+goal 任务模式即为此设计，只是谓词要在场景侧登记）。

### S3 探针同源 / 拦截同义反复
**真实资产：** 边界探针、Eq.(1) 双分支、六类攻击 seed 化生成器（mulberry32 数值抖动，非固定值清单）、每线每协议 P3 硬门（拦截 100% + 误拦 0%）、四臂消融中 no-interlock 臂证明拦截归因于联锁层。
**答复方向：** 探针值由攻击类生成器按夹具窗口独立推导；边界三探针专测决策边界；no-interlock vs full 的差异即"联锁在拦截中起作用"的机制归因。
**缺口：** 🔴 单位错配探针、经 agent 工具路由的越窗探针、跨参数探针均无（小工程：在 api-3-interlock-f5 加三类用例）；🔴 五来源×检查项矩阵测试无——**且必须先修正论文措辞：代码写来源只有 4 条受治理路由（`closed-loop.ts:11` manual/recipe/agent/rollback，单咽喉点 `05-write.ts:22-133` 头注"不存在旁路来源"），第 5 条 heartbeat 不走 write()、重发已准入值（`dcw-runtime.ts:102-117`）——论文"five write sources"必须改为"four governed routes + heartbeat re-dispatch"**。

### S4 证据链自身有洞
**真实资产：**
- 双账本结构真实：`closed-loop.ts:29-43` 锚点（proposal/actor/source/timestamps/approvalId/taskId）+ `:92-120` 优化记录（hypothesis、params from→to、状态机 open/judged/rolled-back/superseded、judge.by、rollbackOf 回指、policy）。
- 第二证据链：audit_log 34 处埋点（`ops/ops.ts:57-78`，actorKind user/agent/system、ops.log WS 帧）+ Agent 自查工具 `ops_log`/`recipe_log`（`ops-tools.ts:51-149`，可回答"谁、经哪个 Channel、哪个成员、何时"）。
- 备份：每日三库快照 7 份轮转、wal_checkpoint+原子落盘（`server/plugins/backup.ts`）。
- bench 结果 append-only + harnessHash（13 个检查器源 sha256）+ gitCommit（`bench/run.mjs:49-57`）。

**答复方向：** 以双账本+第二审计链+自查工具回答"证据系统是什么"；以 harnessHash/gitCommit 回答工件可追溯。
**缺口（认账并给出动作）：** 🔴 **"signed history" 无任何代码对应物**（全仓无签名/哈希链/WORM）——撤词或实现记录哈希链（工程量小）；🔴 **"a verdict is never rewritten" 非机制事实**——`02-judge.ts:23` 直接赋值、`03-rollback.ts:137` 回退失败改写 judge.reason、`01-lock.ts:22` 孤儿接管补写、records 环形淘汰 cap 2000——措辞必须收敛为"判定可归因、更正可追加、不可静默替换"或实现不可变字段；🔴 run id 缺（锚点有可选 recipeRunId 仅配方路径、手动/agent 写为 null；OptimizationRecord 无 runId）——补字段是小活；🔴 write-ahead intent record 无——先落意图再动作，小工程；🟡 **audit_log 90 天 retention 会删除审计数据**（`retention.ts:25-29`）——论文需披露；🔴 BOPET mission 时钟缺失（`biax.mjs:291` 输出无时间戳、轨迹无时刻列）——补时间戳重跑或如实披露；🟡 simulator 侧只记 URL 无树指纹——补内容哈希。

### S5 无对照 / 无分母
**真实资产：** ungated 臂（真·无治理写路径，三旁路锚点 `bench/README.md` §5）；确定性控制器臂 `closedloop.mjs:166-178` scriptedPolicy（质量守恒反演+步长限幅，头注"无 LLM，可复现"）；四臂计时写 → full−ungated 延迟差 = 治理开销（数据已归档）；**接入成本已有量化**：模拟器子模块 git `04d7d5e`（注塑+污水+退火，10 文件 +2141/−192）、`f86653d`（biax，10 文件 +1363/−71），平台侧 "0 code changes" 可移植性检查（`pipeline.mjs:1181`）+ ensure untouched 计数入报告。
**答复方向：** 治理开销从 e1-lite 归档直接导出一张表；复用性用两个 git commit 的 diff 统计 + 三步蓝图契约（`PIPELINE.md` §10：dry-run 蓝图 → 按 id 差分补建 → 引擎 upsert）作量化证据。
**缺口：** 🔴 PID/爬山/固定配方独立臂无（Q3 只能称 deterministic policy，不得称 PID）；🔴 naive 集成对照臂无——用 git 数字替代并在摘要降级"integration work"措辞为假设。

---

## A 级攻击对照

### A1 HITL 可自配绕过 / 无真人入环
**真实资产：** 上方利好 1（超时 fail-closed）+ 利好 3（binding 权限门）+ decide 端点 `approved` 必须显式布尔（v17 修复"缺省即批准"）+ Channel 归属与资格快照（`hitl-decision/visibility.ts:33-65`）+ 批准后二次绑定校验（`param-tools.ts:103-105` 等）+ 独立 maker-checker 双人复核 `approval-gate.ts:25-67`（申请人≠批核人、一次性核销，4 个高危 REST 端点可配，默认关）+ 真人 UI 形态（Town Agent 面板 1s 轮询审批 + HITL 待办中心 `HitlBell/NotificationCenter`）+ e2e 批准闭环 P4c（`governance.mjs:198-248`，461ms 时延归档）。
**答复方向（核心三句）：** ① binding 的创建/改模式/撤销是**用户侧**产线权限动作（requireBindingAccess），agent token 无 binding 写 API——"被治理 agent 自我开通 automatic"在机制上不可达；② 审批默认 fail-closed：超时=拒绝=不执行；③ 双人复核闸门已实现、生产部署可开启（默认关如实说）。
**缺口：** 🔴 独立 line-scoped approver 角色无（论文已自认——维持）；🟡 拒绝/过期 e2e 用例无（机制在，补两条 bench 用例即可）；🔴 真人审批研究无（降为 future work 或做 5-10 人小实验）。

### A2 审批-执行 TOCTOU 语境脱钩
**真实资产：** 批准后二次绑定校验存在；执行时区间**现取当前活动 run 不缓存**（`05-write.ts:29-46` → `assertWithinLimits` 每次执行时解析）。
**如实承认：** 🔴 recipe 切换**不会**使 pending 审批失效（`cancelPendingFor` 仅解绑/删节点触发）——人批 I₁、执行 I₂ 的窗口真实存在，但有两级既有缓解：值仍必须落在**新**窗口内（越窗即拒）、硬量程恒拦。
**答复方向：** 承认 + 指认两级缓解 + 工程修法 = 上下文版本号（recipe/binding 变更即失效 pending，小改动）+ 补 drill（批准后切配方，展示 abort）。

### A3 Backstop 三缺陷
**真实资产（三条里反驳两条半）：**
- **补偿写入有回读确认**（利好 2）——"记录显示已恢复而过程未恢复"的攻击被 `03-rollback.ts:164-175` 直接反驳。
- **de-arm 不是无脑封顶**：`MAX_AUTO_ROLLBACKS=2` 只约束 `policy==='auto_rollback'`；链满后系统照常落判定、转人工执行（`04-sweep.ts:56-67`）；另有 `approve_rollback`（人工批核）与 `observe_only` 两档策略——这是**配置化的降级路径**，不是恢复力消失。
- 计数语义需修正：`chainRollbackCount` 统计该节点全部来源的 rolled-back 记录、受 2000 条环形淘汰影响——论文 "retained" 一词必须改。
**缺口：** 🔴 de-arm/策略降级未写入 §limits（纯文字，先补再引）；🔴 慢响应时标下的 nuisance-reversion 分析无（用 `MIN_WINDOW_MS` 可配置性 + 快慢两个 fixture 各跑一次 drill）；🔴 错误 keep 结构性盲区属实（`04-sweep.ts:14` `listOpenRecords`）——答复=如实限定 + 指出 keep 后仍有场景级 guards 与独立监测报警（F2 drill：冻结 PV ≤2s 报警归档）+ future: closed-record 复查。

### A4 只管数值不管意图
**真实资产：** agent 可存配方版本（`ops-tools.ts:270-339`，需逐节点绑定+reason+审计）**但保存≠生效**：配方 apply/开跑需 admin/editor 角色 + 可选双人复核（`apply.post.ts:15-23`），且逐参数下发走写网关全量守卫（`07-recipes.ts:90-118`），保存时已对自身窗口校验（`05-write.ts:46` skipRecipe 注释）。
**答复方向：** "authorship ungoverned, activation governed"——配方保存有归属与审计，激活有角色门+复核+网关守卫，被操纵配方无法静默生效。
**缺口：** 🔴 跨参数/速率/步长检查无（`grep slew|rateLimit|联合约束` 零命中）——如实限定为 value-only governance（升格一级局限）或加步长约束（dcw 语义卡已向 agent 提示"单次调幅步进 ≤量程2%"但非强制）；🔴 in-window 对抗提案的执行前拦截实验无。

### A5 注入威胁模型
**真实资产：** "source-dependent" 的真实内容 = 写入路由差异（写锁只锁 agent/manual `05-write.ts:53-56`；agent 互斥与回退冷却只约束 agent 来源 `01-lock.ts:15-17`）+ 绑定鉴权只在 agent 工具面 + 值域联锁对任何来源恒在。记忆检索提示"与当前任务冲突时以当前任务为准"（`01-recall.ts:181`）。归档有越权拒绝实录（wwtp-timeline:29）。
**答复方向：** 按 RT-B 裁决改写为 **bounded-blast-radius 主张**："text is untrusted; only typed values at admission are trusted; a manipulated proposer is confined by per-binding scope, per-request interval recheck, and device-side limits"——每个成分都有 file:line。**删除**"met with source-dependent checks"的缓解暗示。
**缺口：** 🔴 注入 drill 无（goal/记忆投毒 → in-window 错误 setpoint，验证后果被限制在窗内——补一个用例）。

### A6 "advisory" 自相矛盾
**真实事实：** 写入确实直达设备。可指认的"plant-side veto"机制：驱动层拒绝（每个驱动校验+回读不一致判失败）、节点停用/网关暂停 409（`05-write.ts:29-34`）、validateEng 双保险（`dcw-node.ts:113-119`）、失败写不动账本并置 error 态。
**答复方向：** 删除 "advisory"，改写为 "subject to device-side limits, gateway/node state gates, and driver-level rejection, each recorded as separate evidence states"——四个成分全部可引代码。

### A7 demand-rate / safe state 零分析
**真实资产：** 最坏合法写速率其实有界且可论证：post-write hold 30s/节点（agent+manual）+ 在飞 409 互斥 + open 记录单持有者 + 回退同向冷却 409——每节点 agent 写上限 ≈ 每 30s 一次、且不排队（`05-write.ts:66-72` 快速拒绝）。心跳重发只发已准入值且持同一互斥锁（`dcw-runtime.ts:97-117`）。sweep 500ms+30s 非实时已声明。
**答复方向：** 写一段定性 demand-rate 论证（上面四个闸门的复合上界）+ 框架失效语义（网关暂停/line stop/备份与 retention 策略）。
**缺口：** 🔴 正式 hazard/LOPA 小节无——做一次 WWTP 场景的定性 LOPA 表即可（纯写作）；🔴 "alarm-style ISA-18.2" 措辞按 R1#11 改写为 "automatically actuated supervisory recovery action with ISA-18.2-style annunciation"。

### A8 语义卡标定防错
**真实资产：** 线性标定归一（scale≠0 拒绝，`shared/daq-protocol.ts:172-204`）、decimals 强校验（0..4/0..6，且有 decimals=101 抓错审计案例）、写容差按标定比例缩放（`01-actuation.ts:31-38`）、回读死区判读。
**缺口：** 🔴 单位/量纲一致性交叉校验无（`param-map.repo.ts:127` unit 直接透传）——小工程：param unit 与 node unit 一致性检查 + 单位错配探针。

### A9 测量模型
**真实事实：** 硬度/克重 = 每拍准稳态代数计算+高斯噪声、无化验延迟建模（`injection-model.ts:202-274`、`anneal-model.ts` step）；castfilm 有真 transportDelayS≈7.58s（truth.jsonl 实测）；freshness 以"Ns 前更新"文本进 agent 上下文（`industrial-context.ts:77,88`）但 **admission 无 freshness 门**。
**答复方向：** 场景措辞限定（WWTP DO/BOPET 测厚为真实在线量；注塑/退火质量量为模型推断值——这正是真实产线的 model-inferred 做法，可以正面表述而非遮掩）。
**缺口：** 🔴 admission freshness 门（小工程：lastAt 年龄超阈值拒绝/降级）；🔴 lab-delay 建模（或删该表述）。

### A10 AW_BENCH_MODE 旁路
**真实资产（比攻击描述的强）：** 见全局利好 4——只 manual REST 一口、生产恒 undefined、只旁路软层、硬量程恒在、agent 路径透传不了 benchArm。
**缺口：** 🔴 benchArm 不入 ops 审计（`05-write.ts:110-123` detail 无 benchArm 字段——一行工程）；🔴 归档证据运行大概率置位了它（`build-final-report.mjs:403` 用它启动）——论文必须声明取值，或重跑关键归档；🟡 连带修三处工件债：`render-biax-report.mjs:354` ungated 误标"去审批门"、`e6-hil.yaml:11` `out_of_range_writes` 指标无计算点、`s3-governance-pipeline.mjs:38` 读取已不存在的 `dcw-controller.ts` 单文件（过期检查会 ENOENT）。

---

## B 级攻击对照（紧凑表）

| # | 攻击 | 真实资产（file:line） | 判定 | 答复/动作 |
|---|---|---|---|---|
| B1 | n=1、无阴性对照 | `--cl-seeds` 多 seed 已归档（3 seeds [0.968,0.971]）；x78 首轮全败+12q8 两败 = 真实失败案例归档 | 🟡 | 论文改述"failure cases archived"；初始态随机化用 plantReset params 扩（🔴小做） |
| B2 | 并发无争用 | Channel 隔离+节点级 409/429/冷却/审批去重全部真实；同节点多主体语义有明确定义 | 🟡 | 补双 channel 同节点交错 drill（🔴新做）；BOPET 时钟补时间戳重跑（🔴） |
| B3 | 零扰动 | `POST /api/plant/{phase,reset}` 支持 disturbances（heaterDecay+feedDriftPerMin）；signals.ts stuckAt/spike/drift；断链演练+冻结量测 drill 全有归档（P8b backstop_latency 120.464s；F2 ≤2s 报警） | ✅资产在 | 组 mission 中途扰动臂即可；off-spec 核算 🔴 新增指标 |
| B4 | run 标识/换型 | 窗口归属制真实（`line-run.ts:18-28` ActiveLineRun、[setAt,closedAt] 窗、`lastStableBefore`）；OptimizationRecord 无 runId 属实 | 🟡 | 补 runId 字段（🔴便宜）；换型/双 run 交叠 drill（🔴）或收窄 domain 声明 |
| B5 | MOC 缺席 | apply 角色门+可选双人复核；binding 权限面；ensure-pass 是幂等蓝图接入（漂→PATCH 计数入报告，非静默改产配置） | 🟡 | 生产部署前提=外挂 MOC（扩成明确 precondition）；🔴 真洞：REST `recipes/[id]/index.patch.ts:11-22` 仅登录即可改配方——补 requireLineMode（一句话修） |
| B6 | J* 不透明 | gridSearchOptimum API 可复现（castfilm + biax 闭式网格） | 🟡 | 论文给出 J 定义与 J* 网格参数；≥3 维场景 🔴（biax 多旋钮可作） |
| B7 | 83 检查不可枚举 | `PIPELINE.md` 有 17 阶段→7 层→75 检查完整映射；decimals=101 抓真 bug 实证 | 🟡 | 附录导出检查→claim 映射表（从 PIPELINE.md 提炼）；正文降级为工程回归 |
| B8 | LLM 层不可审计 | 归档含 harness/model/provider/usage 帧（omp/deepseek-flash/ustc） | ✅ | 论文从归档披露；平台级 token 指标 🔴（metrics.ts 无，声明即可） |
| B9 | Reusable 无外部验证 | git diff 统计（+2141/−192、+1363/−71，各 10 文件）+ "0 code changes" 可移植性检查 + 三步蓝图契约 + ensure untouched 计数 | ✅最强资产 | 论文加 onboarding-cost 小表；第三方独立接入 🔴（或降级措辞） |
| B10 | R2R/APC 与 LLM-governance 文献双缺 | — | 🔴 | 补定位段：本系统=确定性强制基座（带设备 readback+工业台账的实体写入路径），CaMeL/AgentSpec/GuardAgent 的策略/裁判可编译其上；R2R prescription 纪律为近邻，增量为策略槽可插拔+跨协议证据层 |
| B11 | 对 DCS/MES 增量未证 | 四层联锁中 product/recipe 层为 DCS 单回路限值表达不了的条件限值 | 🟡 | 写部署拓扑段（框架在 DCS 之上、DCS 为最终权威）；跨参数联合约束实验 🔴 |
| B12 | 治理魔数 | `writeLockSeconds` 0-3600/节点可配（`dcw-node.ts:71,104`）、`rollback_min_window_ms` config 可配（120s 是缺省非硬编码） | 🟡 | 论文改为"configurable defaults"+各场景取值依据；敏感性分析 🔴 |
| B13 | 未评测能力陈列 | 记忆（FTS5+vec0+RRF+MMR）、孪生、插件、14 引擎均为真实实现，只是未测 | 🟡 | capability-status 表（evaluated/exercised/implemented-only）；摘要只留 evaluated 层 |
| B14 | 标题三词超载 | — | 🔴文字 | 标题主语改为 governed supervisory execution/write path |
| B15 | HMI 对比句 | — | 🔴 | 降为 untested hypothesis 或删除；与 A6 措辞联动修 |

---

## 答辩口径红线（不得引用/不得声称，考古确认不存在）

1. **"三区 210℃ 写穿"、硬件 PLC 闭环** —— 全仓无此工件；实机证据=软件模拟器上的真实协议栈（Modbus TCP 软从站 15040、9 点采样、SP 写 182℃、27s 收敛、F2 冻结，见 `bench/reports-archive/20260922-paper-perfect/benchmark-report.md:22`）+ agent 侧全真 e2e（.gw-allreal）。只能表述为 "real protocol stacks against author-implemented simulators"。
2. **"21.2min 入带"** —— 无对应工件；改用现存数字：castfilm 全程 ~22min/40 断言（docs/experiments/05）、goal-loop 498.99s/685.77s 3 次写收敛 52±0.8µm。
3. **signed history / immutable verdict** —— 无机制，撤词或先实现。
4. **"five write sources"** —— 代码为 4 条受治理路由 + heartbeat 重发已准入值（结构性旁路 admission），措辞必须改。
5. **PID 对照** —— 只有确定性策略臂，不得称 PID/经典控制器。
6. **"advisory setpoints"** —— 改为 device-side limits + state gates + driver rejection 表述。
7. **PID/TEP/SWaT/硬件在环** —— 均为 roadmap（e5-anomaly 占位、00-MASTER-PLAN D12），引用时必须标注 designed-only（`docs/experiments/07-tii-experiment-review.md:59` 自己就是这么认的）。

## 快修工程清单（按性价比）

| 动作 | 工程量 | 化解的攻击 |
|---|---|---|
| benchArm 写入 ops 审计 detail + 论文声明归档运行取值 | ~1 小时 | A10 |
| REST recipe PATCH 补 requireLineMode | ~1 小时 | B5 |
| "signed/immutable" 撤词（或记录哈希链） | 文字（或 1 天） | S4、红队 (E) |
| paper 五来源→4 路由+heartbeat 措辞 | 文字 | S3 |
| de-arm/策略降级补入 §limits + backstop 补偿回读确认写进正文（机制已在！） | 文字 | A3 |
| records 补 runId 字段 | 半天 | S4、B4 |
| 边界之外补三类探针（单位错配/agent 路由/跨参数） | 半天 | S3 |
| approval 过期/拒绝两条 e2e + mid-mission 解绑一条 e2e | 半天 | A1、A2 |
| 审批上下文版本号（recipe 变更失效 pending） | 1 天 | A2 |
| 单位一致性校验 + admission freshness 门 | 1 天 | A8、A9 |
| pending 失效 drill + 双 channel 同节点 drill | 半天 | A2、B2 |
| biax 输出补时间戳重跑 | 半天 | S4、B2 |
| 修工件债：ungated 误标 / e6 死指标 / s3 过期路径 | ~1 小时 | A10 |
