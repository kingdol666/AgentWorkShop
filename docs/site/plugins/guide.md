# AgentWorkShop 插件开发指南(完整版)

> 插件 = 一个自包含目录:入口 `index.mjs`(必需),可选 `client.mjs`(浏览器增强)与
> `i18n.json`(多语言消息包)。一个目录同时增强**服务端**(路由/工具/数采/事件)与
> **浏览器**(面板组件/多语言/设置 UI),放入即装载,启停即热重载。
> 本文是唯一权威参考;`docs/site/plugins/` 的分页文档与本文同源。
>
> 适用版本:插件系统 v2 自 **v0.7.29** 起可用(前端组件注入 / 插件设置 / 插件 i18n /
> 运行时服务面);本文档对应当前版本 **v0.7.36**。`ctx.sdkVersion` 当前为 `0.3.0`。

## 一、目录结构与快速开始

```bash
aw plugin create my-plugin          # 脚手架到 <repo>/.AgentWorkShop/plugins/my-plugin(项目级,默认)
aw plugin create my-plugin --global # 或用户级 ~/.AgentWorkShop/plugins/my-plugin(-g 同义)
aw plugin list                      # 三作用域清单(含启停态)
aw plugin disable my-plugin         # 停用(写状态文件,服务自感知热重载)
aw plugin enable my-plugin          # 重新启用
```

`aw plugin create` 默认落 **project** 级;`--global` / `-g` 落 **user** 级;`--project` 是显式写法(与默认等价,保留以符合直觉);`--force` / `-f` 覆盖已存在目录。插件名校验 `^[a-z][a-z0-9-]{1,31}$`(小写字母开头,2~32 位)。命令生成三个文件:

```
<repo>/.AgentWorkShop/plugins/my-plugin/
├── index.mjs      # 服务端入口(必需):export default { name, setup(ctx), … }
├── client.mjs     # 浏览器增强(可选,且必须在 manifest 里声明 client:'./client.mjs')
└── README.md
```

插件根目录还可以放 `i18n.json`(多语言消息包,见 §5)。**插件 KV 不在这里** —— 它落在 `<配置根>/data/plugins/<插件名>/kv.json`(见 §6)。

### 三作用域与优先级

宿主按 `builtin` → `project` → `user` 顺序扫描,**同名先到先得**:

| 作用域 | 入口路径 | 说明 |
|---|---|---|
| `builtin` | `<包根>/server/plugins-builtin/<name>/index.mjs` | 随包发布,永远存在;当前发行内置 `diag-bridge`、`rag-bridge` |
| `project` | `<repo>/.AgentWorkShop/plugins/<name>/index.mjs` | 随检出分发,可 git 版本化 |
| `user` | `$AW_HOME/plugins/<name>/index.mjs`(默认 `~/.AgentWorkShop/plugins`) | 用户级,跨项目生效 |

同名优先级 **builtin > project > user**(宿主先扫先占,`seen` 集合去重)。注意方向:CLI 指令注册表(`cli/core/registry.mjs`)是**后扫覆盖**,即 project > user > builtin —— 两者相反,不可互相类推。`aw plugin list` / `aw plugin enable|disable` 用的也是这同一顺序,所以启停一定打到你看到的那个插件上。

### 启停状态文件

启停状态在 **`<home>/plugins-state.json`**,其中 `home = $AW_HOME || ~/.AgentWorkShop`。源码检出下它与**配置根不是同一个目录**:

- `configRoot = <repo>/.AgentWorkShop` —— 数据与插件 KV 在这里;
- `home = ~/.AgentWorkShop` —— 启停状态在这里。

全局安装(home 模式)时两者重合,旧描述写成"配置根"时看不出差别,但源码检出下会指向错误路径。文件格式:

```json
{ "version": 1, "updatedAt": "2026-09-03T00:00:00.000Z", "disabled": ["my-plugin"] }
```

`aw plugin enable|disable`、Web 插件管理页与宿主三方读写同一份文件。

## 二、插件契约(index.mjs)

`index.mjs` 导出**普通对象**(零导入依赖 —— `ctx` 由宿主注入):

```js
export default {
  name: 'my-plugin',         // 必填,全局唯一(缺失/非字符串立即装载失败)
  version: '1.1.0',          // 可选,manifest 展示用
  description: '…',          // 可选
  auth: 'user',              // 可选:none(默认)| user | admin | agent-or-user
  client: './client.mjs',    // 可选:浏览器入口(必须是相对路径字符串)
  settings: [ /* 可选:插件设置声明,见 §4 */ ],
  configGroups: [ /* 可选:插件配置分组声明,见 §4 */ ],
  routes: [                  // 可选:声明式路由(setup 返回后才注册)
    { method: 'GET', path: '/health', handler: () => ({ ok: true }) },
  ],
  async setup(ctx) { /* 服务端生命周期,见 §3 */ },
}
```

装载期宿主做形态校验(`validatePluginModule`):`name` 必须是非空字符串;`setup` 若存在必须是函数;`client` 若存在必须是字符串;`settings` 若存在必须是数组。任一不满足即装载失败,记入 `failures` 并告警,**错误隔离绝不拖垮主服务**。

路由注册顺序很重要:**先 `await setup(ctx)`,再注册 `routes[]`**。这样 `setup` 抛错时不会留下"路由活着、宿主无记录"的幽灵路由。

## 三、启用、停用与热重载

| 阶段 | 服务端 | 浏览器 |
|---|---|---|
| 装载 | nitro 插件 `server/plugins/aw-plugins.ts` → 三作用域扫描 → 动态 import(`?t=` 破缓存)→ 形态校验 → `setup(ctx)` → 注册 `routes[]` | loader(`app/plugins/aw-plugins.client.ts`)拉 `GET /api/plugins/manifest` → 拉 `GET /api/plugins/i18n` → 动态 import `/api/plugins/client/<name>` → `setup(ctx)` |
| 注入 | 路由/工具/驱动/模板/处理器即时生效;设置描述符并入 `SystemConfigService` | 面板经 `ctx.ui.registerPanel` 注入页面插槽;`client:init` 钩子广播 |
| 运行 | `daq:sample` / `daq:frame` / `dcw:write` / `line:start\|stop` / `config:changed` / `event:<type>` / `*` | `event:<type>`(与 WS 同源)/ `page:change` / `i18n:changed` |
| 重载 | 状态文件变化 → 全量 dispose(逐个 `await`)→ 解绑 hooks → 清路由 → 重新装载 → 广播 `plugins:reloaded` | WS `plugins.reloaded` 即时同步,另有 15s 轮询兜底 → 停用插件 `ctx.dispose()` |
| 关机 | 逐插件执行 dispose 队列(含 KV 同步落盘)→ 广播 `server:close` | 页面 `pagehide` 自动 `ctx.dispose()` |

热重载的几个事实:

- **触发源是状态文件**:宿主 `fs.watch` 监听 `plugins-state.json` 所在目录,另有 **10s mtime 轮询**兜底(Windows 上 `rename` 原子写可能丢事件)。`aw plugin enable|disable`、Web 开关、或直接触碰该文件都会触发,**约 1s 内**完成全量重装载。
- **改代码不需要重启进程**:重装载用 `import(entry + '?t=' + Date.now())` 打破 ESM 模块缓存,所以插件代码改动会在下一次重装载时生效。宿主没有独立的插件目录 watcher —— 改完代码后触碰 `plugins-state.json`(或 enable/disable 往返一次)就能让它立刻生效。
- **核心代码仍需重启**:`server/` 与 `shared/` 的改动不在插件热重载范围内。
- **竞态防护**:重装载进行期间状态文件再次变化(如 disable→enable 连击)时,去抖回调会撞上 in-flight 守卫;装载结束后宿主比对禁用集快照,有差异自动补跑一次,启停事件不丢失。
- **浏览器侧**:新启用的插件最迟 15s 注入(WS 可用时即时);停用插件立即卸载并回收其全部面板。

## 四、插件设置与配置分组

### 声明式字段(manifest `settings[]`)

```js
settings: [
  { key: 'base_url', type: 'string', default: 'http://127.0.0.1:8770',
    labelKey: 'plugin.my-plugin.settings.base_url',   // i18n 键(见 §5)
    label: '服务地址(回退文案)', description: '保存即热生效' },
  { key: 'max_turns', type: 'number', default: 0, min: 0, max: 2000, label: '最大轮数' },
  { key: 'auto_enabled', type: 'boolean', default: false, label: '自动模式' },
  { key: 'mode', type: 'select', default: 'a', options: ['a', 'b'], label: '模式' },
],
```

校验器(`validatePluginSettings`)的硬约束 —— 任一条不满足,该条目被**跳过并告警**,其余条目照常装载:

| 约束 | 规则 |
|---|---|
| `key` | 必填,且匹配 `/^[A-Za-z0-9_-]+$/`(仅字母数字与 `-` `_`) |
| `type` | 必须是 `'string' \| 'number' \| 'boolean' \| 'select'` 之一 |
| `default` | **必填** —— 不给默认值的条目直接跳过 |
| `select` | 必须给 `options` 数组,且 `default` 必须在其中(比较按字符串) |
| `min` / `max` | 仅 `number` 生效(仍会被写进描述符,但对其他类型无意义) |
| `label` | 缺省回落 `key`;`labelKey` 存在时优先解析 i18n |
| `description` | 缺省为空串 |

规范化后的描述符 `applies` 恒为 `'live'`(保存即热生效),键被强制编址为 **`plugins.<插件名>.<key>`** —— 与全局 schema 键同一编址空间。

### 配置分组(manifest `configGroups[]` + `settings[].group`)

```js
configGroups: [
  { id: 'default', label: '连接', description: '后端地址与鉴权', order: 400 },
  { id: 'advanced', label: '高级', collapsed: true },
],
settings: [
  { key: 'base_url', type: 'string', default: 'http://127.0.0.1:8770', group: 'default', label: '服务地址' },
  { key: 'timeout_ms', type: 'number', default: 8000, group: 'advanced', label: '超时(ms)' },
],
```

- 分组 id 会被收敛进本插件命名空间:`default`(或写成插件名)映射为 `plugin-<插件名>`,其余声明 id `x` 映射为 `plugin-<插件名>-x`。两个插件用同一个 `network` 也不会互相覆盖。
- `settings[].group` 引用的是**声明时的原始 id**(`default` / `advanced`),不是已经加过前缀的 id。
- **未声明 `group` 的字段**落入本插件默认分区,id 为 `plugin-<插件名>`;若插件没有为这个默认 id 声明过标题,设置页显示的标题就是这个 id 本身(即 `plugin-<插件名>`)。想显示可读标题,就像上面那样声明一个 `{ id: 'default', label: '…' }` —— 两个内置插件都这么做。
- 分组会在插件卸载/停用时自动摘除,不残留空分区。
- 设置页里**没有**一个字面叫「插件」的配置分组:那是系统设置 → 运行配置里的插件管理清单(启停开关 + 健康检测),与插件自己的配置分区是两块 UI。

> 字段 `configGroups` 是宿主实际读取的名字(`host.mjs` 读 `def.configGroups`)。类型声明文件 `sdk/index.d.mts` 里写的是 `groups?`,与运行时不一致,以本文与代码为准。

### 运行时注册(在 `setup` 里按条件扩展)

```js
async setup(ctx) {
  // 追加一个分组,并拿到收敛后的真实 id
  const group = ctx.config.defineGroup({ id: 'rules', label: '自动规则', collapsed: true })
  // 追加字段(等价于 manifest 的 settings[],但可以按条件注册)
  ctx.config.defineField({
    key: 'auto_rules', type: 'string', default: '', group: 'rules', label: 'JSON 规则',
  })
  ctx.logger.info(ctx.config.groups().map(g => g.id).join(','))
  ctx.logger.info(ctx.config.fields().map(f => f.key).join(','))
  // 摘除(removeGroup 收的是 defineGroup 返回的已命名空间化 id;removeField 收短 key)
  if (group) ctx.config.removeGroup(group.id)
  ctx.config.removeField('auto_rules')
}
```

`defineGroup` / `defineField` 的校验规则与声明式完全一致(不合法返回 `null` 并告警);`removeGroup` / `removeField` 返回布尔值表示是否真的移除了。这些分组与字段随插件卸载自动摘除,已保存的值不会因为重注册而丢失。

### 读取与持久化

- 读取:`ctx.config.get('plugins.my-plugin.base_url')`(每次调用都读合并后的有效值,保存即热生效);`ctx.config.all()` 拿全量快照。
- 订阅:`ctx.config.onChange(fn)` 等价于 `ctx.hooks.on('config:changed', fn)`。
- 运行时覆盖持久化在 `<配置根>/runtime-settings.json`;`PATCH /api/system/settings` 按同一份描述符校验,前端设置页按描述符渲染。
- 迁移:0.7.28 前写死在 `shared/config/schema.json` 的 `plugins.kb.*` / `plugins.diag.*` 已由插件声明取代;服务启动时一次性搬移旧覆盖到新键(新键未注册时保留旧键等下一次 pass,绝不丢数据)。

## 五、插件 i18n(i18n.json)

```json
{
  "zh-CN": { "settings": { "base_url": "服务地址" }, "panel": { "title": "我的面板" } },
  "en":    { "settings": { "base_url": "Service URL" }, "panel": { "title": "My panel" } }
}
```

- 装载期宿主解析插件根目录的 `i18n.json`(坏文件忽略,不阻断装载)。
- `GET /api/plugins/i18n` 汇编全部**已启用**插件的消息包(免鉴权;只放 UI 文案,**严禁放敏感信息**),返回 `{ i18n: { "<插件名>": { "<locale>": { … } } }, locales: ["zh-CN", "en"] }`。
- 浏览器 loader 拉取后:合并进 vue-i18n 命名空间 `plugin.<插件名>` —— 宿主组件(设置页 `labelKey`、面板 `titleKey`)直接解析;同时 `ctx.t(key)` 在插件自有的消息树上自解析(`ctx.t('panel.title')` 解析到 `plugin.my-plugin.panel.title`,未命中回落原键)。
- 语言切换时 loader 广播 `i18n:changed` 钩子;插件用 `ctx.hooks.on('i18n:changed', fn)` 接收(注意:它**不在** `ctx.on` 的投递面上)。
- manifest 暴露 `hasI18n` / `settingsCount` / `hasClient` 供前端展示。

## 六、服务端 ctx 全参考

| 面 | 成员 | 说明 |
|---|---|---|
| 身份 | `ctx.name` / `ctx.scope` / `ctx.dir` / `ctx.sdkVersion` | `scope ∈ 'builtin' \| 'project' \| 'user'`;`dir` 为插件目录绝对路径 |
| 钩子 | `ctx.hooks.on / once / off / emit` | 每插件门面;热重载自动解绑,无需手动 `off` |
| 日志 | `ctx.logger.debug / info / warn / error` | 自动前缀 `[aw-plugins] [<插件名>]` |
| 配置 | `ctx.config.get / all / onChange / defineGroup / defineField / removeGroup / removeField / groups / fields` | 有效配置只读 + 变更订阅 + 运行时分区分字段注册(见 §4) |
| 存储 | `ctx.kv.get / set / all / bump` | 插件私有 KV;**没有 `reset()`**;内存态为准 + 200ms 防抖原子落盘 |
| 定时 | `ctx.timer.setInterval / setTimeout` | 自动进回收队列,关机与热重载都会清理 |
| 清理 | `ctx.onDispose(fn)` / `ctx.subscriptions.add(d)` | 与 `ctx.timer` 共用同一个宿主回收队列 |
| 路由 | `ctx.route(method, path, handler)` | 挂 `/api/plugins/<插件名><path>`(exact-match);**返回 boolean** |
| 平台 | `ctx.api` | 平台 REST 客户端(自环 origin;自动解信封;鉴权端点需 `ctx.api.setToken(token)`) |
| 网络 | `ctx.http.get(url, opt)` / `ctx.http.post(url, body, opt)` | 出站 fetch;守卫**只校验协议**(仅 http/https),不限制 host;默认超时 8s;`headers` 透传 |
| 事件 | `ctx.events.on(type, fn)` / `ctx.events.off(type, fn)` | scene 实时事件糖:内部订阅 `event:<type>`(见 §7) |
| 路径 | `ctx.paths.home / configRoot / dataDir`;`ctx.dataDir` | `ctx.dataDir` 即本插件 KV 目录 `<配置根>/data/plugins/<插件名>` |
| 数采 | `ctx.daq.registerDriver / registerProcessor / registerTemplate / onFrame / onSample / query / nodes` | 驱动、下沉处理器、节点模板注册 + 时序查询 + 节点元数据快照 |
| 工具 | `ctx.omp.registerTool({ name, label?, description, parameters, roles?, handler })` | Agent 工具注入;`roles` 仅 `'lead'` 与 `'worker'`(见 §10) |
| 服务 | `ctx.services.names()` / `.get(name)` / `.provide(name, getter)` | 运行时对象面:`get('daq' \| 'lines' \| 'channels' \| 'plugins')`;`provide` 自动加 `<插件名>.` 前缀 |
| 权限 | `ctx.permissions.lineMode / visibleLineIds / listGrants / setGrants` | 产线授权查询与管理 |

### KV 落在哪里

`<configRoot>/data/plugins/<插件名>/kv.json` —— **不在插件目录里**。写入以内存为准,200ms 防抖后 `tmp + rename` 原子落盘;关机与热重载时取消挂起的防抖并同步落盘。`ctx.kv` 只有 `get / set / all / bump` 四个方法。

```js
ctx.kv.set('threshold', 180)        // 写(200ms 后落盘)
ctx.kv.get('threshold')             // 读(未写过为 undefined)
ctx.kv.bump('alarms')               // +1,返回新值;bump('alarms', -1) 递减
ctx.kv.all()                        // 全量浅拷贝快照
```

## 七、事件参考(服务端)

事件经 HookBus 分发,**监听器按注册序串行 await**,同一个监听器收到的 payload 始终是**同一个未被改写的对象** —— 不是 waterfall(只有最后一个非 `undefined` 的返回值被保留,宿主不使用它),v1 也没有 veto / 拦截能力。单个监听器抛错被隔离并计数:成功清零,**连续失败 8 次自动摘除**(熔断)。

### 生命周期与平台事件

| 事件 | 时机 | payload |
|---|---|---|
| `plugin:host:init` | 全部插件 setup 完成后(一次性) | `{ plugins: string[], failures: number }` |
| `plugins:reloaded` | 热重载收尾 | `{ plugins: <manifest> }` |
| `config:changed` | `runtime-settings.json` / 设置页变化 | `{ type, changed: string[], effective, sources }` —— **没有 `at` 字段** |
| `server:close` | nitro close,逐插件 dispose 之后 | `{ at }` |

### 业务事件

| 事件 | 时机 | payload |
|---|---|---|
| `daq:sample` | 节点采样经管线汇聚后的**下发级**出口(与 WS `daq.reading` 同点同节拍,按 `publishIntervalMs` 门控) | `{ nodeId, templateRef, value, state, at, lineId }` |
| `daq:frame` | 多形态帧(向量/图像)入账后(只含元数据/指标/预览,不含 blob) | `{ nodeId, templateRef, kind, at, lineId, preview?, metrics, thumbUrl?, state }` |
| `dcw:write` | 写控 ACK 落账后(含 10s 同值去重) | `{ nodeId, name, eng, prevValue, ok, source, lineId, at }`;`source ∈ manual \| recipe \| agent \| rollback` |
| `line:start` | 批次窗口开启 | `{ lineId, runId, recipeId, productName }` |
| `line:stop` | 批次窗口关闭 | `{ lineId, runId }` |
| `event:<scene-type>` | 任一 `broadcastSceneEvent(type, payload)`,与浏览器 WS 完全同源 | 事件自身 payload |

### 通配符与 scene 事件

服务端通配写法是**裸星号 `'*'`**,回调收到的是 `{ type, payload }` 包装:

```js
ctx.hooks.on('*', ({ type, payload }) => {
  ctx.logger.debug('全事件审计', type)
  void payload
})
```

`ctx.hooks.on('event:*', fn)` 是**错的** —— 永远不会触发。要按类型订阅 scene 事件,用 `ctx.events`,它会替你补 `event:` 前缀:

```js
ctx.events.on('daq.node.changed', (p) => ctx.logger.debug('节点变更', p?.op))
ctx.events.on('daq.alarm.changed', (p) => ctx.logger.info('告警状态', p?.nodeId, p?.recovered))
```

常见 scene 事件:`daq.reading`、`daq.frame`、`daq.alarm`、`daq.alarm.changed`、`daq.node.changed`、`daq.controller`、`daq.template.changed`、`dcw.node.changed`、`device.created|updated|deleted`、`ops.log`、`permissions.changed`、`plugins.reloaded`、`aml.job|dataset|model`。

### 权限变更

权限变更到达插件总线时是 scene 事件 `permissions.changed`(原始总线上的名字是 `event:permissions.changed`)。`ctx.hooks.on('permissions:changed', …)` **永远不触发**,正确写法:

```js
ctx.events.on('permissions.changed', (p) => ctx.logger.info('授权变更', p?.userId))
```

### 配置变更

```js
ctx.hooks.on('config:changed', (p) => {
  ctx.logger.info('配置已变更', p.changed)
  ctx.logger.info('当前主题色', ctx.config.get('theme.primaryColor'))
})
// 等价糖:ctx.config.onChange(fn)
```

## 八、浏览器 client.mjs(ctx 面参考)

客户端入口必须**在 manifest 里声明** `client: './client.mjs'` —— 仅存在文件是不够的。loader 从 `/api/plugins/client/<插件名>` 取脚本后动态 import 并调用 `setup(ctx)`。

```js
export function setup(ctx) {
  let samples = 0
  const counter = ctx.el('strong', {}, ['0'])

  // scene 事件:type 传事件名本身;收全部 scene 事件用字面量 'event:*'
  ctx.on('daq.reading', () => { samples += 1; counter.textContent = String(samples) })

  // 生命周期钩子只能走 ctx.hooks.on(不在 ctx.on 的投递面上)
  ctx.hooks.on('i18n:changed', ({ locale }) => ctx.log.info('语言切换:', locale))

  ctx.ui.registerPanel({
    slot: 'plugins.page',       // 插槽名(见下)
    name: 'my-panel',           // 同插件内唯一
    titleKey: 'panel.title',    // 解析 plugin.my-plugin.panel.title(或用静态 title)
    order: 10,
    mount(el) {                 // el = 面板容器(标题由插槽渲染)
      const box = ctx.el('div', {}, ['样本数:', counter])
      el.append(box)
      const timer = setInterval(() => { counter.textContent = String(samples) }, 5000)
      return () => { clearInterval(timer); box.remove() }   // 清理函数:面板卸载时调用
    },
  })

  ctx.log.info('客户端已注入')
}
```

| 成员 | 说明 |
|---|---|
| `ctx.name` / `ctx.sdkVersion` | 插件名 / 客户端 SDK 版本 |
| `ctx.hooks` | 真实 HookBus:`client:init` / `page:change` / `i18n:changed` / `client:destroy` |
| `ctx.on(type, fn)` | scene 事件订阅(type 传事件名本身,内部装到 `event:<type>`);只有字面量 `'event:*'` 是通配;返回解绑函数 |
| `ctx.fetch(path, opt)` | 同源平台 API 助手(自动带 cookie token、解 `{code,data}` 信封、非 2xx 抛错) |
| `ctx.el(tag, attrs, children)` | DOM 助手;`style` 走 `cssText`,`class` 走 `className`,`onXxx` 自动 `addEventListener` |
| `ctx.mount(target, node)` / `ctx.root()` | 挂到选择器/元素(缺失时挂 `ctx.root()`)/ 插件私有挂载点 `#aw-plugin-<name>` |
| `ctx.ui.registerPanel(entry)` / `ctx.ui.slots` | 向命名插槽注册面板,返回注销函数;`slots` 为已知插槽名 |
| `ctx.t(key, params?)` | 插件命名空间翻译(`plugin.<name>.<key>`) |
| `ctx.locale` | 当前界面语言 |
| `ctx.log.info / warn / error` | 带 `[aw-plugin:<name>]` 前缀的 console |
| `ctx.dispose()` | 卸载:广播 `client:destroy` → 回收订阅 → 移除 `root()`(幂等) |

### 通配与不可达的订阅(高频坑)

| 写法 | 结果 |
|---|---|
| `ctx.on('daq.reading', fn)` | 正确:订阅 scene 事件 `daq.reading` |
| `ctx.on('event:*', fn)` | 正确:唯一通配写法,收全部 scene 事件 |
| `ctx.on('*', fn)` | **死订阅**:不会触发 |
| `ctx.on('event:line.start', fn)` | **死订阅**:只订阅同名 scene 事件 `event:line.start`,而它不存在 |
| `ctx.on('daq:sample', fn)` | **死订阅**:服务端钩子不过桥到浏览器 |
| `ctx.hooks.on('page:change', fn)` | 正确:生命周期钩子走 `ctx.hooks` |
| `ctx.on('client:init', fn)` | **死订阅**:生命周期钩子不在 `ctx.on` 面上 |

服务端钩子(`daq:sample`、`daq:frame`、`dcw:write`、`line:start\\|stop`)**永远不会到达浏览器**;浏览器能收到的只有 scene 事件(经 TownBus/WS 桥)。反过来,`page:change` / `i18n:changed` 也只存在于浏览器侧。

### 面板与页面插槽

宿主页面在任意位置放 `<workshop-plugin-slot slot-name="…" />` 即接收注入;`ctx.ui.slots` 当前为:

| 插槽 | 落点 |
|---|---|
| `plugins.page` | 插件管理页(默认落点) |
| `settings.plugins` | 系统设置 → 运行配置 → 插件管理区下方 |
| `dashboard.widgets` | 仪表盘页尾 |

`registerPanel` 返回 `unregisterPanel` 注销函数;面板的 `mount(el)` 可以返回清理函数(面板卸载时调用),也可以抛错 —— 单面板异常由插槽隔离,不影响其他面板与页面。

### 卸载语义

- `ctx.dispose()` 由 **`pagehide`** 触发(导航离开 / 进入 bfcache;切标签页**不**触发)。它会广播 `client:destroy`、回收插件自己的订阅、移除 `root()`。
- `ctx.dispose()` 本身**不注销面板** —— 面板回收由 loader 在停用/热重载时调用 `unregisterPlugin(name)` 完成。
- 热通道双保险:WS `plugins.reloaded` 事件(即时)+ 15s 轮询 diff。

## 九、路由与鉴权

`ctx.route(method, path, handler)` 立即注册并返回 **boolean**;manifest 里的 `routes[]` 在 `setup` 返回之后才注册。两者最终都挂在同一个路由表上:

```
GET /api/plugins/<插件名>/health   ←  ctx.route('GET', '/health', handler)
                                   ←  routes: [{ method: 'GET', path: '/health', handler }]
```

- 匹配是 **exact-match**,路径统一以 `/` 开头;没有通配段、没有子路由匹配。
- handler 收到 h3 的 `event`;JSON body 已由平台转发层预读并挂在 **`event.awBody`** 上(插件无需导入 h3)。
- handler 的返回值由 nitro 序列化为 JSON;抛错会变成 500 信封(带插件归属的日志),不裸传堆栈。
- **鉴权由声明式 `auth` 字段统一执行**,在进入 handler **之前**校验,对 `routes[]` 与 `ctx.route()` 一视同仁:

| `auth` | 行为 |
|---|---|
| `'none'`(默认) | 不校验,直接进入 handler |
| `'user'` | 需要有效用户 token,否则 401 |
| `'admin'` | 需要管理员,否则 401 |
| `'agent-or-user'` | 接受 Agent 身份或用户 token |

**不要把鉴权写进 handler**:`resolveUser(event)` 不可从插件导入,`ctx` 上也没有它。要鉴权就声明 `auth`。

```js
ctx.route('GET', '/report', () => ({ plugin: ctx.name, at: new Date().toISOString() }))

ctx.route('POST', '/threshold', (event) => {
  const v = Number(event.awBody?.threshold)   // 宿主已预读 JSON body
  if (!Number.isFinite(v)) return { ok: false, error: 'threshold 必须是数字' }
  ctx.kv.set('threshold', v)
  return { ok: true, threshold: v }
})
```

## 十、工具与团队开关

`ctx.omp.registerTool(def)` 注册的工具出现在全部 harness 的工具面上(omp 经 RPC `set_host_tools` 下发 / 其余引擎经 MCP 桥 `tools/list` / pi 经工具文件 / mock 经 REST invoke 直调),注册表变化会**热重发**给在跑的会话,无需重启或重 spawn 子进程。

```js
ctx.omp.registerTool({
  name: 'sensor_log',
  label: '传感器标定',
  description: '查询/登记传感器标定结论',
  parameters: { type: 'object', properties: { sensor: { type: 'string' } }, required: ['sensor'] },
  roles: ['lead', 'worker'],          // 仅这两个字面量;缺省=两者都可用
  handler: async (args, agent) => ({ text: `${agent.role}@${agent.channelId}: ${args.sensor}` }),
})
```

参数 schema 里**不要开 `url` / `host` 这类注入口** —— 插件工具的参数直接来自模型,任何"让模型指定目标地址"的字段都会变成 SSRF 面。

### 团队 / Channel 级开关

全局启停之外,每个团队(Channel)还有独立的插件开关组(由 `channel_plugins` 表承载):

- **建队时勾选**:`POST /api/workshop/teams` 接受 `plugins: [{ name, enabled }]`,以 team id 为键落库,部署时传导到 Channel;
- **随时切换**:`GET|PUT /api/workshop/channels/:id/plugins`、`GET|PUT /api/workshop/teams/:id/plugins`(body 为 `{ plugins: [{ name, enabled }] }`,全量替换语义,未知/停用插件名忽略);
- **语义**:无显式行 = 未配置 → 全部启用插件对该团队可见(向后兼容);写入显式行后按行过滤 —— **被关闭插件的工具不注入该团队的 Agent,dispatch 同源拒绝**;
- **前端**:workshop teams 页(创建勾选 + 团队弹层)。

## 十一、完整示例

```js
// index.mjs —— 服务端入口(零导入依赖;ctx 由宿主注入)
export default {
  name: 'my-plugin',
  version: '1.0.0',
  description: '示例:越限计数 + 自有 API + 设置分区 + Agent 工具',
  auth: 'user',
  client: './client.mjs',
  configGroups: [
    { id: 'default', label: '我的插件', description: '基础配置', order: 500 },
    { id: 'advanced', label: '高级', collapsed: true },
  ],
  settings: [
    { key: 'threshold', type: 'number', default: 180, min: 0, max: 5000, group: 'default',
      label: '告警阈值', description: '保存即热生效' },
    { key: 'endpoint', type: 'string', default: 'http://127.0.0.1:8080', group: 'advanced',
      label: '外部服务地址' },
  ],
  routes: [
    { method: 'GET', path: '/health', handler: () => ({ ok: true }) },
  ],

  async setup(ctx) {
    ctx.logger.info(`装载完成(scope=${ctx.scope}, sdk=${ctx.sdkVersion})`)

    const threshold = () => Number(ctx.config.get('plugins.my-plugin.threshold')) || 180

    // 1) 数采下发级样本:越限计数落插件私有 KV
    ctx.hooks.on('daq:sample', (s) => {
      if (typeof s?.value === 'number' && s.value > threshold())
        ctx.kv.bump(`alarm:${s.nodeId}`)
    })

    // 2) scene 事件订阅(ctx.events 自动补 event: 前缀)
    ctx.events.on('daq.alarm', (a) => ctx.logger.warn('告警', a?.nodeId))
    ctx.events.on('permissions.changed', (p) => ctx.logger.info('授权变更', p?.userId))

    // 3) 全事件审计:服务端通配是裸 '*',回调收 { type, payload }
    ctx.hooks.on('*', ({ type }) => ctx.logger.debug('event', type))

    // 4) setup 之后才会注册 routes[];这里用 ctx.route 立即注册(返回 boolean)
    ctx.route('POST', '/threshold', (event) => {
      const v = Number(event.awBody?.threshold)
      if (!Number.isFinite(v)) return { ok: false, error: 'threshold 必须是数字' }
      ctx.kv.set('threshold', v)
      return { ok: true, threshold: v }
    })

    // 5) 定时器 + 清理:同一个宿主回收队列,关机与热重载都会执行
    ctx.timer.setInterval(() => ctx.kv.set('heartbeat', new Date().toISOString()), 5000)
    ctx.onDispose(() => ctx.logger.info('插件已清理'))

    // 6) Agent 工具(roles 仅 'lead' | 'worker')
    ctx.omp.registerTool({
      name: 'my_alarm_report',
      description: '读取本插件记录的越限告警计数',
      parameters: { type: 'object', properties: { nodeId: { type: 'string' } }, required: ['nodeId'] },
      roles: ['lead', 'worker'],
      handler: async (args, agent) => ({
        text: `${args.nodeId} 告警 ${ctx.kv.get(`alarm:${args.nodeId}`) ?? 0} 次(by ${agent.role})`,
      }),
    })
  },
}
```

`client.mjs` 见 §8;`i18n.json` 见 §5。装到哪个作用域、怎么启停见 §1。

## 十二、故障排查

| 现象 | 原因 / 处理 |
|---|---|
| 改了插件代码没生效 | 宿主没有插件目录 watcher:触碰 `<home>/plugins-state.json` 或 `aw plugin enable/disable` 往返一次触发重载(重载会带 `?t=` 破缓存);核心 `server/`、`shared/` 改动仍需重启进程 |
| 装载失败看不到 | `aw plugin list` **不显示**装载失败。用 `GET /api/workshop/plugins`(返回 `{ plugins, failures, initedAt }`,**没有 `{code,data}` 信封**),或看启动日志里的 `[aw-plugins] 装载失败 …` |
| 插件路由 404 | exact-match;检查 method 与 path 前导 `/`,以及插件是否处于启用态(停用插件的路由已从路由表移除) |
| 插件路由 401 | 入口声明了 `auth: 'user' \| 'admin' \| 'agent-or-user'`,请求未带有效凭据;开放接口才用 `auth: 'none'` |
| 客户端面板没出现 | 浏览器 console 看 `[aw-plugins]` 告警;确认 manifest `hasClient: true`(即 manifest 里声明了 `client:'./client.mjs'`)且插件 `enabled !== false` |
| 客户端订阅不触发 | 检查是不是踩了 §8 的坑(`ctx.on('*')`、`ctx.on('event:line.start')`、`ctx.on('daq:sample')`,或把生命周期钩子交给 `ctx.on`) |
| 设置项没渲染 | 声明里缺 `default` 会被跳过并告警;`select` 的 `default` 必须在 `options` 里;`key` 只允许字母数字与 `-` `_` |
| 设置值改了没生效 | 确认读的是 `ctx.config.get('plugins.<插件名>.<key>')`(短 key 读不到) |
| `permissions:changed` 钩子不触发 | 该名字不存在;用 `ctx.events.on('permissions.changed', fn)` |
| KV 数据"丢了" | KV 在 `<配置根>/data/plugins/<插件名>/kv.json`,不在插件目录;写入 200ms 防抖落盘,强杀进程会有极小丢失窗口 |
| `ctx.api` 401 | 鉴权端点需 `ctx.api.setToken(token)`;免鉴权端点(manifest / ping)无需 |

**信任模型**:插件是任意 node 代码,与 aw commands 同级 —— 只安装/启用你信任的插件。

### 已知边界(有意为之,不是缺陷)

- **钩子是观察语义**:v1 没有 veto / 拦截 / 改写能力,写控联锁完整性优先。
- **`ctx.http` 守卫只校验协议**(仅 http/https),**不限制 host**;需要白名单请在插件内自行校验(内置 `diag-bridge` / `rag-bridge` 就是这么做的)。
- **`ctx.t(key, params)` 的 `params` 当前被忽略**(不做插值);需要拼字符串请在插件里自己做。
- **`ctx.kv` 没有 `reset()`**,只有 `get / set / all / bump`。
- **服务端与浏览器的订阅面不互通**:服务端钩子不过桥,浏览器事件也不上服务端。
- **浏览器新启用插件注入延迟 ≤15s**(WS 可用时即时)。
- **`server:close` / `onDispose` 依赖优雅关闭信号**,Windows 强杀进程不触发。
- **`aw plugin list` 只做目录扫描**,不反映装载失败与运行态健康。

## 十三、发布前验证清单

1. `aw plugin list` 三个作用域都能看到;C 端插件显示 `+client`;启停开关往返后路由/工具/面板同步生灭(连击不丢事件)。
2. `GET /api/workshop/plugins` 的 `failures` 为空;`GET /api/plugins/manifest` 的 `settingsCount` / `hasClient` / `hasI18n` 与声明一致。
3. 设置页出现本插件的配置分区(未声明分组的字段落在 `plugin-<插件名>` 分区),改值后 `ctx.config.get('plugins.<插件名>.<key>')` 立即读到新值。
4. 语言切换:面板标题/文案跟随;`i18n:changed` 清理函数无泄漏。
5. 工具经 `GET /api/workshop/agent-tools/list` 可见;参数里没有 `url` / `host` 注入口;团队开关关闭后工具消失且 dispatch 拒绝。
6. 触发一次热重载(enable/disable 往返),确认 `plugins:reloaded` 到达插件、KV 与定时器无泄漏。
