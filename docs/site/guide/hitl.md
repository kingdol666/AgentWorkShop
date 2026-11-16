# HITL 人机协同审批

HITL(Human-in-the-Loop)让需要人工裁决的 Agent 数控动作在执行前挂起 —— 平台保证
「Agent 提议,适用时由人批准,系统执行,全程留痕」。是否需要审批取决于动作类型与有效策略，不是所有下发都一律 HITL。

## 工作机制

1. 写控节点绑定的 `mode` 参与行为判定，并与 Channel 执行模式、产线总闸共同生效:
   - `auto` —— 该绑定不额外要求审批(范围/窗口联锁、其他策略门仍生效);
   - `manual` —— 该绑定要求人工批准(审批意见可回传给 Agent)。
2. 需要审批的动作进入待审批队列,同一 Agent 同节点的重复挂起会被去重;
3. 管理员在界面(或 REST)批准/拒绝,附注意见;
4. 批准 → 指令真实执行(二次校验绑定仍有效);拒绝/超时 → Agent 收到原因,
   PLC 值不变;
5. 裁决人身份写入审计日志(`approval.approve` / `approval.reject`)。

## REST 面

```bash
# 待审批列表
curl $API/api/workshop/agent-tools/approvals -H "Authorization: Bearer $TOKEN"

# 裁决
curl -X POST $API/api/workshop/agent-tools/approvals/$ID/decide \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"approved": true, "comment": "窗口内,批准"}'
```

> Agent 的 `dcw_control` 直调已禁用并拒绝，不会通过 manual 审批变成可用入口。其他适用的人工审批仍遵循各自的动作与策略门。

### 动作特例与策略门

- `recipe_propose` 始终创建人工审批卡；拒绝时设备不写入，候选与意见留痕。
- `line_start` / `line_stop` 始终要求 HITL，即使相关写控模式为 `auto`。
- `recipe_trial` / `recipe_apply` 是否进入 HITL，由 Channel/产线/绑定模式与可选全局 `security.recipeDispatchApproval` 共同决定；后者只额外门控 trial/apply。
- `recipe_update`(仅改配方定义)不属于全局 recipe-dispatch 审批门；其他适用的治理策略仍须遵守。

### 配方下发裁决门(整批动作)

`recipe_trial` / `recipe_apply` 的**整批下发动作**可受独立审批门影响；运行时设置 `security.recipeDispatchApproval` 默认关闭，开启后对所有频道的这两类动作生效。该开关不会替代 Channel/line/binding 模式门。

该全局门开启时，审批卡会列出每个参数的「节点 当前值 → 候选值」与假设声明；批准后整批下发并把附言回传 Agent，拒绝/超时则不下发，拒绝指导原样回流。裁决记录 `approval.approve` / `approval.reject`，下发动作记录 `recipe.trial` / `recipe.apply`。`recipe_rollback` 不受该全局门控制，但仍服从适用的其他治理策略。

> 裁决 REST 与上方相同,但 `approved` 必须是**显式布尔值**(缺省不再等于批准)。

## 与调控闭环的关系

HITL 审批只作用于「下发」这一步。下发成功后仍进入调控闭环
(优化记录 → 数采观察 → `dcw_judge` 判定 → `dcw_rollback` 回退),
判定与回退同样可配置为需要人工确认。
