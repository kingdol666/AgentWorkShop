# HITL 人机协同审批

HITL(Human-in-the-Loop)让 Agent 的数控下发在执行前经过人工裁决 —— 平台保证
「Agent 提议,人批准,系统执行,全程留痕」。

## 工作机制

1. Agent 节点绑定的 `mode` 决定行为:
   - `auto` —— 工具调用自动执行(仍走量程/窗口联锁);
   - `manual` —— 每次下发挂起等待人工批准(可附备注回传给 Agent)。
2. `manual` 下发时指令进入待审批队列,同一 Agent 同节点的重复挂起会被去重;
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

> 注意:Agent 侧的 `dcw_control` 调用在 manual 模式下会**挂起直到裁决**
> (超时按 `security.hitl_timeout_ms`,默认 180000ms = 3 分钟,超时自动拒绝)——这是设计语义。

## 配方下发裁决门(整批动作)

节点级 `dcw_control` 之外,配方链路的**整批下发动作**有独立的审批门,由运行时设置
`security.recipeDispatchApproval` 控制(默认关闭;开启后对所有频道生效):

- 覆盖动作:`recipe_trial`(整批候选试验下发)与 `recipe_apply`(已固化版本正式下发);
  `recipe_update`(仅改配方定义,不下发)与 `recipe_rollback`(回退收敛)不在此门内;
- 挂起语义:提交后整批动作**挂起等待人工裁决**,待审批项会列出每个参数的
  「节点 当前值 → 候选值」与假设声明;
- 批准(可附言)→ 整批真实下发,附言随工具回执返回给 Agent;
- 拒绝(可附指导)→ PLC 不动、配方版本不变,人工指导文本**逐字回流**工具回包,
  Agent 按指导修订候选后重新提交 —— 即「改好配方交给人判断;不批准就按人说的改」;
- 超时(`security.hitl_timeout_ms`,默认 180s)按拒绝收敛,不产生任何下发;
- 审计:裁决入 `approval.approve` / `approval.reject`;下发本身入 `recipe.trial` /
  `recipe.apply`(带配方 id 与 Agent 归因)。

> 裁决 REST 与上方相同,但 `approved` 必须是**显式布尔值**(缺省不再等于批准)。

## 与调控闭环的关系

HITL 审批只作用于「下发」这一步。下发成功后仍进入调控闭环
(优化记录 → 数采观察 → `dcw_judge` 判定 → `dcw_rollback` 回退),
判定与回退同样可配置为需要人工确认。
