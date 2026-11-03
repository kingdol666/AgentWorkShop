# E3 审批门：manual（需批准） vs auto（免批准）

- run: `20261101121436-approval-gate` · base http://127.0.0.1:3005 · scenario injection · line ln-3856f218 · node scen-injection:dcw:barrel-temp-1-sp(dw-42d04635)
- 步长 2.8000000000000003 · 工具 `optimization_explore` · 初始值按 30%/40% 量程分刺激复位

| 臂 | 刺激 | 审批卡 | 裁决 | 设备变化 | isError | 前→后 | 时延 |
|---|---|---|---|---|---|---|---|
| manual | legal-approved | 有 | approved | **变化** | false | 202→204.8000030517578 | 10593ms |
| manual | legal-rejected | 有 | rejected | **不变** | true | 216→216 | 544ms |
| auto | legal-request (manual arm rejected) | 无 | n/a | **变化** | false | 202→204.8000030517578 | 10071ms |
| auto | legal-request (manual arm approved) | 无 | n/a | **变化** | false | 216→218.8000030517578 | 10073ms |

**判定：PASS** — 拒绝的请求未到达设备；同一请求在免批准配置下执行。

## 口径（写进论文脚注）

1. 这是**配置级对照**（manual vs auto），不是「只跳过审批等待」的单机制消融；
   后者需要 bench-only 旁路并另经安全审阅，本轮未做。
2. manual 臂的批准/拒绝由脚本夹具执行，**不是人工判断质量证据**。
3. 两臂同一场景/节点/初始值/工具/步长；审批卡只在 manual 臂出现。
