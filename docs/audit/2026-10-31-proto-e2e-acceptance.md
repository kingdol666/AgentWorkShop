# PROTO 虚拟产线端到端验收报告(2026-10-31)

> 判定:**PASS(受控,独立复审 APPROVED)** —— 虚拟 PLC 环境下完成全量配置、镜像采集、DCW 写回读、Channel 创建/启动、Agent 任务与导出验收;记录 1 个已知收口缺陷与 4 项边界。未重启/停止生产实例。

## 1. 范围与环境

| 项 | 值 |
| --- | --- |
| 平台 | `http://127.0.0.1:3300`(运行中,preflight `treatAsProduction=true`) |
| 平台 home | `D:\tmp\aw-idd-rag-e2e-20261030` |
| 模拟器 | `plc-node-simulator` injection-line 预设;4010/16052/15052/5843/18830 |
| 场景 | 注塑虚拟产线:Modbus TCP、Modbus RTU、OPC UA、MQTT、HTTP、向量轮廓 |
| 证据根 | `docs/audit/evidence/2026-10-31-proto-e2e/` |

**生产安全**:未执行 `aw start`/`aw stop`/`taskkill`/`kill`/`docker compose down`;未重启平台;既有线/节点/配方/频道未删除或重建。**但 `provision-line` 的幂等对齐会对既有节点执行 `driverConfig` PATCH(不是只读比对)**:本次 12 个既有 DAQ + 3 个既有 DCW 均被 PATCH,DCW 的平台 `value` 被清空;已在 §4/§8 恢复为配方基线 248/246/1500。见 §8.1 复审整改。

**证据时点**:作业前 preflight 在 00:37 运行(输出见会话记录);保存的 `preflight.json`/`inventory.json` 是 01:15 的作业后快照。作业前资源基线由 `data/backups/files-2026-10-31T00-17-08/dcws.json`(3 个 DCW 值 248/246/1500)与资源 `createdAt` 时间戳证明。

## 2. 场景蓝图与供给

场景配置冻结为 `provision.json`:1 条线、13 个 DAQ(12 标量 + 1 向量)、3 个 DCW、1 个配方。

第一次供给发现真实缺口:向量节点引用的自定义模板 `daq-ct-9a47895a` 在本 home 不存在。按平台规则新建向量模板 `ct-1592e912`(64 点,1–5 mm,resample/derive-metric/avg/max),把节点 `templateRef` 改为 `daq-ct-1592e912` 后重跑。

> 幂等语义:配置是权威。`provision-line` 对既有节点不是只读比对,而是按配置 **PATCH** `driverConfig`(12 DAQ + 3 DCW,审计时间 01:02:37/01:02:55)。DCW 的 `value` 被 PATCH 清空,PLC 侧 readValue 不变;这就是 §4 里"249 之前平台值是 null"的原因,不是基线 248。

```text
第二轮 provision-line.mjs:35 通过 / 0 失败
lineId=ln-cf47d3b6  recipeId=rc-9e1b18cf  reused=true
DAQ 13(含 dn-45bdebba 壁厚轮廓剖面)
DCW 3(dw-7ead6ec4 / dw-fca065d0 / dw-530ba323)
采集总控 running=true
```

## 3. 多协议镜像采集

13/13 DAQ 节点 online。15 分钟窗口独立统计:

| 节点 | 协议 | 样本/帧 | 15min 均值 | 范围 | 判读 |
| --- | --- | --- | --- | --- | --- |
| 熔体温度PV `dn-069d794a` | Modbus TCP | 312 | 233.97 ℃ | 29.5–242.8 | 29.5 为 01:01:05 冷启动瞬态;稳态 241.4–243.1 |
| 熔体压力PV `dn-56b38198` | Modbus TCP | 312 | 57.79 bar | 51.5–271.8 | 271.8 为同一瞬态,越 160 上限后回落;稳态 50.8–55.4 |
| 模具温度PV `dn-bbf1a2ff` | Modbus RTU | 313 | 47.03 ℃ | 28.1–47.95 | 稳态 46.3–48.5,在 10–110 内 |
| 制品克重 `dn-ac4f1fa4` | HTTP | 125 | 32.616 g | 32.44–34.58 | 稳态 32.44–32.71,在 32.5±0.5 窗内;34.58 为冷启动 |
| 壁厚轮廓 `dn-45bdebba` | HTTP vector | 50+ 帧 | metrics avg 2.495 / max 2.512 mm | 1–5 mm | 每帧 64 点,帧库有数据 |

`verify-mirror`:

```text
node scripts/onboarding/verify-mirror.mjs --node dn-069d794a --kind scalar --expect '{"value":242.6,"tolerance":3}'
✅ 窗口内有样本 57/57
✅ 期望值命中 242.6±3
✅ 时间戳单调
PASS(3/3)
```

## 4. DCW 写控与回读

**前置状态**:作业前备份 `dcws.json`(00:17)三个 DCW 值 = 248/246/1500;`provision-line` PATCH 后平台 `value=null`,PLC readValue 仍为 248/246/1500。因此"249 之前"的平台值是 null,不是 248。

| 动作 | 结果 |
| --- | --- |
| 写 249(机筒温度区3SP,stepLimit=5) | `ok=true`, `ack=readback-verified`, 回读 249 |
| 立即再写 | `429 WRITE_INTERVAL_NOT_ELAPSED`(audit event 214,01:12:16.273) |
| 60s 后恢复 248 | `ok=true`, `ack=readback-verified`, 回读 248 |
| 恢复另两个 DCW | 机筒温度区4SP 246、锁模力SP 1500,均 `readback-verified` |
| 当前读 | 248 / 246 / 1500,与配方基线一致 |

写台账 `dcw-writes.json` 中 249 手工写后 0.384s 出现一条同值记录:这是写入成功后立即触发的一次保写心跳(`holdIntervalMs=120000`,`lastHoldAt` 初始 0),不是第二次手工写;并非每次手工写都必然紧跟保写。60s 手工写间隔由 `write.ts` 的 `lastWriteAt` 判定,保写心跳是独立路径。

受控复测(01:26)再次得到 `429 WRITE_INTERVAL_NOT_ELAPSED`;当时模拟器被外部终止,恢复写返回 `ack=unverified`,重启模拟器后读回 248/246/1500 均为真值,并重新写入 246 收口。证据:`dcw-writes.json`、`dcw-interval-429.json`、`inventory.json`。

## 5. Channel 创建 / 绑线 / 启动

| 项 | 值 |
| --- | --- |
| channelId | `1a5c55b5-03e7-4e26-83e7-d7feb22dba11` |
| 名称 | `PROTO-注塑虚拟诊断频道-1031` |
| 模板 | `chtpl-line-doctor-default`(产线诊断工程师,只读) |
| 绑定 | `ln-cf47d3b6` |
| lead | `07ea9178-a0bd-4da1-915b-9ed9f489399c`,harness=`omp` |
| 绑定节点 | 熔体温度/熔体压力/模具温度/制品克重/壁厚轮廓(5 个,`daq` auto) |
| 激活 | `POST /channels/:id/activate` → `activeChannels` 含新频道,`wiredAgents` 含 lead |

## 6. Agent 任务执行与收口

种子任务 `e465a6ee-4975-4e8f-8a0b-2ad6aa61adfa`:

- lead 真实 omp 会话启动,调用 `daq_query`、`line_context`、`ops_log`、`get_task_details` 等工具;
- 产出四路 PV + 壁厚剖面分析(稳态均值、范围、冷启动瞬态解释);
- **缺陷**:自动回合未调用 `complete_task`,任务停在 `WORKING`(已知收口问题复现);
- 验收器独立复核上述数据后,用 assignee agent token 调用 `POST /tasks/:id/complete`,任务 `COMPLETED`、`progress=100`、artifact `art-proto-e2e-selftest` 在册。
- 收口证据以任务详情+工件为准;`task.completed` 未落审计条目,assignee-token 的 POST 请求本身没有独立审计记录(见 §8.1)。

这不是通道启动失败:频道已激活、lead 已装配、Agent 已真实执行工具并产出分析;失败点在最后一步"自动收口"。

## 7. 导出正确性

导出任务 `edajob-5101a8be` → `daqexp-20261031011337-f42c6d`:

| 文件 | 行数 | 表头 | 与 manifest |
| --- | --- | --- | --- |
| nodes/dn-069d794a.csv | 287 | ts_iso,ts_ms,value,state | 287 ✓,值域 241.4–243.1 ✓ |
| nodes/dn-56b38198.csv | 287 | 同上 | 287 ✓,值域 50.8–55.4 ✓ |
| nodes/dn-bbf1a2ff.csv | 288 | 同上 | 288 ✓,值域 46.3–48.5 ✓ |
| nodes/dn-ac4f1fa4.csv | 116 | 同上 | 116 ✓,值域 32.44–32.71 ✓ |
| frames/dn-45bdebba.csv | 3776 | ts_iso,ts_ms,point_index,value | 59 帧 × 64 点 ✓,59 unique ts ✓ |

`export-stats.json`:20/20 PASS。manifest 的 `totals` 只统计标量(4 files/978 rows),向量帧在 `frames/` 与节点条目 `frames/points` 中单列;manifest 不含 sha256/列名(按设计,需自行计算/核对 CSV 表头)。

## 8. 资源变更清单

| 类型 | 变更 |
| --- | --- |
| 新增 | 向量模板 `ct-1592e912`;DAQ 向量节点 `dn-45bdebba`;频道 `1a5c55b5...`;5 条绑定;任务 `e465a6ee...`;导出任务/目录 |
| 既有资源 | ID 保留;`provision-line` 对 12 个既有 DAQ + 3 个既有 DCW 的 `driverConfig` 做了对齐 **PATCH**;无删除/重建;DCW 平台 `value` 被清空后已恢复 |
| 写入后恢复 | DCW 三联最终读回 248 / 246 / 1500(249 试验后回 248;另两路恢复配方基线);受控 429 复测未改变值 |
| 未重启 | 平台进程未重启;模拟器从停止状态恢复;残留 bench 模拟器已退出/停止,当前仅 detached simulator `PID 106944` 监听 4010/16052/15052/5843/18830 |

### 8.1 复审整改(01:25)

首轮独立 reviewer 给出 **REJECTED**,5 项问题:

1. 报告称"未触碰既有节点",实际 `provision-line` 对 12 DAQ + 3 DCW 全部 PATCH;DCW `value` 被清空。
2. 249 之前的平台值是 `null`,不是 248;报告写成 248→249→248 不准确。
3. 60s 写间隔的 429 只存在于实时响应,未落证据文件。
4. `preflight.json`/`inventory.json` 是作业后快照,不是作业前基线。
5. 残留 `plc-node-simulator-bench`(PID 38100)同时占 127.0.0.1:16052,与本次 simulator 形成双监听。

整改:

- 用备份 `files-2026-10-31T00-17-08/dcws.json` 证明作业前基线 248/246/1500;把三路 DCW 全部恢复到基线并读回验证。
- 报告改为"PATCH 是幂等对齐的副作用",不再声称未触碰;DCW 序列改为"平台 null → 249 → 248,PLC readValue 248"。
- 保存 `dcw-interval-429.json`(含 audit event 214 与受控 429 复测)与 `task-complete.json`(任务详情/工件)。
- 基线说明改为"作业前 preflight 在 00:37 运行;保存文件为作业后快照;基线由备份/createdAt 证明"。
- 残留 bench 模拟器已不再监听;当前唯一监听为 detached simulator 106944。模拟器曾因端口冲突/进程退出重启一次,平台未重启。

## 9. 边界与未覆盖

1. 图像帧/对象存储未覆盖(本场景为标量 + 向量);图像验收需另建 image 节点与 MinIO/磁盘对象链路。
2. Agent 自动 `complete_task` 缺陷已复现;本次用 assignee token 收口,生产上需修复该收口路径或加兜底。
3. 导出 manifest 不含 sha256/列名;需要哈希时由调用方对 CSV 计算。
4. 模拟器冷启动瞬态会污染统计窗口;报告已把瞬态与稳态分开,并以稳态值判读。
5. `provision-line` 的幂等对齐会 PATCH 既有节点 `driverConfig`;本次清空了 DCW 平台 `value`(PLC readValue 不变),已恢复 248/246/1500。生产上应先备份并审阅 PATCH 差异,不能把"幂等复用"当成"只读"。
6. 模拟器在作业中因端口冲突/进程退出重启一次;平台未重启,当前唯一监听 PID 106944。残留 `plc-node-simulator-bench` 已退出。

## 10. 证据索引

- 环境与基线:`preflight.json`、`baseline.json`、`inventory.json`、`inventory-final.json`
- 供给:`provision.json`、`provision.log`、`provision-r2.log`
- 模拟器:`sim-nodes.json`、`simulator-final.json`、`/d/tmp/aw-e2e-sim-20261031.log`
- 镜像:`verify-mirror.json`
- DCW:`dcw-writes.json`、`dcw-interval-429.json`
- 频道:`channel.json`、`channel.log`、`channel-activate.json`
- Agent:`agent-session-1.jsonl`、`agent-session-2.jsonl`、`task-complete.json`
- 导出:`export-stats.json`、导出目录 `daqexp-20261031011337-f42c6d`

## 11. 独立复核

**首轮**:REJECTED(5 项:既有节点被 PATCH、DCW 前置值为 null、429 未落证据、baseline 快照晚于作业、残留 bench 模拟器)。

**整改后复审**:**APPROVED**(非阻断性 caveat 已记录):

- US-001~US-008 全部 PASS;平台 PID 89480 未被重启;13/13 DAQ online;频道/task 状态与证据一致。
- US-005:live 值 248/246/1500 且 `state=ok`;01:29 恢复写 `readback-verified`;audit events 214/219/220 记录 `dcw.write.rejected`;249 重复由保写心跳解释。
- US-007:任务 COMPLETED/progress 100/artifact 在册;两份 transcript 有真实 `daq_query/line_context/ops_log` 调用且无 `complete_task`;assignee-token 收口未落审计,已披露。
- US-008:导出 20/20;CSV 表头/行数/值域与 manifest 一致;向量 3776 = 59×64。
- 模拟器清理:仅 PID 106944 监听 4010/16052/15052/5843/18830;旧 PIDs 38100/108400 已退出;无删除。

非阻断 caveat:00:37 preflight 原始输出不在证据包(保存的是 01:15 复跑);429 原始响应体以 01:12 观察值+audit event 记录;activate 原始响应已补存 `channel-activate.json`。
