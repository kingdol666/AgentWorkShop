# e2e-2026-10-07 · DAQ 数采与 Recipe 下发控制链路核验报告(附实况演示)

> 问题:①Agent 获取数据时是怎么下发工具的?②下发 recipe 时是怎么执行下发工具的?③PLC 协议节点与 MES API 节点的工具执行方式是否不同?④是否"PLC 节点数据存 tsdb 直接查库、MES 走 API 传 req 参数、recipe 层对 Agent 屏蔽协议"?
> **结论:你的理解基本完全正确,其中一处需要精确化(见 §2.3)。全部论断均有"代码链路取证 + 本日实况演示"双重证据。**

---

## 1. 两条链路的真实执行路径(代码级)

### 1.1 数据获取链(数采)
```
PLC/仪表(五协议)
  → daq 驱动 read(寄存器/OPC-UA节点/MQTT主题/HTTP端点)
  → DaqNodeRuntime.tick(逐产线运行门:活动批次窗口内才采集)
  → tsdbBuffer 批量 INSERT ──→ TimescaleDB 表 daq_samples(hypertable,
     携带 line_id/product_id/recipe_id/run_id 逐样本打标;time_bucket 降采样查询)
  → Agent 工具 daq_query / daq_export
     (工具入参:node_id/last_minutes/bucket_ms/… → 内部 getTsdb().query/queryTagged 执行 SQL
      → 默认自动按"该节点所属产线的活动批次"过滤 → 文本化返回+工况判读)
```
关键代码:`server/services/workshop/agents/industrial/daq-tools.ts:54`(toolDaqQuery → `getTsdb()`)、
`daq/storage/timescale.adapter.ts`(create_hypertable/批量 INSERT/time_bucket)、
`daq/daq-controller/sweep-alarms.ts`(采样由批次驱动)、`daq/daq-controller/tsdb-twin.ts`(批量写缓冲)。

### 1.2 下发控制链(recipe)
```
Agent 工具 recipe_propose(带五要素提案→HITL结构化审批卡)/recipe_update/recipe_trial/recipe_apply
  → 治理闸(全协议一致):绑定门(必须绑配方)→授权清单→运行门(活动批次)→
    四层限界(节点量程∩参数基准∩产品限界∩配方窗)+单步上限 fail-closed
  → applyRecipe(按配方参数逐节点执行,参数={nodeId,value,min,max,stepLimit})
  → DcwController.executeWrite(节点,工程值):
      工程值 →inverseTransform(encode标定)→ PLC值
      → resolveDcwDriver(节点.driver).write({eng,tolerance,domain,driverConfig})  ←★协议在此分叉
      → 回读 →decoder→ 物理值 → 死区校验
      → 写历史(journal 锚点:prevValue→newValue+runId)+WS 直推
```
关键代码:`dcw-controller/actuation.ts:23`(executeWrite → `resolveDcwDriver(node.driver).write`)、
`drivers/shared.ts:43`(**统一驱动接口**:write/test/read?/fetchHistory?,7 驱动同一契约)、
`drivers/modbus.ts:48`(writeRegisters 寄存器写)vs `drivers/mes-rest.ts`(writeMap→HTTP POST)。

### 1.3 MES 点的读取路径(与 PLC 数采不同)
```
Agent 工具 dcw_read / param_read → mes-rest 驱动 read
  → HTTP GET(readMap: method/path/query/headers/secretRef)
  → response.valuePath 提取工程值(按需调用,实时返回)
```
MES 读值**不流式写入 tsdb**;它保存在 DCW 节点现值、写历史与参数台账中。daq 侧驱动目录
(http/mock/modbus-rtu/modbus-tcp/mqtt/opcua/s7-stub)当前**没有 mes-rest 适配器**。

## 2. 对你四项论断的逐一判定

| # | 论断 | 判定 | 证据 |
| --- | --- | --- | --- |
| 1 | PLC 节点数据存入系统 tsdb(TimescaleDB),直接查询数据库 | ✅ 成立(对数采节点) | 实况:Agent `daq_query` 返回 FurnaceTemp 720.477(10min 窗);**绕开平台 docker psql 直查同一表**:720.475/720.447…逐桶吻合;全库 2,182,502 行/57 节点 |
| 2 | MES API 是调用 API 传入 req 参数获取结果 | ✅ 成立 | mes-rest 驱动=声明式 readMap/writeMap/historyMap(method/path/query/headers/`{{value}}` 插值/successOn 状态码/secretRef 零明文);本日实写回环 55→60(试验卡 ap-648b5484 批准后落值) |
| 3 | PLC 节点与 MES 节点执行工具方式不同 | ✅ 成立,但要精确化 | 驱动层确不同:modbus=寄存器写(writeRegisters)、MES=HTTP POST;**但 Agent/recipe 层完全相同**(§3)。需精确化的一点:**MES 读值目前不入 tsdb**(按需 HTTP 实时取,存 DCW 现值/写历史/参数台账);PLC 数采节点才流式入 tsdb。若要 MES 时序也入库,需为 daq 侧补 mes-rest 适配器(现无,已列建议) |
| 4 | recipe 下发工具全协议一致,参数绑定层让 Agent 无需关心协议 | ✅ 完全成立 | 配方参数就是 `{nodeId,value,min,max,stepLimit}`,无任何协议字段;同一 `recipe_trial` 工具本日实测驱动了 modbus-tcp(227/199)、modbus-rtu(404)、MES-HTTP(60) 三种传输;executeWrite 在最后一刻才按节点.driver 分叉 |

## 3. 实况演示记录(本报告当日,全部留痕可复查)

**演示 A:Agent 数采工具 + Timescale 直查同源验证**
1. 以退火频道数据分析师实例(`527dcc1b`)调用 `daq_query {node_id: dn-c76b8a5a, last_minutes:10, bucket_ms:60000}` → 返回 5 点降采样(最新 720.516,均值 720.477),并**自动标注活动批次口径**(`run=rr-bf0f4d24 配方 rc-b80fd6b7`)与工况判读(同线四设定值)。
2. `docker exec awshop-daq-timescale psql` 直查:`SELECT time_bucket('60 seconds', ts), avg(value)…WHERE node_id='dn-c76b8a5a'` → 同窗同值(720.475/720.447/720.853/720.465/720.026)。**Agent 工具与裸 SQL 同源同库。**

**演示 B:同一 recipe 工具跨协议下发(modbus-rtu)**
1. 以退火频道工艺工程师实例(`13bc2091`)调用 `recipe_trial {recipe_id: rc-b80fd6b7, params:[{node_id: dw-5119f457, value: 404}]}`(+4=单步限幅)→ HITL 卡 ap-486a8396。
2. 人工批准 → `executeWrite` → modbus-rtu 网关写 → **PLC 回读 404 精确命中**("读回 raw 404 → eng 404")→ journal 锚点 `400→404(run=rr-05096b57)`。
3. 演示后恢复 400(期间 60s 写间隔闸再次拦截急躁写入——治理在每一层都在工作)。

**跨协议同一工具的第三例(MES)**:本日早些时候同一 `recipe_trial` 工具 + HITL 批准(ap-648b5484)对 mes-rest 节点 dw-05f6ce78 完成写值 55→60(HTTP POST writeMap)。三个协议、同一工具、同一治理链、三种传输。

## 4. 给你的最终答案

**是的——系统正是按你描述的方式工作的**:Agent 用统一的数采工具查 tsdb 拿 PLC 时序数据,用统一的配方工具下发参数;协议差异被封装在两处——**数采的驱动 read**(寄存器/主题/端点→写进 TimescaleDB)与**下发的驱动 write**(寄存器写/HTTP POST),配方管理层(限界/运行门/审批/台账/标定/回读校验)对全部协议一视同仁,Agent 只需传 `recipe_id + [{node_id, value}]`。

唯一建议精确化的认知:**MES 点的读值当前是"按需 HTTP 实时取",不流入 tsdb**(PLC 数采节点才流式入库)。若希望 MES 历史序列也能像 PLC 一样在 tsdb 里被 Agent 用 daq_query 查询,有两条现成路径:①给 daq 侧补一个 mes-rest 数采适配器(把 readMap 轮询结果写入样本管线,工作量小,驱动接口现成);②直接用 MES 驱动自带的 historyMap(声明式分页拉历史,Agent 的 `mes_fetch` 工具已可消费)。需要的话下一轮我可以把①做掉并验收。

## 5. 演示产物索引

- 工具调用:Agent 实例 527dcc1b(daq_query)/13bc2091(recipe_trial)经 `POST /api/workshop/agent-tools/invoke` 留痕
- 审批卡:ap-486a8396(批准)/ap-648b5484(MES,批准)/ap-5c0dcbe6(199,批准)
- 台账锚点:400→404(rr-05096b57)、208.8→227(rr-f4a4d929)、55→60(MES)
- Timescale 直查:`daq_samples` 2,182,502 行 / 57 节点(docker 容器 awshop-daq-timescale)
