# 系统设计完整性评审 —— 数采镜像/数控/Channel/绑定注入/HITL 全链

- 日期:2026-10-28
- 评审轮次:三模式执行落地后(v0.8.3 + execution modes)
- 结论:**核心链路(数采镜像 → 数控 → Channel 创建 → worker 绑定 → 运行时提示词注入 → 数据获取 → HITL 控制下发)设计完整、代码级贯通,具备产线端启用条件**;边界条件见 §4。

## 1. 数采镜像(DAQ)

| 环节 | 实现 | 锚点 |
| --- | --- | --- |
| 采集 | 逐节点边缘运行时:独立采样节拍/在飞互斥;六协议驱动(modbus-tcp/rtu-over-tcp/opcua/mqtt/http/serial-bridge)+ 插件注册 | `server/services/workshop/daq/`(drivers 注册表) |
| 管线 | 驱动 → 队列(进程内/MQTT 断连缓冲)→ 乱序防御 → 三路分发(WS 直推/TSDB 批量/孪生回写) | daq controller 帧与 `daq.controller` 指标 |
| 镜像/查询面 | `daq_query` 缺省按活动批次作用域(run_id+recipe_id 过滤),`scope:'all'` 跨配方;`daq_export` 全量原始时序 CSV+manifest | `agents/industrial/daq-tools.ts` |
| 台账 | TSDB 落库 + 告警(2% 滞回+3 拍去抖) | daq-timeseries.sqlite |

**判定:完整。** 采样→落库→查询镜像→Agent 读面全链贯通;批次作用域查询防跨配方混样。

## 2. 数控(DCW)

| 环节 | 实现 | 锚点 |
| --- | --- | --- |
| 写入咽喉 | 手动/配方/Agent/回退四路共用单入口:限界联锁(量程∩参数∩产品∩配方)→ 步限 → 60s 间隔 → 保持窗 → 驱动下发 → 回读鉴定 | `server/services/workshop/dcw/dcw-controller/write.ts` |
| ACK 鉴定 | readback-verified / transport-ack / 无确认通道 三态,不虚报 | `write-verify.ts`、回包文案 |
| 台账 | ops_log(`dcw.write.*` 含 hypothesis/executionMode)+ journal 锚点 + 优化记录 open/judge/rollback | `write-audit.ts`、`recipe-rollback-manager/` |
| 回退 | 窗口归属制 + auto/approve/observe_only 三策略 + 孤儿接管 | `recipe-rollback-manager/internal.ts` |

**判定:完整。** v2 权限模型下 Agent 直写工具面已摘除(handler 桩双保险),治理写收敛配方面与 optimization_explore。

## 3. Agent Channel 创建 → worker 绑定 → 运行时提示词注入

| 环节 | 实现 | 锚点 |
| --- | --- | --- |
| Channel 创建 | REST 建频道+lead agent(harness 可选 14 引擎);模板实例化(含 exp-miner/line-doctor 观察档) | `server/api/workshop/channels/index.post.ts`、`runtime/manager/channel-templates.ts` |
| worker 绑定 | 节点绑定(kind=daq/recipe;首绑恒 manual)/ lead 委派(grant,权限不可超越授予者) | `agent-tools/bindings/*`、`node-delegation.ts` |
| 提示词注入 | 每回合装配:绑定节点语义卡(只含实际绑定,语义三层合并 节点>模板>mes desc)+ 配方操作面 + **执行模式卡**(observe/manual/auto 后果明示)+ 场景 prompt;omp 原生 `set_host_tools`、pi 扩展、11 引擎 MCP 桥共用同一张 `hostToolsForRole` 清单 | `agents/industrial-context.ts`、`host-tool-bridge/catalog.ts`、`per-agent.ts` |
| 模式注入联动 | 频道 executionMode 切换 → recycle 成员运行时 → 下次装配带新模式卡(热生效) | `execution-mode.patch.ts` + `recycleChannelForTwinProfile` |

**判定:完整。** "绑定即知、注入即合"——Agent 只见自己的绑定面;三模式后 Agent 开局即知档位与后果。

## 4. 数据获取 + HITL 控制下发链

| 环节 | 实现 | 锚点 |
| --- | --- | --- |
| 数据获取 | `daq_query/mes_fetch/ops_log/recipe_log/recipe_versions/dcw_journal/line_context` 按绑定面/频道绑线只读扩权 | `ops-tools.ts`(agentOpsScope) |
| 控制下发 | recipe_update/apply/trial/rollback(reason 必填)→ 绑定门→二级认证→运行门→HITL 判定(频道/产线/绑定三层取最严)→ 审批卡 → 批准后二次复核(解绑/收权即失活)→ 四路共用写咽喉 | `recipe-gate.ts`、`ops-tools.ts`、`dcw-tools.ts` |
| HITL | 挂起去重(同 agent+node)/ 超时默认拒 / 批准附言回流 / 审批卡含 hypothesis 依据 | `manual-approval.ts`、`hitl/respond` |
| 三模式门 | observe:注入摘除+分发拒写+handler 兜底;manual:频道钳位强制挂卡;auto:免批但 rationale 必填+限界照常+台账 executionMode | `execution-mode.ts`、`dispatch.ts` 写守卫 |

**判定:完整。** 本轮 e2e 34/34 实证(observe 拒写/读可用、manual 频道钳位挂卡+批准附言回流、auto 免批直执行+缺依据拒绝+台账带 mode)。

## 5. 产线上线就绪裁决

**可直接上线(真实产线启用)**:
1. Modbus TCP/RTU-over-TCP、MQTT、HTTP 驱动族 + HITL 手动档 —— 多轮实机验收(本轮 + 2026-10-28 harness 全链 Δ+0.57℃ 物理响应 + line-governance 44/44)支撑;
2. 观察档(observe)做只读分析接入 —— 物理零写双保险,安全边界不依赖提示词;
3. 自动档在「线 auto + 绑定 auto + 频道 auto」三层显式确认后启用,保留四层限界/步限/60s/越窗自动回退兜底。

**有限制条件(上线前知晓)**:
1. **OPC UA 变量↔信号同步失联(F1,子模块在途回归)**:OPC UA 族联调改用 modbus/mqtt;平台写只达变量缓存,厂侧模型取旧值;
2. **pi 引擎无程序化 HITL**:需要 HITL 审批的作业选 omp 或 ACP 族引擎;
3. **崩溃重启断点恢复(R1)**:crash-cycle 2/5 存在静默退出分支,生产部署建议配进程守护(systemd/PM2)+ 启动对账已内置(dispatched 卡回读判 unknown);
4. **单进程 writeLocks/审批队列**:多实例部署需共享存储改造(当前按单实例设计);
5. **配方级下发间隔 ≥60s**:连续试验需等待窗(平台如实提示剩余秒数)。

**总体**:核心功能面完整且经真实环境验证,按上述边界部署即可在产线端启用。
