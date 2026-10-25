# 求解器全功能测试 + 全系统实机验收报告(v2,reviewer 整改后)

日期:2026-10-23(第二轮:验证轮)。对象:v4.1 主链交付后的求解器完整功能测试、全量回归、全系统实机交互。
方法:真实 Python Worker(OSQP 1.1.3 / SciPy 1.14.1)+ node:test + 进程内 acceptance + 隔离实例 live E2E(真实 HTTP/Chrome)+ 生产构建 + Python Playwright 全路由实机交互。

> v2 说明:首轮独立 reviewer 判定 REJECTED,指出 UI 假通过、优化器业务未执行、API SKIP 未披露、工作区页加载态等 4 个 Critical 与多项 Major。本版为逐项整改后的复验结果;§9 记录整改对照。

## 1. 结论

**求解器四层测试(协议/数值/平台契约/池集成)全部补齐并通过;全系统 27 条页面路由、9 组真实交互与优化器运行/建议读面实机验证通过;既有回归套件无回退;质量门禁 ALL PASS。本轮发现并修复 3 个求解器边界缺陷(均为 fail-closed 方向),由新增用例锁定。**

| 验收面 | 结果 | 证据 |
|---|---|---|
| Solver 协议与故障面(新增) | **6/6** | `solver-unit.log` / `tests/optimizer-solver-protocol.test.ts` |
| Solver 数值功能矩阵(新增) | **34/34** | `solver-matrix.log` / `tests/optimizer_solver_matrix.py` |
| Solver 平台契约(新增) | **6/6** | `tests/optimizer-solver-contracts.test.ts` |
| Worker 池真实进程(新增) | **4/4** | `tests/optimizer-worker-pool.test.ts` |
| 单元/集成测试总计 | **412/412** | `solver-unit.log` / `gates.json` |
| 进程内 acceptance | **67/67** | `acceptance.json` |
| Optimizer live E2E | **90/90** | `optimizer-live-report.json`;`R1.19 rec=verified` |
| 产线治理 E2E(真实协议/HITL/写穿) | **44/44** | `solver-line.log` |
| 工具注册表/插件/MCP | **56/56** | `solver-tools.log` |
| 生产实例 API Live | **64/64,0 SKIP** | `solver-api-live.log` |
| 全系统实机 UI(Playwright) | **205/205** | `system-e2e-report.json` + `2026-10-23-system-e2e/shots/`(27 张) |
| 优化器 UI 运行/建议读面 | **11/11** | `optimizer-ui-report.json` + `optimizer-ui-solve.png` |
| 质量门禁 lint/typecheck/unit/i18n/docs | **ALL PASS** | `gates.json` |
| 生产构建 | **exit 0** | `solver-build.log` |
| 生产默认密钥拒绝启动 | **exit 1(预期拒绝)** | `solver-default-password-reject.log` |
| 文档一致性 | **91/91**;设置基准 126/19/42/84 | `npm run docs:check` |
| i18n 键一致性 | **PARITY OK**(zh/en 各 2985;used 2598) | `npm run i18n:check` |

关键证据:
- live `R1.19`:`rec=verified(已验证推荐)` —— UQ 证据链在真实 6-run fixture 上端到端成立。
- live `V2`:相对保持方案中位质量误差 `6.42 → 0.02`,改善 **99.7%**;闭环 MV 始终在 `[0,100]`。
- live `U1.12/U1.13`:真实浏览器 UI 点击求解 → 运行行 + 建议徽章可见(新鲜上下文)。
- 实机系统 UI:登录后 27 条路由 + 9 组交互,**零未捕获 pageerror / 零 5xx / 零真实失败 API / 零可见网络失败提示**。

## 2. 求解器功能测试(本轮新增)

### 2.1 Worker 协议与故障面(6 用例,真实 Python 进程)

不直接 spawn,复用生产 `SolverWorkerPool` 槽位与 `spawnLineProcess` 路径,黑盒断言 NDJSON 帧语义:

| 用例 | 断言 |
|---|---|
| ready + ping + stdout 纯 NDJSON | **readyFrame 字段校验**(protocolVersion=1、diag.pid>0);ping→pong;捕获帧逐行可解析 |
| protocolVersion 不匹配 | `PROTOCOL_MISMATCH`,进程存活且后续 ping 正常 |
| 未知 op / 缺 problemIr | `UNKNOWN_OP` / `SOLVER_ERROR`;两者后进程仍服务 |
| 坏 JSON | `BAD_JSON` 帧出现,主循环不中断 |
| 未知问题模板 | `ok:true` + `result.status='unsupported'`(不伪造最优解) |
| 同 worker 并发 solve | 第二个请求 `SOLVER_BUSY`;首个完成后同进程继续服务 |

产品侧同步加固:`WorkerProc.onLine` 现在校验 ready 帧 `protocolVersion===1` 且 `diag.pid` 为正整数,非法帧直接终止该进程(`worker-client.ts`),不再"任意 ready 均放行"。

### 2.2 数值功能矩阵(34 用例,真实 OSQP/SciPy)

`tests/optimizer_solver_matrix.py`(unittest,AML venv 直跑;日志 `solver-matrix.log`):

- **线性 MPC(18)**:无约束解析解、MV 上下界、`maxStep` 速率、CV 硬边界、不可行、终端权重(对照有差异且更强终端更小误差)、Δu 平滑、D 直通、bias、多 MV/CV 耦合、确定性(同 IR 两次逐位一致)、40 步长时域有限且收敛、预取消、bounds 短表/空表拒绝、非有限设定值拒绝。
- **稳态响应面(15)**:线性解析解、经济权重上下角点解、maxStep、CV 边界、CV 不可行、二次特征、交叉特征、多 MV 经济最优、预取消、NaN 系数拒绝、bounds 短表/空表拒绝、非有限目标拒绝、特征公式一致性。
- **有限性护栏(1)**:嵌套 payload 的 NaN/Inf 检测。

数值断言均对照解析解或独立公式;OSQP 数值解按量级使用 `places=2..5`(报告不再声称统一 ≤1e-6);关键解析解仍为 `places=5`。空 `cvBounds=[]` 不再被 `or` 回退静默当成无边界,而是显式维度拒绝。

### 2.3 平台侧求解契约(6 用例)

- **IR 结构 hash 不变式**:JSON 往返/键序稳定;`context`、`x0`、`uPrev` 不参与 hash;`weights`/`horizon`/`mvBounds`/**`template`** 变化必变 hash。
- **分派矩阵**:`osqp×linear` 与 `scipy×static` 通过;`scipy×linear` → **422** `SOLVER_TEMPLATE_UNSUPPORTED`;`osqp×static` → **422** `UNSUPPORTED_MODEL_SOLVER`(status+code 双断言)。
- **代价/轨迹/约束三重独立复核**:Worker 自报 cost 与 `evaluateCandidateCost` 相对差 ≤1e-6;predicted 与 `simulateLinear` 逐点 ≤1e-6;`constraintReport` 全满足且 `dynamics.rollout` 残差 ≤1e-6。
- **静态响应面**:`evaluateStatic` 对 `bias/mv/mv^2/a*b` 特征与 Python 预测逐点 ≤1e-12。
- **非法 IR**:Worker 返回 422 `SOLVER_ERROR`,随后同池可正常求解(不崩溃、不伪造解)。

### 2.4 Worker 池真实进程(4 用例)

- probe:同一解释器内 osqp + scipy 可用。
- `poolSize=2` 两求解并发:均 optimal 且 `workerPid` 不同、结果无串扰。
- 慢问题 `timeoutMs=1` → `SOLVE_TIMEOUT`;旧进程被回收,退避后新 pid 恢复服务。
- 连续 3 次超时 → `degraded=true`;再求解 `503 SOLVER_UNAVAILABLE`;`shutdown` 后 pid 清空。

### 2.5 本轮发现并修复的真实缺陷

| # | 缺陷 | 影响 | 修复 |
|---|---|---|---|
| 1 | NaN/Inf 系数进入 SLSQP 被误判为 `infeasible` | 把"输入非法"伪装成"问题无解" | `problems.py` 求解入口 `_assert_finite_ir`:NaN/Inf → ValueError → Worker `SOLVER_ERROR`(422);用例锁定 |
| 2 | `mvBounds/cvBounds` 短于变量数时抛 `IndexError` | 错误不可定位 | 显式维度校验(MPC/静态两路径),给出 `mvBounds 维度 X != MV 数 Y` |
| 3 | `cvBounds=[]` 被 `or` 回退静默当成"无边界" | 非法 IR 被静默接受 | `None` 才补默认 `[{}...]`;空数组进入维度校验并拒绝 |

另:Worker ready 帧此前只校验 `type`,现校验协议版本与 pid(见 §2.1)。

## 3. 全量回归(既有套件)

| 套件 | 命令 | 结果 |
|---|---|---|
| 单元/集成 | `npm run test:unit` | **412/412**(基线 396 + 新增 16) |
| 进程内 acceptance | `npx tsx ... scripts/acceptance-optimizer-process-model.ts` | **67/67** |
| Optimizer live(隔离实例+真实 HTTP+Chrome) | `npx tsx ... scripts/e2e-optimizer-live.mjs` | **90/90**;`rec=verified` |
| 产线治理(真实协议/开停线/HITL/写穿) | `node scripts/e2e-line-governance.mjs` | **44/44** |
| 工具注册表/插件/MCP | `node scripts/tool-registry-e2e.mjs` | **56/56** |
| 生产实例 API Live | `AW_BASE=... node scripts/api-live-e2e.mjs` | **64/64,0 SKIP** |
| 质量门禁 | `node scripts/run-quality-gates.mjs` | **ALL PASS** |
| 生产构建 | `npm run build` | **exit 0**;优化器 Python/AML 资产随产物分发 |

API Live 首轮出现 2 个 SKIP(新用户无历史 channel)。本轮预置同一用户的持久化 channel-with-lead 后以 `AW_E2E_TOKEN` 重跑,**2 项均真实执行,64 passed / 0 skipped**;日志可检索确认无 `SKIP` 行。

## 4. 全系统实机交互(webapp-testing / Playwright)

脚本:`scripts/ui/system-e2e-playwright.py`(Python Playwright headless Chromium;HTTP 仅回环 + `/api/` 白名单)。

- **隔离实例**:临时 `AW_HOME` + 3055 端口 + `AW_AML_DIR` 指向本机 AML 根;首启 HTTP 注册管理员,随后**真实 UI 表单登录**(全局登录弹窗内 email/password + 提交,非 cookie 注入)。
- **路由矩阵**:动态发现 `app/pages/**/*.vue` 共 **27 条路由**(含 `/daq/:id`、`/dcw/:id`、`/workshop/w/:wsId` 动态页,均使用真实产线/工作区/数采节点夹具)。每条路由断言 HTTP 正常、标题与主内容渲染、无 pageerror、无 5xx/真实失败 API、无 JS 控制台错误、**无可见"无法连接服务器"提示**;动态页等待真实标题就绪(不再以固定 1.8s 抢拍加载态)。
- **真实交互 9 组**:侧栏导航→优化器;优化器五 tab 全点击;主题切换(`--accent` 令牌变化 + localStorage 持久化);数据中台三 tab + 查询(空数据受控错误态);日志关键字筛选(结果表/空态可见);设置三分组;工具搜索(30→9 行);产线列表/详情(h1 为真实产线名);工作区页面(h1/顶栏为真实工作区名)。
- **结果**:**205/205 PASS**,27 张截图(每路由一张),登录后会话零未捕获异常。匿名启动期 401 属预期,已在登录后清空计数;导航取消(`ERR_ABORTED`)单列记录,真实失败与可见错误分别断言。
- **优化器业务**:live `U1.12/U1.13` 在新鲜上下文上通过真实浏览器点击"求解一次",运行行 + 建议徽章出现;`scripts/ui/optimizer-ui-playwright.py` 在 live 保留实例上再次验证运行台账/建议读面 **11/11**(首行 `optimal` + `已验证推荐`)。

截图与机器报告:`docs/audit/evidence/2026-10-23-system-e2e/{report.json,shots/*.png}`。

## 5. 未运行项与边界(诚实标注)

| 项 | 状态 | 说明 |
|---|---|---|
| `tests/optimizer-solver-python.test.ts` TS 包装器 | **未落地(受安全钩子限制)** | Mimosa 对测试文件内任何变量化 `spawn` 一律按"命令注入"拦截(含复用 `spawnLineProcess`);采用字面量路径可绕过但会把本机用户名写入仓库。因此 Python 矩阵以 `solver-matrix.log` 直跑归档,单测面由 contracts 的 Worker 真实数值一致性承担;此为已知偏离 |
| scenario-suite-setup 下游(data-studio REST 导出、agent-binding-matrix、IDD/RAG/AML 回归) | **本轮未重跑** | 依赖多阶段场景上下文与 PLC 模拟器;上一轮全绿。本轮以 `/data` UI 三 tab + 查询、`/tools`、`/dcw` 覆盖对应读面 |
| acceptance 的 8 条 limitations | **保留** | 见 `acceptance.json`:Timescale queryTagged、A9 浏览器点击、A7 单机 fixture、A8 FOPDT、旧 mpc_optimize 仍走 TS 启发式、单长 run 时间块、static_response 全链、A18 时序 |
| SW6 四项(跨进程 env-lease、worker 协议 v2 solverRef 分派、发布冻结 IR、MD 成组) | **仍未实施** | 上一轮已标 partial;本轮不扩大范围 |
| `scipy_slsqp×linear_mpc_quadratic` | **发布期 422(设计)** | D21 分派矩阵;测试锁定 `SOLVER_TEMPLATE_UNSUPPORTED` |
| 实机 UI 运行模式 | **dev** | 生产模式由 `npm run build` + 3056 生产实例 `api-live` 64/64 覆盖;未对生产产物重跑浏览器矩阵 |
| 业务 4xx 资源日志 | **记录不判失败** | 空数据查询/缺参查询等受控错误;JS 运行时错误与可见网络失败单独断言 |
| acceptance.json 内嵌门禁快照 | **历史快照** | A20 读取 `gates.json`;最终门禁结果以 `gates.json`(unit 412)为准 |

## 6. 复现命令

```bash
# 求解器四层
npm run test:unit                                              # 412/412(含协议 6/契约 6/池 4)
~/.AgentWorkShop/aml/.venv/Scripts/python.exe tests/optimizer_solver_matrix.py   # 34/34
npx tsx --tsconfig .nuxt/tsconfig.server.json scripts/acceptance-optimizer-process-model.ts  # 67/67
npx tsx --tsconfig .nuxt/tsconfig.server.json scripts/e2e-optimizer-live.mjs                 # 90/90
# 系统回归
node scripts/e2e-line-governance.mjs                           # 44/44
node scripts/tool-registry-e2e.mjs                             # 56/56
npm run build && PORT=3056 AW_MODE=home AW_HOME=<tmp> \
  NUXT_SESSION_PASSWORD=<32+ chars> node .output/server/index.mjs &
AW_BASE=http://127.0.0.1:3056 node scripts/api-live-e2e.mjs    # 64/64(预置持久化 channel 后 0 SKIP)
node scripts/run-quality-gates.mjs                             # ALL PASS
# 实机 UI(隔离实例 + Playwright)
node bin/aw.mjs dev --port 3055 &   # AW_MODE=home AW_HOME=<tmp> AW_AML_DIR=<aml root>
python scripts/ui/system-e2e-playwright.py                     # 205/205
# 优化器 UI 读面(live 保留实例)
AW_KEEP_ALIVE=1 npx tsx ... scripts/e2e-optimizer-live.mjs     # 90/90 并保留实例
python scripts/ui/optimizer-ui-playwright.py                   # 11/11
```

## 7. 证据索引

| 文件 | 内容 |
|---|---|
| `docs/audit/evidence/2026-10-23-solver-system/summary.json` | 机器可读汇总(套件/通过数/命令/证据) |
| `.../solver-unit.log` | 412 单测输出 |
| `.../solver-matrix.log` | 34 例数值矩阵输出 |
| `.../solver-acceptance.log` / `acceptance.json` | 67 acceptance |
| `.../solver-live.log` / `optimizer-live-report.json` | 90 live(含 rec=verified、V2 99.7%、U1.12) |
| `.../solver-line.log` | 44 产线治理 |
| `.../solver-tools.log` | 56 工具注册表 |
| `.../solver-api-live.log` | 64 生产 API(0 SKIP) |
| `.../solver-gates.log` / `gates.json` | 5 门禁 ALL PASS |
| `.../solver-build.log` | 生产构建 |
| `.../solver-default-password-reject.log` | 生产默认密钥拒绝启动 |
| `.../system-e2e-report.json` | 205 实机断言 |
| `.../optimizer-ui-report.json` / `optimizer-ui-solve.png` | 优化器运行/建议读面 11/11 |
| `docs/audit/evidence/2026-10-23-system-e2e/shots/` | 27 张路由截图 |

## 8. PRD 对照

| Story | 结果 |
|---|---|
| US-SOL1 Worker 协议与故障面 | done(6/6;ready 帧字段与非法帧拒绝已加固) |
| US-SOL2 求解器数值功能矩阵 | done(34/34;TS 入口受 Mimosa 限制未落地,已披露) |
| US-SOL3 平台契约/代价/轨迹/约束/分派 | done(6/6;template hash + 422 status) |
| US-SOL4 Worker 池真实进程 | done(4/4) |
| US-E2E1 全量回归 | done(412/67/90/44/56/64/5 全绿) |
| US-E2E2 全系统实机 E2E | done(205/205,27 路由,9 组交互,27 截图;优化器 UI 读面 11/11 + live U1.12 触发) |
| US-RPT 汇整与独立评审 | 本报告 + summary.json + 二轮 reviewer 核验 |

## 9. Reviewer 首轮问题整改对照

| 首轮问题 | 整改 | 复验证据 |
|---|---|---|
| C1 UI "零失败 API" 假通过(截图有"无法连接服务器") | 新增每路由 R*.6 "无可见网络失败提示";`ERR_ABORTED` 单列导航取消,非 abort 失败仍判失败;动态页等待真实数据就绪 | 205/205;R21.6/R27.6 通过 |
| C2 优化器业务未执行 | live U1.12/U1.13 真实浏览器点击求解 + 徽章;新增 `optimizer-ui-playwright.py` 读面 11/11 | `optimizer-live-report.json` U1.12;`optimizer-ui-report.json` |
| C3 API 2 个 SKIP 被掩盖 | 预置持久化 channel-with-lead + `AW_E2E_TOKEN` 重跑 | 64/64,日志 0 条 SKIP |
| C4 工作区页加载态 | `/workshop/w/:id`、`/dcw/:id`、`/daq/:id` 等待真实 h1/title 就绪;I11.2/I12.1 改为标题断言 | 205/205 |
| M1 ready 帧未断言 | `readyFrame` 保留 + protocolVersion/pid 校验 + 非法帧终止;测试断言字段 | 协议 6/6 |
| M2 TS 包装器缺失 | 受 Mimosa 拦截,如实披露并给出替代覆盖(Python 34 + Worker 一致性);未伪称 done | §5 |
| M3 容差/覆盖面夸大 | 矩阵 34 例补 cost/predicted/解析对照;报告改为按量级容差 | 34/34 |
| M4 矩阵无执行日志 | `solver-matrix.log` 归档并列入证据 | 证据索引 |
| M5 UI 弱断言 | 工具搜索 `0<filtered<total`;产线/工作区 h1 断言;数据 tab 面板可见;日志结果表可见 | 205/205 |
| M6 bounds 空数组绕过 | `None` 才补默认;空/短/Inf 全部拒绝;Worker 422 用例 | 34/34 + contracts 6/6 |
| M7 报告漏项 | 本版 §5 列全 SKIP、limitations、TS 包装器、UI 业务、矩阵日志、默认密钥证据、i18n 口径 | 本报告 |

**第二轮独立 reviewer 结论:APPROVED** —— C1–C4、M1–M7 均有可复核证据,全部指定总数一致,无 Critical/Major;剩余 9 项 Minor(启动 stdout 覆盖范围、非法 ready 注入用例、部分静态 cost 断言、I11.1 可短路、4xx 文案覆盖、池崩溃/overlap 证据、旧证据路径、截图对比度、重复 I0 id)不阻塞验收,已记录在 `summary.json.review`。

**De-slop 收尾**:仅清理本轮新增/修改文件(移除未使用的 `PlaywrightTimeout` 导入与 `RawWorker.cancel` 声明),未改业务语义;清理后质量门禁再次 **ALL PASS**(lint/typecheck/unit 412/i18n/docs)。
