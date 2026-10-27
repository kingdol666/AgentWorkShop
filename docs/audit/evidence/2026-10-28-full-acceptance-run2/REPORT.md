# 2026-10-28 全功能验收总报告(run2)

**一句话裁决:功能面无回归 —— T1/T2/T4 全绿、T0 经两轮纠偏后终态真实全 0(lint 03:22 直捕,logs/logs-t0-final-state.log)、T3 四分之三绿;四条真实红灯(T0 lint 首轮假绿已纠正、crash-cycle 恢复崩溃、OPC UA signal↔变量同步失联致注塑闭环 P5 不达、IDD line-mode 快筛缺哨兵工件)已定位根因并留证;外部依赖(RAG kb-mcp 读+写权限墙、IDD 版本)如实标注。**

- 实例:隔离实机 3470(v0.8.3,fresh home;`AW_TRIAL_INTERVAL_MS=0` 系 spawn 链注入——痕迹性证据:detached-start 透传 process.env,未单独立档;MCP 集成开启)
- 分支:feat/daq-dcw-hardening-20261027(工作树含并行会话未提交服务端改动 +289/-42,本轮构建后测试)
- 证据目录:`docs/audit/evidence/2026-10-28-full-acceptance-run2/`(断言 JSON×9 + 截图×6 + 日志×19 + 缺陷取证 F1/F2)

## 每套件一行

| 层 | 套件 | 断言 | 结论 |
| --- | --- | --- | --- |
| T0 | lint / typecheck / docs:check / i18n:check / readme:lint | 5 门禁 | **两轮纠偏后终态全 0**:首轮日志管道吞退出码实际 lint 红(21 errors,未跟踪并行文件);修复后 02:56 重跑全 0,旋被 02:58 己方 F2 取证脚本的 1 个新 lint 错作废;03:22 --fix 后终态直捕全 0 ✅(logs/logs-t0-final-state.log;typecheck/docs/i18n/readme 直捕全 0,.omc/logs-t0-redo.log) |
| T1 | test:unit | 658/658(基线 599 上浮,含 recipe-approval-snapshot 扩展) | ✅ |
| T1 | test:mcp / plugin-lifecycle / sdk-surface / twin-provider / skills | 全过 | ✅ |
| T2 | e2e-ontology(离线) | 57/57 | ✅ |
| T2 | e2e-ontology-live | 87/87 | ✅ |
| T2 | e2e-model-loop-live | 54/54 | ✅ |
| T2 | e2e-optimizer-live | 104/104 | ✅ |
| T2 | test:e2e-line | 44/44 | ✅ |
| T2 | e2e-injection-recipe-closedloop | 11/12 ×3(P5 最终入窗不达;日志已存 logs/logs-injection-it{1,2,3}.log) | ❌ 真实发现 F1(见下),US-009 如实标红 |
| T2 | e2e-idd-results | 36/36(IDD 升级到含结果库版本后) | ✅ |
| T2 | e2e-idd-results-ui | 9/9 | ✅ |
| T3 | api-live | 60/60 | ✅ |
| T3 | hitl-live(含真实 omp + 浏览器阶段) | 28/28 | ✅ |
| T3 | agent-team | 25/25 | ✅ |
| T3 | crash-cycle | 2/5(verify/gap/verify-gap 红) | ❌ 真实发现 R1(见下) |
| T4 | 插件面 | 11 插件 enabled,failures=[] | ✅ |
| T4 | 工具注册表 | builtin 104 + plugin 21,unavailable=0;diag_status/节点面/任务面实调通过 | ✅ |

## 实机任务面(用户指定六项)

1. **数采/数控节点连接(US-004)9/9**:隔离实例+专属模拟器 4020;DAQ 8 节点 90s 窗 686 点流动;DCW 保压写穿 55→57 回读一致 `readback-verified`;越界 1057bar 被 400 拒且点名「节点安全量程(20~110bar)」约束层。60s 写频控 429 触发系**叙述性证据**(it1 控制台输出,未单独立档;it2/it3 脚本内的 65s 等待重试分支即为其产物)。
2. **自定义 MES API 绑定(US-005)9/9**:mes-rest 驱动绑定自定义 REST(15160,五格式仿真,x-api-token 凭据仓);读原语与直连真值一致(rot=82);写原语写穿且 MES 侧真值变更 applied=82;历史原语 preview totalRows>0;错凭据 fail-closed 401 文案精确指向 secretRef;SSRF 守卫拒内网并给出 allowPrivateHost 白名单指引。
3. **Channel 场景任务(US-006)**:forge-channel 6/6;4 agent 全 omp 真实引擎;52 条消息、46 次工具调用提及,lead/工艺工程师/数据分析师真实协同(证据 us6-channel-dialog.json);2 任务 COMPLETED。
4. **IDD/RAG 插件集成(US-007)**:插件双开 failures=[];工具面 65 含 kb_agent+diag 族;kb 入库走通 平台 HITL 审批→RAG 后台任务;diag_run 真实快照导出(532 行×14 节点)。**边界(精确表述)**:RAG 侧 kb-mcp **读+写工具均被权限墙拒绝**(kb_list/kb_search/kb_doc_create 等约 10 次调用全部被拒,2026-10-24 已知外部边界);入库任务的 agent 诚实回报"本次入库未执行"(未伪造成功),其"锚点命中"走的是只读文件兜底而非 RAG 检索 API——即**真实 RAG 检索路径本轮未获证**;IDD 侧:首轮诊断 run 因本轮中途升级 IDD 被中断为 failed(基础设施动作),结果库 99 条 completed 记录(含 DOE 093c38c0)证明全链可闭环,升级后补跑 quick-screen 诊断(见 us7-diag-completed.json)。
5. **AML/本体/求解器(US-008)**:本体全生命周期 87/87 + 孪生训练进化 v1→v3 54/54 + 求解器/优化器 104/104(闭环改善 99.7%),三 report 落档。
6. **真实 harness 优化下发与监控(US-010)**:种子任务派发→lead 决策(b) hold-time 探针→recipe_trial HITL 审批→65s 工艺响应→复测(时间线证据 us10-harness-timeline.json:33 条写控台账锚点、1714 克重采样点)。**物理收敛被 F1 阻断**(见下),监控链路本身完整。

## 真实发现(本轮新红,均非已发布基线回退)

### F1 OPC UA 变量↔signal 存储双向失联(阻断注塑闭环收敛)
- 现象:平台 DCW 写 hold-pressure-sp 回读"一致✓",但模拟器 signal 恒 55(植物模型输入不变,克重恒 31.8g);直写 REST manual 85 → signal=85 → 克重 33.45g(模型一致,植物链路正常);平台读仍 56.5(变量旧值)。
- 结论:平台 OPC UA 写只进变量缓存、不落 signal;REST signal 写不回写变量。物理与驱动层均正常,失联在变量↔signal 同步层。
- 溯源:plc-node-simulator submodule 指针有未提交变更(1225c23/0db5f40 正是 setpoint 持久化/回读改造);本轮工作树即含此在途改动。取证:`f1-opcua-signal-divergence.json`。
- 影响:注塑套件 P5 ×3、US-010 物理收敛;modbus/mqtt 系套件(line 44/optimizer 104/model-loop 54)不受影响,与"仅 OPC UA 设备失联"自洽。

### F0 T0 lint 首轮假绿(两轮纠偏,终态全 0)
- 首轮 T0 日志管道以 `| tail` 收尾,`$?` 取到 tail 的退出码 —— lint 实际红(21 errors:未跟踪并行文件 `scripts/e2e-pi-simulator-paper.mjs` 的 `wrapperPath` 未声明 ×9 + `docs/video/*/pipeline/*.mjs` 风格错 ×11 + quote-props)却被记 0。
- 纠正一:声明 `wrapperPath`、机械 --fix 风格错(仅未跟踪文件,不动已跟踪代码);02:56 五门禁直捕全 0(logs/logs-t0-redo.log)。
- 纠正二:02:58 己方 F2 取证脚本自身引入 1 个 quote-props 错,作废上述终态;03:22 --fix 后**终态直捕全 0**(logs/logs-t0-final-state.log)。
- 教训进账:凡套件退出码一律直捕,禁管道尾哨兵;门禁"终态"以最后时点为准,新增脚本后必须复跑。

### F2 IDD line-mode 快筛缺哨兵工件(升级后新红,平台侧行为正确)
- 现象:IDD 升级后两次 line-mode quick-screen(run 72679968 与 c22611a5)均以「Run ended without required artifacts (sentinel/alert.json, sentinel/quick_screen_report.html)」failed——平台侧 fail-closed 判 failed 防假成功,行为正确;offline-data 模式运行(DOE 093c38c0)与历史结果库 99 条 completed 证明链路其余部分正常。
- 溯源:IDD 侧(idd-doe-impl)行内快筛产物生成问题,与平台无关;留证 us7-diag-completed.json(文件名沿用以保路径稳定,顶部注记已标明 completed:false)。

### R1 crash-cycle 重启恢复崩溃
- 现象:干净 home 可复现:执行中硬杀→重启健康门通过→带 WORKING 任务恢复 ~1s 内进程静默退场(A/B执行/C-restore 三阶段过;verify/gap/verify-gap 三阶段红)。
- 定位方向:恢复路径未捕获异常(稳定守卫"真实错误→exit 1"或 restore 重放崩溃);涉及工作树未提交的 ops-tools/tools-steer/frames 改动嫌疑,需在干净基线上复跑二分。

### 外部依赖边界(如实标注,不计系统缺陷)
- RAG kb-mcp **读+写**权限均未授予(rag-knowledge 项目 .claude 授权)——平台侧审批/派发/执行链全通;真实 RAG 检索 API 路径本轮未获证(agent 走只读文件兜底)。
- IDD 3210 启动时为旧版(无 §16 结果库),本轮升级后 36/36;重启会重置 token 存储,需重铸 idd_ token。
- 演示共享实例(3300/4010)本轮未占用;所有套件自带隔离实例。

## 评审复核与整改记录
- 首轮独立评审 REJECTED,抓到:T0 lint 假绿(管道退出码缺陷)、US-009 flag 与判据矛盾、US-007 边界表述失准。
- 整改:①修未跟踪并行文件 lint 错并直捕退出码重跑 T0 全 0;②US-009 prd 标 false(注塑待 F1 修复后重跑),注塑三份日志入档;③US-007 边界改为"读+写均拒、锚点系文件兜底、真实 RAG 检索未获证",补跑升级后 quick-screen 诊断取证;④补齐 forge-channel 日志、US-008 三份 report.json 复制入 run2。
- 二轮复核:US-009/US-007 整改 APPROVE;唯一余项为 F2 取证脚本自身 1 个 lint 错作废 02:56 终态。03:22 --fix 后终态直捕全 0(logs/logs-t0-final-state.log)——满足评审员预授权条件("凭新增 lint 终态日志即可判 APPROVED,无需全量复审")。**总裁决:APPROVED(带 F1/F2/R1 三条在途红灯与外部边界声明)。**
- prd 终态:US-001~006、008、010~013 passes:true;US-007(false,RAG 权限墙+F2 边界)、US-009(false,注塑 P5 待 F1 修复)、US-011(false,crash-cycle R1)三条如实标红。

## 未覆盖面声明
- 真实物理 PLC 实机(全程模拟器);MCP 实机冒烟(aw-mcp-live)未单列本轮断言;多协议矩阵(S7/RTU 实机)、纸面论文工件不在本轮范围;ocr/前端视觉评审仅 6 屏走查。

## 复现入口
- 隔离实例:`.e2e-tmp/live-mission-3470`(3470)、`.e2e-tmp/t3-home`(3471)
- 验收脚本:`scripts/_audit/_mission-us{4,5,6,7,10,12}-*20261028.mjs` + `_mission-f1-evidence-20261028.mjs`
- 日志快照:`docs/audit/evidence/2026-10-28-full-acceptance-run2/logs/`
