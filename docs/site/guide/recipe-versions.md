# Recipe 版本管理

配方参数的每一次修改都自动版本化入史,记录**来源(用户/Agent/系统)、操作者、原因**,
回退是非破坏的(生成新版本,历史完整保留)—— 为在线闭环优化提供治理基座。

## 版本化规则

- 配方创建即 `v1`;活动批次外的参数修改 → 版本自增,旧版整体入 `paramsHistory`(上限 20);
- 每条历史:`{ version, params, at, by, actorName, actor, description }`;
  - 用户界面编辑 → 归因登录用户;
  - Agent `recipe_update` → 归因「Channel名/成员名」+ 必填原因;
- 批次级安全网:判定 keep 的优化记录可标记 **lastGood 批次**(参数冻结快照)。

## REST

```bash
# 版本历史(旧→新,尾行=当前版)
GET /api/workshop/dcw/recipes/:id/versions

# 回退:到指定版本 / 到 lastGood 批次冻结(生成新版本)
POST /api/workshop/dcw/recipes/:id/revert
{ "version": 2, "reason": "界面回退" }
{ "toLastGood": true, "reason": "优化翻车,回良好批次" }
```

## Agent 工具

| 工具 | 作用 | 鉴权 |
|---|---|---|
| `line_context` | 我控制的产线/产品/配方全景(逐参数目标 vs PLC 当前值) | 绑定节点所属产线 ∪ 频道绑定产线(只读) |
| `recipe_versions` | 版本史 + 参数 diff(谁/何时/为什么) | 同上 |
| `recipe_trial` | **多参数候选整批试验**:一次带上所有要改的参数整批下发,**不写配方版本**(hypothesis 必填;同线节拍 ≥5 分钟) | 逐节点 dcw 绑定 |
| `recipe_apply` | 把当前已固化版本整批下发(改配方后的正式下发) | 持配方 ≥1 节点绑定 |
| `recipe_update` | 保存最佳参数(部分合并,reason 必填,生成新版本) | 逐节点 dcw 绑定 |
| `recipe_rollback` | 回退到指定版本 / lastGood;带 `dispatch:true` = **统一回退**(定义回退 + 该版参数整批重下发 PLC) | 同上 |

节点级参数变更史用 `dcw_journal`(逐笔 锚/优化记录/判定),节点单步回退用 `dcw_rollback`。

## 配方链路闭环(v0.7.53)

闭环优化的参数变更**一律走配方管理**,与人类工艺员逻辑一致 —— 修改(试验)与固化(update)分离:

```
多参数候选(知识 + 数据依据)
  → recipe_trial 整批试验(不写版本;四层限界照常;同线节拍 ≥5 分钟防震荡)
  → 等工艺惯性 → daq_query 复测判读
      有进步/达标 → recipe_update 固化(同一配方 id,版本 +1)→ recipe_apply 正式下发
      无进步/劣化 → recipe_rollback { dispatch: true } 统一回退(定义回退 + PLC 整批恢复)
```

- 优化闭环内禁用 `dcw_control`/`param_control` 逐参数直调(防单参数震荡;AML 探索模式的小步激励除外);
- trial 不受 60s/单步卡控(配方路径设计),防震荡由「整批 + 节拍 + 判读门控」承担;
- trial/apply/回退全程审计入册(`recipe.trial` / `recipe.apply` / `dcw.write.rejected`),版本史可追溯。

## 失效节点守卫

配方参数引用的节点被删除/停用/解绑时:

- 下发(一键下发/开跑批次)**自动跳过**并在批次结果记明「已停用/已取消绑定/已删除」;
- 界面参数芯片灰化 + 徽标;编辑表单自动剔除已删除行并横幅告知;
- Agent `recipe_update` 触到失效节点精确拒因;保存时自动剪除基线失效参数并告知;
- 回退到含失效节点的历史版本 → 剪枝成功,剔除动作写入版本描述。

## 闭环示例

```
Agent: line_context(确认归属与当前值)
  → recipe_trial(多参数候选整批试验,不写版本)→ daq_query 复测
  → 有进步:recipe_update 固化为 vN(同 id)→ recipe_apply 正式下发
  → 劣化:recipe_rollback(dispatch=true)统一回退(定义回退 + PLC 整批恢复)
单节点应急微调(配方链路之外):dcw_control → dcw_judge → dcw_rollback
```

**取证据默认只取当前批次**:`daq_query` 会自动解析节点所属产线的活动批次,按该批次的
`run_id` + `recipe_id` 过滤,因此换配方后取到的永远是**当前运行配方**的样本(不会把上一轮的
数据混进本轮判定);结果表头会打印 `run=<id> 配方「名」(recipe_id)`,文末逐节点重申生效口径。
需要跨配方对比或复盘历史时显式传 `scope: 'all'`,或直接给 `recipe_id` / `run_id` / `product_id`;
产线未开跑则不做过滤,历史样本照常可查。
