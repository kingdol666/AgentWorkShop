# Channel 绑定产线(只读扩权)+ 写拒绝审计 验收记录(2026-09-29)

## 需求 → 实现 → 验收

| 需求 | 现状/实现 | 验收 |
|---|---|---|
| 节点↔工艺参数中间层解耦 | 参数映射面(param-map)早已存在:工艺参数 key ↔ PLC 执行点,语义寻址(param_control/param_read) | 此前 P4f 基准 4/4;本轮 T4 复验 ✓ |
| 工艺参数最大最小区间 | 四层限界:节点安全量程 ∩ 工艺参数限界 ∩ 活动产品限界 ∩ 配方工艺窗口,取交集为"有效写入区间" | T4:超量程/超配方窗/超步限三类拒绝文案全部点名约束层 + 有效区间 ✓ |
| 每个 recipe 绑定节点参数区间 | 配方 params 每节点带 min/max(工艺窗口),开跑冻结 | T4.② 拒绝文案点名「配方 … 工艺窗口」✓ |
| 双区间同时满足,超出拦截+反馈+log | 咽喉点 write() 四路共用;400/409/429 带约束层与区间;**本轮新增:拒绝入审计(dcw.write.rejected,含操作者/产线/summary)** | 拒绝审计 4/4 PASS;成功写原留痕不变,两类并存 ✓ |
| Agent 工具 response 明示成败 | 成功回包含"下发成功+回读一致+优化记录开窗";失败 isError 带原因 | T4.④/拒绝审计 1 ✓ |
| worker 查看本产线日志等 | ops_log/recipe_log/recipe_versions/line_context 全套(节点授权 scope) | 此前在册 ✓ |
| **Channel 绑定产线(新功能)** | channels.line_id + PUT /channels/:id/line + instantiate bindLineId;只读扩权(ops_log/recipe_log/recipe_versions/line_context);装配时注入产线简报;解绑/换绑即时回收成员运行时 | 15/15 PASS ✓ |

## 绑定产线设计(语义边界)

- **只读扩权**:绑定后成员无需节点绑定即可读该线运维日志、配方变更史/版本史、实时全景(运行状态/活动批次/当前配方与参数窗口);工具回执带「(频道绑定,只读)」来源标注。
- **写不扩权**:dcw_control/param_control/recipe_rollback 仍严格走节点授权(实测无绑定成员全被拒);授权仍由 lead 经 team_grant_nodes/grant_node_ids 下发。
- **上下文注入**:装配成员时在场景提示词后追加"绑定产线(只读上下文)"简报(线名/描述 + 工具指引);绑定变更与场景变更同链路回收成员运行时。
- **通用→专业场景**:实例化带 bindLineId(或设置弹窗选择)即得"该产线的完整作业上下文";场景提示词继续可编辑 —— 特定场景 = 选线 + 填场景任务提示两步。

## 变更清单
- server:rows/schema/migrations(channels.line_id)、channel.repo(setLine)、admin-channel(bindChannelLine/channelLineBindingOf)、channels/[id]/line.put.ts、instantiate(bindLineId)、ops-tools(agentOpsScope 只读扩权 + 5 读工具)、runtime-wiring(产线简报注入)、write.ts(拒绝审计 reject())
- app:useWorkshopApi(lineId/bindChannelLine/listDcwLines)、ChannelSettingsModal(绑线选择器)、i18n 三键
- seed:通用模板作业纪律补"产线上下文先行"

## 验收数据
- 绑线矩阵 15/15 PASS(实例 3960;脚本 .e2e-tmp/bind-e2e/)
- 拒绝审计 4/4 PASS(实例 3970;脚本 .e2e-tmp/rej-audit/;审计行字段级复核全过)
- 回归:typecheck ✓ / lint 0 / 单测 68/68
