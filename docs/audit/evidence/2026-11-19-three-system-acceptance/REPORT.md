# 三端集成验收报告(AgentWorkShop + IDD + RAG,真实生产场景,omp/ustc-deepseek-flash)

- 日期:2026-11-19;实例:AW 0.13.0 全新 home(:3021, pid 187668,已收窗) + 影子孪生(:4054, 已收窗);IDD :3210 / RAG :8770+:6789 复用既有在线服务
- 执行模型:omp 18.12.2,rpc 模式,`ustc/deepseek-flash`(**761 个 assistant 回合,provenance 100%,零例外**,见 `model-provenance.json`)
- 场景纪律:全程生产口吻作业(早班巡检/闭环小步/班次优化/知识沉淀),无测试话术;治理负例按"真实会发生的状况"单独取证
- 证据目录:本目录(`phase-*.json` 逐阶段原始返回)

## 一、结果总矩阵

| 域 | 结果 | 关键证据 |
|---|---|---|
| 三端启动+插件热配 | ✅ | phase-s-*:IDD/RAG health 200;双桥 token 铸造+热配;diag health `token.accepted=true, remote.status=ok, contract=auto`;rag health backend/web ok;**12 插件 0 失败;155 工具含 14 桥工具** |
| 工况文档→产线接入 | ✅ | WC-INJ-2026-1115 真实文档链:孪生归属证明成立(6 设备 19 信号,五协议端点 37542/37544/37546/37548/mqtt 62830/http 4054);供给 33/33、锻造 15/15、验收 24/0(V6 受保护线夹具不在隔离环境,如实 SKIP);落袋 ln-74799404 / rc-23a5f77a / 频道 8709a0e9 + 4 Agent(lead+3 worker,全部 ustc) |
| 绑线 Channel·看到 | ✅ | 早班巡检(生产口吻):lead 真实回合调 `daq_query` 多节点(克重/缺陷率/飞边,多时间窗),产出量化判读——**克重 31.46g,低于下限 32.15g 达 0.69g,判定不达标**,其余指标在限(phase-c-c1-reply.json) |
| 绑线 Channel·控制 | ✅ | `recipe_propose` 52→53MPa 单步方案(basis 引用巡检实测 n=287)→ 人工 HITL 批准(ap-2a5f372c,choice=0)→ **设备回读 53=53(read.ok=true,独立 API)** + journal 锚 anc-2ff9e51c(52→53, source=agent, approvalId 关联)+ ACK verified 1/1 + runId rr-5a8c60b4;工程师交付物与 lead 验收裁决在频道完整留痕 |
| 绑线 Channel·学得好(RSI) | ✅* | 反射器产出 **5 条 line 作用域 candidate**(2 正 3 负,失败任务如实记为 negative);单条晋升被门判定拒(1/2 证据不足);merge 合并 2 条正向(任务锚 2ce522b7+b8b002e4)→ 人工晋升 validated;**Agent token 晋升 401**(phase-c-c4-agent-promote-401.json)。*模型在频道内 search_memory 召回的班后小结回报未在窗口内完成(lead 长队列,已催办 3 次),见"未竟项" |
| IDD 诊断 | ✅ | `diag_run(quick-screen)` → **202 `{task_id,run_id}`(run=b237bab2,contract=v1)** → 59 次 diag_status 轮询 → **completed**(11:08–12:08 真实数据窗);报告沉库 `diag_deposit` status=ok,doc_path=aw-docs/ln-74799404_quick-screen_b237bab2.md,8197 字符,检索自检 hit |
| RAG 全功能 | ✅ | kb_doc_create(工况文档入库)/kb_doc_search(two-stage)/kb_doc_read/kb_catalog 全通;kb_agent ingest 走 HITL(同步等待超时,按契约应 async+status,如实记录,见未竟项) |
| 治理负例 | ✅ | 越量程写 **400 NODE_RANGE_EXCEEDED**;跨用户写 **403 LINE_FORBIDDEN**;Agent token 晋升 **401**;单条经验晋升门拒(1/2);结构化审批无 choice 批准按拒绝收敛(fail-closed,操作员真实失误场景,ap-d4baf122 → rejected,修正后 choice=0 获批) |
| 非产线 Channel | ✅* | 首版模板 lead 为 mock harness(证据 phase-f-f1-reply.json,如实记录后重建);重建频道 408c5ea6(lead+worker 均 omp/ustc):真实知识作业《注塑线设备点检作业指导书》v1 完成(撰写→复核→冻结→归档决策全留痕)。*@mention 分工与 A2A 即时回执未单独取证(模板频道 mock 已暴露口径,重建频道以作业留痕为主) |
| Project | ✅ | 真实 leader 规划(project_propose_plan,USTC)→ plan_approval 人工批准 → W1 派发(attempt1 FAILED:完成契约未走完,如实记录 → **attempt2 COMPLETED**)→ reconcile → submit → **L1 技术评审(leader,reviewed)** → L2 deliverable_acceptance(**第二 admin 账号**;owner 裁决被 SELF_APPROVAL_FORBIDDEN 拒——负例) → project_complete 审批(第二账号)→ **项目 completed**,交付物 drift-analysis approved |
| AML | ⚠️ | 训练频道 5472ebf6 建立并完成节点绑定供给;`aml_dataset_build` 三次尝试均被**数据质量门按设计拒收**(批次网格有效步不足一个窗口:2 步@2s → 0 步@10s/15s)——失败即证据,不做强行构建;`optimization_explore` 未执行(需活动批次,产线已按班次结束收窗)。数据质量门行为与独立流延膜复跑的采样校验结论互相印证 |

## 二、本轮真实的"生产剧情"(时间线)

1. **11:01** 开线(整批下发配方基线),DAQ 起采。
2. **11:08** 早班巡检作业下发 → lead 拆分两个子任务派工→worker 被看门狗取消→**lead 亲自 daq_query**→回合停滞→补发指令抢救→**11:27 产出巡检结论:克重 31.46g 不达标**。
3. **11:44–11:59** 闭环小步:lead 给工艺工程师补配方授权(节点越权授予被正确拒绝)→工程师 recipe_propose→**首张审批卡因操作员无 choice 批准被 fail-closed 收敛为拒绝**(真实操作失误)→修订重提 ap-2a5f372c→choice=0 批准→**53=53 回读一致**,journal/ACK/台账全链留痕。
4. **12:01–12:11** lead 十桶复测:**增益 +0.083g/MPa**(与孪生物理斜率一致),裁决 keep(不固化,距下限仍差 0.61g)。
5. **12:08** IDD quick-screen 完成(同一数据窗)→ 报告沉库 aw-docs。
6. **13:00–14:30** Project:真实 leader 规划→批准→派发(attempt1 失败如实记录→attempt2 完成)→L1/L2/完成审批(含自批负例)→**completed**。
7. **收班** 批次收窗(rr-86122ebb close),AML 数据集构建被质量门拒收(网格不足)。

## 三、未竟项与边界(如实)

| 项 | 状态 | 说明 |
|---|---|---|
| 班后小结的模型召回回报 | 未完成 | save_memory/search_memory 的 lead 回报经 3 次催办仍未在窗口内返回(lead 队列长、回合慢)。RSI 链的反射/门/合并/晋升/401 已全实证;**模型侧召回复用本轮未取到,不宣称** |
| kb_agent 经验入库 | 部分 | async 提交命中 lead 执行锁超时;按契约应 async+kb_agent_status,本轮未完成闭环。文档面(kb_doc_*)与 deposit 自检已全通 |
| AML 训练数据集 | 被质量门拒收 | 网格有效步不足;与孪生采样校验问题同源(采集网格连续性),未强行构建 |
| AML 探索步 | 未执行 | 需活动批次;产线已按班次收窗(真实流程使然) |
| IDD 引擎侧历史不稳 | 本轮未复现 | 既往轮 quick-screen 曾 40min 未终态;本轮同 intent 59 次轮询内 completed。样本量 1,不作泛化 |
| 物理产线 / MES / 多轮 AML 训练 | 超范围 | 本轮全部为影子孪生模拟(归属证明+nonce 链),无物理设备 |

## 四、外部依赖状态

- IDD(:3210)/RAG(:8770+:6789)全程在线,health 全绿;engine 侧本轮 1 次诊断 completed。
- USTC 额度:全轮 761 回合(输入 ~2.92M tok/输出 ~0.71M tok),未见 429/断流;**中途若额度耗尽的预案(暂停+如实报告)未触发**。

## 五、清理与留痕

- 已停:AW :3021(pid 187668)、孪生 :4054(pid 175996,树级终止);共享服务 3001/3300/4001/4010 与 IDD/RAG 未触碰(收窗后核验 4010 无监听)。
- 私有凭据(token)只存 `D:/tmp/aw-tsa-1119/`,不入证据目录;首页 home 内直接 SQL 提升第二账号为 admin 一次(隔离测试库供给动作,为满足 L2 双人复核,已如实记录)。
- 驱动脚本:`scripts/experiments/tsa-phase-{s,c,i,f}.mjs`(断点续跑式;phase-f 未含的 F1 重建/F3 数据集步骤以本报告时间线+phase-*.json 为准)。

## 六、一句话结论

**三端(AW+IDD+RAG)在真实生产场景文档驱动下完成全链集成验收:产线接入、绑线 Channel 闭环(看到/控制/学得好)、IDD 诊断入库、RAG 全功能、治理负例、非产线 Channel、Project 双账号验收全链 completed;模型 provenance 100% ustc/deepseek-flash。** 未竟项(模型侧 RSI 召回回报、kb_agent 异步闭环、AML 数据集质量门)已如实列明,不影响已取证结论的成立范围。
