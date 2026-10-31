---
name: aw-plugin-dev
description: AgentWorkShop 插件开发手册 skill。当需要为平台开发、修改、调试、热加载或发布插件(服务端钩子/API 路由/Agent 工具/数采读驱动/写控驱动/解码器/下沉处理器/节点模板/混合孪生 Provider)时使用。覆盖 index.mjs 契约、ctx 全表面、DAQ/DCW 驱动接口、解码器与处理器、模板注册、热重载、测试与导出验收、安全红线。触发词:插件开发、自定义协议、自定义驱动、解码器、下沉处理器、registerDriver、热加载、插件发布。
---

# AgentWorkShop 插件开发手册

> 权威契约在 `docs/plugins.md`(§二 入口、§六 ctx 全参考、§十三 发布清单)与 `sdk/index.mjs`;本 skill 是开发流程、接口选择与验收口径。示例以实现为准:`server/plugins-builtin/serial-bridge/index.mjs`(读+写驱动)、`.AgentWorkShop/plugins/aw-matrix-plugin/index.mjs`(驱动+处理器+模板+工具)。

## 先读契约再动手

- `docs/plugins.md` §二:manifest 字段与装载校验;§六:ctx 每个方法;§十三:发布前清单。
- `sdk/index.mjs` 导出 `definePlugin/createPluginContext/validatePluginModule`;类型见 `sdk/index.d.mts`。
- 驱动接口以代码为准:`server/services/workshop/daq/drivers/shared.ts`(读)、`server/services/workshop/dcw/drivers/shared.ts`(写)、`server/services/workshop/daq/decoders.ts`、`server/services/workshop/daq/frames.ts`。

### 0. 生产安全与装载位置

先跑 `node scripts/onboarding/preflight.mjs --json`;已运行实例一律按生产对待,不重启、不杀进程。

| 位置 | 生效 | 生产可用 |
| --- | --- | --- |
| `.AgentWorkShop/plugins/aw-matrix-plugin/`(project) | 状态文件变化 → ~1s 全量重载 | 是 |
| `~/.AgentWorkShop/plugins/<name>/`(user) | 同上 | 是 |
| `server/plugins-builtin/`(builtin) | entry 随状态文件重载;helper 模块可能被 ESM 缓存,builtin 优先级遮蔽 project 同名副本 | 验证后仍不确定 → 维护窗口 |

保存代码**不会**自动触发重载(宿主只监听 `plugins-state.json`);保存后 `aw_plugin_toggle`(或触碰状态文件)一次即可,不要为了生效重启进程。

### 1. 选择扩展面

| 需求 | 接口 | 说明 |
| --- | --- | --- |
| 新传输协议(读) | `ctx.daq.registerDriver(driver)` | 注册任意 kind;前端表单来自 `meta.configFields` |
| 新传输协议(写) | `ctx.dcw.registerWriteDriver(driver)` | 与读驱动对称;ack 分级 |
| 私有报文 → 标量/向量/图像 | `ctx.daq.registerDecoder(name, fn)` | 同步纯函数;优先于声明式路径 |
| 向量/图像后处理 | `ctx.daq.registerProcessor(kind, name, fn)` | **只对 vector/image 帧执行** |
| 新节点模板 | `ctx.daq.registerTemplate(def)` | 含 `sink.processors`/`metrics`;内存态 |
| Agent 工具 | `ctx.omp.registerTool({name,...})` | 同步进 tool_registry |
| 平台 API | `ctx.route(method, path, handler)` | 挂 `/api/plugins/<name><path>`,精确匹配 |
| 浏览器增强 | `client.mjs` + `ctx.ui.registerPanel` | 见 docs/plugins.md §八 |
| 新数据形态(text/file/音频) | **核心扩展,不是插件面** | 需改 `shared/daq-protocol.ts`、`drivers/shared.ts`、`frames.ts`、`daq-controller/*`、`storage/*`、API/UI |

判断顺序:声明式路径(`jsonPath/pointsPath/imagePath/fields`)→ 解码器 → 读/写驱动 → 核心扩展。每往下一层,回归面更大。

### 2. 入口契约与 ctx

`index.mjs` 默认导出普通对象,零导入依赖:

```js
export default {
  name: 'my-plugin',            // 必填,全局唯一
  version: '1.0.0',
  description: '…',
  auth: 'user',                 // none|user|admin|agent-or-user
  client: './client.mjs',       // 可选
  settings: [ /* {key,type,default,label} */ ],
  configGroups: [ /* {id,label} */ ],
  routes: [ { method: 'GET', path: '/health', handler: () => ({ ok: true }) } ],
  async setup(ctx) { /* 注册驱动/处理器/模板/工具/路由/钩子 */ },
}
```

ctx 关键面:`logger`、`kv.get/set/all/bump`、`config.get/all/onChange`、`timer.setInterval/setTimeout`、`onDispose/subscriptions`、`route`、`api`(平台 REST 客户端)、`http.get/post`(出站,SSRF 守卫)、`events.on`、`daq`、`dcw`、`omp`、`services`、`twin`、`permissions`、`paths/dataDir`。完整表见 `docs/plugins.md` §六;常用细节在 `references/plugin-ctx-api.md`。

### 3. DAQ 读驱动

```ts
interface DaqDriver {
  readonly kind: string
  available(): Promise<boolean>
  sample(input: DaqDriverInput): Promise<number | DaqFrameSample | null> | number | DaqFrameSample | null
  test(cfg: Record<string, unknown>, signalKind?: 'scalar'|'vector'|'image'): Promise<DriverTestResult>
  subscribe?(input: DaqPushInput): Promise<() => void | Promise<void>>
  fingerprint?(cfg: Record<string, unknown>): string
  meta?: { label: string; status: 'builtin'|'real'|'planned'; configFields: DriverConfigField[] }
}
```

- 标量直接返回 `number`;数组/图像返回 `{ frame: { kind:'vector', points, metrics? } }` 或 `{ frame: { kind:'image', blob, mime, width, height } }`。
- `sample` 抛错 → 节点 `lastError` 可见;不要返回假值/0 掩盖故障。
- 实现 `subscribe` 后按事件驱动采集,不再轮询;返回的 stop 必须幂等。`fingerprint` 用于凭据/主题变化时重建订阅。
- `meta.configFields` 决定前端“添加节点”下拉与表单;没有 meta 的驱动只能出现在可用性里,不能出表单。

完整签名、帧限制与推送语义见 `references/daq-dcw-driver-contract.md`。

### 4. DCW 写驱动

```ts
interface DcwWriteDriver {
  readonly kind: string
  available(): Promise<boolean>
  write(input: DcwWriteInput): Promise<DcwWriteResult>
  test(cfg: Record<string, unknown>): Promise<{ ok: boolean; message: string }>
  read?(input: DcwReadInput): Promise<DcwReadResult>
  canRead?(cfg: Record<string, unknown>): boolean
  fetchHistory?(input: DcwFetchHistoryInput): Promise<DcwFetchHistoryResult>
}
```

- `write` 必须返回 `ack`:`readback-verified` / `transport-ack` / `unverified`;网关据此分级,不要冒充。
- 有回读通道就实现 `read` + `canRead`;没有就如实返回“不支持读取”,避免每 5s 一条噪音。
- `fetchHistory` 用于 MES/历史 API:行格式 `scalar/vector/image/table/event`,分页游标 `nextCursorPath` 必须配。
- 工程量↔原始值换算用 `shared.ts` 的 `engToRaw/rawToEng/readbackAck`,不要自己重写。

### 5. 解码器、处理器、模板

- 解码器:`(input: {raw, bytes, json, config, signalKind, nodeId}) => {kind:'scalar'|'vector'|'image'}`;必须同步纯函数;形态必须与模板 `signalKind` 一致。
- 处理器:`{ name, applies:'vector'|'image'|'any', process(frame,args) }`;执行点是 `runSinkPipeline`,只在帧采样路径调用。注册 `'scalar'` 会被映射成 `'any'`,**不会处理标量样本,反而会跑在 vector/image 帧上**;标量加工写在驱动/解码器里。
- 模板:`ctx.daq.registerTemplate({key,name,unit,min,max,signalKind,vector?,sink?,metrics?})`;插件模板是内存态,REST 不可改;停用/重载**不会**自动清退模板(当前代码缺口),需要维护窗口重启或换 key。

### 6. 热加载与生效验证

1. 写文件 → 保存(**保存本身不触发重载**,宿主只监听状态文件)。
2. `aw_plugin_toggle { name, enabled: true }` 或触碰 `<home>/plugins-state.json` 触发重载(ESM `?t=` 破缓存),约 1s。
3. `aw_plugin_list` 确认插件出现、`failures=[]`。
4. 实测驱动:用 `aw_request GET /api/workshop/daq` 看 `drivers[]` 是否出现该 kind(带 `plugin:true`);路由 `GET /api/plugins/<name>/health` 可访问;钩子计数增加。
5. 改一行行为再 toggle,确认热重载真的生效;不要用重启“试试看”。

建节点(`aw_daq_create`)/写参数返回 400 先看 `message` 定位字段;401 是鉴权/产线权限;409 是重名/在飞写/单实例锁;超时先确认实例是否被其它作业占用,不要重启。

内置插件改动:entry 会随状态文件重载,但 helper 模块可能被 ESM 缓存;验证不生效时走维护窗口,不要在生产重启。

### 7. 测试与导出正确性

| 测试面 | 命令/方法 |
| --- | --- |
| 生命周期/装载/启停 | `node scripts/test-plugin-lifecycle.mjs` |
| 插件治理/路由/设置 | `npx tsx --tsconfig .nuxt/tsconfig.server.json --test --test-force-exit tests/plugin-governance.test.ts` |
| 驱动/解码器纯逻辑 | 新增 `tests/plugin-governance.test.ts` 同款结构,纯函数断言,不依赖平台实例 |
| 热加载实测 | `aw_plugin_toggle` → `aw_plugin_list` → 路由/驱动目录 |
| 镜像值 | `aw_daq_samples` 或 `node scripts/onboarding/verify-mirror.mjs --node <id> --expect '{"value":...}'` |
| 导出 | 行数/列名/时间戳/标签/对象键五项核对(DAQ manifest 无 sha256,需自行计算);工具面可用 `aw_agent_tool_invoke` 实调 |

“接上了”不等于“数据对了”:必须验证值(不是常量/残留)、量(行数/点数/帧数)、时间(窗口内/单调)、标识(line/product/recipe/run)与对象键(图像可被内容端点取回且字节非空)。

### 8. 发布清单

- `docs/plugins.md` §十三逐条过:manifest 完整、settings 类型正确、路由 auth 声明、KV 只走 `ctx.kv`、事件订阅有 `onDispose`、README/i18n 齐备。
- 版本语义:`version` 只在发布时递增;project/user 插件随目录分发,builtin 随包。
- 安全:凭据走 `secretRef`/env,不进源码/KV;出站走 `ctx.http`(SSRF 白名单);日志不打印 token。
- 权限:`auth` 与路由级 auth 一致;`ctx.omp.registerTool` 的 `roles` 在注册时冻结,需要热切换的闸门在 handler 里现读设置。
- builtin 插件:entry 会随状态文件重载,但 helper 模块可能被 ESM 缓存;有工作副本的插件保持字节一致,没有副本的(如 serial-bridge)直接改 builtin 目录。验证不生效时走维护窗口。

## 红线

- 插件不得绕过治理面直写 PLC/数据库;写路径走 DCW 网关/HITL/量程/步长。
- 不吞异常、不返回假值;失败要让 `sample/write` 抛错或返回 `ok:false`。
- 不把凭据写进源码、KV、日志或对话;只进 `secretRef`/环境变量。
- 不为让插件生效重启生产进程;builtin 需要重启时移交维护窗口。
- 新数据形态不要硬塞进 `image` MIME 冒充;如实告知需要核心扩展。

## 验收清单

- [ ] `aw_plugin_list` 无 failures,插件 enabled,`aw_status` 的 `mcpEnabled=true`
- [ ] `setup` 日志出现(`[aw-plugins] [<name>]`)
- [ ] 驱动出现在 `/api/workshop/daq|dcw` 的 `drivers[]`,meta 表单可用
- [ ] 解码器/处理器/模板行为与声明一致(纯函数单测 + 实机样本)
- [ ] 热重载后行为更新;启停回路 enable/disable 通过
- [ ] 路由鉴权正确,`ctx.http` 出站受白名单约束
- [ ] 镜像值/行数/时间戳/标签/objectKey 五项验收通过
- [ ] builtin 插件改动已验证(entry 重载/helper 缓存),生产未重启
- [ ] `docs/plugins.md` §十三发布清单全过
