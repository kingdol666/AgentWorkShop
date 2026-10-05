# SYSTEM-TEST-SKILL v2 增补(2026-10-05)—— 补齐 008de98 加固批次与未覆盖表面

> 本增补并入 SYSTEM-TEST-SKILL.md 的分层流程,新增 **L9 加固特性回归**、**L10 前后端交互设计核查**,并修订 L6。

## L9 · 加固特性回归(2026-10-05 批次,每项一条活体断言)
| 特性 | 断言方法 |
|---|---|
| 排队根预算(未入场不判死) | 用 FAILED 根调 `POST /api/workshop/tasks/:id/reopen` → 新根跨过期 deadline 存活并执行;二开 → 409 ROOT_REOPEN_IN_FLIGHT |
| 重试预算重置 | ROOT_TIMEOUT 根 retry 后 deadlineAt > now(不再秒死) |
| samples 404 | `GET /daq/dn-notexist/samples` → 404 NOT_FOUND(非 500) |
| 插件驱动目录 | /daq drivers 含插件驱动(如 verify-burst) |
| 工具结果事件 | Agent 执行期 channel_events 出现 tool start→end 帧对(end 含 isError) |
| HITL TTL 升级 | security.recipe_dispatch_timeout_ms 调短 → 50%/85% 时限出现 ⏰ 提醒通知;超时仍 fail-closed |
| MCP 桥空面拒绝 | 掐断 agent-tools/list → tools/list 回 -32603(非空 tools) |
| 16K 截断 | 大结果工具(ops_log 大窗口)落库文本 ≤ 上限+尾注 |
| schema 严格+逃生门 | host-tools.json 82 工具 additionalProperties:false;AW_TOOLS_SCHEMA_STRICT=0 时剥离 |
| 双值语义 | dcw_read/param_read/line_context 描述含 value/readValue 口径 |
| replaces 声明 | 覆盖内置驱动未声明 → 注册被拒 PLUGIN_OVERRIDE_NOT_DECLARED |
| 线程折叠 | 同线程 ≥2 条消息 poll 折叠为 `[线程 n 条]` |
| 记忆治理 | search_memory 结果带召回度量行;shared 域同事实并入(并存确认);数值矛盾 → [contested] |
| reopen 防多根 | 同 FAILED 根二开 → 409;COMPLETED 根 → 409 INVALID_STATE |

## L10 · 前后端交互设计核查(UI 实机走查顺序与断言)
按信息流走查,每页断言"后端数据可见 + 交互入口可用":
1. `/`(仪表盘):运行产线/累计样本/告警非零(有作业时);写控成功率。
2. `/dcw`(产线运营):线卡=实时 SP/读回;`/operations` 统一流水可截到「提案→批准→下发」三连(**前后端同源事件:ops_log/channel_events**)。
3. `/monitor`(运行时监控&HITL):待批审批卡倒计时可见;批准/拒绝按钮=后端 respond 端点;裁决后时间线出现回执。
4. `/workshop`(频道时间线):任务状态推进与 agent 消息同屏;AEP WS 实时性(发消息秒级上屏)。
5. `/daq`:节点 12/12、实时值刷新、曲线桶聚合、帧(向量)节点可见。
6. `/aml`:provider/scene/训练面;hybrid 频道 twin-profile 可见。
7. `/permissions`(权限管理):线域 grant 列表;`/users` 角色管理(admin)。
8. `/plugins`:插件清单(含测试插件启停);`/tokens`:API Token 签发;`/settings`:运行时设置(root_timeout 等可热更)。
9. `/town`(3D 孪生):设备点位与实时读数联动。
10. `/logs`(日志管理):ops/审计可检索。
**交互设计断言**:每页"数据-操作-反馈"闭环(看到什么→能做什么→操作后界面如何变);时间线类页面必须实时(WS);表单类页面必须给出后端校验回显。

## L6 修订(AML)—— 已实测贯通的操作序列(2026-10-05):
```
twin_scene_discover(无参)→ 记下 controls
→ twin_scene_compile {scene_id,line_id,recipe_id,product_id:活动批次productId,scene_version:'0.2.0-draft'} → 记 hash
→ twin_scene_freeze {scene_id,scene_version 同上,confirmation:'USER_CONFIRMED_SCENE_CONTRACT',expected_hash:hash}(版本必须与 compile 一致,重复冻结幂等返回旧版)
→ 运维:频道 profile.scene_id/scene_version 对齐冻结版(aml_channel_profiles)
→ twin_snapshot_create {auto_daq:true,channel_id,phase:场景 phases 之一(平台标准 phases=discovery/exploration/calibration/shadow/online)}
→ mpc_optimize {snapshot_id,baseline_controls} → safe_small_step recommendation(精确搜索需 AML 模型过门禁)
``` 历史注:`SCENE_NO_CONTROLS`/`BINDING_KIND_INVALID` 已修复 —— discover 应直接含配方参数 control;freeze 仍需 USER_CONFIRMED;MPC 无模型走 safe_small_step;bayes 需绑定门禁模型。castfilm-greybox-v1 已注册并实测完成 rollout(scene-line2-pump:同物理族泵送单元,ScrewSpeedSP→dw-38f145fe);W* 对拍见 /4010/api/plant/optimum。

## 全表面矩阵(后端 API 组 ↔ UI 页面 ↔ 本 skill 层)
| API 组 | UI | 层 |
|---|---|---|
| users/permissions | /users /permissions | L1(负向)/L10 |
| channels/messages/a2a/mailbox | /workshop | L1/L4/L5/L9 |
| tasks/schedules | /workshop/schedules | L1/L5(三模式)+ 定时任务(创建→观察自动触发→停用) |
| dcw(lines/recipes/runs/history) | /dcw /operations | L1/L4 |
| daq(nodes/samples/alarms/frames/export) | /daq | L1/L4 数据深度 |
| agent-tools/bindings/invoke | — | L1 负向/L4 |
| hitl/approvals | /monitor | L4/L10 |
| memories | /workshop(记忆面) | L1/L9 |
| ops-logs/audit | /logs | L1/L10 |
| plugins/channel-templates | /plugins | L3 |
| teams/workspaces | /workshop/teams | L1 |
| aml(twin/providers/dataset) | /aml | L6 |
| device-twins/scene/assets | /town | L10 |
| harnesses/runtime/fs/exp | — | 冒烟(GET 200/形状) |
| ws(AEP) | 全部实时页 | L4 捕获/L10 |
