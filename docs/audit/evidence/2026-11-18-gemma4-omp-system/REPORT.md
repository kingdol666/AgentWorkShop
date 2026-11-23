# 本地 Gamma4(gemma-4-12b-qat)+ omp harness 全系统端到端验收报告

- 日期:2026-11-18
- 实例:隔离 `AW_MODE=home`, `AW_HOME=D:/tmp/aw-gemma4-1118/home`, 端口 `3072`,版本 0.13.0
- 模型:LM Studio `google/gemma-4-12b-qat`(Q4_0,7.15 GB),context **65536**,parallel **1**,单实例串行
- Harness:`omp 18.12.2`,`--mode rpc`;模型经 `set_model {provider: local, modelId: google/gemma-4-12b-qat}`
- 范围:Channel 通信、Project 模式、RSI 持续学习;产线(mock 隔离模拟线)与非产线。**未集成 IDD/RAG**
- 结论:US-001～US-005 通过;US-006 由本报告完成。报告中的 PASS 均有原始 JSON/JSONL/日志支撑;测试脚本自身的断言失败(时序/正则)单独披露,不用其替代功能证据。

---

## 0. 环境与真实模型基线(US-001)— PASS

| 判据 | 结果 | 证据 |
| --- | --- | --- |
| Gemma4 以 64k/parallel=1 加载 | PASS | `env/lms-ps.txt`:`CONTEXT 65536 / PARALLEL 1` |
| omp local provider 注册模型 id | PASS | `env/local-provider-redacted.yml`(apiKey 已剔除) |
| 隔离实例健康 + 首注册 admin | PASS | `env/health.json`(实例就绪)+ `env/admin-redacted.json`(admin `gemma@aw.local`,createdAt 17:29:24,无 token) |
| LM Studio 直连返回非空 content | PASS | `env/direct-probe.json`:`content="GEMMA4_OK"`,`finish_reason="stop"`(首次探测 32 token 上限被 reasoning 吃满导致空 content,已用 160 token 重测) |
| omp 真实回合 + 模型可证 | PASS | 任务「常识问答:水沸点」COMPLETED,交付「100°C」;`raw/omp-sessions/channel-lead-water-boiling.jsonl` 的 assistant 消息全部 `provider=local / model=google/gemma-4-12b-qat`;`raw/omp-sessions/provenance.json` 汇总全部归档会话均为 local/gemma |

**关键发现(已修正)**:`config.model` 必须是 omp 的**模型 id**,不能用显示名。首轮传显示名 `gemma-4-12b-64k` 时平台 `set_model` 失败被吞,omp 静默回落默认 `ustc/deepseek-flash`(`raw/omp-sessions/fallback-ustc-deepseek.jsonl` 的 `model_change` 可证)。修正为 `google/gemma-4-12b-qat` 后,归档的 10 个 JSONL 中,除 fallback 文件(仅含切换前的云端回合)外,其余 9 个会话的 assistant 回合全部为 local/gemma(`raw/omp-sessions/provenance.json`)。

## 1. Channel 通信(非产线)(US-002)— PASS

| 判据 | 结果 | 证据 |
| --- | --- | --- |
| lead+worker 两个 omp Agent,provider=local、model=google/gemma-4-12b-qat、rpcMode=rpc | PASS | `channel/us002-agents-fixed.json`;PRD 判据已按 omp 约束更正为模型 id |
| 频道绑定 2 个 Agent | PASS | 创建后 `agents=2`(`channel/us002-channel-create.json` 返回 channelId;`us002-agents-fixed.json`) |
| lead 真实回合 | PASS | 水沸点任务交付「100°C」(`channel/us002b-task-final.json`);模型证据见 raw JSONL |
| worker 真实回合 | PASS | 群聊 @worker「4×6」→ 回复 `24`(`channel/us002-chat-history.json`) |
| lead→worker A2A requireReply | PASS | 首次回合模型误用 `write` 工具(回执变成工具报错);明确“禁止工具、只回复 OK-A2A-9”后回执 `OK-A2A-9.`(`channel/us002e-a2a-send.json`、`us002e-a2a-final.json`) |
| worker 直派任务 | PASS | 首次产物为工具报错文本;重试(禁工具)产物 `19`(`channel/us002e-worker-task-final.json`) |
| 消息持久化 | PASS | chat/messages 历史落库(`final-generic-chat.json`、`final-generic-messages.json`) |
| 双 Session 隔离 | PASS | A 问暗号→`收到 ALPHA-7`;B 问同一暗号→`不知道`;A 的 brief 块含 ALPHA-7,B 不含;两回合均为 local gemma(`channel/us002d-histories.json`、`us002d-blocks.json`、`raw/omp-sessions/session-A-alpha7.jsonl`、`session-B-unknown.jsonl`、`provenance.json`) |

> 说明:A2A/worker 首轮失败是**本地 12B 模型的工具协议能力问题**(`write` 的 `path`/`content` 参数漏传),不是消息路由失败;消息确实投递并触发了 worker 回合。重试通过说明链路可用。

## 2. Project 模式(非产线)(US-003)— PASS

| 判据 | 结果 | 证据 |
| --- | --- | --- |
| Project 创建 + 激活 | PASS | `project/us003-project-create.json`;`project/final-project.json` status=completed,planVersion=1 |
| 真实 leader 规划 | PASS | office continue 触发;`raw/omp-sessions/project-leader-plan.jsonl` 中 local/gemma 调用 `project_propose_plan`;计划载荷见 `project/us003b-approvals.json`(交付物/工作项/验收标准) |
| 计划批准 + 物化 | PASS | `project/final-approvals.json` 中 `plan_approval` = approved;工作项 planVersion=1 |
| 工作项派发 + 执行 | PASS(人工收口,已披露) | 项目实例频道真实 Gemma4 回合尝试完成失败(`raw/omp-sessions/project-instance-write-fail.jsonl`:`write` 缺 `path`/`content`);验收方用实例 lead token 经 REST 完成,交付正文 1063 字节含 `7*8=56`(`project/us003g-task-complete.json`,正文内已注明人工收口) |
| reconcile → 结果 draft | PASS | `project/us003g-results.json` |
| L1 技术复核 | PASS | `review → reviewed`(`project/us003d-review.json`) |
| 自批拒绝(负例) | PASS | admin 提交后 admin 自批 → `SELF_APPROVAL_FORBIDDEN`(`project/us003d-acceptance-decide.json`) |
| L2 成果验收(非自批) | PASS | 第二个用户(项目 `approver` 角色)批准(`project/us003e-acceptance-decide.json`) |
| 交付物状态 | PASS | 全部工作项终态后重算为 `approved`(`project/final-deliverables.json`) |
| 项目完成 | PASS | `project_complete` 审批批准(`project/final-approvals.json`)→ `status=completed`,报告 ratio=1(`project/final-report.json`) |
| 项目报告可查 | PASS | `project/final-report.json` |

**平台边界发现(P2,建议后续修)**:L2 决策瞬间若同一交付物下仍有 `DRAFT` 工作项,`deliverableAcceptanceReady` 为 false,交付物停在 `planned`;之后取消该 DRAFT **不会重算**交付物状态,完成门持续 `DELIVERABLES_INCOMPLETE`。本次通过“重派工作项 → 新 attempt(v2)→ 重新 L1/L2”这一正当路径完成,未改库、未用豁免。

## 3. RSI 持续学习(US-004)— PASS

### 3.1 非产线频道(泛化行为)

| 判据 | 结果 | 证据 |
| --- | --- | --- |
| 任务完成自动反射经验 | PASS | 3 条 `kind=experience`、positive、scope=channel(`rsi/us004-stats-before.json`) |
| 经验可召回 | PASS | `search_memory` 命中率 100%(`rsi/us004-recall-before.json`、`us004-recall-after.json`) |
| 合并(证据并集) | PASS | taskIds=2(`rsi/us004b-merge.json`) |
| 单任务晋级被门拒绝 | PASS | `独立任务样本不足:1/2`(`rsi/us004b-promote-negative.json`) |
| 非产线经验状态语义 | 说明 | 非产线反射经验规范为 `status=active`,晋升端点要求 `candidate`,返回“仅 candidate 可晋级”(设计使然) |

### 3.2 绑线频道(candidate-only 完整生命周期)— 关键补证

频道 `caf7976b…`(production_line_integrated,线 `ln-61f4b69e`),3 个确定性任务(由实例 lead token 经 REST 终结,反射真实发生):

| 判据 | 结果 | 证据 |
| --- | --- | --- |
| 捕获 candidate 经验 | PASS | 任务 A/C 先后反射为 `status=candidate`、`scope=line`、`scope_key=ln-61f4b69e`;A 随后经合并晋升为 validated,C 仍为 candidate——`rsi/final-line-experience-stats.json` 显示 `validated:1 / candidate:1 / scope:line`;`rsi/us004b-line-promote-single.json` 在 A 尚未合并时返回 `独立任务样本不足:1/2`,证明其当时为 candidate |
| 单任务 candidate 晋级被拒 | PASS | `独立任务样本不足:1/2`(`rsi/us004b-line-promote-single.json`) |
| 合并两条 candidate | PASS | A+C 的 taskIds 合并为 2(`rsi/us004b-line-merge.json`) |
| 人工晋升 validated | PASS | `ok=true, next=validated, reasons=["证据充分(2 任务 / 0 锚点)"]`(`rsi/us004b-line-promote-ok.json`);最终 stats 中 validated=1、candidate=1(`rsi/final-line-experience-stats.json`) |
| Agent 越权调用人工晋升面 | PASS | Agent token → HTTP **401 USER_UNAUTHORIZED**(`rsi/us004b-line-promote-unauthorized.json`) |
| 工具面不可达 | PASS | 频道工具目录无 memory promote/merge;目录中的 `aml_model_promote` 是 AML 模型晋级,与经验晋升无关(`rsi/us004-tools.json`) |

**测试脚本断言披露**:`rsi/us004b-line-evidence.json` 的 R1c 为 `pass=false`(`candidates=0`),原因是该快照在任务 A/C 完成反射**之前**采集(18:18,任务完成于 18:26–18:27),属于时序伪失败;`rsi/us004b-line-experiences.json` 因此为空数组,不作为候选证据。功能事实以 `final-line-experience-stats.json`(validated 1 / candidate 1 / scope line)、`us004b-line-promote-single/merge/promote-ok` 与 401 越权文件为准。

## 4. 产线真实场景(mock 隔离模拟线)(US-005)— PASS

专用线 `ln-61f4b69e`(simulated=true),DCW `dw-932247e5`(mock,60–200°C,stepLimit=6),DAQ `dn-c3822c49`(mock,2s),配方 `rc-00f1628e`(150°C)。

| 判据 | 结果 | 证据 |
| --- | --- | --- |
| 线/产品/模板/节点/配方供给 + 开线 | PASS | 首批次 `rr-3321be5b`(`line/us005b-line-start.json`) |
| 频道绑线 + 成员 + 绑定面 | PASS | `line/us005b-agents.json`、`us005b-bindings.json`(line-recipe/recipe/daq,全部 code=0) |
| Agent DAQ 查询 | PASS | 实采 141.1°C,含单位/量程/活动批次(`line/us005b-daq-1.json`);全窗口 68 点、均值 139.664(`line/final-daq-window.json`) |
| recipe_propose → HITL | PASS | 整包审批卡 `ap-3bd7d227`;人工 choice=0 批准后整批下发,批次 `rr-8880f76c`(`line/us005b-propose.json`、`line/final-hitl-history.json`) |
| 设备回读一致 | PASS | `value=144`、`readValue=144`(`line/us005b-readback.json`、`us005c-node.json`) |
| journal 留痕 | PASS | `150→144`,`source=agent`,`approvalId=ap-3bd7d227`,`recipeRunId=rr-8880f76c`(`line/us005b-journal.json`、`final-journal.json`) |
| 越界负例(量程) | PASS | `to=999` 提案被预检拒绝、未建审批卡(`line/us005d-negative-range.json`) |
| 超单步负例(派发门) | PASS | 150→190 试验卡被批准后,**派发门**明确拒绝:「本次变化 40°C 超过单步限制 6°C(来源:param)」,设备值保持 150(`line/us005e-overstep-result.json`、`us005e-node.json`) |
| 下发后 DAQ 持续采样 | PASS | 两次运行 `taggedSamples` 11(第二次,`line/final-line.json`)+ 全窗口 68 点 |

**测试脚本断言披露**:`line/us005b-evidence.json` 中 L11/L12 为 `pass=false`——原因不是功能失败,而是**时序/正则**:
- L11 的 invoke 在 HITL 人工批准后才返回,返回体是“已获批准并整批下发”的回执,而脚本正则期待“待批/审批中”字样;
- L12 的 pending 快照在人工已批准后才采集,故为空。
功能事实由 HITL history(创建 17:51:13 / 批准 17:52:52)、journal(approvalId)、回读(144/144)三方互证。首版 `us005b-journal.json` 中的 `taggedSamples` 口径也不作为样本证据,样本数一律以 DAQ 查询与 `final-line.json` 为准。

## 5. 关键数据/事实

- omp 每回合 prompt/usage 约 **24k–62k tokens**(归档 92 个 assistant 回合的 totalTokens 实测,min 24,191 / max 61,978);12B 本地推理单回合约 **2–5 分钟**;一次产线任务回合在 8192 output 上限处截断(`line-task-length-loop.jsonl`),说明长工具链对 12B 不稳定。
- 会话隔离的确定性证据:`GET /channels/:id/sessions/:sid/brief?format=block` 显示 A 块含 ALPHA-7、B 块不含(另有 A/B 历史与 omp JSONL 互证)。
- Project:真实 leader 规划;工作项执行回合因 `write` 工具参数失败由 REST 收口;L1/L2/完成门均为平台真实链路;L2 由第二名用户批准,自批被拒。
- 产线:HITL 批准≠放行,超单步在派发门被联锁拒绝,设备无变更。
- 全程未集成 IDD/RAG。

## 6. 未做/遗留

1. 物理 HIL:本次只有 mock 模拟线(非物理设备)。
2. 云端模型对照:本轮只测本地 Gemma4,未做云模型同场景对照。
3. Gemma4 的 `write`/`send_message` 工具协议稳定性不足以独立完成长工具链(Project 执行回合、A2A/worker 首轮均出现参数错误;明确“禁工具”或人工收口后通过)。
4. 交付物状态在“验收后再取消工作项”场景不重算(P2,建议在 work item 终态迁移/取消后触发交付物重算)。
5. `recipe_trial` 审批卡生成阶段不做单步预检,拦截发生在批准后的派发门——需产品确认是否符合“审批前预检”的预期(本次已实测派发门拒绝,设备未被写)。

## 7. 证据索引与复现入口

- `env/`:模型加载、omp 版本、健康、直连探针、local provider(脱敏)
- `channel/`:Channel 创建、Agent、回合、群聊、A2A、Session 隔离、模型来源摘要
- `project/`:Project 创建、计划审批载荷、工作项、结果、L1/L2、自批拒绝、完成与报告
- `rsi/`:非产线经验/召回/合并/负例;绑线频道 candidate→validated 全链;越权 401
- `line/`:线供给、绑定、DAQ、propose/HITL、回读、journal、量程/单步负例、全窗口样本
- `raw/`:实例日志、运行日志、`omp-sessions/`(10 个关键会话 JSONL)+ `provenance.json`

**复现端点(需 admin user token;Agent 工具面用 lead agent token)**:

```text
GET  /api/health
GET  /api/workshop/channels/:id/agents
POST /api/workshop/channels/:id/tasks            {title,description,assigneeId,mode}
POST /api/workshop/agent-tools/invoke            {agentId,tool,args}
GET  /api/workshop/hitl/pending?channelId=
POST /api/workshop/hitl/respond                  {kind:'dcw-approval',id,confirmed,choice}
GET  /api/workshop/dcw | /dcw/journal?lineId= | /dcw/lines/:id
GET  /api/workshop/projects/:id[/approvals|/work-items|/results|/deliverables|/report]
POST /api/workshop/projects/:id/continue         {message,clientMessageId}
POST /api/workshop/projects/:id/approvals/:aid/decide {approve,reason}
POST /api/workshop/channels/:id/sessions | /sessions/:sid/messages | /sessions/:sid/brief?format=block | /sessions/:sid/history
GET  /api/workshop/channels/:id/memories/experience-stats
POST /api/workshop/channels/:id/memories/merge   {memoryIds}
POST /api/workshop/channels/:id/memories/:mid/promote {to:'validated'}
POST /api/workshop/tasks/:id/complete            {artifacts:[{artifactId,name,parts:[{text}]}]}
```

> 注:测试环境中的中文 POST 体一律用 Node `fetch`/脚本发送;Git Bash `curl -d` 会把中文按本地代码页编码,产生乱码(本次两次踩到并已避免)。该现象不影响平台 JSON 接口本身。
