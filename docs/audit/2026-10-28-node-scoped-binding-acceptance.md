# 节点级写授权(双轨)× 三模式 —— 真实场景验收报告

- 日期:2026-10-28
- 结论:**已支持,真机验收通过**。节点绑定 = 点位写授权;活动配方负责工艺管控(窗口/目标/运行门);配方批次/账本记录逐节点下发历史,统一回退可恢复。
- 计划:`docs/plans/2026-10-28-node-scoped-binding-plan.md`(M1–M5 已实施)
- 证据:
  - `docs/audit/evidence/2026-10-28-node-binding-3mode/report.json`(真实 omp + Qwen3.5-9B,33/33 PASS)
  - `docs/audit/evidence/2026-10-28-node-binding-authz/report.json`(权限矩阵 E2E,40/40 PASS)

---

## 一、四个问题的直接回答

### 1. 是否支持 Agent 绑定 DCW 节点做节点分权?

**支持。** 授权面 `W(a) = dcw 绑定节点 ∪ 配方绑定覆盖的参数节点`:

| 操作 | 授权要求 |
|---|---|
| `recipe_trial`(带 overrides) | 本次覆盖的每个节点 ∈ `W(a)`;部分覆盖即拒并列出缺失节点 |
| `recipe_trial`(无 overrides) | 配方全部参数 ∈ `W(a)` |
| `recipe_apply`(整批) | recipe 绑定 ∨ 配方全部参数 ⊆ dcw 绑定面 |
| `recipe_update` / `recipe_rollback` | **仅 recipe 绑定**(节点绑定不授予版本权) |
| 直写 `param_control` / `dcw_control` | 恒拒(未注册/停用,不因节点绑定恢复) |

REST `POST /agent-tools/bindings` 已恢复 `kind='dcw'`:写向绑定需产线 `operate` 权限,首绑强制 `manual`,切 `auto` 必须 `PATCH {mode:'auto', confirm:true}`。工具注入面会把「本 Agent 的数控节点写授权面」拼进 `recipe_trial/apply` 的描述,模型无需先探测绑定面。

### 2. 是否还要绑整条 recipe 才能调一个回路?

**不需要。** 绑一个 DCW 节点即可对该节点做 `recipe_trial` / 整批覆盖内的 `recipe_apply`;不再要求把整条配方(全部参数)的写权限授予 Agent。配方绑定仍保留,用于「配方级操作权」(版本写入/回退/整批任意参数),两种绑定取并集。

### 3. 切换 recipe 时,当前运行的 recipe 能否继续管理 DCW?

**能。** 节点绑定 Agent 推荐传 `line_id`:服务端解析该线**活动批次**的配方;授权检查只看「本次覆盖节点是否 ⊆ 自己的点位绑定面」,运行门要求该配方正在执行,窗口/目标/产品限界全部来自**当前活动配方**。换配方不会让节点绑定 Agent 停摆;recipe 绑定 Agent 的行为不变(授权仍是配方级,不随换配方漂移)。

### 4. recipe 是否记录节点下发历史与回退?

**是。** 每次下发经配方批次落账:节点级账本记录 `prevValue → newValue`、`source`、`recipeRunId`、审批 id;配方侧有版本史(v1→v2→v3)。`recipe_rollback(version, dispatch=true)` 生成新版本并把目标版本参数整批重下发 PLC,账本记录回退批次。**边界(设计如此)**:节点绑定只授予点位写权,回退/版本操作需要 recipe 绑定(配方级操作权)。

---

## 二、真实场景验收(omp + Qwen3.5-9B)

环境:生产构建隔离实例 `127.0.0.1:3410`(version 0.8.5,`AW_HOME=D:/tmp/aw-node-scoped-20261028`),真实 omp 子进程,本机 LM Studio `qwen3.5-9b-32k`(32768 上下文),设备为内置 mock(无物理响应耦合)。为防止 9B 模型在编码型 harness 里被 `bash/glob/edit` 带偏,omp 以 `--no-tools` 启动,只注入任务所需的 host 工具(4–5 个)。

### 场景

| 项 | 配置 |
|---|---|
| 观察线 | 2 个数采节点 + 1 个 DCW;观察频道只绑数采 |
| 写入线 | 1 个数采节点 + 2 个 DCW(`A/B`);配方含 A、B 两个参数(60/60,窗口 50–70,单步 ≤4) |
| 三个 Channel | 观察(observe)/ 手动(manual)/ 自动(auto),均 omp lead |
| Agent 绑定 | 观察=daq;手动=`dcw A`;自动=`dcw B`;**三者在试验阶段都没有 recipe 绑定** |

### 结果(33/33)

| 断言 | 结果 |
|---|---|
| 观察模式任务 COMPLETED,结论含样本统计/窗口判读 | ✅(515s,零写) |
| 观察线账本条数不增、无写审批 | ✅ |
| 手动模式:频道 manual 钳位 → 人工审批卡 `ap-721f6611` 批准 | ✅ |
| 手动模式:点位写授权下发 `60→62℃`(无配方绑定),设备回读=账本值 | ✅ |
| 手动模式:试验不写配方版本(仍 v1) | ✅ |
| 自动模式:全链 auto,无任何审批卡 | ✅ |
| 自动模式:点位写授权下发 `60→62℃`,设备回读=账本值 | ✅ |
| 同一活动配方下 A/B 两条轨迹各自落账(不同批次) | ✅ |
| 配方定义升 v2(56/64),统一回退到 v1:`62→60` / `62→60`,ACK 2/2 | ✅ |
| 回退生成 v3(60/60),v1/v2 历史保留 | ✅ |
| 换配方 B:活动批次接管 DCW(A=52,B=64) | ✅ |
| 同一节点绑定 Agent 换配方后 trial B 的 B 点:`64→66℃`,无需新绑定/无审批 | ✅ |
| IDD 三插件启用、诊断/知识工具注册、后端 `/health` 200;未启动分析 | ✅ |

### 模型行为说明(非平台缺陷)

- 9B 模型把候选值选成了 `62℃`(提示词写的 58),依据节点语义/单步规则自行调整;断言按「窗口内、prev=60、设备回读=账本值」判定,不绑定具体数值。
- 手动/自动任务的工具链完成后,模型没有在 15s 内自行 `complete_task`;平台按既有任务状态机由运营侧取消收敛(报告中 `state=CANCELED, cancelledByOperator=true`)。控制链证据(审批/账本/回读)均已成立。这是本地小模型的收口行为,不是授权或下发缺陷。

---

## 三、回归矩阵(当前工作树)

| 层 | 套件 | 结果 |
|---|---|---|
| T0 | `npm run lint` / `typecheck` / `docs:check` / `i18n:check` / `readme:lint` | 全绿(docs 91/91) |
| T1 | `npm run test:unit` | **739/739** |
| T1 | `test:mcp` / `test:plugin-lifecycle` / `test:sdk-surface` / `test:twin-provider` / `test:skills` | 14/14 · 22/22 · PASS · 5/5 · 124/124 |
| T2 | 节点授权矩阵 `scripts/e2e-node-binding-authz.mjs` | **40/40** |
| T2 | 真实三模式 `scripts/e2e-node-binding-3mode-real.mjs` | **33/33** |
| T2 | 产线治理 `npm run test:e2e-line` | 44/44 |
| T2 | 三模式执行 `node scripts/e2e-execution-modes.mjs` | 34/34 |
| 未跑 | 优化器 live / 模型闭环 / 注塑闭环 / 本体真机 / IDD 结果库 | 本轮未跑(依赖更重外部条件;IDD 仅做集成面检查,未启动分析) |

---

## 四、边界与上线建议

- 设备为 mock:证明平台授权/审批/下发/回读/账本链路,**不等价于真实 PLC 工艺响应**;真实产线试点前需按 `aw-line-onboarding` 做协议/量程/回读标定。
- 节点绑定不授予配方版本权;回退/固化需 recipe 绑定。这是「点位授权」与「配方操作权」的分界,不是缺陷。
- S7 驱动仍为 stub;IDD 诊断 token 未配置(调用会 401),本轮未启动分析。
- 小模型 + 编码型 harness 建议 `--no-tools` + 最小 host 工具面;否则易被 `bash/glob/read` 带偏。

## 五、复现

```bash
# 权限矩阵(自起隔离 dev 实例)
node scripts/e2e-node-binding-authz.mjs

# 真实三模式(需 LM Studio qwen3.5-9b-32k;自起生产构建隔离实例)
npm run build
node scripts/e2e-node-binding-3mode-real.mjs
```

> 注:工作区由并行会话共享,本轮改动已被扫入提交 `698ef128`(并伴随 0.8.6 版本号);上表为当前工作树复跑结果,真实三模式证据生成于 0.8.5 构建,功能代码与当前树一致。
