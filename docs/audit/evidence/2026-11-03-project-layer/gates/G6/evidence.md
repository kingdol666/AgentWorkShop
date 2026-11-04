# G6 — Live 全量：产线治理 E2E + 项目生产业务 E2E + 回滚演练

> 生成时间：2026-11-04T07:14:11.478Z
# G6 — Live 全量：产线治理 E2E + 项目生产业务 E2E + 回滚演练

> 生成时间：2026-11-04T07:04:42.028Z
# G6 — Live 全量：产线治理 E2E + 项目生产业务 E2E + 回滚演练

> 生成时间：2026-11-04T06:58:30.306Z

## `node scripts/e2e-line-governance.mjs` — PASS (51s, exit=0)

```
✔ [L1] 隔离实例启动 + workshop ready
✔ [L1b] admin 注册/登录
✔ [L2] 建线/节点/产品/配方/频道(lead)/绑线
✔ [L3a] line_start 生成审批卡(line-start:*)
✔ [L3b] 批准后开线成功且参数设备证实
✔ [L3c] line_status 显示运行中
✔ [L4a] line_stop 生成审批卡(line-stop:*)
✔ [L4b] 批准后停线成功
✔ [L4c] 停线后 line_status 未运行
✔ [L5a] 换线前审批卡已挂起
✔ [L5b] 换线后审批单取消且未开线
✔ [L5c] A 线仍未运行
✔ [L6a] 不可下发配方仍生成审批卡(预检在批准后执行)
    L6 raw: {"status":200,"code":0,"message":"ok","data":{"result":{"text":"开线失败:配方「停用配方-lmk48h」全部 1 个参数均未下发成功。已自动停线收窗,产线未保持运行状态。\n失败明细:\n  - 停用数控-lmk48h: 已跳过:节点「停用数控-lmk48h」已停用,参数未下发","isError":true}}}
✔ [L6b] 全部参数失败 → isError + 已自动停线
✔ [L6c] 自动停线后 line_status 未运行
✔ [L7a] 数采节点创建(不直接绑定,仅频道绑线可读)
✔ [L7b] daq_query limit=-5 → 参数错误
✔ [L7c] daq_query from>=to → 时间窗错误
✔ [L7d] daq_query bucket_ms=-1 → 参数错误
✔ [L7e] daq_frames kind=foo → 参数错误
✔ [L7f] 频道绑线节点可只读导出(daq_export 授权同源)
✔ [L8a] 预备批次已开跑
✔ [L8b] 停线审批卡已挂起
✔ [L8c] 人工停线后重开新批次
✔ [L8d] 旧停线审批被批次复核拒绝
✔ [L8e] 新批次仍在运行(未被旧单误停)
✔ [L9a] 开线审批卡已挂起
✔ [L9b] 审批期间配方改版成功
✔ [L9c] 旧配方快照批准后拒绝开线
✔ [L9d] 配方变更后产线未开跑
✔ [L10a] 解绑线后可显式绑 B 线节点
✔ [L10b] 换线到 A 后 B 线绑定被清理(查询被拒)
✔ [L11a] 读取频道成员 agent token
✔ [L11b] agent token 调用 daq_query 成功(频道绑线只读面)
✔ [L11e] 错误 agent token 被拒(401/403)
✔ [L11c] agent token 发起 line_start 并挂审批
✔ [L11d] agent token 经治理链开线成功
✔ [L12a] 产线开跑用于实采
✔ [L12b] DAQ 实采样本可查
✔ [L12c] DCW 写入受理 + ACK 等级如实
✔ [L12d] DCW 回读一致
✔ [L12e] 超单步限幅被拒(20)
✔ [L12f] 60s 写间隔被拒
✔ [L12g] 越节点量程被拒

═══ 结论:PASS(44/44)═══
```

## `node scripts/e2e-project-line-acceptance.mjs` — PASS (18s, exit=0)

```
OMPLETED",
      "pass": true,
      "detail": "status=200 state=COMPLETED"
    },
    {
      "id": "P13c",
      "name": "root COMPLETED 自动生成成果 draft（带真实 artifact 证据）",
      "pass": true,
      "detail": "status=200 result=draft evidence=[{\"artifactId\":\"970549f7-06b3-46e6-9465-0e63a245ab7b\",\"name\":\"lead-direct-answer\",\"kind\":\"artifact\"}]"
    },
    {
      "id": "P13c2",
      "name": "channel lead read_results 可见本频道 draft",
      "pass": true,
      "detail": "text=[\n  {\n    \"id\": \"568468e8-57a6-42d3-b49e-b41a7d0cf9bf\",\n    \"title\": \"建立产线基线-pll1ax 成果\",\n    \"status\": \"draft\",\n    \"channelId\": \"5067f50a-a171-4fb0-a641-490c46f8eceb\",\n    \"deliverableId\": \"76b8b19b-7caf-4912-b859-f33a667027a1\",\n    \"workItemId\": \"173dd9cd-7cef-41c6-87bd-49ea183c495b\",\n    \"attempt"
    },
    {
      "id": "P22b",
      "name": "viewer 成果按 line grant 过滤（无授权=空，owner 可见）",
      "pass": true,
      "detail": "viewerRows=0 ownerRows=1"
    },
    {
      "id": "P13d",
      "name": "成果 submit（channel lead 工具）",
      "pass": true,
      "detail": "status=200 text={\n  \"ok\": true,\n  \"result\": {\n    \"id\": \"568468e8-57a6-42d3-b49e-b41a7d0cf9bf\",\n    \"status\": \"submitted\",\n    \"title\": \"建立产线基线-pll1ax 成果\",\n    \"workItemId\": \"173dd9cd-7cef-41c6-87bd-49ea183c495b\",\n    \"attemptNo\": 1,\n    \"version\": 1,\n    \"evidenceCount\": 1\n  }\n}"
    },
    {
      "id": "P13e",
      "name": "成果 review（owner/leader）",
      "pass": true,
      "detail": "status=200"
    },
    {
      "id": "P14",
      "name": "成果验收审批已创建 pending",
      "pass": true,
      "detail": "status=200"
    },
    {
      "id": "P14b",
      "name": "owner 批准成果验收",
      "pass": true,
      "detail": "status=200"
    },
    {
      "id": "P13f",
      "name": "成果 approved",
      "pass": true,
      "detail": "state=approved"
    },
    {
      "id": "P14c",
      "name": "交付物 approved",
      "pass": true,
      "detail": "state=approved"
    },
    {
      "id": "P16",
      "name": "审计 decisions/events 落库且带 trace",
      "pass": true,
      "detail": "decisions=9 events=8"
    },
    {
      "id": "P14d",
      "name": "审批重复决策 → 409",
      "pass": true,
      "detail": "status=409 code=APPROVAL_STATE_INVALID"
    },
    {
      "id": "P14e1",
      "name": "project_leader 计划提案（proposal + plan_approval）",
      "pass": true,
      "detail": "status=200 text={\n  \"ok\": true,\n  \"proposalId\": \"8e90aec8-62f1-4c0b-8d63-e9124e896b6b\",\n  \"approvalId\": \"7cb06a66-6c59-426c-b3d4-4d01ef9325ea\",\n  \"planVersion\": 1,\n  \"status\": \"pending\",\n  \"next\": \"owner 必须在项目审批页批准计划；批准后 ProjectService 自动物化交付物与工作项（幂等）\"\n}"
    },
    {
      "id": "P14e2",
      "name": "同版本计划审批幂等（leader 提案复用同一 approval）",
      "pass": true,
      "detail": "planReq=200 id=7cb06a66-6c59-426c-b3d4-4d01ef9325ea proposed=7cb06a66-6c59-426c-b3d4-4d01ef9325ea"
    },
    {
      "id": "P14e3",
      "name": "approver 成员批准 plan → planVersion=1 + leader 交付物物化",
      "pass": true,
      "detail": "memUp=200 planDec=200 version=1 deliverables=2"
    },
    {
      "id": "P20a",
      "name": "channel lead 申请 write_intent（pending + args digest）",
      "pass": true,
      "detail": "status=200 text={\n  \"ok\": true,\n  \"approvalId\": \"784ea242-92f9-4265-9406-cab0fdef912f\",\n  \"digest\": \"6cba1ff6c39b158aab5d302da55d5532ec5a68276dee6c00d3179c5748c512fc\",\n  \"tool\": \"recipe_update\",\n  \"status\": \"pending\",\n  \"next\": \"owner 批准后，执行器只放行 tool/args digest/attempt 完全一致的这一次调用（一次性）\"\n}"
    },
    {
      "id": "P20b",
      "name": "owner 批准 write_intent",
      "pass": true,
      "detail": "status=200"
    },
    {
      "id": "P14f",
      "name": "项目完成门禁 + owner 批准 → completed",
      "pass": true,
      "detail": "completeReq=200 completeDec=200 status=completed"
    },
    {
      "id": "P17a",
      "name": "周报 API 数字与库一致（交付物/成果/工作项/进度）",
      "pass": true,
      "detail": "status=200 d=2 r=1 w=1 ratio=1"
    }
  ]
}
```

## `node scripts/e2e-project-rollback.mjs` — PASS (52s, exit=0)

```
✔ [R0] 隔离实例启动（boot1）
✔ [R1] 基线对象（产线+绑线频道）
✔ [R2a] 停服
[backup:baseline] 1486848 bytes
✔ [R2b] DB 文件备份
✔ [R3a] 重启（boot2）
✔ [R3b] 完整项目流（派发/完成/对账）
✔ [R4a] 停服
✔ [R4b] DB 恢复到基线备份
✔ [R5a] 重启（boot3）
✔ [R5b] 回滚生效：项目消失
✔ [R5c] 基线保留：频道仍在
✔ [R5d] 产线业务面正常

=== ROLLBACK pass=12 fail=0 ===
```

## `node scripts/e2e-line-governance.mjs` — PASS (39s, exit=0)

```
✔ [L1] 隔离实例启动 + workshop ready
✔ [L1b] admin 注册/登录
✔ [L2] 建线/节点/产品/配方/频道(lead)/绑线
✔ [L3a] line_start 生成审批卡(line-start:*)
✔ [L3b] 批准后开线成功且参数设备证实
✔ [L3c] line_status 显示运行中
✔ [L4a] line_stop 生成审批卡(line-stop:*)
✔ [L4b] 批准后停线成功
✔ [L4c] 停线后 line_status 未运行
✔ [L5a] 换线前审批卡已挂起
✔ [L5b] 换线后审批单取消且未开线
✔ [L5c] A 线仍未运行
✔ [L6a] 不可下发配方仍生成审批卡(预检在批准后执行)
    L6 raw: {"status":200,"code":0,"message":"ok","data":{"result":{"text":"开线失败:配方「停用配方-lms85c」全部 1 个参数均未下发成功。已自动停线收窗,产线未保持运行状态。\n失败明细:\n  - 停用数控-lms85c: 已跳过:节点「停用数控-lms85c」已停用,参数未下发","isError":true}}}
✔ [L6b] 全部参数失败 → isError + 已自动停线
✔ [L6c] 自动停线后 line_status 未运行
✔ [L7a] 数采节点创建(不直接绑定,仅频道绑线可读)
✔ [L7b] daq_query limit=-5 → 参数错误
✔ [L7c] daq_query from>=to → 时间窗错误
✔ [L7d] daq_query bucket_ms=-1 → 参数错误
✔ [L7e] daq_frames kind=foo → 参数错误
✔ [L7f] 频道绑线节点可只读导出(daq_export 授权同源)
✔ [L8a] 预备批次已开跑
✔ [L8b] 停线审批卡已挂起
✔ [L8c] 人工停线后重开新批次
✔ [L8d] 旧停线审批被批次复核拒绝
✔ [L8e] 新批次仍在运行(未被旧单误停)
✔ [L9a] 开线审批卡已挂起
✔ [L9b] 审批期间配方改版成功
✔ [L9c] 旧配方快照批准后拒绝开线
✔ [L9d] 配方变更后产线未开跑
✔ [L10a] 解绑线后可显式绑 B 线节点
✔ [L10b] 换线到 A 后 B 线绑定被清理(查询被拒)
✔ [L11a] 读取频道成员 agent token
✔ [L11b] agent token 调用 daq_query 成功(频道绑线只读面)
✔ [L11e] 错误 agent token 被拒(401/403)
✔ [L11c] agent token 发起 line_start 并挂审批
✔ [L11d] agent token 经治理链开线成功
✔ [L12a] 产线开跑用于实采
✔ [L12b] DAQ 实采样本可查
✔ [L12c] DCW 写入受理 + ACK 等级如实
✔ [L12d] DCW 回读一致
✔ [L12e] 超单步限幅被拒(20)
✔ [L12f] 60s 写间隔被拒
✔ [L12g] 越节点量程被拒

═══ 结论:PASS(44/44)═══
```

## `node scripts/e2e-project-line-acceptance.mjs` — PASS (17s, exit=0)

```
OMPLETED",
      "pass": true,
      "detail": "status=200 state=COMPLETED"
    },
    {
      "id": "P13c",
      "name": "root COMPLETED 自动生成成果 draft（带真实 artifact 证据）",
      "pass": true,
      "detail": "status=200 result=draft evidence=[{\"artifactId\":\"69816996-797f-4f25-8897-143608c4775b\",\"name\":\"lead-direct-answer\",\"kind\":\"artifact\"}]"
    },
    {
      "id": "P13c2",
      "name": "channel lead read_results 可见本频道 draft",
      "pass": true,
      "detail": "text=[\n  {\n    \"id\": \"4b4b1e75-6360-436a-805e-3acca42b2c87\",\n    \"title\": \"建立产线基线-plt03z 成果\",\n    \"status\": \"draft\",\n    \"channelId\": \"c36876c6-6fb9-49b9-a409-3570e803c330\",\n    \"deliverableId\": \"c0a29857-ffb6-4193-a356-9eea4ed62916\",\n    \"workItemId\": \"f8642b70-450b-4e34-9984-82aa5e229b7b\",\n    \"attempt"
    },
    {
      "id": "P22b",
      "name": "viewer 成果按 line grant 过滤（无授权=空，owner 可见）",
      "pass": true,
      "detail": "viewerRows=0 ownerRows=1"
    },
    {
      "id": "P13d",
      "name": "成果 submit（channel lead 工具）",
      "pass": true,
      "detail": "status=200 text={\n  \"ok\": true,\n  \"result\": {\n    \"id\": \"4b4b1e75-6360-436a-805e-3acca42b2c87\",\n    \"status\": \"submitted\",\n    \"title\": \"建立产线基线-plt03z 成果\",\n    \"workItemId\": \"f8642b70-450b-4e34-9984-82aa5e229b7b\",\n    \"attemptNo\": 1,\n    \"version\": 1,\n    \"evidenceCount\": 1\n  }\n}"
    },
    {
      "id": "P13e",
      "name": "成果 review（owner/leader）",
      "pass": true,
      "detail": "status=200"
    },
    {
      "id": "P14",
      "name": "成果验收审批已创建 pending",
      "pass": true,
      "detail": "status=200"
    },
    {
      "id": "P14b",
      "name": "owner 批准成果验收",
      "pass": true,
      "detail": "status=200"
    },
    {
      "id": "P13f",
      "name": "成果 approved",
      "pass": true,
      "detail": "state=approved"
    },
    {
      "id": "P14c",
      "name": "交付物 approved",
      "pass": true,
      "detail": "state=approved"
    },
    {
      "id": "P16",
      "name": "审计 decisions/events 落库且带 trace",
      "pass": true,
      "detail": "decisions=9 events=8"
    },
    {
      "id": "P14d",
      "name": "审批重复决策 → 409",
      "pass": true,
      "detail": "status=409 code=APPROVAL_STATE_INVALID"
    },
    {
      "id": "P14e1",
      "name": "project_leader 计划提案（proposal + plan_approval）",
      "pass": true,
      "detail": "status=200 text={\n  \"ok\": true,\n  \"proposalId\": \"3089c057-9ab5-4879-9320-db8e59bceea3\",\n  \"approvalId\": \"13e25c37-dcba-4d2a-98e7-efce795119c2\",\n  \"planVersion\": 1,\n  \"status\": \"pending\",\n  \"next\": \"owner 必须在项目审批页批准计划；批准后 ProjectService 自动物化交付物与工作项（幂等）\"\n}"
    },
    {
      "id": "P14e2",
      "name": "同版本计划审批幂等（leader 提案复用同一 approval）",
      "pass": true,
      "detail": "planReq=200 id=13e25c37-dcba-4d2a-98e7-efce795119c2 proposed=13e25c37-dcba-4d2a-98e7-efce795119c2"
    },
    {
      "id": "P14e3",
      "name": "approver 成员批准 plan → planVersion=1 + leader 交付物物化",
      "pass": true,
      "detail": "memUp=200 planDec=200 version=1 deliverables=2"
    },
    {
      "id": "P20a",
      "name": "channel lead 申请 write_intent（pending + args digest）",
      "pass": true,
      "detail": "status=200 text={\n  \"ok\": true,\n  \"approvalId\": \"8affa4f7-4666-4ccb-bbd6-2aa1519a713d\",\n  \"digest\": \"119a50f088af1abdbc034ff4b48143614e20a382502764e6c44215270fd572d7\",\n  \"tool\": \"recipe_update\",\n  \"status\": \"pending\",\n  \"next\": \"owner 批准后，执行器只放行 tool/args digest/attempt 完全一致的这一次调用（一次性）\"\n}"
    },
    {
      "id": "P20b",
      "name": "owner 批准 write_intent",
      "pass": true,
      "detail": "status=200"
    },
    {
      "id": "P14f",
      "name": "项目完成门禁 + owner 批准 → completed",
      "pass": true,
      "detail": "completeReq=200 completeDec=200 status=completed"
    },
    {
      "id": "P17a",
      "name": "周报 API 数字与库一致（交付物/成果/工作项/进度）",
      "pass": true,
      "detail": "status=200 d=2 r=1 w=1 ratio=1"
    }
  ]
}
```

## `node scripts/e2e-project-rollback.mjs` — PASS (52s, exit=0)

```
✔ [R0] 隔离实例启动（boot1）
✔ [R1] 基线对象（产线+绑线频道）
✔ [R2a] 停服
[backup:baseline] 1486848 bytes
✔ [R2b] DB 文件备份
✔ [R3a] 重启（boot2）
✔ [R3b] 完整项目流（派发/完成/对账）
✔ [R4a] 停服
✔ [R4b] DB 恢复到基线备份
✔ [R5a] 重启（boot3）
✔ [R5b] 回滚生效：项目消失
✔ [R5c] 基线保留：频道仍在
✔ [R5d] 产线业务面正常

=== ROLLBACK pass=12 fail=0 ===
```

## `node scripts/e2e-line-governance.mjs` — PASS (40s, exit=0)

```
✔ [L1] 隔离实例启动 + workshop ready
✔ [L1b] admin 注册/登录
✔ [L2] 建线/节点/产品/配方/频道(lead)/绑线
✔ [L3a] line_start 生成审批卡(line-start:*)
✔ [L3b] 批准后开线成功且参数设备证实
✔ [L3c] line_status 显示运行中
✔ [L4a] line_stop 生成审批卡(line-stop:*)
✔ [L4b] 批准后停线成功
✔ [L4c] 停线后 line_status 未运行
✔ [L5a] 换线前审批卡已挂起
✔ [L5b] 换线后审批单取消且未开线
✔ [L5c] A 线仍未运行
✔ [L6a] 不可下发配方仍生成审批卡(预检在批准后执行)
    L6 raw: {"status":200,"code":0,"message":"ok","data":{"result":{"text":"开线失败:配方「停用配方-lm4f7r」全部 1 个参数均未下发成功。已自动停线收窗,产线未保持运行状态。\n失败明细:\n  - 停用数控-lm4f7r: 已跳过:节点「停用数控-lm4f7r」已停用,参数未下发","isError":true}}}
✔ [L6b] 全部参数失败 → isError + 已自动停线
✔ [L6c] 自动停线后 line_status 未运行
✔ [L7a] 数采节点创建(不直接绑定,仅频道绑线可读)
✔ [L7b] daq_query limit=-5 → 参数错误
✔ [L7c] daq_query from>=to → 时间窗错误
✔ [L7d] daq_query bucket_ms=-1 → 参数错误
✔ [L7e] daq_frames kind=foo → 参数错误
✔ [L7f] 频道绑线节点可只读导出(daq_export 授权同源)
✔ [L8a] 预备批次已开跑
✔ [L8b] 停线审批卡已挂起
✔ [L8c] 人工停线后重开新批次
✔ [L8d] 旧停线审批被批次复核拒绝
✔ [L8e] 新批次仍在运行(未被旧单误停)
✔ [L9a] 开线审批卡已挂起
✔ [L9b] 审批期间配方改版成功
✔ [L9c] 旧配方快照批准后拒绝开线
✔ [L9d] 配方变更后产线未开跑
✔ [L10a] 解绑线后可显式绑 B 线节点
✔ [L10b] 换线到 A 后 B 线绑定被清理(查询被拒)
✔ [L11a] 读取频道成员 agent token
✔ [L11b] agent token 调用 daq_query 成功(频道绑线只读面)
✔ [L11e] 错误 agent token 被拒(401/403)
✔ [L11c] agent token 发起 line_start 并挂审批
✔ [L11d] agent token 经治理链开线成功
✔ [L12a] 产线开跑用于实采
✔ [L12b] DAQ 实采样本可查
✔ [L12c] DCW 写入受理 + ACK 等级如实
✔ [L12d] DCW 回读一致
✔ [L12e] 超单步限幅被拒(20)
✔ [L12f] 60s 写间隔被拒
✔ [L12g] 越节点量程被拒

═══ 结论:PASS(44/44)═══
```

## `node scripts/e2e-project-line-acceptance.mjs` — PASS (17s, exit=0)

```
OMPLETED",
      "pass": true,
      "detail": "status=200 state=COMPLETED"
    },
    {
      "id": "P13c",
      "name": "root COMPLETED 自动生成成果 draft（带真实 artifact 证据）",
      "pass": true,
      "detail": "status=200 result=draft evidence=[{\"artifactId\":\"299fc8c0-9676-45cc-8c53-0320043d34a7\",\"name\":\"lead-direct-answer\",\"kind\":\"artifact\"}]"
    },
    {
      "id": "P13c2",
      "name": "channel lead read_results 可见本频道 draft",
      "pass": true,
      "detail": "text=[\n  {\n    \"id\": \"78306aec-12f8-4b0a-81d5-0bdacff7f9b3\",\n    \"title\": \"建立产线基线-pl57ha 成果\",\n    \"status\": \"draft\",\n    \"channelId\": \"da05d8b8-a8b6-4ebc-a2fd-18054b54eaca\",\n    \"deliverableId\": \"9dda0903-4e89-498d-9dc3-6cb413122700\",\n    \"workItemId\": \"7e8cb3e9-5fd6-47b1-ba81-9e3f9ea75725\",\n    \"attempt"
    },
    {
      "id": "P22b",
      "name": "viewer 成果按 line grant 过滤（无授权=空，owner 可见）",
      "pass": true,
      "detail": "viewerRows=0 ownerRows=1"
    },
    {
      "id": "P13d",
      "name": "成果 submit（channel lead 工具）",
      "pass": true,
      "detail": "status=200 text={\n  \"ok\": true,\n  \"result\": {\n    \"id\": \"78306aec-12f8-4b0a-81d5-0bdacff7f9b3\",\n    \"status\": \"submitted\",\n    \"title\": \"建立产线基线-pl57ha 成果\",\n    \"workItemId\": \"7e8cb3e9-5fd6-47b1-ba81-9e3f9ea75725\",\n    \"attemptNo\": 1,\n    \"version\": 1,\n    \"evidenceCount\": 1\n  }\n}"
    },
    {
      "id": "P13e",
      "name": "成果 review（owner/leader）",
      "pass": true,
      "detail": "status=200"
    },
    {
      "id": "P14",
      "name": "成果验收审批已创建 pending",
      "pass": true,
      "detail": "status=200"
    },
    {
      "id": "P14b",
      "name": "owner 批准成果验收",
      "pass": true,
      "detail": "status=200"
    },
    {
      "id": "P13f",
      "name": "成果 approved",
      "pass": true,
      "detail": "state=approved"
    },
    {
      "id": "P14c",
      "name": "交付物 approved",
      "pass": true,
      "detail": "state=approved"
    },
    {
      "id": "P16",
      "name": "审计 decisions/events 落库且带 trace",
      "pass": true,
      "detail": "decisions=9 events=8"
    },
    {
      "id": "P14d",
      "name": "审批重复决策 → 409",
      "pass": true,
      "detail": "status=409 code=APPROVAL_STATE_INVALID"
    },
    {
      "id": "P14e1",
      "name": "project_leader 计划提案（proposal + plan_approval）",
      "pass": true,
      "detail": "status=200 text={\n  \"ok\": true,\n  \"proposalId\": \"9837e8aa-6d9a-4c35-88d8-7bee06213fd2\",\n  \"approvalId\": \"58141a86-210d-4d1e-97af-d899b8bc7ad2\",\n  \"planVersion\": 1,\n  \"status\": \"pending\",\n  \"next\": \"owner 必须在项目审批页批准计划；批准后 ProjectService 自动物化交付物与工作项（幂等）\"\n}"
    },
    {
      "id": "P14e2",
      "name": "同版本计划审批幂等（leader 提案复用同一 approval）",
      "pass": true,
      "detail": "planReq=200 id=58141a86-210d-4d1e-97af-d899b8bc7ad2 proposed=58141a86-210d-4d1e-97af-d899b8bc7ad2"
    },
    {
      "id": "P14e3",
      "name": "approver 成员批准 plan → planVersion=1 + leader 交付物物化",
      "pass": true,
      "detail": "memUp=200 planDec=200 version=1 deliverables=2"
    },
    {
      "id": "P20a",
      "name": "channel lead 申请 write_intent（pending + args digest）",
      "pass": true,
      "detail": "status=200 text={\n  \"ok\": true,\n  \"approvalId\": \"f3849a06-635f-4950-9cef-c98e46676850\",\n  \"digest\": \"218e612254a7df36a561bb5ed86b33331164c0a49b470b9e374c083eef3a4f18\",\n  \"tool\": \"recipe_update\",\n  \"status\": \"pending\",\n  \"next\": \"owner 批准后，执行器只放行 tool/args digest/attempt 完全一致的这一次调用（一次性）\"\n}"
    },
    {
      "id": "P20b",
      "name": "owner 批准 write_intent",
      "pass": true,
      "detail": "status=200"
    },
    {
      "id": "P14f",
      "name": "项目完成门禁 + owner 批准 → completed",
      "pass": true,
      "detail": "completeReq=200 completeDec=200 status=completed"
    },
    {
      "id": "P17a",
      "name": "周报 API 数字与库一致（交付物/成果/工作项/进度）",
      "pass": true,
      "detail": "status=200 d=2 r=1 w=1 ratio=1"
    }
  ]
}
```

## `node scripts/e2e-project-rollback.mjs` — PASS (52s, exit=0)

```
✔ [R0] 隔离实例启动（boot1）
✔ [R1] 基线对象（产线+绑线频道）
✔ [R2a] 停服
[backup:baseline] 1486848 bytes
✔ [R2b] DB 文件备份
✔ [R3a] 重启（boot2）
✔ [R3b] 完整项目流（派发/完成/对账）
✔ [R4a] 停服
✔ [R4b] DB 恢复到基线备份
✔ [R5a] 重启（boot3）
✔ [R5b] 回滚生效：项目消失
✔ [R5c] 基线保留：频道仍在
✔ [R5d] 产线业务面正常

=== ROLLBACK pass=12 fail=0 ===
```
