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

## 与调控闭环的关系

HITL 审批只作用于「下发」这一步。下发成功后仍进入调控闭环
(优化记录 → 数采观察 → `dcw_judge` 判定 → `dcw_rollback` 回退),
判定与回退同样可配置为需要人工确认。
