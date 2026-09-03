# 数采镜像节点扩展接口 —— 多形态数据(向量/图像)插件化采集与下沉处理计划

> 状态:**pending approval**(待用户批准后实施;本计划仅为规划产物,未改动任何源码)
> 日期:2026-09-02 · 关联架构记忆:daq-server-architecture

---

## 0. 需求摘要

| # | 需求 | 现状缺口 |
|---|---|---|
| R1 | 数采数据不限于单点:测厚仪/扫描仪类**多点向量**、CCD 类**图像** | `DaqDriver.sample()` 仅返回 `{value,state}` 标量(`server/services/workshop/daq/drivers.ts:41-47`);`daq_samples` 表列为标量数值(`storage/timescale.adapter.ts:28-36`) |
| R2 | 特殊模板节点:节点作为独立特殊模板,配置化**实时下沉处理**(模板负责) | 模板只有波形参数 base/amp(`shared/daq-protocol.ts:15-35`),无 signalKind/处理管线概念 |
| R3 | 与**设备/产品/Agent** 绑定 | 设备绑定已有(`daq-controller.ts:66,611`);产品/配方=活动 LineRun 窗口打标(`daq-controller.ts:212-224`);Agent 绑定表已有(`agents/node-bindings.repo.ts:22-30`)——需让**帧数据**同样继承该链路 |
| R4 | **插件**扩展算法适配多种数据类型 | 插件宿主已有(`plugins/host.mjs` + `daq:sample` 钩子于 `daq-controller.ts:206`),但无驱动注册/处理器注册能力 |
| R5 | 向量/元数据入 **Timescale**,图像入**对象存储**(docker-compose 新增对象存储服务) | Timescale 已就绪(`daq-timescale`,`docker-compose.yml:20-31`);无对象存储 |
| R6 | 图像获取作为一个**内置数采模板**;其他模板可自定义添加 | 内置模板 6 件全标量(`shared/daq-protocol.ts:70-77`) |

---

## 1. 总体设计(决策摘要)

**核心思路:不改标量主链路,增开"帧(frame)"并行管线。** 标量样本继续走 `daq_samples`(既有 UI/告警/Agent 查询零感知);新引入 `DaqFrame`(kind=vector|image)走独立入库、独立 WS 帧型 `daq.frame`、独立 REST。模板新增 `signalKind` 判别路由;下沉处理 = 模板配置的处理器管线,处理器与驱动均可由插件注册。

```
驱动 sample()(扩展:可返回 frame 信封)
  → DaqNodeRuntime.onSample 分支
      ├─ 标量:既有路径(daq.reading → daq_samples)不动
      └─ frame:下沉管线(模板 sink.processors)
            ├─ vector:resample/zones/derive-metric → daq_frames 行(JSONB 点列 + metrics)+ 可选派生标量→告警
            └─ image :thumbnail/quality-gate → MinIO 放对象 + daq_frames 行(元数据/metrics)
                  → WS daq.frame(向量降采样预览/图像缩略图引用,不含原始 blob)
                  → 派生 metrics 阈值 → 既有 handleAlarm 链路(daq-controller.ts:304-342)
```

### 关键决策与理由(ADR 精简版)

| 决策 | 备选 | 选择理由 |
|---|---|---|
| D1 帧存储 = 新表 `daq_frames`(hypertable,meta/metrics JSONB)+ 图像 blob 只存对象存储键 | 全塞 JSONB / 全存标量表 | 标量表列型安全、既有查询零迁移;JSONB 承载变长向量与图像元数据;Timescale 存元数据+向量,MinIO 存像素(正是 R5 要求的分工) |
| D2 驱动契约向后兼容扩展:`sample()` 返回值新增可选 `frame` 字段,而非新接口 | 独立 FrameDriver 接口 | 既有 7 个驱动(`drivers.ts` REGISTRY:739-747)零改动;mock 即可同时演示三种 kind |
| D3 对象存储 = MinIO(compose 新服务)+ **本地磁盘降级适配器**(`data/daq-objects/`) | 仅 MinIO / 用 postgres large object | 与既有 Timescale→SQLite 降级双适配模式完全同构(`storage/index.ts:23-47`);MinIO 是 S3 兼容事实标准,运维最轻 |
| D4 下沉处理 = 模板 `sink.processors` 有序管线,处理器由内置+插件注册 | 处理逻辑硬编码在 controller | R2/R4 的"配置化+插件扩展"直接成立;管线在消费泵侧执行,不阻塞采样节拍 |
| D5 WS 下发 `daq.frame` 只带**降采样预览/缩略图引用** | 全量点列/原图推送 | 沿用双节拍门控(`daq-runtime.ts:161-165`);64 点预览 + 缩略图 URL 保前端性能(百节点优化成果不可回退,见 memory 前端性能层) |

---

## 2. 验收标准(全部可测)

### P0(核心管线)
- A1 驱动返回 `frame.kind='vector'`(N 点)的节点:每个采样节拍后 `daq_frames` 出现一行,`points` 列=N,`meta` 含点列;**`daq_samples` 不产生该节点行**(标量表零污染)。
- A2 `frame.kind='image'` 的节点:每帧 MinIO(或降级磁盘)出现一个对象,`daq_frames.meta->>'objectKey'` 与之对应;`daq_samples` 零污染。
- A3 帧行自动携带设备绑定(device_binding_id)与活动 LineRun 打标(line/product/recipe/run),与标量样本同口径(`daq-controller.ts:212-224` 同源取值)。
- A4 模板配置 `sink.processors=[resample(32)]` 的向量节点:入库点数=32(管线在入库前生效);`derive-metric` 产出的 metric 越限时触发既有告警链路(alarm_events 落库 + WS `daq.alarm`)。
- A5 `GET /api/workshop/daq/:id/frames`(bucketMs/limit/kind 过滤)返回帧元数据;`GET /api/workshop/daq/:id/frames/content?ts=` 图像流式返回(鉴权同既有 daq REST)。
- A6 WS 出现 `daq.frame` 帧型:向量含 ≤64 点预览数组;图像含缩略图 content URL(不含 blob)。
- A7 docker-compose 含 `daq-minio` 服务(9000/9001,持久卷);`startInfrastructure:auto` 时 `ensureDaqInfrastructure` 一并拉起(`daq/infra.ts` 既有模式);MinIO 不可达时自动降级本地磁盘并在 `meta.infra` 报警告(与 tsdb 降级同体验)。
- A8 两个新内置模板 `ccd-image`(image)/`thickness-scan`(vector 64 点)随 mock 驱动可完整跑通 A1/A2;既有 6 模板与存量节点行为零变化(回归:存量 e2e 脚本全绿)。
- A9 `DAQ_TSDB_URL` 未配置的降级环境:帧管线同样降级可用(SQLite 帧仿真表),不阻断采集。

### P1(消费面)
- A10 `/daq/[id]` 节点控制台按 signalKind 分视图:vector=多点轮廓图(ECharts),image=实时快照+历史画廊(缩略图分页);`/daq` 节点表实时值列显示 kind 摘要(向量=avg,图像=🖼)。
- A11 Agent 工具:`daq_query` 支持 `kind=frame` 返回 metrics 摘要;新工具 `daq_frame`(受 node-bindings 鉴权,`industrial-tools.ts:173-181` 同口径)可取最新/指定帧——向量=降采样点列+metrics,图像=content URL。
- A12 插件可注册驱动与处理器:示例插件 `daq-vector-demo` 注册一个自定义 vector 处理器并生效(重启后仍生效,随 `plugins.reloaded` 热更新)。

### P2(增强,后续批次)
- A13 图像 blob 生命周期策略(MinIO bucket lifecycle / 本地目录按保留期清理,与 `drop_chunks` 保留期联动)。
- A14 预签名 URL 直连(带 TTL)减少服务端流;`daq_frames` 连续聚合(metrics 分钟级物化)。

---

## 3. 实施步骤

### P0-1 共享协议与模板扩展 — `shared/daq-protocol.ts`

- `DaqTemplateDef`(15-35 行)新增:`signalKind: 'scalar' | 'vector' | 'image'`(缺省 scalar,内置 6 件不动);`vector?: { points: number, unit: string, min: number, max: number }`;`sink?: { processors: Array<{ name: string, args?: Record<string, unknown}> }`;`metrics?: Array<{ key: string, label: string, warn?: number, alarm?: number, unit?: string }>`(派生指标阈值 → A4 告警)。
- 新增内置模板 2 件(70-77 行数组追加):`ccd-image`(image,icon 沿用 vision)、`thickness-scan`(vector 64 点,unit mm)。
- 新增 AEP 载荷类型 `DaqFramePayload`(WS `daq.frame` 用)。

### P0-2 驱动契约 v2 + mock 扩展 — `server/services/workshop/daq/drivers.ts`

- `DaqSampleEnvelope`:sample() 返回值新增可选 `frame?: { kind:'vector'|'image', points?: number[], blob?: Buffer, mime?: string, width?: number, height?: number, metrics?: Record<string, number> }`(41-47 行契约注释与类型同步;既有驱动零改动)。
- mock 驱动(73-109 行)按模板 signalKind 分支:vector=多正弦+游走波形(64 点),image=程序化生成灰度图(**zlib 压 PNG,零新依赖**)+随游走偏移,metrics 附 min/max/avg。
- 插件驱动注册:`REGISTRY`(739-747)导出 `registerPluginDriver(def)`(去重按 key,重复注册覆盖并告警),供 host 调用。

### P0-3 对象存储端口 + MinIO 适配器 — 新 `server/services/workshop/daq/objectstore/`

- `tsdb-port.ts` 同构三件:`objectstore-port.ts`(接口 `put(key,buf,meta)/get(key)/stat(key)/remove(key)`)、`minio.adapter.ts`(**`minio` npm 包,createRequire 加载**——nitro 对外部包动态 import 的 `protocol 'd:'` 坑必须绕行,memory 实录)、`disk.adapter.ts`(本地 `data/daq-objects/` 降级)。
- `objectstore/index.ts` 工厂:`DAQ_OS_URL`/config.yml `daq.objectstore` → minio;不可达 → disk 降级 + `meta.infra.objectstore='disk:degraded'`;`rebuildObjectStore()` 仿 `rebuildTsdb`(`storage/index.ts:62-96`)带 5×2.5s 重试(Timescale 容器初始化窗口坑同款)。
- **依赖变更**:`package.json` + `minio`;`nuxt.config.ts` nitro externals 数组追加(与 pg/mqtt 同位置)。

### P0-4 基础设施编排 — `docker-compose.yml` + `daq/infra.ts` + `server/plugins/daq.ts` + `config.yml`

- compose 新增 `daq-minio`(minio/minio,`server /data --console-address ":9001"`,9000/9001,env MINIO_ROOT_USER/PASSWORD=awshop,volume `awshop-daq-objdata`)。
- `infra.ts`:`probePort(9000)` + 启动列表追加 `daq-minio`;启动后 ensure bucket(`daq`)存在。
- `server/plugins/daq.ts:32-65` 装配序列插入 `rebuildObjectStore`;`daq.objectstore` 段进 runtimeConfig。
- 启动器注入:`scripts/start.mjs` / dev 链路的 DAQ env 透传同款(仅 config.yml 路径,规避 NUXT_DAQ_* env 不覆盖坑,memory 实录)。

### P0-5 帧管线(核心)— `daq-controller.ts` + `daq-runtime.ts` + `storage/`

- **Timescale**:`timescale.adapter.ts` `init()`(25-58)追加 `daq_frames` 建表+`create_hypertable('daq_frames','ts')`+node_id/ts 索引+line/product/recipe/run/device 列(仿 43-51 补列模式)+保留期 `drop_chunks`(默认 720h,独立于标量 168h);`writeFrames(batch)`/`queryFrames(nodeId,{fromMs,toMs,bucketMs,kind,limit})`(metrics 用 JSONB 聚合,time_bucket 即时聚合,与既有 query 同风格 100-106)。
- **SQLite 降级**:`sqlite.adapter.ts` 同名帧表(仿真 JSONB TEXT 列),接口不空转(A9)。
- **controller**:`ingestNode`(193-236)分支——envelope 含 `frame` → `ingestFrame(node, frame)`:
  1. 执行模板 `sink.processors` 管线(内置处理器 `resample`/`zones`/`derive-metric`/`thumbnail`/`quality-gate`,注册表结构同 drivers REGISTRY,插件可追加);
  2. image:`objectStore.put(key='daq/<nodeId>/<yyyy>/<mm>/<dd>/<ts>.<ext>')` → meta.objectKey;
  3. `tsdb.writeFrames` 攒批(复用 TSDB_FLUSH_MS=500/TSDB_BUFFER_CAP=5000,96-98);
  4. WS `daq.frame`(向量 64 点截断预览;图像 `{thumbUrl:'/api/workshop/daq/:id/frames/content?ts=…&thumb=1'}`);
  5. metrics 阈值告警 → 复用 `handleAlarm`(304-342,kind 标注 `daq.frame`)。
  打标取值与 212-224 同源;`publishSample` 队列载荷携带 envelope(帧 blob 经队列传输注意 MQTT 上限——image 建议进程内队列直传,MQTT 模式下 blob 换临时盘落+引用传递,P0 简化为 inproc 直通、MQTT 场景帧只传元数据+blob 走对象存储直写,详见风险 R3)。
- **runtime**:`onSample`(125-167)透传 envelope;双节拍门控对 `daq.frame` 同样生效(161-165)。
- **samples()/frames() 查询透传**:controller 新增 `frames()`(517-523 同风格)。

### P0-6 REST — `server/api/workshop/daq/`

- 新增 `frames.get.ts`(列表,kind/bucketMs/limit/pagination)、`frames/content.get.ts`(按 ts 取图像内容;thumb=1 取缩略图对象;**鉴权与既有 daq 路由同中间件**;降级磁盘时直接流文件)。
- 既有 `templates` 路由透传新字段;`index.get` 的 meta 增 `objectstore` 状态。

### P1-7 前端 — `useDaqStream.ts` + `app/pages/daq/*`

- `useDaqStream.ts`:帧状态(hist 环形同款收敛)+ `daq.frame` 订阅 + `framesOf()/frameContentUrl()`(仿 303-309)。
- `/daq/[id].vue`:按模板 signalKind 分支视图(vector 轮廓图/image 快照+画廊);`/daq/index.vue` 节点表实时值列 kind 摘要 + 模板管理弹窗展示 signalKind 徽标。遵守既有性能纪律:500ms 合批、rowCtx 预计算、content-visibility(memory 前端性能层五项)。

### P1-8 Agent 工具 — `industrial-tools.ts`

- `toolDaqQuery` 增 `kind` 参数(frame 模式返回 metrics 摘要表);新增 `daq_frame`(node-bindings 鉴权同 173-181;host-tools.json 注册,lead/worker 均可见);prompt 文件(`.AgentWorkShop/prompts/`)与 system-manual 工具清单同步。

### P1-9 插件 SDK — `server/services/workshop/plugins/host.mjs` + `sdk/`

- ctx.daq 增:`registerDriver(def)` / `registerProcessor(kind, name, fn)` / `listTemplates()`;变更广播 `daq.template.changed`/`plugins.reloaded` 触发 REGISTRY 重建;`docs/plugins.md` 补章节 + `examples/` 新示例插件 `daq-vector-demo`(自定义 processor:滑动窗口方差→derive metric)。
- 新生命周期钩子 `daq:frame`(每帧发射,负载含 metrics/objectKey,**不含 blob**——防插件侧内存放大)。

### P2(后续批次)
图像 blob 保留期联动清理、预签名直连 URL、`daq_frames` 连续聚合、MQTT 队列大 payload 分帧协议、CCD 连续流(rtsp)驱动。

---

## 4. 风险与对策

| # | 风险 | 对策 |
|---|---|---|
| R1 | Timescale 建表/补列与存量 `daq_samples` 冲突 | 全部 DDL 幂等(IF NOT EXISTS,仿 43-51 补列模式);`daq_frames` 独立表零触碰标量 |
| R2 | MinIO 客户端在 nitro 打包下动态 import 炸(`protocol 'd:'` 坑,memory 实录) | 严格走 `createRequire(import.meta.url)` + `nitro.externals.external` 数组追加;dev/prod 双跑验证 |
| R3 | 图像 blob 走 MQTT 队列超 broker 上限(默认 256KB) | P0:帧管线在**消费侧**落对象存储——队列载荷仅元数据,blob 经进程内引用(MQTT 适配模式下 blob 由生产侧直写对象存储后只传 key);P2 再做分帧 |
| R4 | MinIO 不可达/磁盘满 | disk 降级适配器 + `meta.infra` 警告横幅(与 tsdb 降级同 UX);写入失败帧丢弃计数进既有 dropped 指标,不阻塞采集节拍 |
| R5 | 图像量打爆 WS/前端 | WS 只发缩略图引用;前端懒加载 + content-visibility;图像节点不进 TownView callout 数值管线(P1 只在详情页消费) |
| R6 | 处理器管线异常拖垮消费泵 | 每处理器 try/catch + 失败计数 + 节流日志;管线超时上限(单帧 2s,超时按原始数据入库) |
| R7 | 帧数据量级(64 点×1s)远超标量 | JSONB TOAST 压缩(Timescale 默认);resample 处理器默认把入库规模钉在模板声明点数;保留期 720h 短于标量可配;P2 连续聚合 |
| R8 | 既有 6 模板/存量节点回归 | signalKind 缺省 scalar,全部旧路径 early-return;存量 e2e 资产(`_dbg-daq-cadence`/`_dbg-real-driver-e2e`/`_dbg-daq-rowstate-e2e` 等)作回归门 |
| R9 | 并行会话共享仓库(本轮实录) | 提交按 pathspec 限定;改动集中在 daq 子目录+compose+protocol,与 memory×context 批次文件不相交 |

## 5. 验证方案

| 脚本(新增) | 覆盖 |
|---|---|
| `scripts/test-daq-frames.ts` | 单元:驱动 envelope/mock 三 kind、sink 管线(顺序/超时/异常)、frames 写入(mock tsdb)、打标继承、告警派生 |
| `scripts/_dbg-daq-frames-e2e.mjs` | 集成:建 thickness-scan/ccd-image 节点 → REST frames/content 断言 → MinIO 对象存在性 → 降级模式(disk)等价断言 → 存量标量节点零变化 |
| `scripts/_dbg-daq-frame-ws.mjs` | WS:`daq.frame` 帧型/预览截断/缩略图 URL/双节拍门控(仿 `_dbg-daq-cadence.mjs` 的真实 WS 订阅法:先导航应用源再开 socket) |
| `scripts/_dbg-daq-plugin-driver-e2e.mjs` | 插件:daq-vector-demo 注册处理器→热生效→落库指标含派生 metric |
| Agent 面 | `daq_frame` 工具经 node-bindings 越权拒绝 + 正常取帧;复用 memory 工业工具鉴权测试口径 |

**依赖变更汇总**:`minio`(npm,唯一新增运行时依赖);docker-compose +1 服务;config.yml `daq.objectstore` 段。**不改动**:标量驱动契约语义、`daq_samples` schema、既有模板 6 件、既有 REST/WS 帧型、告警/绑定/调度链路。

## 6. 落地顺序

1. **P0(~2 个会话)**:P0-1→P0-5→P0-6,验收 A1-A9(`test-daq-frames.ts` + `_dbg-daq-frames-e2e.mjs` 绿)。
2. **P1(~1-2 个会话)**:P1-7→P1-8→P1-9,验收 A10-A12。
3. **P2**:按需排期(A13-A14)。

每批独立可交付;总开关式回滚 = 模板不配 signalKind/sink 即整条帧管线逻辑性关闭(零配置零行为)。
