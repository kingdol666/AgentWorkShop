# 全协议连通 + 插件下沉处理 实测验证计划(2026-09-05)

> 定位:用户验收任务 —— ①全主流通信协议在模拟真实工况下的配置连接、DAQ 数采(只读)、DCW 数控(读+写)全链路实测;②插件系统:自定义数据下沉处理模板(默认=WS+Timescale,自定义=算法/入时序或 MinIO/实时渲染/数字孪生/Agent 工具)默认节点+自定义模板插件真实安装连通测试。
> 方法:全部走真实 REST/WS + 真实模拟器进程(MQTT broker/HTTP device/Modbus TCP slave/Modbus RTU slave/OPC UA Server/PLC 涂布产线),发现的问题实录于此,按项修复后回归。

## 测试环境事实

- dev server: `node bin/aw.mjs dev` → 127.0.0.1:3000(config.yml `server.dev.port`)
- 模拟工况:`scripts/dev-protocol-simulators.mjs`(MQTT :1883 每 2s 发布 `aw/sim/temp`、HTTP :1889 `GET /api/value`)+ `dev-modbus-simulator.mjs`(:1502,40001=float32 压力/40003=float32 温度)+ `_rtu-mini-slave.mjs`(:15030,FC03/FC10,float32 42.5↔44.25 交替)+ `dev-opcua-simulator.mjs`(:4840,`ns=2;s=AW.Temp` 读 / `ns=2;s=AW.SetTemp` 写)+ `dev-plc-simulator.mjs`(:15040,涂布产线烘干单元,PV 40001/3/5,SP 40021/3/5 可写)
- Docker 基础设施在位:mosquitto:1883 / Timescale:5432 / MinIO:9000(bucket `daq`)
- DAQ 采集门控:节点必须挂在有 active run 的产线(line)下才开始采样(`daq-controller.sweep`)
- 认证:种子密码已改随机化(P0-1 已修);注册接口 `POST /api/users/register`
- 单测运行方式:`npx tsx --tsconfig .nuxt/tsconfig.server.json scripts/test-*.ts`;E2E `.mjs` 直连运行中的 dev server;Node/curl 须 `NO_PROXY`(:7890 代理劫持 localhost)

## 问题清单(实测实录,持续追加)

### LIVE-P0-A `[LIVE][已复现×2]` opencode 引擎 RPC 失败以 unhandledRejection 击穿整个服务端
- 现象:dev server 启动后数秒内 `opencode API POST /session → HTTP 400: {"_tag":"BadRequest"}`(残留 opencode serve 进程拒绝会话创建,疑似模型/权限配置不兼容)→ `[stability-guard] fatal unhandledRejection, exiting` → **worker exit 1,dev server 全挂**(DAQ/DCW/插件全部不可用)。两次冷启动均复现。
- 根因(三层):
  1. `opencode-agent.ts supervise()` 的 `await this.ensureServer(ctx)` 在自身 `.catch` 链之外;
  2. 引擎边界错误(RPC 4xx/5xx)被 `dev-stability-guard` 归为"真实错误"→ exit 1;
  3. 服务端同时承载工业数采/写控,一个 agent 引擎的故障不能等价于平台故障。
- 修复(本次已落地):
  1. `supervise()` 内 try/catch 包裹 `ensureServer`,失败告警并返回 `[]`(调度器回退规则引擎);
  2. `dev-stability-guard.ts` 新增引擎边界分类(`/\b(opencode|omp|codex|dsh) API\b/i`)→ 记录累计次数、不退出;其余真实错误维持致命语义(安全插件 fail-fast 不受影响);
  3. 回归:重启后注入同型故障(server 返回 400 的场景)确认进程存活。
- 回归状态:✅ 通过(见文末回归记录 R-1)

### LIVE-P0-B `[LIVE]` 运行时设置系统启动即降级:`this.map.get is not a function`
- 现象:每次启动 `[system-config] 初始化失败(设置系统降级)`;`PATCH /api/system/settings`、运行时覆盖(备份周期/保留期/DAQ 覆盖)全部失效 —— P0-3"三文件脑裂"修复后的**回归残留**:`loadDescriptorMap()` 返回普通对象(`Object.fromEntries`),`SystemConfigService` 却声明 `Map` 并调 `.get()`。
- 修复:`SystemConfigService.map` 改为 `Record<string, SettingsDescriptor>` 下标访问(`reloadFromDisk`/`patch` 两处)。
- 回归状态:✅ 通过(启动无告警,PATCH 生效,见回归记录 R-1)

## 实测矩阵与结果(逐协议,持续追加)

| # | 项 | 结果 |
|---|---|---|
| R-1 | 修复后冷启动:health 200、settings 正常、引擎故障注入不退进程 | ✅ |
| R-2 | MQTT DAQ 采集(test→采样落库 Timescale→WS 帧) | ✅ matrix-final2 44/44 |
| R-3 | HTTP DAQ 采集 | ✅ 同上 |
| R-4 | Modbus TCP DAQ 采集 | ✅ 同上 |
| R-5 | Modbus RTU(over TCP) DAQ 采集(uint16 形态) | ✅ 同上 |
| R-6 | OPC UA DAQ 采集 | ✅ 同上 |
| R-7 | DCW 读/写闭环:Modbus TCP(PLC 真实链路,SP→PV 物理收敛 rawSP=182/rawPV≈182) | ✅ |
| R-8 | DCW 读/写:OPC UA(写+回读一致) | ✅ |
| R-9 | DCW 写:MQTT(broker 路由审计落盘)/HTTP(POST 落达);MQTT 读=能力外优雅报错 | ✅ |
| R-9b | 配方窗联锁负例(越窗 400) + 写账本 journal | ✅ |
| R-10 | 插件:默认节点图像帧 MinIO 落储+回源(48KB PNG) | ✅ plugin-matrix3 12/12 |
| R-11 | 插件:发现/启用态/自定义模板注册(plug-matrix-profile) | ✅ |
| R-12 | 插件:自定义驱动(连 HTTP 模拟工况)+自定义算法(1.02x+0.5,6/6 样本落补偿值域) | ✅ |
| R-13 | 插件:REST /stats 路由+钩子计数+管理面可见 | ✅ |
| R-14 | 汇总回归:协议 44/44 · 间隔 16/16 · 插件 12/12 | ✅ |

## 附:插件复测揪出的两个平台 bug(已修)

1. **插件热重载永不生效**:`host.mjs` 装载用 `import(pathToUrl(entry))`,ESM 按 URL 缓存 —— disable/enable 重放时命中旧模块,插件改代码必须重启服务端。修复:装载 URL 加 cache-busting(`?t=${Date.now()}`)。
2. **未知帧 kind 静默蒙成 image**:`daq-controller.sampleNode` 对驱动返回的帧信封只判 vector/其它,插件误包 `{kind:'scalar'}` 被当 image 走 blob 管线,在 sink 派生处炸 `undefined.length` 且节点 offline 无样本。修复:非 vector/image 直接丢帧(return null),标量契约 = 裸 number(插件示例已同步修正)。

## 附:采样/查询时间间隔需求(第二轮,2026-09-05)

需求:节点采样间隔用户自定义(默认 5s,下限 1s,全节点独立);Timescale 查询间隔作为参数(默认 15s,下限 1s),产线数据查询卡与 Agent daq_query 均可传。

现状审查:节点 intervalMs 已全链路独立(create/patch/runtime/runtimeDefaults),但默认 1s、下限 120ms;查询 bucketMs 已参数化贯通(samples/lineQuery/daq_query,参数绑定 SQL),但无默认值无下限。

修改(server):daq-controller defaultIntervalMs 5000 + configure/PATCH/create 钳 [1000,60000];daq-node.effectiveInterval 硬下限 1000(存量数据收敛);samples.get.ts 与 lineQuery 缺省 15000 + 钳 [1000,3600000];daq_query 工具同规则;host-tools.json schema 文案。
修改(UI):daq 新建/编辑表单 min=1000 step=500 默认 5000;daq 详情历史桶选项 1s/5s/15s(默认)/30s/1min;产线数据查询卡 bucketMs 默认 15000 min=1000。

场景测试(`scripts/_dbg-interval-scenario.mjs`,生产构建 3001):**16/16 全绿** —— 1s/5s/7s 三节点 60s 样本 58/12/9(独立节拍)、250ms 创建钳到 1000、运行中 PATCH 7s→1s 后 7s 窗口 7 样本、samples/lineQuery 缺省 15s 桶聚合、bucketMs=1000 桶数 65>5、300/500 钳到 1000。

## 附:多 Harness 团队协同 E2E(第三轮,2026-09-05)

- LLM provider 落地:omp=zhipu-coding-plan/glm-5.3-flash、codex=cc-switch/glm-5.3-flash、opencode=zhipuai-coding-plan/glm-5.3-flash、dsh=ustc/glm-5.3-flash(settings.yaml 已加 glm 模型项);USTC 目录无 glm → 按用户规则全线回退 zhipu coding plan 的 glm-5.3-flash。
- `scripts/e2e-multiharness-team.mjs`:mock lead + 4 引擎 worker 同 Channel,绑定 mqtt/http 数采 + opcua/modbus 数控节点。11/18 通过(节点/绑定/任务下发/产线门控全绿);四路任务被 mock lead 停滞检测 CANCELED(引擎 spawn/LLM 连通在 prod:repo 模式下未跑起来)→ **未全绿,遗留**:跨引擎任务执行链路需在引擎可用的环境复跑(与间隔/协议/插件功能无耦合)。

## 环境事实(复测须知)

- 共享机器有并行会话会 killPort/顶替进程:dev server 与模拟器可能被外部击杀;矩阵脚本自带 preflight 自愈(清僵尸锁+唯一实例拉起)。
- Windows 双绑竞态:同一端口残留旧实例会造成"读写分家"(DAQ 读 A 实例/DCW 写 B 实例)——preflight 清场是硬前提。
- 设备模拟器 MQTT 已挪 18830(避开 docker mosquitto 0.0.0.0:1883 的双绑);模拟器已加畸形帧防护+setpoint 路由审计落盘(`.AgentWorkShop/data/sim-setpoint-routes.log`)。
- 生产实例(3001)安全插件拒启种子默认密码属正确行为;种子密码已轮换并存档 `.AgentWorkShop/data/seed-credentials.txt`。
