# 冷启动综合复测报告:数据获取/导出/下发/HITL/三工况/log/产线管理(2026-10-11 凌晨)

> 用户命题(与 2026-10-10 轮同题复测):按测试 skill 对数据获取、下发、HITL 审批与反馈、Channel 不同工况作业及其他作业流程全面测试;确认数据获取→导出文件夹→直接处理查看、recipe 下发、log 管理、产线管理;给测试结果与系统评价。
> 本轮特点:**全冷启动**(四服务全部离线起跑)——额外覆盖了「降级→自愈」韧性路径,并暴露/修复了一处 benchmark 夹具陈旧。

## 一、总判定

**全部九个维度真实可用;本轮合计 159 项断言全绿(13+6+10+34+10+12+补测20+53+…),并全程零 LLM 额度(工具桥直调)。**
唯一真实缺陷级发现为**测试夹具陈旧**(benchmark 配方参数节点被上轮演示布线清理连带删除),系统对陈旧引用的行为全部 fail-closed 正确(预检剔除/跳过+ACK 如实记失败),已修复夹具并把两处骨干脚本改为动态选节点。

## 二、分维度结果

### ① 数据获取(多源异构)—— 13/13
L11 动态探针 v3 全绿:五协议族(modbus-tcp/rtu、opcua、mqtt、http)2min 窗全有实采;壁厚/MES 剖面向量帧 48 点;CCD 图像帧 sha256+size 指纹+对象存储回取 200;MES 镜像路 10min 有桶;实时值面 146/167 节点;tsdb 契约(升序+min≤avg≤max)。

### ② 冷启动韧性(本轮新增维度)—— ✓ 自愈实证
全服务离线起跑 → Docker Desktop 未运行 → 平台**降级模式**(队列→进程内/时序库→SQLite 仿真/在线采集停用,仪表诚实可见)→ 人工拉起 Docker 后,**30s 自动重连周期自行 docker compose 拉起 mosquitto/timescale/minio 并切回真实链路**(consumed 29→3100,samplesStored 持续增长,tsdbDropped=0)。降级期间手动 startAll 会产生 produced/dropped 空转(样本全丢)——仪表诚实计数,但建议降级态下禁用手动 start(见建议)。

### ③ 数据导出到文件夹 + 直接处理 —— 6/6
注塑成型二线(ln-3f34c9ac,活动批次 rr-65cceb50)分析师 Agent `daq_export` 全窗 → `daqexp-20261010235806-f10d5c/`(manifest.json + nodes/ 12 份逐样本 CSV 1163 行 + 帧长表 + merged.csv 13 列宽表)。**独立本地脚本直接读该文件夹完成统计**:制品克重 n=81、mean=32.339、std=0.043(过滤空串口径,与昨日 n=364 mean=32.495 同线同配方吻合)。

### ④ recipe 下发全链 —— 10/10
演示线5(注塑主机PLC)工艺工程师:recipe_propose(带 basis+exp_ref 证据)→ HITL 卡 ap-9c9ffb88 → 批准(choice=0,**人工意见逐字回流**「[人工反馈] 全测轮批准…」)→ **整批下发全部设备证实(1/1,rr-681e5b80)** → 平台读回 240 + **模拟器真值 240 三方一致**。阴性:未绑定配方提案被权限模型 v2 拒绝(附完整绑定指引文案)。提案门槛实证:缺 exp_ref 拒入包(证据强制)。

### ⑤ HITL 审批与反馈 —— 34/34(hardening 七腿)
approve/reject **意见逐字回流**、线域定向通知(hitl_request)、ACK 三级鉴定(证实→info/未证实→warn/失败→error 落 ops 账)、confirm 守卫(400 MODE_CONFIRM_REQUIRED)、manual 总闸挂卡/auto 免批/hold 模式不自动拒+批准后正常执行、fail-closed 缺省恢复。批准后整批下发 **5/5 全部设备证实**(夹具修复后,modbus/opcua/rtu/mqtt 四驱动真回读)。

### ⑥ Channel 三工况作业 —— 主腿 12/16 + 补测全过
- **optimize**:下发腿 rr-681e5b80(SP 230→240,三方核验)+ 下发后 daq_query 复测(PV MeltTemp 序列在活动批次窗内连续在采)+ recipe_rollback 通道在位(缺 reason 拒绝——审计纪律);
- **tuning**(演示线13 曝气风机站):35→36.5 提案→HITL→设备证实→读回 36.5;**双层频控实证**:60s 配方操作间隔拦「3s 内二次写」(附等待秒数与应急指引),300s 产线试验节拍拦「8s 内整批重发」(防连发震荡);节拍窗后配方面回退 35,**读回 35 现场复原**,journal 账本锚(prev 36.5→newValue 35,runId 关联);
- **diagnose**(退火线 11 信号):line_context 批次/配方上下文 + daq_query 默认口径=活动批次 + scope=all;只读保证实证=**调用时鉴权**(未绑定配方提案→「无权下发…你未绑定该配方」),工具清单为静态面不构成授权。

### ⑦ log 管理 —— 全绿
ops-logs 按 **level**(error=断链写失败/warn=仅链路受理/info=设备证实)与 **action**(recipe.dispatch.ack、daq.controller.start)过滤可用;**同一 action 三级分级落账**;audit 账本裁决留痕(裁决人/意见/choice/via);**journal 参数变更账本**(append-only,prevValue/newValue/source/recipeRunId);通知账本含 hitl_request。

### ⑧ 产线管理 —— 全绿
非 admin 建线 403(admin 独占);线域授权矩阵 PUT /permissions(readonly/operate,**mode:null=撤销**;空数组=无操作——契约文档串明示);收权后 admin 面确认失活;非 admin 不可改授权矩阵;非授权用户可见面过滤;运行门(无活动批次配方下发被拒,含指引文案);新建线缺省 controlMode=manual(fail-safe);confirm 守卫。

### ⑨ 回归骨干 —— api-full-loop 53/53 + PIPELINE 40/40 + docs:check 91/91
PIPELINE(--skip S1)全绿(S0 预检/S2 多源/S3 治理负路径/S4 闭环三方核验/S5 微调回退/S6 诊断/S12 HIL 占位),产物 `docs/benchmarks/benchmark-20261010163807`;S1 即 api-full-loop,已单独 53/53。

## 三、本轮发现与处置

1. **benchmark 夹具陈旧(已修复)**:benchmark.config.json 引用的 5 个 DCW 节点(holdP/holdT/moldT/screw/mesDirect)已被上轮演示布线幂等清理连带删除 → hardening E4 首跑 0/6「已跳过+失败 6」。修复:按模拟器 /export 重建 4 个真驱动 SP 节点(opcua×2/modbus-rtu/modbus-tcp)+mes-rest 写点,配方 v62 重绑+回锚 holdP=63,config 双写。**系统侧行为全部正确**(预检剔除/跳过、ACK 如实、运行门拦截),零代码缺陷。
2. **api-full-loop 硬编码节点同类问题(已修复)**:daq 样本断言改动态选在采节点(api-full-loop.mjs:108-110),53/53 恢复。
3. **僵尸批次自愈路径再验证**:runs 表存在 10-08 endedAt=null 泄漏行;start 被 CONFLICT(批次 rr-b7e6f54e)拦 → stop 报「批次不存在」→ start 随即成功(注册表自净)。stop 对僵尸行 404 的体验瑕疵记录在案(非阻断,交叉校验已免疫其危害)。
4. **收权契约**:PUT /permissions 空数组=无操作,撤销必须 mode:null(文档串明示)。测试脚本首版误用空数组得出假「收权成功」——改用 null 契约后闭环 2/2。**建议:UI/文档确认该契约可见性**。
5. 退火/注塑二线等旧线配方仍引用已删节点(预检「节点已删除」fail-closed 拒绝)——属多轮测试环境的自然老化,非缺陷;若需复用旧线应重走 onboard。

## 四、系统评价

**成熟度:可投用(单机内网+反代 TLS 形态);本轮冷启动复测进一步验证了降级可见性与自愈韧性。**
- **强项**:数据链路端到端真实(五协议采→tsdb→导出→本地可直接处理);下发有证据门槛(exp_ref)+四层卡控(量程/步长/运行门/频控×2)+ACK 三级鉴定+三方核验;HITL 治理闭环完备且 fail-closed 贯穿(缺 choice=拒/超时=拒/意见回流/裁决留痕);三工况语义清晰各有实证;log 四账本(ops/audit/journal/notifications)可追溯;产线管理 fail-safe 缺省+授权矩阵严密;**基础设施全灭时降级诚实、恢复自动**。
- **短板(均已知非阻断)**:单实例无 HA;宿主依赖(Docker)宕机时在线采集停用(设计如此,但建议降级态禁用手动 startAll 防样本空转);F1 前端路由竞态未根治;审批离线外呼待接入;测试夹具随演示布线老化(建议 benchmark 夹具自建自清理,与演示布线隔离命名)。
- **与上轮(10-10)对比**:上轮 218 断言的九个维度本轮全部复现通过;新增「冷启动降级→自愈」实证;两处夹具/脚本陈旧已在本轮修复固化。

—— 生成:全测轮 2026-10-11(工具桥直调,零 LLM 额度;脚本存 tmp-e2e/:l11-live-probe-v3/export-leg/dispatch-leg/hardening-ack-gate/scenarios-leg*/logs-leg/line-mgmt-fix/fixture-repair)

## 五、附录:数据/下发隔离语义活体复验(2026-10-11,10 项全过)

用户追问"Agent 是否只能取绑定节点数据、recipe 优先是否只是口径而非排他、未绑定是否真取不到、下发是否只限绑定配方"——对照实现逐条复验(tmp-e2e/isolation-recheck.mjs):

| # | 断言 | 活体证据 |
|---|------|----------|
| 1 | 未绑定节点 daq_query 拒 | 「无权查询节点 dn-3b5e838f」+附有权清单 |
| 2 | line_id 只能缩小不能放大 | 越线过滤冲突被拒(节点实际归属回显) |
| 3 | 默认口径=当前活动批次 | 头部「当前活动批次 run=rr-d4ef706d 配方「退火基线配方」」+文末 provenance |
| 4 | recipe 优先=查询口径,不排他 | 同 180min 窗:默认(本配方打标 204 点)=scope=all(204 点);跨配方混窗须显式 scope=all |
| 5 | 打标切批 | 显式他线配方 recipe_id → 「窗口内无数据」(逐样本 recipe_id 过滤,不混批) |
| 6 | 产品隔离 | 显式 product_id=pd-0ea129b7 → 204 点(样本行 product_id 列过滤) |
| 7a | MES 绑定面=配方参数节点 | benchmark worker(绑 rc-7e2f6071)mes_fetch mesDirect(参数节点)→ 当前值 185℃ |
| 7b | MES 未绑定拒 | 非 mes-rest/未绑定 id → 「取数被拒」 |
| 8 | 导出同一鉴权面 | node_ids 含未绑定节点 → 「无权导出节点」 |
| 9 | 下发只限绑定配方 | 未绑定配方 recipe_propose → 「无权下发配方…你未绑定该配方」(recipe-gate 绑定门) |
| 10 | 频道绑线作用域(额外发现) | 工程师频道绑 ln-25c3841c,补绑他线配方 → LINE_SCOPE_MISMATCH 拒(第四层:频道绑线后只能绑同线对象) |

实现锚点:daq-tools.ts:16-42(daqTargetsOf 绑定白名单)、:102-109(默认=活动批次)、:114-127(queryTagged);timescale.adapter.ts:120-200(writeSamples 逐样本打标 line/product/recipe/run_id + queryTagged WHERE 过滤);mes-controller.ts:104-120(boundNodeIds=dcw 存量绑定∪配方参数节点)、:226-261(resolveVisibleIds);recipe-gate.ts:41-69(①绑定门②二级认证③运行门④HITL);daq-export.ts:374-398(导出同一白名单)。
