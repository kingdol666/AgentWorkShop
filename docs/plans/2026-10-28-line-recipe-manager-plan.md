# 产线配方管理权(line-recipe)× 下发收窄(dcw)—— 三轨授权计划

- 日期:2026-10-28
- 状态:**已实施 + 真机验收通过**(真机 42/42,权限矩阵 52/52,全量单测 745/745;报告 `docs/audit/2026-10-28-line-recipe-manager-acceptance.md`)
- 关联:`docs/plans/2026-10-28-node-scoped-binding-plan.md`(节点级写授权,本计划在其上扩展第三轨)

---

## 一、需求(用户裁定)

1. 一个 Agent 可被授予某条产线的**配方管理权**:对该线**全部配方**(含未来新建)可 查看/新建/修改/回退;
2. **配方管理**与**参数下发**是两个业务功能:管理权不发参数;
3. 下发授权由 DCW 绑定决定(用户原话裁定):
   - **没绑任何 DCW** → 持配方级授权(单配方绑定或产线管理权)默认可对配方**全部参数**下发——真正向下兼容,存量不破;
   - **绑了 DCW** → 下发前核验覆盖集 ⊆ DCW 绑定面,绑了就只按绑定点位放行(DCW 绑定 = 下发范围收窄器)。

## 二、授权矩阵(语义单一来源)

| 操作 | 单配方绑定(kind='recipe') | 产线管理权(kind='line-recipe') | 纯 DCW 绑定 | 无授权 |
|---|---|---|---|---|
| 查看(目录/版本史/台账) | 该配方 | 该线全部 | 可读线 | 可读线 |
| 新建 recipe_create | —(需线授权锚) | ✅ 该线任意新建 | ✅(该线有节点绑定时,存量规则) | ❌ |
| 修改 recipe_update | ✅ 该配方 | ✅ 该线全部 | ❌ | ❌ |
| 回退 recipe_rollback | ✅ 该配方 | ✅ 该线全部 | ❌ | ❌ |
| 下发 trial/apply | 无 dcw:✅ 全参数;有 dcw:✅ 收窄到点位 | 无 dcw:✅ 全参数;有 dcw:✅ 收窄到点位 | ✅ 覆盖集 ⊆ 点位面 | ❌ |
| 直写 param_control/dcw_control | ❌ 恒拒 | ❌ 恒拒 | ❌ 恒拒 | ❌ |

治理不变:四层限界、运行门、HITL 三层钳位(授权绑定 manual ∪ 产线 manual ∪ 频道 manual)、60s 联锁、逐参数 ACK、journal、审批后复核、收回即失活。

## 三、实施落点

| # | 落点 | 内容 |
|---|---|---|
| 1 | `node-bindings.repo.ts` | kind 增加 `'line-recipe'`(nodeId=产线 id) |
| 2 | `bindings/index.post.ts` | REST 建绑:产线存在 + 调用者 operate + 首绑 manual + modeForced 回执;频道绑线一致性沿用 |
| 3 | `binding-authz.ts` | `lineIdOfBinding`:line-recipe → nodeId 本身;产线删除 = 悬空 404 |
| 4 | `recipe-gate.ts` | 三轨门:版本操作认 recipe 级授权(单配方 ∨ 产线管理);下发规则 = 「无 dcw 全发 / 有 dcw 收窄 / 纯点位轨」;`assertRecipeCreate` 接受管理权授权锚 |
| 5 | `tool-verify.ts` | `managedLines` 面;管理线配方参数进入 boundNodes/writeFace(预检),线外照拒 |
| 6 | `tool-approvals.ts` | `cancelPendingForBinding` line-recipe 分支:收回管理权 → 该线在飞配方审批按当前授权面重判,失效按拒收敛 |
| 7 | `recipe-propose-tools.ts` / `node-delegation.ts` / `team-delegation.ts` | propose 准入认管理权;委派按 nodeId 天然支持;标签「产线配方管理」 |
| 8 | `per-agent.ts` / `dcw-tools.ts`(my_industrial_nodes) | 注入面声明「产线配方管理权 + 下发收窄规则」 |
| 9 | host-tools.json zh/en | recipe_trial/apply/update/rollback/create 描述改三轨口径 |
| 10 | UI | 小镇绑定面板第三选项「产线配方」(选产线列表);i18n zh/en/dict |
| 11 | 测试 | 单测 16 项(管理权矩阵/收窄/兼容/建配/收权/写面);E2E 权限矩阵 T11–T13(52 断言);真机 R10 系列 |

## 四、验收

- 单测 `tests/node-binding-authz.test.ts`:16/16(全量 745/745)
- E2E 权限矩阵 `scripts/e2e-node-binding-authz.mjs`:**52/52**(含 REST 首绑 manual/readonly 403/confirm 切 auto、管理权 update/rollback 全线放行、无 dcw 全参数下发、补绑 dcw 即收窄、收权即拒、注入面声明)
- 真机(omp + Qwen3.5-9B,`scripts/e2e-node-binding-3mode-real.mjs` R10 系列):管理权 Agent 真实新建配方 → 开跑接管 DCW → update v2 → rollback 回 v1 → 收权即拒;未绑点位 trial 被收窄拒、绑定点位放行
- 回归:lint / typecheck / docs:check / i18n 全绿

## 五、边界

- 管理权授予/收回/切 auto 的审批语义与 dcw 写向绑定一致(operate + 首绑 manual + confirm);
- `recipe_create` 仍只建定义不下发;新配方开跑仍由用户/管理员操作(走 line_start 权限面);
- 存量 recipe 绑定行为零变化(下发按「无 dcw 全发」规则继续成立)。
