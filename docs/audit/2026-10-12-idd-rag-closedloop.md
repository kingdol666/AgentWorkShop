# IDD×RAG 双插件三轮闭环诊断测试报告(2026-10-12)

> 命题:接入模拟产线节点,启动 IDD 与 RAG 两个插件项目,在线取数→分析→入库→检索闭环,建诊断频道做多轮分析;流程=先检索既往结论定口径→数采→IDD 分析→入库。

## 一、总判定

**三轮"检索→数采→IDD 分析→入库"闭环全部执行成功(24/25 断言 + 终验补验通过),闭环性得到检索级证明:R1/R2/R3 入库的诊断文档在终验检索中全部命中(含本轮 doc=是),且既往经验(A2O 收口 v1.3)被检索命中纳入本轮口径。** 发现并绕过 rag-knowledge 内部 Agent 超时问题(改走插件确定性路径),发现 diagnose 模板角色索引缺口(手工补齐)。

## 二、执行过程(时间线)

| 步骤 | 结果 |
|---|---|
| 冷启动(含 IDD 与 rag-knowledge 两个独立项目) | 平台/PLC/MES/IDD(:3210)/rag(:8770+:6789) 全绿;DAQ 152/167 在采 |
| 插件链路验证 | IDD token 已持久化于 runtime-settings(上轮待办已闭);插件 sentinel_screen 实测通(32 告警);rag token 同在 |
| skill 接入(诊断场景) | 连通 5/5 → 供给复用(A2O 线+13 数采节点) → 锻造频道 c52fe8c6「A2O工况-在线诊断分析频道」(diagnose 场景,产线诊断工程师 omp,种子任务派发) |
| 频道修补 | diagnose 模板无 worker:0 → 13 条 daq 绑定手工补齐;双插件(idd+rag)按 {plugins:[{name,enabled}]} 契约启用 |
| 三轮闭环 | 见下表 |

## 三、三轮闭环明细(每轮五步)

| 轮 | ①kb 检索(定口径) | ②数采 | ③IDD 分析 | ④入库 | ⑤通报 |
|---|---|---|---|---|---|
| R1 摸底(30min) | ✅ 命中 97(含既往收口经验 v1.3) | ✅ 121 样本 | ✅ 秒筛 26 告警 + watch 38 | ✅ index-document | ✅(补发) |
| R2 聚焦精查(20min) | ✅ 命中 101 | ✅ 81 样本 | ✅ 秒筛 26 + watch 33 | ✅ | ✅(补发) |
| R3 趋势综合(60min) | ✅ 命中 93 | ✅ 205 样本 | ✅ 秒筛 26 + watch 71 | ✅ | ✅(补发) |
| **终验** | **四组查询全命中,R1/R2/R3 入库 doc 全部可检索(是)** | | | | |

## 四、发现与处置(全部记录)

1. **rag-knowledge 内部 Agent 超时(环境级)**:kb_agent agentic 路径(检索问答/入库)在后端内部 Agent 上 540s 超时 failed(LLM 依赖慢)。**处置:改走 rag-bridge 插件的确定性路径**——检索=插件 API /search(two-stage,30s 级),入库=rag /api/v1/search/index-document(直索引)。两条都是插件设计内的正规路径,Agent 可用;agentic 路径需 ragproject 侧排查其 LLM 配置。
2. **插件 API 路径坑**:/api/plugins/<name>/<route>(复数),误写单数 404 → 检索假性 0 命中。已修。
3. **diagnose 模板角色缺口(skill)**:诊断频道模板无 worker:0 角色索引,bindings 全数失败(agentId=undefined)。手工补 13 绑定。建议 skill 修 diagnose 模板的角色定义或 forge 对 diagnose 场景改用 lead 直绑。
4. **频道消息契约**:POST /messages 必填 toAgentId(否则 BAD_REQUEST);频道属主=本轮 forge 的运行身份(e2e-admin)。
5.IDD token 与 rag token 均已持久化在 runtime-settings.json(plugins.*.token),冷启动后直接可用——上一轮"待填 token"待办已闭。

## 五、结论

**"检索既往→数采→IDD 分析→入库→可检索"的闭环在 IDD+RAG 双插件下完整可行,且已实测三轮。** 知识库检索能命中既往诊断与经验(含跨天收口经验),入库文档即时可检索(向量化索引就绪),IDD 统计分析(秒筛+批筛)对告警通道持续给出证据。该模式可直接作为产线在线诊断的常驻作业形态;agentic 检索问答需 ragproject 侧修复其内部 Agent 的 LLM 依赖后启用。

—— 生成:IDD×RAG 闭环轮 2026-10-12(脚本 tmp-e2e/idd-kb-closedloop.mjs/wwtp-diag-onboard.json;频道 c52fe8c6;知识库 aw-industrial=2c353c50)
