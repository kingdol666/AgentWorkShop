# 插件 ctx 服务面速查

> 完整参考:`docs/plugins.md` §六(服务端 ctx)、§七(事件)、§八(浏览器 ctx)、§九(路由与鉴权)。本文件只列开发时最常用、最容易错的点。

## 1. 生命周期

1. 宿主扫描 `builtin → project → user`,同名先到先得。
2. 形态校验(`name` 必填、`setup` 函数、`client` 字符串、`settings` 数组)。
3. `await setup(ctx)`;成功后注册 `routes[]`。
4. 运行期事件/路由/驱动/工具生效。
5. 停用/热重载:逐插件 `dispose` → 解绑 hooks → 清路由 → 重装载。

`setup` 抛错会回滚该插件的半注册状态,记入 `failures`;不影响其它插件。

## 2. 常用 ctx

| ctx | 用法 | 注意 |
| --- | --- | --- |
| `ctx.name/version` | 插件标识 | — |
| `ctx.logger` | `debug/info/warn/error` | 自动加 `[aw-plugins] [<name>]` 前缀 |
| `ctx.kv` | `get/set/all/bump` | 落 `<configRoot>/data/plugins/<name>/kv.json`;无 `reset`;内存为准,200ms 防抖原子落盘 |
| `ctx.config` | `get/all/onChange`、`defineGroup/defineField/removeGroup/removeField/groups/fields` | 有效配置只读;变更订阅 |
| `ctx.timer` | `setInterval/setTimeout` | 自动进回收队列,热重载/关机清理 |
| `ctx.onDispose(fn)` | 清理订阅/连接 | 热重载与关机都会调用 |
| `ctx.subscriptions.add(d)` | 同上 | 与 timer 共用队列 |
| `ctx.route(method,path,handler)` | 挂 `/api/plugins/<name><path>` | 精确匹配,不支持路径参数;返回 boolean |
| `ctx.api` | 平台 REST 客户端(自环 origin) | 自动解信封;鉴权端点先 `ctx.api.setToken(token)` |
| `ctx.http` | `get/post(url,opt)` | 只校验 http/https;默认 8s;headers 透传;受 SSRF 白名单约束 |
| `ctx.events` | `on/off(type,fn)` | scene 事件糖;内部订阅 `event:<type>` |
| `ctx.paths` | `home/configRoot/dataDir` | `ctx.dataDir` = 插件 KV 目录 |
| `ctx.daq` | `registerDriver/registerProcessor/registerTemplate/registerDecoder/onFrame/onSample/query/nodes` | 详见下节 |
| `ctx.dcw` | `registerWriteDriver` | 与读驱动对称 |
| `ctx.omp` | `registerTool({name,label,description,parameters,roles,handler})` | 同步进 tool_registry |
| `ctx.services` | `names/get/provide` | `get('daq'|'lines'|'channels'|'plugins')`;`provide` 自动加 `<name>.` 前缀 |
| `ctx.twin` | Provider Registry 桥 | 物理主干/场景包/求解器;见 docs/plugins.md §六 |
| `ctx.permissions` | `lineMode/visibleLineIds/listGrants/setGrants` | 产线授权查询/管理 |

## 3. ctx.daq / ctx.dcw

```js
ctx.daq.registerDriver(driver)              // 读驱动;任意 kind
ctx.daq.registerWriteDriver                // 不存在;写驱动在 ctx.dcw
ctx.dcw.registerWriteDriver(driver)         // 写驱动
ctx.daq.registerDecoder(name, fn)           // 同步纯函数
ctx.daq.registerProcessor(kind, name, fn)   // kind: 'vector'|'image'|其它→any;只跑帧,不跑标量样本
ctx.daq.registerTemplate(def)               // 节点模板(内存态)
ctx.daq.onFrame(fn) / onSample(fn)          // 便捷钩子
ctx.daq.query({ ... })                      // 时序查询直通(queryTagged)
ctx.daq.nodes()                             // 节点元数据快照(含 lineId)
```

注册走 `globalThis.__daqPluginExt` / `__dcwPluginExt` 队列,DAQ/DCW 侧 `plugin-bridge` 接管回放;热重载会清空插件驱动与解码器并重装。**处理器/模板目前不会自动清退**(代码缺口),停用后仍可能生效到重启;需要严格卸载时用维护窗口重启或换 key。

## 4. 事件

服务端:`daq:sample`、`daq:frame`、`dcw:write`、`line:start|stop`、`config:changed`、`plugins:reloaded`、`server:close`、`event:<type>`、通配 `*`。

- `daq:sample` 载荷是降采样后的样本;`daq:frame` 只含元数据/指标/预览,不含 blob。
- 高频事件不要无脑全订;钩子内不要做长耗时同步操作。
- 每个订阅都要有对应的清理(热重载/关机)。

## 5. 设置与配置分组

声明式 `settings[]` 条目:

```js
{ key: 'base_url', type: 'string', default: 'http://127.0.0.1:8770',
  label: '服务地址', description: '保存即热生效' }
```

- `key` 匹配 `^[A-Za-z0-9_-]+$`;支持 `string/number/boolean/select`。
- 平台设置键是 `plugins.<name>.<key>`;GET 出口会打码含 password/secret/token 的键。
- 插件内部读有效配置用 `ctx.config.get(key)`,不要直接读 `plugins-state.json`。
- 运行期可 `ctx.config.defineGroup/defineField` 动态加;`removeGroup/removeField` 只移除声明。

## 6. 路由与鉴权

```js
routes: [{ method: 'GET', path: '/health', auth: 'user', handler: () => ({ ok: true }) }]
```

- 挂载路径 `/api/plugins/<name><path>`;精确匹配,不支持 `/detail/:id`,用查询串。
- `auth` 逐路由声明:`none|user|admin|agent-or-user`;默认跟随插件 `auth`。
- 返回对象会被平台包成信封;需要透传字段就嵌进返回体。

## 7. 工具注册

```js
ctx.omp.registerTool({
  name: 'my_tool',
  description: '…',
  parameters: { type: 'object', properties: { ... }, required: [...] },
  roles: ['lead', 'worker'],
  handler: async (args, ctx2) => ({ ... }),
})
```

- 工具进 `tool_registry`,`GET /api/workshop/tools` 可查;插件停用后 `available=false`,Channel 调用会被拒。
- `roles` 在注册时冻结;需要热切换的闸门在 handler 里现读 `ctx.config`,不要靠重注册。
- 名字避免与内置/其它插件冲突;前缀化命名更安全。

## 8. 浏览器增强(client.mjs)

- 由 `/api/plugins/client/<name>` 下发;`ctx.ui.registerPanel` 注入页面插槽。
- 事件通过 WS 同源分发;高频通配在玻璃页/后台页可能不可达,不要在 client 做数据总线。
- `pagehide` 自动 `ctx.dispose()`;停用插件立即卸载面板。

## 9. 常见坑

| 坑 | 现象 | 处理 |
| --- | --- | --- |
| 插件入口有裸相对导入 | dev 下按输出目录解析,越出盘符根 | 入口保持自包含;确需引宿主模块先读 docs/plugins.md §十二 |
| 直接读 `plugins-state.json` 改配置 | 与平台设置服务不一致 | 用 `ctx.config` |
| `ctx.kv` 当数据库 | 无事务/无查询 | 只放小状态;数据走平台 API |
| 路由带路径参数 | 精确匹配不到 | 改查询串 |
| 工具 `roles` 想热切换 | 注册时冻结 | handler 内现读设置 |
| 事件订阅无清理 | 热重载后重复触发 | `ctx.onDispose`/`subscriptions` |
| `ctx.http` 打内网 | SSRF 守卫拒绝 | 显式白名单/平台配置,不要绕过 |
| 停用插件后驱动还在 | 旧进程未重载 | 确认 `aw_plugin_list` 与驱动目录;热重载会清空插件驱动 |
