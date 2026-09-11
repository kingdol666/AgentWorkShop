# 插件开发指南

> 插件 = 一个自包含目录(入口 `index.mjs`,可选 `client.mjs` / `i18n.json`)。一个目录同时
> 增强**服务端**(路由/工具/数采/事件)与**浏览器**(面板组件/多语言/设置 UI),放入即装载,
> 启停即热重载。完整权威参考见 [完整指南(单页)](/plugins/guide)。

## 快速开始

```bash
aw plugin create my-plugin          # 脚手架到 <repo>/.AgentWorkShop/plugins/my-plugin(项目级,默认)
aw plugin create my-plugin --global # 或用户级 ~/.AgentWorkShop/plugins/my-plugin(-g 同义)
aw plugin list                      # 三作用域清单(含启停态)
aw plugin disable my-plugin         # 停用(写状态文件,服务自感知热重载)
aw plugin enable my-plugin          # 重新启用
```

`aw plugin create` 默认落 **project** 级,`--global` / `-g` 落 user 级,`--project` 是显式写法(与默认等价),`--force` / `-f` 覆盖已存在目录;插件名需匹配 `^[a-z][a-z0-9-]{1,31}$`。生成:

```
<repo>/.AgentWorkShop/plugins/my-plugin/
├── index.mjs      # 服务端入口(必需):export default { name, setup(ctx), … }
├── client.mjs     # 浏览器增强(可选,需在 manifest 声明 client:'./client.mjs')
└── README.md
```

插件根目录还可放 `i18n.json`(多语言消息包)。**插件 KV 不在这里**:它在 `<配置根>/data/plugins/<插件名>/kv.json`。

### 三作用域与优先级

| 作用域 | 入口路径 | 说明 |
|---|---|---|
| `builtin` | `<包根>/server/plugins-builtin/<name>/index.mjs` | 随包发布;当前发行内置 `diag-bridge`、`rag-bridge` |
| `project` | `<repo>/.AgentWorkShop/plugins/<name>/index.mjs` | 随检出分发,可 git 版本化 |
| `user` | `$AW_HOME/plugins/<name>/index.mjs`(默认 `~/.AgentWorkShop/plugins`) | 用户级,跨项目 |

宿主按 `builtin` → `project` → `user` 扫描,**同名先到先得**,故优先级 **builtin > project > user**(`aw plugin list` 与 `enable|disable` 同序)。CLI 指令注册表方向相反(后扫覆盖),不可类推。

### 启停状态文件

启停状态在 **`<home>/plugins-state.json`**,`home = $AW_HOME || ~/.AgentWorkShop` —— 源码检出下它与**配置根不是同一个目录**(`configRoot = <repo>/.AgentWorkShop` 放数据与 KV,`home = ~/.AgentWorkShop` 放状态;全局安装时两者重合)。

```json
{ "version": 1, "updatedAt": "2026-09-03T00:00:00.000Z", "disabled": ["my-plugin"] }
```

## 插件系统 v2 四大能力

| 能力 | 用法 | 落点 |
|---|---|---|
| **前端组件注入** | `client.mjs` 里 `ctx.ui.registerPanel({slot, name, mount(el)})` | 页面 `<workshop-plugin-slot slot-name="…" />` 插槽:插件页 / 设置页 / 仪表盘 |
| **插件设置** | `index.mjs` 声明 `settings: [{key,type,default,…}]` + `configGroups: [{id,label,…}]` | 设置页渲染为本插件自己的配置分区,保存即热生效 |
| **插件 i18n** | 根目录 `i18n.json`(`{"zh-CN":{…},"en":{…}}`);`ctx.t(key)` / `labelKey` / `titleKey` | vue-i18n 命名空间 `plugin.<插件名>`,语言切换即时跟随 |
| **运行时服务面** | `ctx.services.get('daq'\|'lines'\|'channels'\|'plugins')` / `.provide(name, getter)` | 后端运行时对象只读取数 + 跨插件供服务(自动加 `<插件名>.` 前缀) |

## 插件契约(index.mjs)

`index.mjs` 导出**普通对象**(零导入依赖 —— `ctx` 由宿主注入):

```js
export default {
  name: 'my-plugin',         // 必填,全局唯一
  version: '1.0.0',
  description: '…',
  auth: 'user',              // 可选:none(默认)| user | admin | agent-or-user
  client: './client.mjs',    // 可选:浏览器入口(必须是相对路径字符串)
  settings: [ /* 可选:设置声明 */ ],
  configGroups: [ /* 可选:配置分组声明 */ ],
  routes: [                  // 可选:声明式 API(也可在 setup 里 ctx.route())
    { method: 'GET', path: '/health', handler: () => ({ ok: true }) },
  ],
  async setup(ctx) { /* 服务端生命周期 */ },
}
```

装载期宿主做形态校验(`validatePluginModule`);失败记入 `failures` 并告警,不拖垮主服务。路由注册顺序是**先 `setup(ctx)`,再注册 `routes[]`**。

## 插件设置与配置分组

```js
configGroups: [
  { id: 'default', label: '连接', description: '后端地址与鉴权', order: 400 },
  { id: 'advanced', label: '高级', collapsed: true },
],
settings: [
  { key: 'base_url', type: 'string', default: 'http://127.0.0.1:8770', group: 'default',
    labelKey: 'plugin.my-plugin.settings.base_url', label: '服务地址', description: '保存即热生效' },
  { key: 'max_turns', type: 'number', default: 0, min: 0, max: 2000, group: 'advanced', label: '最大轮数' },
  { key: 'mode', type: 'select', default: 'a', options: ['a', 'b'], group: 'advanced', label: '模式' },
],
```

- `key` 只允许字母数字与 `-` `_`;`type` 仅 `string|number|boolean|select`;**`default` 必填**(缺失的条目被跳过并告警);`select` 的 `default` 必须在 `options` 里;`min`/`max` 仅 `number` 生效。
- 键强制编址 `plugins.<插件名>.<key>`;`settings[].group` 引用声明时的原始 id(`default` → `plugin-<插件名>`,`x` → `plugin-<插件名>-x`)。
- **未声明 `group` 的字段**落入本插件默认分区(标题为 `plugin-<插件名>`;声明 `{ id:'default', label:'…' }` 即可换成可读标题)。
- 设置页里没有字面叫「插件」的配置分组:那是插件**管理**清单(启停 + 健康检测),与插件自己的配置分区是两块 UI。
- 运行时扩展:`ctx.config.defineGroup / defineField / removeGroup / removeField / groups / fields`(在 `setup` 里按条件注册,卸载自动摘除)。
- 读取:`ctx.config.get('plugins.<插件名>.<key>')`;订阅:`ctx.config.onChange(fn)`。

## 插件 i18n(i18n.json)

```json
{
  "zh-CN": { "settings": { "base_url": "服务地址" }, "panel": { "title": "我的面板" } },
  "en":    { "settings": { "base_url": "Service URL" }, "panel": { "title": "My panel" } }
}
```

`GET /api/plugins/i18n` 汇编全部已启用插件的消息包(免鉴权;**只放 UI 文案**)并合并进 vue-i18n 命名空间 `plugin.<插件名>`;`ctx.t('panel.title')` 在插件自有消息树上自解析,未命中回落原键。语言切换广播 `i18n:changed` 钩子(用 `ctx.hooks.on` 收)。

## 插件热管理(`aw plugin` + /plugins 页)

```bash
aw plugin list                  # 三作用域清单(含启停态;+client 表示有浏览器增强)
aw plugin create my-plugin      # 脚手架(默认项目级;--global 进用户级)
aw plugin disable my-plugin     # 停用(写 plugins-state.json,服务自感知)
aw plugin enable my-plugin      # 重新启用
```

- 状态文件 = **`<home>/plugins-state.json`**(`home = $AW_HOME || ~/.AgentWorkShop`,**不是**配置根)`{ version, updatedAt, disabled: [...] }`;CLI 与 Web 插件页写同一文件,装载/重装载时跳过 disabled 项(manifest 仍可见,`enabled: false`)。
- **启停无需重启进程**:宿主 `fs.watch` 状态文件所在目录并有 10s mtime 轮询兜底,约 1s 内完成全量重装载。
- **改插件代码也无需重启进程**:重装载用 `import(entry + '?t=' + Date.now())` 打破 ESM 缓存。宿主没有插件目录 watcher,所以改完代码要触碰 `plugins-state.json`(或 enable/disable 往返一次)触发重载;核心 `server/`、`shared/` 改动仍需重启。
- 重装载期间状态文件再变化(如 disable→enable 连击)由禁用集快照比对自动补跑,事件不丢失。

## 装载与重载流程

```
服务启动(nitro 插件 server/plugins/aw-plugins.ts)
  └─ 三作用域扫描(同名先到先得:builtin > project > user)
       ├─ <包根>/server/plugins-builtin/*/index.mjs      (builtin)
       ├─ <检出>/.AgentWorkShop/plugins/*/index.mjs       (project)
       └─ $AW_HOME|~/.AgentWorkShop/plugins/*/index.mjs   (user)
  └─ 逐插件: 动态 import(?t= 破缓存) → 形态校验 → 跳过 disabled
       → createPluginContext → setup(ctx) → 注册 routes[] → 登记 client/i18n
  └─ 同步设置描述符与配置分组 → emit plugin:host:init { plugins, failures }

运行中: plugins-state.json 变化(fs.watch + 10s 轮询)
  └─ 逐插件 dispose(await) → 解绑 hooks → 清空路由表 → 重新装载
       → emit plugins:reloaded → 广播 scene 事件 plugins.reloaded(浏览器即时同步)

服务关闭(nitro close)
  └─ 逐插件执行 dispose 队列(含 KV 同步落盘)→ 广播 server:close
```

- **错误隔离**:单插件装载/执行失败记入 `failures` 并告警,绝不拖垮主服务;半注册状态(routes / hooks / omp 工具)按插件名回滚。
- **失败可见性**:`aw plugin list` **不显示**装载失败;用 `GET /api/workshop/plugins`(返回 `{ plugins, failures, initedAt }`,**没有 `{code,data}` 信封**)。

## 服务端 ctx 全成员

| 分组 | 成员 | 说明 |
|---|---|---|
| 身份 | `ctx.name / scope / dir / sdkVersion` | `scope ∈ 'builtin' \| 'project' \| 'user'` |
| 钩子 | `ctx.hooks` | HookBus:`on/once/off/emit`(异步串行、错误隔离、裸 `'*'` 通配、连续失败 8 次熔断);热重载自动解绑 |
| 日志 | `ctx.logger` | `debug/info/warn/error`,自动前缀 `[aw-plugins] [<插件名>]` |
| 配置 | `ctx.config.get / all / onChange / defineGroup / defineField / removeGroup / removeField / groups / fields` | 有效配置只读 + 变更订阅 + 运行时分区/字段注册 |
| 存储 | `ctx.kv.get / set / all / bump` | 插件私有 KV(**没有 `reset()`**);内存态为准 + 200ms 防抖原子落盘 |
| 定时 | `ctx.timer.setInterval / setTimeout` | 自动进回收队列,关机与热重载都会清理 |
| 清理 | `ctx.onDispose(fn)` / `ctx.subscriptions.add(d)` | 与 `ctx.timer` 共用同一个宿主回收队列 |
| 路由 | `ctx.route(method, path, handler)` | 插件 API → `/api/plugins/<插件名><path>`(exact-match);返回 boolean |
| 平台 | `ctx.api` | 平台 REST 客户端(自环 origin、自动解信封;鉴权端点需 `setToken`) |
| 网络 | `ctx.http.get / post` | 出站 fetch;守卫**只校验协议**(仅 http/https),不限制 host;默认 8s 超时 |
| 事件 | `ctx.events.on / off` | scene 实时事件订阅(内部补 `event:` 前缀) |
| 路径 | `ctx.paths.home / configRoot / dataDir`;`ctx.dataDir` | `ctx.dataDir` = `<配置根>/data/plugins/<插件名>` |
| 数采扩展 | `ctx.daq.registerDriver / registerProcessor / registerTemplate / onFrame / onSample / query / nodes` | 插件驱动 / 下沉处理器 / 数采节点模板 / 时序查询 / 节点元数据(同名覆盖) |
| OMP 工具 | `ctx.omp.registerTool(tool)` | 注册 host 工具 → 全部 harness 运行时热注入;`roles` 仅 `'lead'` 与 `'worker'` |
| 服务 | `ctx.services.names / get / provide` | 运行时对象面:`get('daq'\|'lines'\|'channels'\|'plugins')`;`provide` 自动加 `<插件名>.` 前缀 |
| 权限 | `ctx.permissions.lineMode / visibleLineIds / listGrants / setGrants` | 产线授权查询与管理 |

**KV 位置**:`<configRoot>/data/plugins/<插件名>/kv.json` —— 不在插件目录里。

## 服务端事件

| 事件 | 时机 | payload |
|---|---|---|
| `plugin:host:init` | 全部插件 setup 完成后(一次性) | `{ plugins: string[], failures: number }` |
| `plugins:reloaded` | 热重载收尾 | `{ plugins: <manifest> }` |
| `config:changed` | 设置变化(设置页 / `runtime-settings.json`) | `{ type, changed: string[], effective, sources }` —— **没有 `at` 字段** |
| `daq:sample` | 下发级采样(与 WS `daq.reading` 同点同节拍) | `{ nodeId, templateRef, value, state, at, lineId }` |
| `daq:frame` | 多形态帧入账后(无 blob,只有元数据/指标/预览) | `{ nodeId, templateRef, kind, at, lineId, preview?, metrics, thumbUrl?, state }` |
| `dcw:write` | 写控 ACK 落账后(含 10s 同值去重) | `{ nodeId, name, eng, prevValue, ok, source, lineId, at }`(`source ∈ manual\|recipe\|agent\|rollback`) |
| `line:start` / `line:stop` | 批次窗口开 / 闭 | `{ lineId, runId, recipeId, productName }` / `{ lineId, runId }` |
| `event:<scene-type>` | 任一 `broadcastSceneEvent(type, payload)`(与浏览器 WS 同源) | 事件自身 payload |
| `server:close` | nitro close(逐插件 dispose 之后) | `{ at }` |

```js
// 通配:服务端是裸 '*',回调收 { type, payload }
ctx.hooks.on('*', ({ type }) => ctx.logger.debug('event', type))

// scene 事件:用 ctx.events(它会补 event: 前缀)
ctx.events.on('daq.node.changed', (p) => ctx.logger.debug('节点变更', p?.op))

// 权限变更:ctx.hooks.on('permissions:changed') 永不触发
ctx.events.on('permissions.changed', (p) => ctx.logger.info('授权变更', p?.userId))
```

## 插件 API(路由与鉴权)

```js
ctx.route('GET', '/stats', () => ctx.kv.all())

ctx.route('POST', '/threshold', (event) => {
  const v = Number(event.awBody?.threshold)   // 宿主转发层已预读 JSON body
  if (!Number.isFinite(v)) return { ok: false, error: 'threshold 必须是数字' }
  ctx.kv.set('threshold', v)
  return { ok: true, threshold: v }
})
```

→ `/api/plugins/<插件名><path>`(exact-match;返回值由 nitro 序列化为 JSON)。鉴权由入口的声明式字段统一执行,在进入 handler **之前**校验,对 `routes[]` 与 `ctx.route()` 一视同仁:

| `auth` | 行为 |
|---|---|
| `'none'`(默认) | 不校验 |
| `'user'` | 需要有效用户 token,否则 401 |
| `'admin'` | 需要管理员,否则 401 |
| `'agent-or-user'` | 接受 Agent 身份或用户 token |

不要把鉴权写进 handler:`resolveUser(event)` 不可从插件导入,`ctx` 上也没有它 —— 要鉴权就声明 `auth`。

## 多形态数采与 omp 工具扩展

数采不止单点数值:模板可声明 `signalKind: 'vector'`(测厚仪/扫描仪多点轮廓)或 `'image'`(CCD 图像)。向量与帧元数据入 Timescale(`daq_frames`),图像像素入对象存储(MinIO,不可达自动降级本地磁盘)。

```js
// 注册下沉处理器:模板 sink 配置 { name: 'demo-roughness' } 即生效
ctx.daq.registerProcessor('vector', 'demo-roughness', (frame, args) => ({
  ...frame, metrics: { ...frame.metrics, roughness: computeRoughness(frame.points) },
}))

// 注册节点模板(出现在 /daq 模板目录与创建向导;key 需匹配 /^[\w-]+$/ 且不与内置冲突)
ctx.daq.registerTemplate({
  key: 'plug-my-plugin-sensor', name: '我的传感器', unit: 'mm',
  min: 0.4, max: 0.6, base: 0.5, amp: 0.02, decimals: 3, icon: 'tension',
  signalKind: 'vector', vector: { points: 32, min: 0.4, max: 0.6 },
  sink: { processors: [{ name: 'resample', args: { n: 32 } }, { name: 'demo-roughness' }] },
  metrics: [{ key: 'roughness', label: '粗糙度', alarmHigh: 0.05 }],
})

// 注册 omp host 工具:全部 harness 运行时热注入(不重 spawn)
ctx.omp.registerTool({
  name: 'sensor_log',
  description: '查询/登记传感器标定结论',
  parameters: { type: 'object', properties: { sensor: { type: 'string' } }, required: ['sensor'] },
  roles: ['lead', 'worker'],
  handler: async (args, agent) => ({ text: `${args.sensor} @ ${agent.role}` }),
})
```

- 派生指标阈值越限(模板 `metrics` 声明)走平台既有告警链路(落库 + WS + webhook)。
- 工具参数里**不要开 `url`/`host` 注入口**;完整语义与示例见 [完整指南(单页)](/plugins/guide)。

## 浏览器增强(client.mjs)

自包含 ESM 导出 `setup(ctx)`;入口必须在 manifest 声明 `client: './client.mjs'`,loader 从 `/api/plugins/client/<插件名>` 取脚本。

```js
export function setup(ctx) {
  let samples = 0
  const counter = ctx.el('strong', {}, ['0'])

  ctx.on('daq.reading', () => { samples += 1; counter.textContent = String(samples) })  // scene 事件

  ctx.ui.registerPanel({
    slot: 'plugins.page', name: 'my-panel', titleKey: 'panel.title', order: 10,
    mount(el) {
      const box = ctx.el('div', {}, ['样本数:', counter])
      el.append(box)
      const timer = setInterval(() => { counter.textContent = String(samples) }, 5000)
      return () => { clearInterval(timer); box.remove() }   // 清理函数(面板卸载时调用)
    },
  })

  ctx.log.info('client ready')
}
```

| 事件 / 成员 | 说明 |
|---|---|
| `client:init` | `setup(ctx)` 完成后由 loader 广播;用 `ctx.hooks.on` 订阅 |
| `event:<scene-type>` / `event:*` | WS 实时事件(经 TownBus 桥);`ctx.on(type)` 传事件名本身,唯一通配写法是字面量 `'event:*'` |
| `page:change` | 路由切换完成 `{ path }`;用 `ctx.hooks.on` 订阅 |
| `i18n:changed` | 语言切换 `{ locale }`;用 `ctx.hooks.on` 订阅 |
| `client:destroy` | `ctx.dispose()` 前广播 `{ name }` |
| `ctx.t(key, params?)` | 插件命名空间翻译(`params` 目前被忽略,不做插值) |
| `ctx.fetch / el / mount / root / locale / log / dispose` | 同源 API 助手 / DOM 助手 / 挂载 / 私有根节点 / 当前语言 / 前缀日志 / 卸载 |

**死订阅清单**:`ctx.on('*')`、`ctx.on('event:line.start')`、`ctx.on('daq:sample')` 都不会触发 —— 服务端钩子(daq:sample / dcw:write / line:start|stop)**不过桥到浏览器**,生命周期钩子也**不在 `ctx.on` 面上**(走 `ctx.hooks.on`)。

内置插槽:`plugins.page`(插件页)· `settings.plugins`(设置页插件区下方)· `dashboard.widgets`(仪表盘页尾)。

## 团队级插件开关(channel × 插件)

全局启停之外,每个团队(Channel)还有**独立的插件开关组**(由 `channel_plugins` 表承载):

- **建队时勾选**:`POST /api/workshop/teams` 接受 `plugins: [{ name, enabled }]`,以 team id 为键落库,部署时传导到 Channel;
- **随时切换**:`GET|PUT /api/workshop/channels/:id/plugins` 与 `GET|PUT /api/workshop/teams/:id/plugins`(body `{ plugins: [{ name, enabled }] }`,全量替换,未知/停用插件名忽略);
- **语义**:无显式行 = 未配置 → 全部启用插件对该团队可见(向后兼容);写入显式行后按行过滤 —— **被关闭插件的工具不注入该团队的 Agent,dispatch 同源拒绝**;
- **前端**:workshop teams 页(创建勾选 + 团队弹层)。

## 调试与陷阱

| 现象 | 原因 / 处理 |
|---|---|
| 改了插件代码没生效 | 宿主没有插件目录 watcher:触碰 `<home>/plugins-state.json` 或 `aw plugin enable/disable` 往返一次(重载带 `?t=` 破缓存);核心 `server/`、`shared/` 改动仍需重启 |
| 装载失败看不到 | `aw plugin list` 不显示;**用 `GET /api/workshop/plugins`**(`{ plugins, failures, initedAt }`,无 `{code,data}` 信封)或看启动日志 `[aw-plugins] 装载失败 …` |
| 客户端徽标没出现 | 浏览器 console 看 `[aw-plugins]` 告警;确认 manifest `hasClient: true`(manifest 里声明了 `client:'./client.mjs'`) |
| 客户端订阅不触发 | 踩了死订阅:见上文清单 |
| 插件路由 404 | exact-match;检查 method 与 path 前导 `/`,以及插件是否启用(停用插件的路由已移除) |
| 插件路由 401 | 声明了 `auth` 但请求未带有效凭据;开放接口用 `auth: 'none'` |
| 设置项没渲染 | 缺 `default` 被跳过;`select` 的 `default` 必须在 `options` 里;`key` 只允许字母数字与 `-` `_` |
| `ctx.api` 401 | 鉴权端点需 `setToken`;免鉴权端点(manifest/ping)无需 |
| `permissions:changed` 钩子不触发 | 该名字不存在;用 `ctx.events.on('permissions.changed', fn)` |

**信任模型**:插件是任意 node 代码,与 aw commands 同级 —— 只安装/启用你信任的插件。

## 已知边界(有意为之)

- 钩子是**观察语义**:v1 无 veto / 拦截 / 改写。
- `ctx.http` 守卫**只校验协议**(http/https),**不限制 host** —— 需要白名单请在插件内自行校验。
- `ctx.t(key, params)` 的 `params` 当前被忽略(不做插值)。
- `ctx.kv` **没有 `reset()`**;200ms 防抖落盘,强杀进程有极小丢失窗口。
- 服务端与浏览器的订阅面**不互通**;**浏览器新启用插件注入延迟 ≤15s**(WS 可用时即时)。
- `server:close` / `onDispose` 依赖优雅关闭信号(Windows 强杀不触发)。

## 作用域与发布

- 内置(builtin):`<包根>/server/plugins-builtin/`(随包发布,优先级最高)。
- 项目级(project):`<repo>/.AgentWorkShop/plugins/`(团队可 git 版本化)。
- 用户级(user):`$AW_HOME|~/.AgentWorkShop/plugins/`(跨项目)。
- 卸载 = 删除目录后重启(或触碰状态文件触发重载)。
