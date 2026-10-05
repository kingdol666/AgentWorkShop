# IDD × 知识库插件集成实测报告 —— 数采→分析→入库→检索全链打通(2026-10-06)

> 目标:验证「真实数采数据库数据 → 落盘文件夹 → IDD 插件分析 → 结果入库知识库 → 检索召回」全链条在 Channel 内真实可用。
> 参与:平台 :3001(v0.7.55,14 插件)× IDD 服务 :3210(industrial-deep-diagnostic,up 27h)× rag-knowledge(Web :6789 + FastAPI :8770)。
> 结论:**全链打通,五个环节全部真实跑通**;过程中暴露 3 个 P1 接线问题、3 个 P2/P3 缺口,已列入优化 plan(§5)。

## 1. 全链运行过程与结果(全部经 Channel worker 走 agent-tools/invoke)

| 环节 | 动作 | 结果 |
|---|---|---|
| ① 数据获取 | `daq_export` 线1 双节点(dn-0183240d 熔体温度 + dn-a41c49cc)3h 窗 | **3476 行落盘** `.AgentWorkShop/data/daq-exports/daqexp-20261006014810-4caa0d/`;合并为多参数 CSV(1734 行,time+melt_temp+zone2_sp,采样 2.06s 零断窗) |
| ② 哨兵建档 | `sentinel_baseline`(line=演示线1) | 任务 SNB-…ts1t7q003 **completed**,watch_baseline.json 建立 |
| ③ 哨兵秒筛 | `sentinel_screen`(最近 400 行,同步 ≤5s) | **11 条告警**(NELSON_R1 3σ 单点/R5 短窗波动/R6),参数覆盖 melt_temp 与 zone2_sp |
| ④ 哨兵批筛 | `sentinel_watch`(全窗异步) | 任务 SNW-…rows2m004 **completed**:**41 条告警** + `watch_report.md` + `alert.json` 落盘 IDD workspace |
| ⑤ 根因判读 | 告警簇 vs 工艺事件对时 | 告警簇与 10-05 深夜受控 SP 阶跃(z2/z3→205、z1→201.6→203.4,HITL 批准)吻合——**"受控阶跃被 SPC 捕获",非传感器故障** |
| ⑥ 知识库入库 | `kb_agent`(async,带 regime_key 场景化标题) | KB 内部 Agent 走完全质量管线:**A0 去重→A2 解析→A3b 标签 5/5→A5 存储→A6-V 向量(bge-m3,2 chunks)→Neo4j 图谱(7 关系)→A7 八项终检全过**,doc_id `93203c35` |
| ⑦ 检索召回 | `kb_agent`(sync,QDCVR 全流程) | **P0 直接命中**:3 查询变体宽网向量+两阶段补充+内容验证门(丢弃 1 个术语偶合文档),向量分 0.726,41 条告警/根因/处置建议完整召回 |
| ⑧ 经验闭环 | `experience_log`(登记昨夜真实 z1 调参)→ `experience_recommend` | 登记 id `202610060b08e895`,归因任务异步排队;签名检索走**四级降级链**优雅降级(fallback_generic+回执 id)——首条经验需归因窗口+第二条佐证才成 playbook,符合设计 |

**判定:全功能集成可行,链条真实打通。** 数据是数采库真实样本,分析是 IDD 真实 SPC 引擎,入库经向量+图谱双索引,检索带引用与可信分级。

## 2. 系统当前是否正常

正常。平台 :3001(14 插件全装载)、线1/线2 生产批次持续采集(打标样本持续增长)、IDD 服务 up 27h、rag-knowledge 全组件(backend/web/neo4j/mineru)健康。昨日的 P1(回合间隙收口 D1)在本轮未再触发长任务,但根因未修。

## 3. 系统设计与插件集成设计评价

**优秀的部分**:
- **插件契约统一且自描述**:两插件都走 `settings(热生效)+ omp.registerTool + KV 跟踪`同一形态;工具 description 自带"下一步调什么"(screen→watch→status→kb_agent 入库),Agent 可自走全链——本轮我就是按工具内指引走完的,零外部文档。
- **职责解耦干净**:检索/入库/经验全部收敛进 kb_agent 单入口(功能解耦设计),平台侧零拼装;IDD 分析与 KB 沉淀通过"regime_key 场景化标题"约定衔接,两插件互不依赖。
- **KB 内部质量管线硬**:入库不是简单写文件——去重、解析质量、标签、向量、图谱、A7 八项终检,每步有回查验证;检索有内容验证门(丢弃术语偶合文档),可信分级 P0 + 引用。
- **fail-closed 到位**:无基线时 screen 拒判;经验无命中走降级链而非编造;服务不可达返回 isError 文本不拖垮宿主。

**不足(详见 §4)**:接线层(端口/鉴权/路径)是明显短板——三个服务各自鉴权/端口约定不一致,插件默认值与实际部署漂移,开箱即断,靠人肉对齐。

## 4. 问题清单(本轮实测暴露)

| # | 级别 | 问题 | 证据 |
|---|---|---|---|
| P1-1 | 高 | **rag-bridge 默认端口漂移**:默认 8771,实际部署 8770(config.yml),开箱即 404/000 | 首次 kb_agent 调用失败,手工热更 `plugins.rag-bridge.base_url` 解决 |
| P1-2 | 高 | **IDD/KB 鉴权开启但插件 token 未配置且获取流程无文档**:IDD 需注册账号→登录→签发 `idd_` token;KB 注册路径实为 `/api/v1/auth/register`(插件注释写 `/auth/login`);两插件 token 默认空 | sentinel 首调 401"缺少认证凭据";kb_agent 首调 HTTP 401 |
| P1-3 | 高 | **IDD 路径沙箱未声明**:工具参数写"CSV 绝对路径",实际只允许 IDD 仓库根内路径(`path outside allowed roots`),跨项目数据交接无约定目录 | baseline 首跑 exit=2 失败,直查任务详情才见原因;改用 IDD workspace/aw-exchange 交接目录解决 |
| P2-1 | 中 | `sentinel_status` 插件输出不透传 error/stdout_tail(基线 failed 原因要绕过插件直查 IDD) | SNB-…qo02nc001 失败原因插件面不可见 |
| P2-2 | 中 | kb_agent 单点走 web 层(:6789),web 挂则全链断,无 backend(:8770)直连降级 | 架构面观察 |
| P3-1 | 低 | daq-export 单节点 CSV(ts_iso,value)与 IDD 期望(time_col+多参数列)语义不对齐,多节点分析需手工合并对齐 | 本轮手写 merge 脚本(还踩了一次字段名错) |
| P3-2 | 低 | IDD `_io.py` 支持 extra_root 机制但无配置文档 | 源码 `_contained(candidate, extra_root)` |

## 5. 优化 Plan(下发)

**Plan-A 接线包(P1,0.5 人日,建议立即)**
1. rag-bridge 默认 base_url 对齐部署(8770),或在 README/插件描述写明端口判定顺序;
2. 两插件 README 增补「三步接线」:服务注册账号→签发 API token→填插件 settings(含 KB 正确注册路径 /api/v1/auth/register、IDD register→tokens 流程);
3. 约定**跨项目数据交换目录**:IDD 配置 extra_root(或固定 workspace/aw-exchange),rag/平台侧文档写明;插件 settings 增加 `exchange_dir` 字段,工具 description 自动提示"数据须位于交换目录"。

**Plan-B 体验补全(P2,0.5-1 人日)**
4. sentinel_status/watch 透传 error 与 stdout_tail(失败原因一次看全);
5. kb_agent 增加 backend 直连降级(web 不可达时走 :8770 API);
6. `daq_export` 增加 `merge: {node_ids, time_col, value_cols}` 模式,直接产出 IDD 友好的多参数对齐 CSV(消灭手工合并)。

**Plan-C 一键化(P3,1 人日,价值最大)**
7. 平台内置「哨兵巡检→入库」工作流模板:export(merge)→baseline(如无)→watch→结论摘要→kb_agent 入库,一次派单全链自动走完——本轮手工 8 步收敛为 1 步;
8. 告警簇与工艺事件(HITL 下发记录)自动对时,受控阶跃自动标注"预期形态",减少人工判读。

**Plan-D 治理(P3)**
9. 集成类插件的 CI 冒烟:起依赖服务→打 health→跑一次最小调用,防默认值漂移再次发生。

## 6. 留痕
导出 daqexp-20261006014810-4caa0d;IDD 任务 SNB-ts1t7q003/SNW-rows2m004;KB 文档 doc_id 93203c35-5eb8-409c-bc1a-e708f2c51d4c;经验 202610060b08e895;桥接账号 aw-bridge(IDD id=5 / KB usr-8a3f9d98)与 API token 已入插件 settings(本机本地服务)。
