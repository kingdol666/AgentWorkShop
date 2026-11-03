# E4·L1 授权面一致性（Agent 工具面）

- run: `20261101121415-authorization` · base http://127.0.0.1:3005 · scenario injection · line ln-3856f218
- 节点 A=scen-injection:dcw:barrel-temp-1-sp(dw-42d04635) · 节点 B=scen-injection:dcw:barrel-temp-2-sp(dw-edadfee6) · 目标观测 dn-bde5fd79

| 用例 | Agent | 目标节点 | 期望 | 实际 | 面板状态 | 回包（截断） |
|---|---|---|---|---|---|---|
| unbound write | U(no binding) | dw-42d04635 | reject | **reject** | 200 | 工具调用被拒(引用校验,optimization_explore):control_node_id = 「dw-42d04635」不在你的授权范围内(节点「scen-injecti |
| bound write (control) | U(bound A) | dw-42d04635 | accept | **accept** | 200 | 探索步完成(已真实写入产线并记录):
  记录: opt-exploration-mvxsla5n-yvkp56
  控制: scen-injection:dcw:barrel-t |
| cross-node write | V(bound A) | dw-edadfee6 | reject | **reject** | 200 | 工具调用被拒(引用校验,optimization_explore):control_node_id = 「dw-edadfee6」不在你的授权范围内(节点「scen-injecti |

**判定：PASS** — 未绑定拒绝、绑定放行、跨节点越权拒绝。
