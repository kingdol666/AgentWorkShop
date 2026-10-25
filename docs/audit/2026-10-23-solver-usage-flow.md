# Optimizer 求解器使用逻辑与流程(实测版)

日期:2026-10-23。本文描述的每一步都由 `scripts/e2e-optimizer-live.mjs`(R1/R3/W/M/U1/V 系列)在隔离实例上真实执行过;端点、参数与顺序以代码为准。

## 0. 总览:五段式使用旅程

```
① 建数据底盘        ② 建模与发布           ③ 绑定与求解            ④ 证据增强            ⑤ 治理下发
产线/产品/配方  →   规格→数据集→资格    →  Profile→绑定→solve  →   互校(crosscheck) →   dispatch 建卡
数采节点+历史批次    训练→模型(lineage)     建议(verified/unverified)  dual 状态           HITL 批准→设备写入
```

铁律:**建议永不等于执行授权**。求解全程零设备写入(R1.20 断言);唯一写入路径是 ⑤ 的 HITL 批准。

## 1. ① 建数据底盘(前置)

| 步骤 | 动作 | 要点 |
|---|---|---|
| 1.1 建产线 | `POST /api/workshop/dcw/lines` `{name, simulated:true}` | 模拟产线;真实线需要 real 作用域资格 |
| 1.2 建产品 | `POST /api/workshop/dcw/products` | 归属产线 |
| 1.3 建配方 | `POST /api/workshop/dcw/recipes` `params:[{nodeId,value,min,max}]` | **参数面决定下发了什么**:MV 执行节点必须在配方参数里 |
| 1.4 建数采节点 | DAQ 节点(MV/CV 观测)+ DCW 控制节点(MV 执行) | 观测与执行分离 |
| 1.5 采历史批次 | 开跑产线,≥6 个完结批次、每批 ≥160 拍、激励丰富 | 每批自动落 confirmed context segment(谱系锚) |

## 2. ② 建模与发布(全部走 `/api/workshop/process-model/*` + `/api/workshop/aml/*`)

| 步骤 | 端点 | 要点 |
|---|---|---|
| 2.1 登记规格 | `POST /process-model/specs` | 声明变量(mv/cv、scale/offset、delayMs、min/max/maxStep、**controlNodeId**)、beatMs、trainer、切分;发布后不可变(409 SPEC_VERSION_IMMUTABLE) |
| 2.2 发布规格 | `POST /process-model/specs/:id/publish` | content hash 冻结 |
| 2.3 建数据集 | `POST /process-model/datasets` | 按 confirmed segment 逐 run 归属版本;`lineage_verified=1` 才可训练/求解 |
| 2.4 资格评估 | `POST /process-model/eligibility` | `optimizationEligible=true` + 作用域(simulation/real) |
| 2.5 提交训练 | `POST /aml/jobs`(train) | linear_arx@1 → 状态空间工件;G1-G3 门禁;两阶段登记 model_id |
| 2.6 模型就绪 | `GET /aml/models/:id` | `artifact_kind=linear_state_space@1`,artifact_hash 64 位 |

## 3. ③ 绑定与求解

| 步骤 | 端点/工具 | 要点 |
|---|---|---|
| 3.1 建 Profile | `POST /optimization/profiles` `{modelId, template:'linear_mpc_quadratic@1', solver:'osqp_mpc@1', processSpecRef, problemConfig}` | 服务端回填工件 hash;分派矩阵校验(scipy 只配 steady_response) |
| 3.2 发布 Profile | `POST /optimization/profiles/:id/publish` | 冻结模型精确版本+问题结构 hash;legacy 数据集 422 |
| 3.3 建绑定 | `POST /optimization/bindings` `{workspaceId, channelId, agentInstanceId, profileId, profileVersion, mode:'recommendation'}` | **授权面=绑定面**:agent 只有绑了 Profile 才能调用 optimizer_* |
| 3.4 求解(三入口等价) | ① REST `POST /optimization/solve {agentInstanceId}`;② Agent 工具 `optimizer_solve`(经 `/api/workshop/agent-tools/invoke` 或会话内);③ MCP `tools/call optimizer_solve` | 链路:resolve 绑定→装配规格→读工件→**编译 ProblemIR**→Python Worker(OSQP)求解→TS 独立重算代价/轨迹/约束→落 run+candidates→生成建议 |
| 3.5 读建议状态 | `optimizer_plan_get` / `GET /optimization/runs` | 状态 ∈ verified/unverified/expired;**verified = 有 UQ 证据(测试集 conformal 覆盖达标 + 操作点距离 OK + 保鲜期内)且模型 production** |
| 3.6 生命周期 | `optimizer_status`(终态查询)/ `optimizer_cancel`(终态返回 cancelled:false 不报错) | 单 worker 互斥;超时 SOLVE_TIMEOUT 杀进程退避重启 |
| 3.7 能力探针 | `optimizer_capabilities` / `GET /optimization/capabilities` | 返回 venv 路径、osqp/scipy 版本、池大小、绑定清单 |

## 4. ④ 证据增强(下发的先决)

| 步骤 | 端点 | 要点 |
|---|---|---|
| 4.1 候选互校 | `POST /optimization/recommendations/:id/crosscheck` | 用冻结快照回放 typed predictor,与 Worker 逐 CV 比对(无量纲,默认 tol=1e-6);verdict=pass 且 stale=false 才有 dual 状态 |
| 4.2 查 dual | `optimizer_plan_get` / run status | `dual = verified ∧ 最新互校 pass ∧ 未 stale`;模型/绑定一变即 stale |

## 5. ⑤ 治理下发(HITL,唯一写设备路径)

| 步骤 | 端点 | 要点 |
|---|---|---|
| 5.1 申请建卡 | `POST /optimization/recommendations/:id/dispatch` `{note?}` | body **禁止携带任何证据字段**(422 D11);服务端落库回查构造参数包(首步工程值=模型首步经 scale/offset 还原);状态机 idle→dispatched(幂等锚,重复建卡 409) |
| 5.2 人审 | 审批面(`GET /agent-tools/approvals?scope=pending`,卡前缀 `optimizer-recipe:`)→ `POST /agent-tools/approvals/:id/decide {approved:true}` | 批准时刻 **D13 八项重验**(建议 verified/互校 fresh/绑定 revision/IR-工件无漂移/controlNodeId ∈配方参数面且在线/AML 非活动/当前 MV 步限(模型单位)/preflight 量程);任一失败按拒收敛零写。注意 body 是显式布尔 `{approved:true}`,缺省 400 |
| 5.3 执行与回执 | 批准响应含 `execution.acks {total, verified, failed, unverified}` | 整批经 DCW 写入并回读核验(按节点小数位量化);dispatch_state→executed;审计 `optimizer.dispatch.request` + `optimizer.dispatch.execute` 落 ops 日志 |
| 5.4 收敛路径 | 拒绝/超时/撤权 → cancelled/denied/expired | 无自动重放;重启对账 committed 无 execute → failed |

## 6. 入口矩阵(全部实测等价)

| 入口 | 求解 | 计划/状态 | 下发 |
|---|---|---|---|
| REST(用户 token) | `POST /optimization/solve` | `GET /runs`、`GET /runs/:id` | `POST .../dispatch` + crosscheck |
| Agent 工具(agent 绑定) | `optimizer_solve` | `optimizer_plan_get/status/cancel/capabilities` | 经 HITL 卡人审 |
| MCP(stdio 桥,AW_AGENT_TOKEN) | `tools/call optimizer_solve` | `tools/list` 含 5 个 optimizer_* | 同上 |
| UI(/optimizer 五 tab) | 「运行/建议」tab「求解一次」按钮 | 运行台账+建议徽章 | 审批卡在 /dcw 产线页与监控页人审 |

## 7. 典型最小调用序列(已验证)

```bash
# 1-2 建模发布(见 §2;或 UI 五 tab 等价操作)
# 3 绑定后,一个请求即可求解:
curl -X POST $BASE/api/workshop/optimization/solve \
  -H "authorization: Bearer $TOKEN" -H "content-type: application/json" \
  -d '{"agentInstanceId":"<lead实例id>"}'
# → { result:{status:"optimal", firstMove:{mv1:36.96},...}, recommendation:{status:"verified",...}, runId }

# 4 互校拿 dual:
curl -X POST $BASE/api/workshop/optimization/recommendations/$REC/crosscheck -H "authorization: Bearer $TOKEN"

# 5 申请下发 → 审批面拿到 optimizer-recipe 卡 → 人批准 → 设备写入+回执
curl -X POST $BASE/api/workshop/optimization/recommendations/$REC/dispatch \
  -H "authorization: Bearer $TOKEN" -H "content-type: application/json" -d '{"note":"申请下发"}'
```

## 8. 失败语义速查

| 症状 | 码 | 处置 |
|---|---|---|
| 建议不可信 | rec=unverified | 查 UQ:测试集 run 数≥2/步数≥120、覆盖门、保鲜 7 天、操作点距离>3 = OOD |
| 互校不过 | verdict=fail / 409 CROSSCHECK_MODEL_REPLACED | 模型或快照漂移,重新 solve+互校 |
| 建卡被拒 | 403 DISPATCH_GATE_UNVERIFIED / NOT_CROSSCHECKED | 走全链 solve→crosscheck→dispatch |
| 批准被拒收敛 | W7 approved=false + code | 按 comment 修因(常见:当前 MV 无读数、超步限、绑定 revision 变) |
| 求解超时/崩溃 | SOLVE_TIMEOUT / WORKER_INTERRUPTED | 池自动退避补位;连续 3 次降级 SOLVER_UNAVAILABLE 需重启实例 |
