# 核心桥梁四功能 × 多实例真实 harness 验收报告

- 日期:2026-10-28
- 结论:**全部收口条件满足(3 实例 + 回归门禁全绿)**。Agent↔产线业务四座桥——动态工具注册、工具调用认证放行、数据抓取/采集、控制参数下发 + recipe 管理——在多实例不同场景下实测通过。
- 本轮顺手修复:见「四」。

---

## 一、收口条件(先定义,后验证)

| # | 收口条件 | 判据 | 结果 |
|---|---|---|---|
| G1 | 实例①(3410,真机 omp+Qwen,三模式+管理权,本轮早前验收) | 42/42 PASS + 实例健康 | ✅ PASS(证据在档,health ready) |
| G2 | 实例②(3411,mock harness 确定性矩阵):动态注册/认证/采集/下发/管理权 | 全部断言 PASS;负向断言按预期拒绝 | ✅ **34/34** |
| G3 | 实例③(3412,真机 omp+Qwen):真实作业闭环(抓取→决策→HITL 下发→复测→配方管理) | C1-C5 全 PASS | ✅ **12/12** |
| G4 | 回归门禁 | unit 745/745;lint;typecheck;docs 91/91;i18n PARITY | ✅ 全绿 |

## 二、实例②:核心桥梁矩阵(34/34,mock harness 确定性)

场景:两线;线A = 2 数采 + 2 数控(双参数配方,开跑);频道绑线A + 3 个差异化绑定的 worker + 观察频道。

**A 动态工具注册(按绑定实时编译,非克隆)**
- 三个 Agent 同工具集、不同描述(单一目录即时编译视图)✅
- 注入面按绑定差异化:直接绑定段 w1 只见 dnA1、w2 只见 dnA2;配方段只进持配方授权者;点位写授权面进 w3 的 recipe_trial 描述 ✅
- **解绑即时收窄**(直接绑定段移除)、**授予产线管理权即时声明**、**observe 频道写族整体摘除** ✅

**B 工具调用认证放行**
- 错误 token → 401;token/agentId 错配 → 401;无身份 → 401 ✅
- 引用面:他线节点拒、自己节点放行、频道绑线只读扩权可读同线未绑数采 ✅
- 写面预检:下发未绑定节点 → 拒且点名节点 ✅

**C 数据采集**:DAQ 控制器开采 → 采样落库 → daq_query 按授权面取到真实样本(样本数>0)✅

**D 控制参数下发**:点位绑定(manual)→ trial 挂人工审批卡 → REST 批准 → ACK 设备证实 → journal 落账 50→55(绑定 run)→ 设备回读=账本值 ✅

**E recipe 管理权**:管理权 Agent 无单配方绑定 update 成功;无 dcw 全参数下发(向下兼容);补绑 dcw 即收窄(未绑点拒/绑定点放行);收窄不影响版本操作;收回管理权后 update 拒 ✅

## 三、实例③:真实作业闭环(12/12,omp + Qwen3.5-9B 32k)

一个 Agent(点位绑定 + 产线管理权,manual 频道)两条任务:

1. **调参任务(抓取→决策→下发→复测→汇报)**:daq_query 抓取真实采样 → 声明假设 → recipe_trial 下发(HITL 卡人工批准)→ journal 落账 60→56 → 设备回读=账本值 → 任务收口 ✅(C1/C2/C3)
2. **配方管理任务**:凭管理权 **recipe_create 新建配方**(无单配方绑定,创建审批批准)→ 新配方开跑接管 DCW(=v1 定义值)→ recipe_update 生成 v2(60→62)→ recipe_rollback 回退 → v3=v1(版本轨迹 `1:[60] → 2:[62] → 3:[60]`)→ 任务收口 ✅(C4a/C4b/C4c/C1b)
3. **授权边界**:收回管理权后版本操作被拒 ✅(C5)

## 四、本轮检查中发现并修复的问题

| # | 问题 | 修复 |
|---|---|---|
| 1 | `GET /agent-tools/approvals?agentId=&scope=history` **漏 agentId 过滤**(pending 分支有),按 Agent 查历史会看到他人审批 | 两个 scope 口径一致(`approvals/index.get.ts`) |
| 2 | `recipe_create` 无法从 line_id 推断产品:产线只挂一个产品时仍要求显式 product_id,真实 Agent(只传 line_id+params)被拒 | 该线**唯一产品自动归属**,多产品歧义仍要求显式(fail-closed)(`ops-tools.ts`) |
| 3 | 验收脚本自身缺陷:审批轮询漏传 token(401→永远看不到卡);managed line 场景跨线绑定;“直接绑定段”断言把频道只读扩权段误判为泄漏;取消收敛路径交付物为空误判 | 均已修正 |

**实测踩坑(非平台缺陷,已记录规避方式)**:
- `.output` 两次构建竞态会缺路由 chunk(ERR_MODULE_NOT_FOUND)→ 真机验收前清目录重建;
- 本地 9B 长回合触发 omp 自动压缩时,压缩角色走全局配置的云端模型 → 预算 422 打断回合 → 用 `--config` overlay 把全部模型角色钉到本地模型(实例③已用,零 422);
- manual 频道下 recipe_create/update/rollback 同样挂审批,验收运营侧需一并自动批准。

## 五、回归门禁(最终态)

| 门禁 | 结果 |
|---|---|
| `npm run test:unit` | **745/745** |
| `npm run lint` / `typecheck` | 全绿 |
| `npm run docs:check` / `i18n:check` / `readme:lint` | 91/91 · PARITY OK · 通过 |
| 权限矩阵 E2E(52/52)、真机三模式(42/42) | 在档 PASS(本轮早前) |

## 六、证据

- 实例②:`docs/audit/evidence/2026-10-28-core-bridges/report.json`(34/34)
- 实例③:`docs/audit/evidence/2026-10-28-business-loop/report.json`(12/12)
- 实例①:`docs/audit/evidence/2026-10-28-node-binding-3mode/report.json`(42/42)
- 脚本(可复现):`scripts/e2e-core-bridges-matrix.mjs` · `scripts/e2e-business-loop-real.mjs` · `scripts/e2e-node-binding-authz.mjs` · `scripts/e2e-node-binding-3mode-real.mjs`
- 隔离实例仍在线可查:①3410(0.8.6)②3411(dev)③3412(0.8.6)

## 七、边界声明

- 实例②③设备为内置 mock:验证授权/注入/下发/回读/账本链路,不等价于真实 PLC 工艺响应;
- 实例③运行于生产构建(0.8.6,含本轮全部修复);实例②为 dev 模式(同源代码);
- 工作区由并行会话共享,本轮改动未提交。
