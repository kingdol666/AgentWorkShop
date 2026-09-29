# 配方链路闭环(trial → 判读 → update/统一回退)验收记录(2026-09-29)

## 需求确认(用户拍板)
- **试验语义**:trial 下发候选参数**不写配方版本**;只有复测有进步/达标才 recipe_update 固化(同 id 版本+1)。
- **直调定位**:优化闭环内禁用 dcw_control/param_control 逐参数直调(AML 探索模式小步激励除外)。
- **审批**:治理下全自动(四层限界 + 同线试验节拍 ≥5 分钟卡控,env AW_TRIAL_INTERVAL_MS 可调)。

## 实现清单
- **控制器**:applyRecipe 支持候选覆盖集(overrides 只覆盖配方已有节点;trial 受节拍卡控);rollbackRecipeAndDispatch(定义回退 + 上一版参数整批重下发 PLC);createRun 支持 paramsOverride(批次快照=候选值,审计回放以实际生产值为准)。
- **Host 工具(72→74)**:
  - `recipe_trial`:多参数候选整批试验(逐节点授权校验;hypothesis 必填;回执带逐参数结果与被拒原因;审计 recipe.trial);
  - `recipe_apply`:下发已固化版本(改配方后的正式下发;需持配方 ≥1 节点授权;审计 recipe.apply 带 recipeId 列);
  - `recipe_rollback` 增强:`dispatch:true` = 统一回退(定义回退 + PLC 整批恢复);缺省仍仅定义回退(文本明确提示)。
- **治理接线**:recipe_trial/recipe_apply 进高危直写集合(HYBRID_TWIN_DIRECT_WRITE_TOOL_NAMES → HIGH_RISK 权限面)+ dispatch fail-closed 守卫;守卫测试 conscious-change guard 同步更新。
- **提示词**:通用频道作业纪律/lead/工艺工程师 全面改为配方链路流程(候选→trial→判读→固化/统一回退;闭环内禁直调)。

## 验收(E2E 14 项 PASS,0 产品级 FAIL;实例 3980 全新库;脚本 .e2e-tmp/rc-e2e/)

| # | 项 | 证据 |
|---|---|---|
| T1 | trial 整批 | 双参数一次落 PLC(A170/B78);**版本未动**(v1/1条);audit recipe.trial 含假设;journal 双节点同 runId(整批) |
| T2 | 节拍卡控 | 1s 后再 trial 拒:「试验节拍为 ≥300s…请等待 299s」;PLC 不动 |
| T3 | update 同 id | recipe_update → 同 id v1→v2,params=候选值;versions diff 正确 |
| T4 | apply 正式下发 | v3 → recipe_apply 2/2,PLC=新版本值;audit recipe.apply |
| T5 | 统一回退 | rollback{v2,dispatch:true} → v4=v2 参数 + **PLC 整批恢复 170/78**;对照:不带 dispatch 只回定义,文本明示 |
| T6 | 越界候选拦截 | trial{172,999}:999 不落 PLC,run.results 点名量程与有效区间,dcw.write.rejected 入册;同批合法参数照常 |
| T7 | id 稳定 | 首尾同 id(rc-7ddffce2),create=0;终态 v6 与 PLC 一致 |

回归:typecheck ✓ / lint 0 / 单测 68/68(含高危集守卫更新)。

## 语义边界(如实)
- trial 不受 60s/单步卡控(recipe 路径设计如此;防震荡由"整批+节拍+判读门控"承担);四层限界(量程∩参数∩产品)照常。
- 混合批次(部分参数越界):合法参数照常落 PLC,越界参数拒绝并逐参数标注原因 —— 如实记录设计,未做全批原子回滚。
- optimize 达成目标后的"最终固化"= 同一 recipe_update 语义(同 id 版本递增),全程无新 recipe id。
