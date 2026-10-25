# Optimizer / Process-Model 前后端与集成 Live 验收报告

日期：2026-10-23。对象：`docs/plans/2026-10-22-optimizer-process-model-plan.md`（v3.1）落地后的新增功能。
方式：**隔离实例 + 真实 HTTP + 真实浏览器（Chrome/puppeteer-core）**，不是进程内函数调用。

## 1. 结论

| 验收面 | 结果 | 证据 |
|---|---|---|
| Live 全链（REST + Agent 工具 + UI + Channel 矩阵 + 多场景 + AML 适配 + 闭环收益） | **90/90 通过** | `docs/audit/evidence/2026-10-23-optimizer-live/report.json` |
| 重启持久性（同一 home 重启后规格/Profile/绑定/求解） | **7/7 通过** | `docs/audit/evidence/2026-10-23-optimizer-live/restart-check.json` |
| 浏览器截图 | 5 张（规格/资格/Profile/绑定/运行） | `docs/audit/evidence/2026-10-23-optimizer-live/ui-0*.png` |
| 进程内系统验收（回归） | **67/67 通过** | `docs/audit/evidence/2026-10-22-optimizer-process-model/acceptance.json` |
| 单元/集成测试 | **344/344** | `npm run test:unit` |
| lint / typecheck / i18n / docs | 全部 exit 0 | `docs/audit/evidence/2026-10-22-optimizer-process-model/gates.json` |
| 生产构建 | 成功 | `npm run build` |

结论：**求解器、Process Model、AgentChannel、多场景与 AML 孪生适配均已真实跑通，并验证了数值收益**；测试共发现并修复 **5 个真实缺陷**（见 §5），修复后 90/90；另发现 1 个“模型单位语义”易用性缺口，已用 UI 提示收敛。

## 2. 测试环境与数据

- 隔离实例：`AW_MODE=home` + 临时 `AW_HOME`，独立端口，`aw dev` 启动；不触碰用户常驻实例。
- 三套场景种子（全部真实 TSDB 落库）：
  - **A 薄膜动态**：1 MV/1 CV，4 批 × 160 拍 × 5s，ARX 真值 `y=0.3y+0.7u_delay+8`（带噪声）。
  - **B 双变量 + 单位换算**：2 MV/2 CV，MV 以 `L/min` 采集、`m3/h` 建模（scale=0.06），4 批 × 160 拍；CV 为厚度/幅宽。
  - **C 退火静态**：1 MV/1 CV，`CV=f(MV)` 二次响应面、无动态记忆，4 批 × 160 拍。
- 时序库强制 SQLite（宿主机 Timescale 在线时插件会切到 Timescale，导致预置 SQLite 样本不可见；通过 `<AW_HOME>/runtime-settings.json` 的 `overrides` 指到关闭端口降级）。
- AML venv 用 junction 复用本机真实环境，不联网安装。
- 求解前写入“新鲜上下文尾巴”（24 拍 × beat），覆盖 `context.maxAge=1.5×beat`；TSDB 存**物理单位**，context 按 spec `scale/offset` 转模型单位。

## 3. 覆盖矩阵（90 条）

### 3.1 核心 REST + Agent 工具（46 条）

| 组 | 覆盖 |
|---|---|
| Process Model | 规格登记/列表/产线过滤；同版本改内容 409；stage 工况 422；发布；数据集 v2（524 窗）；manifest v2；资格评估/最新/历史；作用域错配 422 |
| 训练与模型 | 提交 → 轮询 done → `model_id` 两阶段登记；`linear_state_space@1` / 接口 / 64 位工件 hash |
| Optimizer | Profile 登记（工件字段服务端回填）/ 求解器-模板不兼容 422 / 发布；workspace+channel+mount；绑定创建/回读/模板 id 拒绝；capabilities；solve optimal；runs（IR hash/建议/载荷）；撤权后 409 |
| 零写/建议 | 求解前后 `dcw-writes.json` 不变；建议 `unverified` +「未验证(缺 UQ/OOD 证据)」 |
| RBAC | 非 editor 读 Profile 403；非 admin 读全局绑定/运行 403；无产线授权不可见/不可登记 |
| Agent 工具 | 注入面 5 工具；capabilities/solve/plan_get/status/cancel 真实 dispatch；终态 cancel 返回 `cancelled=false` |

### 3.2 浏览器 UI（15 条）

`/optimizer` 五 tab 全流程：规格（两变量）→ 数据集（524 窗）→ 资格（eligible/simulation/证据）→ 训练 → Profile（默认配置即服务端契约形状）→ 发布 → 绑定 → 求解（optimal + 未验证醒目标识）；非法 JSON 前端提示；全程无 pageerror。

### 3.3 AgentChannel 适配矩阵（12 条）

| 档位 | 结果 |
|---|---|
| legacy | 不注入 5 个新 optimizer 工具；直调 → `OPTIMIZER_CHANNEL_DISABLED` |
| aml_training | 不注入；保留训练工具；直调 → `OPTIMIZER_PROFILE_DENIED` |
| exp-miner 观察面 | 不注入；直调拒绝 |
| hybrid_twin + 绑定 | 注入（schema 含 `binding_id`）；真实 solve optimal |
| 同 Channel 两 Agent | 未绑定者只有 capabilities；各自绑定不同 Profile 均可求解；读他人 run → `BINDING_NOT_OWNED`；撤权后工具面立即收回 solve |

### 3.4 多场景（7 条）

- **静态响应面**（场景 C）：规格→数据集(544 窗)→资格→训练（`static_response@1`）→ Profile（`steady_response@1` + `scipy_slsqp@1`）→ Agent 求解 optimal；`mv≈63.6` 命中 CV 目标 55；静态工件配 OSQP → 422 `UNSUPPORTED_MODEL_SOLVER`。
- **双 MV/双 CV + 单位换算**（场景 B）：无代码训练→注册→Profile→Agent 求解 optimal；`firstMove={flow_a:4.25, flow_b:2.88}`（模型单位 m3/h，物理值 70.8/48.0 L/min），规格持久化 `scale=0.06/modelUnit=m3/h`。

### 3.5 AML 数字孪生适配（7 条）

- Twin Gate 通过的 AML 模型 → Channel `boundModelId` 绑定成功（`mode=model_backed`），注入 `mpc_optimize/twin_trial_run`；
- 未通过 Twin Gate/仍为 candidate 的模型 → 409 `AML_MODEL_STAGE`；
- 旧 ONNX 孪生工件可绑定 Channel（旧工具面兼容），但新求解器 Profile → 422 `UNSUPPORTED_MODEL_SOLVER`；
- **双闸门分离**：Channel 绑定模型不自动授权 `optimizer_*`（无 optimizer binding → `BINDING_NOT_FOUND`）；补 binding 后可求解。

### 3.6 闭环收益（3 条）

- 12 拍 Live 闭环（逐拍刷新上下文、只应用首步、真实 Agent 工具求解）：中位质量误差 **6.42 → 0.02（改善 99.7%）**，MV 始终在 `[0,100]` 工艺窗口。
- 进程内 A8 的 20 种子配对统计（动态 94.8% / 静态 42.2%）仍为统计口径证据。

### 3.7 重启持久性（7 条）

同一 `AW_HOME` 重启服务后：admin 可登录；规格（2 条）、Profile（6 条，含 published）、绑定（归属不变）仍在；用同一绑定再次 `solve` → optimal；工具面仍按绑定注入 5 个 optimizer 工具。

## 4. 系统设计现状评估

**成立的部分**：Process Model → 数据集 v2 → 训练 → 模型注册 → Profile → 绑定 → 求解 → 建议的分层清晰；求解器与问题构造同口径（TS 独立复算差 2.6e-16）；资格/作用域、绑定 revision/实例身份、执行期逐次重校验构成多层 fail-closed；Channel 档位门控在注入面与执行面一致；静态/动态两类问题族可仅靠配置切换；单位换算在数据集/上下文/有效域统一口径。

**边界（设计使然，不是缺陷）**：旧 ONNX 孪生工件只服务旧工具面，不能直接被新求解器消费（首版支持的工件类型是 `linear_state_space@1` / `static_response@1`）；Channel 的 Twin Gate 与 Optimizer 的资格/绑定是两套闸门，互不代替；求解器只产出建议，不授予设备写权限。

**仍需后续投入**：真实模拟器/物理线闭环（本轮为独立 plant + 真实 Service 链路）；跨场景统一 UQ/OOD 证据链；Timescale 的 `queryTagged` state/分页遗留项。

### 4.1 “自定义求解器”能力矩阵

| 能力 | 当前状态 | 证据/入口 |
|---|---|---|
| 选择内置求解器（OSQP / SciPy SLSQP） | ✅ | Profile `solverRef`；模板兼容校验（静态+OSQP → 422） |
| 自定义问题权重/目标/终端代价/Δu 权重 | ✅ | Profile `problemConfig`（嵌套模板键）；值目标 50→55 改变解，闭环验证 |
| 自定义规格（变量/单位换算/延迟/时域/有效域/工况/切分） | ✅ | ProcessModelSpec；A/B/C 三场景 |
| 自定义训练器 | ✅ 内置两个，配置驱动 | `linear_arx@1` / `static_response@1`；Twin TrainingAdapter 已接入真实训练 |
| 自定义求解器代码 / 第三方求解算法 | ❌ 首版不支持 | `SOLVER_REFS` 固定、`worker.py` 按问题模板分派；Twin `registerSolverAdapter` 存在但新 optimizer worker 未消费 |
| 自定义问题模板（插件 ObjectiveAdapter） | ⚠️ 半接入 | ObjectiveAdapter 已注册，但 `problem-builder` 仍按两个内置模板硬分派；插件模板不会被 optimizer 执行 |
| 请求级 `horizon` 覆盖 | ⚠️ 未生效 | 工具 schema 暴露该参数，但 manager 未消费；horizon 由 ProcessModelSpec 冻结（“仅诊断用”应视为暂不可用） |

新增一个求解器/问题模板需要：`SOLVER_REFS` 与兼容矩阵、`problem-builder` 分支、Python `problems.py` 求解实现与 `worker.py` 分派、以及（动态路径）TS 独立复算。属代码级扩展，符合计划“首版仅内置模型/问题家族、新算法需扩展 Adapter”的边界。

## 5. 发现并修复的真实缺陷

1. **资格作用域单边放行**：模拟线可生成 `real` 报告且会顶掉 `latest` 合格资格 → solve 误拒。已双向校验（`eligibility-service` + `manager.solve`）。
2. **`/optimizer` unhead dispose 崩溃**：`useHead(() => t(...))` 写在 `useI18n()` 之前，watchEffect 立即求值触发 TDZ，卸载时 `entry.dispose()` 报错。已调整顺序。
3. **UI 默认 problemConfig 形状错误**：扁平 `{cvWeights,...}` 与服务端 `{linear_mpc_quadratic:{...}}` 不符，UI 建的 Profile 保存成功但 solve 422。默认值已改嵌套，并加配置键提示。
4. **REST 模板 id 错误码不精确**：绑定/求解先查实例归属，模板 id 只回 404。`rest-auth` 现识别模板 id 并回 422 `AGENT_TEMPLATE_ID_NOT_ALLOWED`。
5. **资格门槛误杀静态场景**：`NO_OBSERVABLE_DELAYED_RESPONSE` 对 `static_response@1` 同样生效，导致 A11 要求的静态场景“训练成功但求解永远不合格”。已改为仅对 `linear_arx@1` 检查延迟响应。

**易用性收敛**：规格的 min/max/单步限幅/有效域使用**模型单位**；UI 新增提示（`modelUnitsHint`），避免把物理值填进模型域。

**已知未修（本轮只报告，不擅自改契约）**：请求级 `horizon` 参数在工具 schema 中暴露但 manager 未消费（horizon 由 ProcessModelSpec 冻结）；Twin `registerSolverAdapter` 与新 optimizer worker 未打通。二者是“自定义求解器”下一轮的首选事项。

## 6. 复现

```bash
npm run test:e2e-optimizer       # 90 条 live(约 4-6 分钟)
node scripts/e2e-optimizer-restart.mjs  # 复用上一轮 home 的重启持久性抽检(7 条)
npx tsx --tsconfig .nuxt/tsconfig.server.json scripts/acceptance-optimizer-process-model.ts
node scripts/run-quality-gates.mjs
```

## 7. 证据与边界

- `docs/audit/evidence/2026-10-23-optimizer-live/report.json`（90 条断言、三类种子、环境/venv、pageerror）与 `restart-check.json`（7 条重启持久性）。
- 截图：`ui-01-spec-empty.png`、`ui-02-eligibility.png`、`ui-03-profile.png`、`ui-04-binding.png`、`ui-05-runs.png`。
- 边界：历史批次为测试种子（真实 TSDB/真实 builder）；只覆盖模拟产线；未触发 HITL/设备写；闭环 plant 为独立 ARX 模型而非 plc-node-simulator 引擎；宿主机 Timescale 在线时测试实例强制 SQLite。
