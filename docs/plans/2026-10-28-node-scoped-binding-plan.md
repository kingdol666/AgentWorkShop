# 节点级写授权(dcw 绑定恢复)× 配方管控下发 —— 双轨授权优化计划

- 日期:2026-10-28
- 状态:**pending approval**(待用户批准后实施)
- 关联:`docs/audit/evidence/2026-10-28-execmodes/`(三模式已落地)、权限模型 v2(`bindings/index.post.ts`)

---

## 一、背景:两个真实的粒度缺口(代码已核实)

### G1 配方绑定 = 全参数写权限(授权粒度过粗)
- `recipe-gate.ts:62` 绑定门只查"是否绑定该配方",无参数级过滤 → 绑 11 参数配方 = 11 个节点全部可写。
- 治理写路径虽按"节点 ∈ 配方参数"判定(`dcw-tools.ts:130-141`),但配方绑定的覆盖面就是全部参数。
- 场景后果:Agent 只该动 1 个回路时,只能给全配方权限,或拆配方。

### G2 授权跟配方 id 走 → 换配方即停摆(用户指出的核心问题)
- 授权锚点是 recipeId(`nodeId` 字段存 recipeId);产线从 rc-A 切到 rc-B 后:
  - 绑定门查 rc-B 绑定 → 无 → 拒;
  - 运行门查 rc-A 活动批次 → 无 → 拒。
- Agent 在换配方瞬间丧失全部操作能力,直到有人为新配方建绑——**授权本应跟设备节点(稳定),管控跟活动配方(动态)**。
- 而基础设施已就绪:`resolveRecipeTarget`(ops-tools.ts:717-732)**已支持 line_id → 活动配方解析**;`tool-verify` 的 `boundNodes` **已包含 dcw 绑定节点**(tool-verify.ts:58-75);team 委派至今仍能创建 dcw 绑定(`node-delegation.ts:103`);存量 dcw 绑定仍被治理写路径第一优先识别(`dcw-tools.ts:124`)。

### 唯一被砍掉且应当恢复的:dcw 绑定作为**授权面**(不是直写入口)
v2 砍掉的是"Agent 直写节点工具"(应当砍,`param_control`/`dcw_control` 恒拒桩仍在);但把节点级**授权面**一并砍掉是过头。恢复它,执行仍 100% 收敛在配方管道。

---

## 二、目标与非目标

**目标**:双轨授权——**节点绑定 = 写授权面(稳定,跟设备走);配方 = 执行管道与工艺管控(动态,跟活动批次走)**。
- Agent 绑定 dcw 节点后:对"当前产线活动配方"的参数下发,只要覆盖集 ⊆ 自己的节点绑定面即放行;换配方不停摆。
- recipe 绑定保持现有语义(配方级操作权:update/rollback/整批 apply),两种绑定**取并集**。
- 所有写仍经配方管道:四层限界、HITL 三层门、审批后元组复核、逐参数 ACK、journal、审计零改动。

**非目标**:不恢复直写工具(`param_control`/`dcw_control` 恒拒桩不动);不改 HITL 语义;不做参数级 allowlist 绑定(节点粒度已够);不做自动绑定迁移(存量数据天然兼容)。

---

## 三、授权矩阵(语义单一来源,实现与测试都以此为准)

记 Agent 授权面 `W(a)` = **dcw 绑定节点集 ∪ (recipe 绑定覆盖的参数节点集)**(与 `tool-verify.boundNodes` 同口径,tool-verify.ts:58-75 已实现)。

| 操作 | 授权要求 | 拒绝时回执 |
|---|---|---|
| `recipe_trial`(overrides 覆盖集,只写声明节点) | 每个 override node ∈ `W(a)` | 拒,列出**缺失授权的节点清单**+指引("请让用户为你绑定节点 X,或改用已授权节点") |
| `recipe_trial`(无 overrides,候选全参数) | 全部参数 ∈ `W(a)` | 同上 |
| `recipe_apply`(整批下发) | recipe 绑定(**配方级操作权**)∨ 全参数 ⊆ `W(a)` | 同上 |
| `recipe_update / recipe_rollback`(版本操作) | recipe 绑定(维持现状,节点绑定不grant版本权) | 现状文案 |
| 治理写 `optimization_explore`(单节点) | 现状双路,不动 | 现状文案 |
| 目标配方解析 | `recipe_id` 显式给出用之;**只给 `line_id` 时解析该线活动配方**(已有,`resolveRecipeTarget:726-731`)——节点绑定 Agent 的推荐用法 | 已有文案 |

**换配方语义(M3 核心)**:节点绑定 Agent 对线 L 操作时,推荐 `line_id` 定位 → 活动配方 rc-B 自动成为目标;绑定门对 dcw 绑定 Agent 改查"**节点覆盖**"而非"recipeId 匹配";运行门不变(配方必须在跑)。rc-A→rc-B 切换后,同一 Agent 立即可对 rc-B 的**已授权节点**操作,窗口/目标值来自 rc-B。

## 四、校验落点(用户问的"verify"——三处,纵深防御)

1. **tool-verify 预检**(`tool-verify.ts`,给 Agent 可行动反馈的第一道):
   - `recipe_trial/recipe_apply/recipe_update` 的 `params[].node_id` 逐点对照 `W(a)`(现有 `boundNodes` 直接可用);
   - 拒绝文案复用既有 node 引用拒绝模板(点名参数+列出绑定面+下一步,tool-verify.ts:133)。
2. **recipe-gate 授权门**(`recipe-gate.ts`,权威判定):
   - 绑定门升级为双轨:`recipe 绑定`(配方级,现状)∨ `目标节点 ⊆ dcw 绑定面`(节点级,新增);
   - dcw 绑定 Agent 的 hitlRequired 判定沿用其绑定 mode(dcw 绑定也有 auto/manual,首绑恒 manual 不变)。
3. **执行时与批准后复核**:
   - `applyRecipe` 执行点(D13 同款):下发前重验覆盖集(绑定可在审批期间被撤销/收回);
   - `verifyApprovedAction`(审批后)增加绑定覆盖复核——收回即失活机制已存在(`node-delegation.ts:147-150` 收回时挂起审批按拒收敛),补"覆盖集复核"使其覆盖 trial/apply 全路径。

## 五、里程碑

| 阶段 | 内容 | 判据 |
|---|---|---|
| M1 入口 | REST 放开 `kind='dcw'` 绑定创建(语义注释:授权面,直写工具不恢复);绑定面板恢复 dcw 选项;模式 auto/manual 语义沿用 | 建绑定 200;权限模型文档更新 |
| M2 校验 | 矩阵表三处落点(tool-verify / recipe-gate / 执行+批准后复核);拒绝回执带缺失节点清单 | 单测:覆盖矩阵全组合(全有/部分/全无 × trial/apply/update) |
| M3 换配方语义 | 节点绑定 Agent 的 line-targeted 操作直通活动配方;跨线校验沿用(节点不属于目标配方产线 → 拒) | e2e:rc-A 切 rc-B 后同一 Agent 无需新绑定即可操作已授权节点 |
| M4 联动验证 | 委派建/撤 dcw 绑定与审批取消联动(机制已存在,补断言);三模式执行门与节点绑定叠加(manual 频道钳位对节点绑定 Agent 同样生效) | e2e 断言 |
| M5 验收 | 权限矩阵 e2e 正反例(≥16 断言);回归:line-governance 44 / perms / execution-modes;README 权限章节更新 | 全绿 + 证据归档 |

## 六、验收标准(US 化)

- US-01 REST 可建 `kind='dcw'` 绑定;缺 confirm 语义、首绑恒 manual 不变;缺节点/缺产线 400。
- US-02 trial 覆盖集 ⊆ `W(a)` 放行;含未授权节点 → 拒 + 缺失清单;纯 dcw 绑定 Agent 对活动配方 trial 成功(经 line_id 解析)。
- US-03 apply:recipe 绑定放行;纯节点绑定的**全覆盖**放行;部分覆盖拒 + 清单。
- US-04 换配方:rc-A→rc-B,dcw 绑定 Agent 无需任何新绑定即可继续 trial(rc-B 的已授权参数);recipe 绑定 Agent 行为不变(仍需 rc-B 绑定——其授权本就是配方级)。
- US-05 收权即失活:撤销 dcw 绑定后,在飞审批拒收敛、后续 trial 拒。
- US-06 回归三套件全绿;`docs/site` 权限文档与 README-zh 权限模型段落同步。

## 七、风险与对策

- **R1 双轨心智负担**:文档与回执必须讲清"节点绑定=点位授权,配方绑定=配方操作权";拒绝文案自带指引(既有 house 风格)。
- **R2 提权回归**:dcw 绑定恢复绝不等于直写工具恢复——`param_control/dcw_control` 恒拒桩与分发守卫不动,单测钉死。
- **R3 整批一致性**:apply 全覆盖校验防"部分节点绑定变相提权到未授权参数"(缺一即拒)。
- **R4 存量兼容**:存量 dcw 绑定本就被识别,零迁移;recipe 绑定行为零变化。
