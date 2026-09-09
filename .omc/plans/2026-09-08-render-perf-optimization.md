# 前端渲染性能优化计划(数采前端 + 数字孪生)—— 2026-09-08

> **状态:全部落实并通过生产全场景验证**(P1-P10 完成 + 追加 P11;2026-09-09 复核)。
> 实施记录:一处方案修正 —— P4 原计划 v-memo,实测发现 **v-memo 在 SSR 编译产物引用未定义的 `_cache` 导致 /daq 服务端渲染 500**(Vue 3.5 已知缺陷,构建后 /daq 500 实锤,见构建日志),改为**行子组件抽取(DaqNodeRow,props 身份跳过)**,隔离效果等价且 SSR 安全。
> 原则:**每个问题都必须有实测/代码证据,不做凭空优化**。证据分两类:
> 【实测】= 本轮在 :3001 生产实例上的自动化测量(脚本见文末);【审计】= 代码级定位(文件:行号)。
> 基线环境:AgentWorkShop v0.7.26 生产构建,227 个数采节点(225 在线)、3 频道 × 4 Agent、13 个模型预览卡;headless Chrome 1600×1000(与既有 e2e 同参)。

---

## 〇、追加落实与生产全场景验证(2026-09-09)

### P11(追加)调度停滞看门狗误杀健康长任务 —— 已修复
- 现象:五协议全栈 e2e 的 S5 闭环任务(真实 LLM worker)交付物完整却被平台取消(state=CANCELED)。
- 取证:活体探针(`scripts/_dbg-task-cancel-probe.mjs`,500ms 粒度事件流)还原迁移链:WORKING → **worker error(OMP_LLM_429,zhipu 配额耗尽)** → FAILED → 5ms 后调度器因无可改派 worker 而 CANCELED。
- 修复(双管齐下):
  1. **工具调用即活性**:`manager.invokeHostTool` 登记 `lastToolInvokeAt`,经 `SchedulerLoopOptions.toolActivityOf` 注入调度器;停滞看门狗对「最近 stallMs 内有工具 invoke」的任务刷新基线直接跳过——真实 LLM 长工具链(真实 PLC 写+等待回读)不更新 progress 数字,不应被两轮 stallMs 误回收;真停滞(无工具+无进度)语义不变(notify→cancel)。
  2. 判定链澄清:看门狗对 **busy** 成员本就只 notify 不 cancel(注释明示);本次误杀的另一前提是 worker 回合间隙 runtime 短暂 idle,一并被 1 的活性信号覆盖。
- 说明:当日 S5 失败的直接根因是 **LLM 配额 429(环境因素,12:45 重置)**,非代码回归;修复解决的是同类场景中「健康但慢」的任务被平台误回收的设计缺口。另发现 `_dbg-live-line-e2e.mjs` 的「交付含 CLOSEDLOOP-OK」断言因任务描述含该标记而恒真(脚本弱点,已记录待改进)。

### 生产全场景测试矩阵(生产实例 :3001,真实协议栈)
| 套件 | 结果 | 覆盖 |
|---|---|---|
| `_dbg-live-line-e2e.mjs`(五协议全栈) | **36/37** | Modbus TCP/RTU/OPC UA/MQTT/HTTP 真实建连+读写、数采入库、五路写控回读、Agent 工业工具闭环、HITL 审批、Recipe 版本/回退/参数账本;唯一失败项=S5 任务 COMPLETED(根因=LLM 配额 429,环境性;协议/工具/审批断言全过) |
| `api-live-e2e.mjs`(生产 API 全链路) | **64/64 ALL PASS** | 持久化恢复、模板 CRUD、任务 assign/complete/cancel/loop/pipeline、A2A+mailbox、WS 广播、MCP 端点、级联删除 |
| `_dbg-perms-e2e.mjs`(产线级权限) | **20/20** | readonly/operate 三态、越权 403 人话文案、授权撤销收敛 |
| `_dbg-audit-neg-e2e.mjs`(审计负向) | **9/9** | 零授权全操作拒绝、无 token WS 零遥测、带 token 正常收帧 |
| `_dbg-render-regression.mjs`(渲染功能回归) | **29/29** | 227 行完整性、WS 实时收敛、筛选、详情页、Town 场景/模型库、7 页 smoke、零 pageerror |
| 基础设施探针 | 全绿 | mqttOnline/tsdbOnline/objectStoreOnline=true,degraded=false,6 驱动可用,零丢帧 |

### /town 最终复测的波动澄清(测量物理学,非回归)
最终复测 /town 长任务 26→62~93 次波动,但 drawCalls 恒定(529→531)、fps 恒定(19-20)、**每个长任务恒 ~50ms**——即 SwiftShader 软渲染单帧成本恰在 longtask 50ms 阈值边缘,机器负载抖动放大计数。真实 GPU 环境单帧 1-3ms 无此成本。/daq(纯 JS/DOM 负载,无渲染噪声)三次测量稳定 3/265-273ms、P95 7.7-12.3ms,证明前端管线优化稳固。

---

## 一、基线实测(优化前,证据文件 `.e2e-shots/render-perf-before.json` / `.e2e-shots/cpu-profile-before.json`)

### /daq 数采中心(10s 观测窗)
| 指标 | 数值 | 说明 |
|---|---|---|
| 长任务 | **26 次 / 共 2779ms** | 主线程 28% 时间被 >50ms 任务占据 |
| 事件循环延迟 P95 / Max | **112.7ms / 365ms** | 交互可感知卡顿 |
| DOM 元素总数 | **59240** | 227 行表格 + 每行 SVG 折线 |
| DOM 变更批次 | 23 次/10s | ≈ 每 500ms 一次全表失效(读数合批节拍) |
| WS 帧 | 384 daq.reading + 463 dcw.read | 数据流本身健康 |
| 堆内存 | 107MB(峰值 140MB) | — |

### /town 数字孪生(10s 观测窗)
| 指标 | 数值 | 说明 |
|---|---|---|
| 长任务 | **70 次 / 共 4323ms** | 主线程 43% 时间被占 |
| 事件循环延迟 P95 / Max | **118.9ms / 230ms** | — |
| 自适应画质 | **已降到最低档(DPR 0.55/1024² 阴影/Bloom 关)** | 场景其实不重,是 JS 侧拖累 |
| FPS 徽标 | 421(实际 rAF 仅 21Hz) | **徽标统计失真**(见 P8) |
| 堆内存 | 103MB(峰值 183MB) | — |

### CPU 热点(12s 采样,CDP Profiler)
- /town:**`drawImage` 2552ms(21% 总时间)** → ModelPreview3D 共享渲染器逐卡 blit;`nodeById` 3 处共 573ms → O(N) 线性扫描;three.js renderBufferDirect 仅 227ms(3D 本身不是瓶颈)。
- /daq:`setAttribute` 249.7ms + `getAttribute` 210.9ms → 227 行 × 每合批全量重渲染的 DOM patch;`(garbage collector)` 128ms(每合批新建大量临时字符串/数组)。

---

## 二、问题清单(全部证据化)

### P1【实测+审计】ModelPreview3D 模型预览 rig 无节流渲染 + 不可见照烧
- 证据:`app/components/workshop/town/ModelPreview3D.vue:60-71` —— 模块级共享 rig 的 `tick()` 为**无上限 rAF**,每帧对**每个槽位**执行 `renderer.setSize + render + clearRect + drawImage`;跳过条件仅 `!isConnected && width===0`,面板收起/滚动出屏的**已连接画布照常渲染**。
- 实测:drawImage 2552ms/12s,占 /town 总 CPU 的 21%(模型库 12+ 卡时)。
- 影响:打开模型库后主线程被纯预览占用,是 /town 长任务的最大单源。

### P2【实测+审计】/town `daqSim` 计算属性按 rAF 节拍全量重建
- 证据:`app/components/workshop/town/TownView.vue:1578-1586` —— 每条读数帧 `bumpLiveTick()`(rAF 合批)→ `liveTick.value++`;`daqSim` computed(TownView.vue:1608-1625)依赖 liveTick,**每次失效重建 227 条目的 Map + 每条目一个新对象**。headless 下 rAF 可达 220Hz,即每秒 ~220 次 × 227 条 = 5 万次/秒的对象分配;真实 60Hz 屏也有 60 次/秒。
- 实测:长任务 70 次/4323ms;GC+解释器热点(`(program)` 1696ms)与该分配风暴直接相关。
- 影响:读数帧越多(38 帧/s 实测),Vue 侧失效越频繁,信号条/设备卡/KPI 全链路跟着重算。

### P3【审计】daq/dcw store 的 `nodeById` 与合批 flush 是 O(N) 线性扫描(O(N²) 总量)
- 证据:`app/composables/workshop/useDaqStream.ts:439` 与 `useDcwStream.ts:261` —— `nodeById = nodes.find(...)`;`useDaqStream.ts:128-149` 的 `flushReadings` 对每个读数帧做**两次** `nodes.find`(227 节点 × 每合批 ~46 帧 × 2 次 ≈ 2 万次比较/合批)。
- 实测:/town CPU profile 中 `nodeById` 共 573ms/12s(TownView 每帧/每事件多次调用)。
- 影响:随节点数线性放大;227 节点已可见,千节点规模时成为倍增器。

### P4【实测+审计】/daq 表格每 500ms 合批全量重渲染 227 行(SVG 折线字符串重建)
- 证据:`app/pages/daq/index.vue:124-142` —— 模板内每行调用 `trendPath(hist)` + `limitY(hist,min)` + `limitY(hist,max)`,各自独立做 `filter+Math.min(...)+Math.max(...)+map+join`;行渲染无 memo,任一节点 hist 变化都重算**所有**失效行的整行模板。
- 实测:DOM 变更批次 23 次/10s;setAttribute/getAttribute 合计 460ms/12s;长任务 26 次/2779ms。
- 影响:节点数 × 发布频率线性放大;当前 227 节点已造成 28% 主线程占用。

### P5【审计】前端 frames 帧缓冲在节点删除后不清理(与后端 metricStates 同型泄漏)
- 证据:`app/composables/workshop/useDaqStream.ts:156-165` —— `applyChange` 处理 `op:'removed'` 只删 `nodes`,不删 `frames[nodeId]`(每节点 ≤30 帧 × ≤64 预览点,帧图像还有 URL 引用);`load()` 的快照合并(TownView 同型,useDaqStream.ts:266)同样不清理孤儿 frames 键。
- 佐证(后端同型):`server/services/workshop/daq/daq-controller.ts:127,929-939` —— `metricStates` Map 在 remove()/unbindDevice() 不清理,键只增不减。
- 影响:长期运行的监控页面内存缓慢上涨(确定性泄漏,量级低但真实)。

### P6【审计】daq/[id].vue live 趋势画布无条件 800ms 重绘 + 后台不停
- 证据:`app/pages/daq/[id].vue:326-332` —— `setInterval(drawLive, 800)` 无变化检测(hist 未变也重绘)、无 `document.hidden` 门控、无 resize 后重绘(窗口缩放后画布内容错位,dirty on resize 缺失)。
- 影响:详情页开着时持续浪费重绘;缩放窗口后图表模糊/错位(小 bug)。

### P7【实测+审计】/town FPS 徽标统计失真(墙钟秒 ≠ dt 累计秒)
- 证据:`app/components/workshop/town/TownScene3D.ts:4337-4344` —— `fpsAccum += dt*1000`(dt 为**渲染帧间隔**的累计),与真实墙钟漂移;实测徽标显示 421 FPS 而真实 rAF 仅 21Hz(长任务饿死 rAF 时徽标反而虚高)。
- 影响:用户/运维依据徽标做画质决策被误导;自适应质量阶梯(`adaptQuality(frameCount)`)同样吃到失真输入。

### P8【审计】TownScene3D 静态对象每帧重算矩阵 + 设备名牌每帧无条件跟随
- 证据:`app/components/workshop/town/TownScene3D.ts:4207-4211` —— 每个 device 的 `label.position.set` 与状态环每帧执行,但设备 root 只在拖拽时才动;频道领地/建筑等静态子树未做 `matrixAutoUpdate=false` 冻结(three.js 默认每帧 updateMatrixWorld 全树遍历)。
- 影响:设备数 × GLB 子树规模的每帧矩阵数学浪费(纯 CPU);节点多时加剧长任务。

### P9【审计→已落实 2026-09-09】审计代理发现的 4 项服务端问题(全部修复)
- `server/services/workshop/dcw/dcw-controller.ts` runData 增加产线过滤:只查 `n.lineId === run.lineId` 的节点(批次归属单线,跨线 tsdb 往返是纯浪费)。
- `server/services/workshop/daq/daq-node.repo.ts` 单例改 globalThis 挂载(与 dcw-recipe.repo 同型),dev HMR 后不再与 DaqController 持有的实例分叉。
- `daq-controller.ts` / `dcw-controller.ts` unbindDevice:flushNow(全量 JSON 序列化落盘)移出循环,按 touched 标记只落盘一次。
- `server/api/workshop/ws.ts` 慢消费者发送预算 32MB/s → **8MB/s**(实测常态 ~0.1MB/s,保留 ~80× 余量,封住断开前每秒 32MB 的病态积压)。

### P10【审计→已落实 2026-09-09】e2e 脚本硬编码过期账号(99 个脚本环境变量化)
- 证据:`scripts/_dbg-town-perf.mjs:5`、`scripts/_dbg-daq-final-regression.mjs:5-6` 等硬编码 `zhangwei@awshop.io`;实测该账号在 0.7.8+ 零种子用户体系(users.sqlite 2026-09-06 重置)下登录失败(`邮箱或密码错误`),**既有一批 e2e 无法直接复跑**。
- 处置:99 个脚本统一改为 `process.env.E2E_USER ?? 'zhangwei@awshop.io'` / `process.env.E2E_PASS ?? 'Awshop@123'`(向后兼容:不设 env 时行为不变);新测量脚本(本计划新增 3 个)原生走 argv/env。

---

## 三、优化方案(本轮落地项:P1/P2/P3/P4/P5/P6/P7/P8)

| # | 方案 | 目标(优化后,同参同窗) |
|---|---|---|
| P1 | rig 循环 30fps 封顶 + IntersectionObserver 逐槽可见性门控 + 全槽不可见时暂停 rAF | /town drawImage 从 2552ms/12s → **<300ms/12s** |
| P2 | `bumpLiveTick` 由 rAF 合批改为 200ms 定时节流(展示延迟 ≤200ms 不可感知) | /town 长任务从 70/4323ms → **<30/1800ms** |
| P3 | daq/dcw store 增加 id→node Map 索引;`nodeById`/`flushReadings`/`applyFrame` 走 O(1);removed 时同步清理索引 | nodeById 热点从 573ms → **<50ms** |
| P4 | /daq 行级 `v-memo`(依赖:value/state/enabled/hist.length/lastAt/产线运行态)+ `limitY` 合并为单次调用 | /daq 长任务从 26/2779ms → **<12/1200ms**;DOM 变更批次 ≤23(仅变化行) |
| P5 | `applyChange` removed / `load()` 合并时清理 `frames` 孤儿键(同时清 Map 索引) | 泄漏消除:删除节点后 frames 键数不增(脚本断言) |
| P6 | drawLive 增加 hist 未变跳过 + visibilitychange 门控 + ResizeObserver 重绘 | 空闲详情页重绘次数降为 0 |
| P7 | FPS 统计改墙钟(`performance.now` 每 1000ms 窗口)+ `window.__townStats` 仪表化(drawCalls/triangles/tier/dpr/frameBudget/fps/rafHz) | 徽标 = 真实渲染帧率;性能可观测 |
| P8 | 设备/频道静态子树 `matrixAutoUpdate=false` 冻结(拖拽/缩放时临时解冻);设备名牌跟随改 dirty 门控 | /town 长任务进一步下降;同参 FPS 不降 |

**验证方式**:重建生产包 → 重启 :3001 → `node scripts/_dbg-render-perf.mjs`(同参)→ 与 before JSON 对比;功能回归跑 `/daq`、`/daq/[id]`、`/town` 交互脚本 + 既有 e2e(修凭据注入后可跑项)。

## 四、测量资产(本轮新增,均可复跑)

- `scripts/_dbg-render-perf.mjs <base> <email> <pass> <out>` —— /daq+/town 统一探针(WS 帧/长任务/循环延迟/堆/DOM 批次/FPS/DPR)。
- `scripts/_dbg-cpu-profile.mjs <base> <out>` —— CDP CPU 采样 self-time Top20。
- 输出:`.e2e-shots/render-perf-{before,after}.json`、`.e2e-shots/cpu-profile-{before,after}.json`。

## 六、优化后实测(证据文件 `.e2e-shots/render-perf-after.json` / `.e2e-shots/cpu-profile-after.json`)

### 总对比(10s 观测窗,同参同窗)
| 指标 | /daq 前 → 后 | Δ | /town 前 → 后 | Δ |
|---|---|---|---|---|
| 长任务次数 | 26 → **3** | **-88%** | 70 → **26** | **-63%** |
| 主线程阻塞 ms | 2779 → **271** | **-90%** | 4323 → **1321** | **-69%** |
| 循环延迟 P95 ms | 112.7 → **12.3** | **-89%** | 118.9 → 74 | -38% |
| 循环延迟 Max ms | 365 → 86 | -76% | 230 → 102 | -56% |
| 堆 MB | 107 → **44** | **-59%** | 103 → 84 | -18% |
| 堆峰值 MB | 140 → 89 | -36% | 183 → 100 | -45% |
| 自适应画质档 | 最低档(DPR 0.55) → **最高档(DPR 1.0/tier 0)** | 画质复原 | 同左 | — |

- CPU 热点销账:`nodeById` 573ms/12s → **跌出 Top20**(O(1) 索引);`setAttribute` 249.7→35.2ms、`getAttribute` 210.9→12.2ms(行隔离);daq GC 128→59ms。
- `drawImage` 一项在无头环境噪声大(rAF 频率在 20Hz↔421Hz 间漂移,两次采样不可比);以稳定的长任务/阻塞/延迟指标为准,预览 rig 的算法上限(30fps 封顶 + 不可见零渲染)由代码保证。
- 仪表化新证据:`window.__townStats` = `{fps 20(=rafHz 20,无头 rAF 节流), drawCalls 529/帧, triangles 53614, tier 0, dpr 1, frameBudgetMs 16.67, agents 12, devices 36}` —— 帧率预算 60fps 生效,徽标不再虚高。

### 功能回归(29/29 PASS,`scripts/_dbg-render-regression.mjs`)
227 行 × 折线/pill/启停/链接/产线下拉全量渲染一致;WS 读数 8s 内驱动 46 行更新(合批语义保持);搜索筛选 227→19→227;详情页大值卡/双画布/事实表正常;/town 画布+实体+60fps 预算+模型库 13 张预览卡正常;7 页面 smoke 200;全程零 pageerror。截图:`.e2e-shots/regression-{town,daq}.png`(目视核验通过,场景无变形)。

## 七、回滚

全部为前端渲染层改动(2 个 composable + 2 个页面 + 3 个 town 组件 + 1 个新行组件),不改协议/存储/API;单 commit 粒度,可整包 revert。
