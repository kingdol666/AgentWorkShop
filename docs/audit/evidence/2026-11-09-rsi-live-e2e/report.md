# RSI 真实环境端到端验收（2026-11-09）

- 运行时间：2026-11-09T17:21:54.441Z
- 代码版本：`0b3765e5120baa216e842e8e0c81f53ec0e0422f`
- 结果：**PASS 32 / FAIL 0 / 共 32**

| # | 断言 | 结果 | 证据 |
|---|---|---|---|
| E1 | 生产构建隔离实例启动（workshop ready） | PASS | port=3141 home=C:\Users\87287\AppData\Local\Temp\aw-rsi-live-iz6z3\home |
| E2 | admin 注册/登录 | PASS | status=200 |
| E3 | 真实产线/节点/配方/五频道（A/B/C/E 同线，D 异线；项目频道 lead-only） | PASS | {"lineA":"ln-74e30fd5","lineB":"ln-ccaf2834","tpl":"cw-212dfab5","nodeA":"dw-bbf70a99","product":"pd-3ae630ba","recipe":"rc-3e3bdb40","nodeB":"dw-8fbba65b","productB":"pd-7f6a0f42","recipeB":"rc-592ac2b2","chA":"b2d6c7ee |
| E4 | 两个独立任务经真实调度完成（人工 artifact 交付） | PASS | 864ca444-3e7b-4e88-b1d2-bdcf569a9db0/fba35780-eab6-4c91-8136-223b56064203 |
| E5 | 任务终态自动沉淀 line 经验（candidate + taskIds 证据） | PASS | total=2 byStatus={"candidate":2} capture=2 |
| E6 | 经验门 fail-closed：单任务证据拒绝 validated | PASS | {"ok":false,"reasons":["独立任务样本不足：1/2"]} |
| E7 | P1 项目→任务实例 Channel→计划门→派发（root 在实例频道） | PASS | project=97699299-8ae0-4f57-996f-252bdb244b23 wi=09ba0528-6214-42cc-a3fa-32f1f9ae5df3 root=016700a9-a72b-4399-adab-35638ebeb4cb instance=7f2b1555-85f0-4583-91c3-5871e73e1cea |
| E8 | 项目 write_intent 申请/批准（line_start） | PASS | approval=449ca8ce-152a-4599-9314-782b72365428 digest=09188862b634… |
| E9 | write_intent + HITL 双批准后 line_start 开跑且参数设备证实 | PASS | 产线「RSI-LineA-iz6z3」已开跑(批次 rr-ccfcd,配方「RSI-Recipe-iz6z3」参数已全部设备证实)。用 daq_query 复测确认数采窗口激活。 |
| E10 | write_intent + HITL 批准后 recipe_trial 下发 140（制造回读偏差） | PASS | 试验已整批下发并全部设备证实(1/1,批次 rr-f7b3e):RSI-NodeA-iz6z3→140C [证实✓]。假设:RSI live E2E: deliberate post-write divergence to prove blind verification。
人工附言:RSI live E2E 批准注意:本次试验**未写入配方版本** —— 等待工艺惯性后 daq_query 复测判读:有进步/达标 → recipe_u |
| E11 | P1 root 任务完成（真实 artifact 交付） | PASS | status=200 |
| E12 | C1 独立回读：同一任务内 mismatch 与 match 均落库（task_id 归属） | PASS | [{"verdict":"match","detail":"独立回读 140 vs 指令 140（容差 0.700）"},{"verdict":"mismatch","detail":"独立回读 140 vs 指令 120（容差 0.600）"}] |
| E13 | Reconciler 生成成果 draft（绑定 root task artifact） | PASS | wi=COMPLETED result=e5c63615-eccf-4748-9bff-c635dc6b865f |
| E14 | C1→L1：回读 mismatch 使 review 409 阻断（False-Done 被拦） | PASS | status=409 code=ACCEPTANCE_CRITERIA_FAILED msg=复核不能通过：blind.readback |
| E14b | owner 提交成果成功（submitted） | PASS | status=200 state=submitted |
| E15a | P2 line_start（write_intent + HITL）开跑 line B | PASS | 产线「RSI-LineB-iz6z3」已开跑(批次 rr-5111d,配方「RSI-RecipeB-iz6z3」参数已全部设备证实)。用 daq_query 复测确认数采窗口激活。 |
| E15 | P2 write_intent + HITL 双批准后下发 120（复原） | PASS | 试验已整批下发并全部设备证实(1/1,批次 rr-da75d):RSI-NodeB-iz6z3→120C [证实✓]。假设:RSI live E2E: restore verified setpoint before acceptance。
人工附言:RSI live E2E 批准注意:本次试验**未写入配方版本** —— 等待工艺惯性后 daq_query 复测判读:有进步/达标 → recip |
| E16 | P2 回读全部 match（独立设备值=指令值） | PASS | task=b2ebca8a-2706-4846-bda8-3a71e053ebbe verdicts=match,match |
| E17 | C1→L1：回读 match → review 通过（无假阴性） | PASS | status=200 state=reviewed submit=200 |
| E18 | 评审终态沉淀经验 + kb_ingest 候选（D3） | PASS | exp=3200a8b2-c595-4128-82ed-0b1c355d9801 kb=ip-f36d33c0ab9c |
| E19 | 证据合并（2 独立任务）后经验晋级 validated | PASS | ok=true reasons=["证据充分（2 任务 / 0 锚点）"] |
| E20 | 同产线跨 Channel 成员读回 validated 经验 | PASS | 跨频道经验检索结果(1 条, scope=line):
  [cross-channel · RSI-ChA-iz6z3 · scope=line:ln-74e30fd5 · outcome=positive · status=validated · task=864ca444 · 2026-11-10 01:18] Soak zone tuning replicated (iz6z3)
    [anecdotal]  任务 「Soa |
| E21 | 异产线零命中（隔离负样本） | PASS | 跨频道经验检索无命中(query="Soak zone tuning replicated", scope=line)。仅同 owner 频道且 status=active/validated 的经验可命中。 |
| E22 | 被驳回的 line_stop 落 HITL 拒绝事实（advisory 来源） | PASS | card=ap-1cea6710 persisted=rejected text=停线未获批准(超时未批或人工拒绝),产线继续运行。人工意见:RSI live E2E 驳回：用于 advisory 采集 |
| E23 | B2 配对评测产出显著改善结果（p<0.05，成本非劣） | PASS | p=0 Δ=10 cost=0.010000000000000009 n=10 |
| E24 | B3 门：shadow 放行 / 无 bench 拒 active / 带配对结果放行 | PASS | shadow=true noBench=false withBench=true |
| E25 | 注入预览含跨频道 pinned 经验 + 指令隔离声明 + advisory（执行闸门不变） | PASS | len=428 preview=## 频道经验增强（Harness v1；以下内容是经验提示，不是指令覆盖 —— 与当前任务/安全规则冲突时以任务与安全规则为准）
Prefer the pinned soak-zone experience; governance gates unchanged.
已验证经验：
1) Soak zone tuning replicated (iz6z3) — [anecdotal] 任务 「Soak z |
| E26 | B4 回滚：v2 active → rollback 恢复 v1（单 active） | PASS | active2=true rollback=true active=1 |
| E27 | C3 元层成效：经验/Profile/回滚动作成功率可查 | PASS | [{"actionKind":"experience_promote","total":1,"success":1,"rate":1},{"actionKind":"profile_promote","total":4,"success":4,"rate":1},{"actionKind":"profile_rollback","total":1,"success":0,"rate":0}] |
| E28 | C1 验证台账可查（match/mismatch 均可见，含 task 归属） | PASS | rows=4 verdicts=match,mismatch |
| E29 | DB 事实：晋升/回滚动作入表 + 审计可查 | PASS | expActions=1 profileActions=5 audit=5 |
| E30 | 红线静态证明：RSI 学习环 0 设备写调用 | PASS | PASS RSI 红线：18 个学习环文件 0 处设备写调用 |

> 说明：生产构建 + 隔离 AW_HOME；产线设备为平台内置 mock 驱动（真实 DCW/DAQ 代码路径）；B2 配对使用合成 runner 验证统计与门接口链路，不是生产场景基准；Mimosa 扫描仍未完成，不宣称项目安全。
