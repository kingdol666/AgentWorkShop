# 计划:全链路错误响应与回退机制(前后端交互/失败可见性/Agent 工具反馈)

- 状态:**pending approval**(待用户批准后执行)
- 日期:2026-08-31
- 范围:前端 API 消费层统一、静默失败清零、失败内容可视化、Agent 工具错误反馈强化
- 原则:后端信封已优秀(零后端破坏性改动);前端做收敛而非重写;高风险路径小步迁移逐个验证

---

## 一、需求摘要(用户原话映射)

| 需求 | 对应缺口 |
| --- | --- |
| 前端能得到后端的反馈 | 四个流式 composable 手写 fetch,业务码/HTTP 状态丢失(G1) |
| 执行失败把失败内容展示出来 | FAILED 任务卡片只有状态标签无原因(G8);部分加载失败被静默吞掉(G2) |
| Agent 工具调用失败让 Agent 知道 | 工具层已优秀(isError+可行动文案),补瞬时失败重试提示(G5) |
| 完整的错误响应和回退机制 | 重试只存在于 useSceneLayouts 一处(G3);网络错误裸文案(G4) |
| 优秀项目架构 | 双 HTTP 层并存($http axios vs 手写 fetch)收敛为单一客户端(G1) |

## 二、审计结论(现状证据,全部 file:line 实证)

### 已优秀的部分(保持,勿重写)
- 后端统一信封:`server/utils/response.ts:24-52` defineApiHandler(AppError→HTTP 状态+业务码;未捕获→500+服务端日志)
- 业务错误消息可行动性典范:越窗拒绝带配方名与窗口(`server/api/workshop/dcw/[id]/write` 实测"设定值 500℃ 超出当前配方「A-标准工艺」的工艺上限 188℃")
- Agent 工具错误语义:`server/services/workshop/agents/industrial-tools.ts:49-80` {text, isError:true} + 死绑定自清理 + 待审批去重
- 回退黄金标准:`app/composables/workshop/useSceneLayouts.ts:127-152` res.ok 校验 + 3 次退避重试 + store.error + loaded 门控(注释记录了历史事故"401/500 空 layouts 让整场频道消失")
- WS 可靠性:`app/composables/workshop/useWorkshopWs.ts:34-64` lastSeq 续传 + 重连对齐"同步中"提示

### 缺口清单(G1-G8,按严重度)

| # | 缺口 | 证据 |
|---|---|---|
| G2·高 | **静默失败**:useDeviceTwins.load 不校验 res.ok/code,服务端 500 被当作"空设备列表"且 error='' | `app/composables/workshop/useDeviceTwins.ts:86-96`(`json?.data?.twins ?? []` 直落,loaded=true) |
| G2·高 | setNodeLine/setNodeDevice(/daq 行内产线/设备换绑)无 try/catch,失败静默且 Promise 未处理拒绝 | `app/pages/daq/index.vue:25-38` |
| G1·高 | 双 HTTP 层并存:$http axios 插件(带 401/5xx toast 拦截器,`app/plugins/http.ts:31-52`)vs 四个流式 composable 手写 fetch(`useDaqStream.ts:64-79`/`useDcwStream.ts:14-29`/`useDeviceTwins.ts:65-72`/`useSceneLayouts.ts:41-49` 的 headers() 五处复制);手写层 throw 通用 Error,业务码/HTTP 状态丢失 | 同左 |
| G4·中 | 网络层错误裸奔:fetch TypeError("Failed to fetch")直出用户界面,不可读 | api 助手无网络错误映射 |
| G3·中 | 重试策略只有 useSceneLayouts 一处;dev 冷启动/undici 首编译瞬态 fetch failed 直击用户 | `useSceneLayouts.ts:129-146` 是唯一实现 |
| G8·中 | FAILED 任务卡片/检查器只显示状态标签"失败",**失败原因文本(历史末条错误)无处展示** | `components/workshop/blocks/ClusterTask.vue:56,72`、`TaskBoardView.vue:48` |
| G6·低 | WS 断线"同步中"提示仅 /town 状态条有;/workshop 等页无全局连接指示 | `useWorkshopWs.ts:58-64` 模式未复用 |
| G7·低 | 未匹配路由的 404 是 h3 原生信封(无业务 code,实测 `{"message":"Page not found: ..."}`),与业务信封形状不一致 | 探针实测 `/daq/dn-notexist/write` |
| G5·低 | Agent 工具错误已含建议动作;Modbus 链路忙(409)文案可补"稍后重试"提示 | `industrial-tools.ts`(连接级队列已缓解,属锦上添花) |

## 三、实施步骤(四阶段,每阶段独立可验证)

### P1 统一 API 客户端(地基,~0.5 天)
1. 新建 `app/composables/workshop/apiClient.ts`:
   - `class ApiError extends Error { code: string|number; status: number }`(保留业务码与 HTTP 状态)
   - `apiFetch<T>(opts: { base: string, path: string, init?: RequestInit, retries?: number }): Promise<T>`:
     - 校验 `res.ok` + 信封 `code === 0`,否则抛 ApiError(message 取信封 message)
     - 网络 TypeError → ApiError(code='NETWORK', message='无法连接服务器,请检查网络或服务状态')
     - 幂等 GET 自动重试 2 次(400ms/800ms 退避);POST/PATCH/DELETE 不重试
2. 迁移四个 composable(useDaqStream/useDcwStream/useDeviceTwins/useSceneLayouts)到 apiFetch,**保持各自 store.error/loaded 对外契约不变**(行为兼容,分 composable 小步提交)
3. `headers()` 收敛进 apiClient(消除五处复制)

### P2 静默失败清零(~0.5 天)
1. `useDeviceTwins.load`:`!res.ok || code!==0` → store.error + loaded=false(对齐 useSceneLayouts 标准)
2. 全库扫描 `.catch(() => ({}))` 与空 catch(`grep -rn "catch () => {}\|catch {}" app/`),逐处判定:该 surfaced 的接 store.error/message.error,确属尽力而为的保留并注释
3. `/daq` setNodeLine/setNodeDevice 包 try/catch → `message.error($t('daq.换绑失败', { msg }))`(新词条 zh/en)
4. 加载失败但存在旧数据时,面板顶部显示「数据截至 <最后成功时刻>」陈旧标记(useDaqStream 已有 store.error 挂点,/daq:954 的 a-spin 条件同步调整)

### P3 失败内容可视化(~1 天)
1. FAILED 任务展示失败原因:`ClusterTask.vue` 卡片在 state=FAILED 时从 `task.history` 尾部取最后一条非 worker 文本渲染为单行错误摘要(ellipsis+title 全文);`TaskInspectorDrawer` 显示完整错误与时间
2. 全局连接指示:把 `useWorkshopWs` 的连接状态(connected/syncing/disconnected)提升为共享 store,`AppHeader.vue` 右侧加 3px 状态点(tooltip 说明;断开时红色)
3. Nitro 层:新建 `server/plugins/envelope-404.ts`(或 errorhandler)把 h3 原生 404/500 包装为 `{code:'NOT_FOUND'|'INTERNAL_ERROR', message, data:null}` 信封

### P4 Agent 工具反馈强化(~0.5 天)
1. `industrial-tools.ts` 链路忙(409)文案追加「链路忙,请稍后重试」建议
2. dcw_control 回读不一致/失败文案统一追加「当前设定值保持 <原值>,可缩小步进后重试」(Agent 可据此自我纠正)
3. (评估项)Modbus 瞬时 busy 在 dcw write 内自动单次重试——连接级队列已缓解,实测若 <1% 失败率则不加,避免重复写

### P5 验证(~0.5 天)
1. 新建 `scripts/test-api-client.ts`:envelope 解析/ApiError 字段/GET 重试计数(假 fetch)/网络错误映射 单测
2. 新建 `scripts/_dbg-error-probe.mjs`:固化五个线上探针(401/400/404/越窗/越权),断言信封形状与消息非空
3. 静默失败回归:临时以 401 token 请求 device-twins → 断言 store.error 非空且 UI 呈现错误(非空列表)
4. 全量回归:既有 smoke/test-task-engine/test-scheduler-loop/town 回归脚本 + `npx nuxt build`

## 四、验收标准(可测试)

1. `grep -rn "function headers" app/composables/workshop/` 仅 apiClient.ts 一处
2. apiFetch 对 500 响应抛 `ApiError{code:'INTERNAL_ERROR', status:500}`;对断网抛 `ApiError{code:'NETWORK'}`(单测断言)
3. GET 首失败次成功时调用计数 = 2(重试生效);POST 永不重试(单测断言)
4. device-twins 模拟 500 → 页面显示错误横幅、设备列表不清空(对比修复前的空列表)
5. /daq 行内换绑失败 → antd message 错误提示弹出且含后端 message
6. FAILED 任务卡片渲染最后一条错误摘要文本(用注入 history 的 fixture 断言)
7. 探针脚本 `_dbg-error-probe.mjs` 全部 PASS;全部既有回归脚本无回归;`npx nuxt build` 成功
8. 现有功能零行为回归:phase1-3 场景脚本(产线/孪生/Agent)复跑结论不变

## 五、风险与缓解

| 风险 | 缓解 |
| --- | --- |
| 迁移触碰高频加载路径引入回归 | store 对外契约(error/loaded/rev)不变;逐 composable 独立提交;每步跑对应回归脚本 |
| GET 重试放大请求 | 仅幂等 GET;上限 2 次;400ms 起退避 |
| WS 状态 store 全局化引入重渲染 | 状态点用独立小 store + computed 采样,不进高频路径 |
| 404 包装影响既有前端对 h3 404 的判断 | 包装后 message 形状不变,仅补 code 字段;前端无按 message 文本判断的逻辑(grep 核实) |
| 另一会话未提交工作(TownScene3D bloom)并存 | 本计划不动 TownScene3D;提交时按文件甄别 |

## 六、验证步骤(落实时逐条执行)

1. 每阶段:eslint 改动文件 0 错误 → 对应回归脚本 → build
2. P1 后:`grep -rn "headers(" app/composables/workshop` 单源确认;daq/dcw 页全功能手测
3. P2 后:401/500 模拟探针(deviceTwins)断言错误可见
4. P3 后:注入 FAILED fixture 断言卡片错误摘要;AppHeader 状态点断线模拟
5. 全部完成后复跑 `_dbg-scenario-phase1/2/3.mjs` 确认端到端链路无回归
