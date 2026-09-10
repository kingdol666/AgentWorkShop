# AgentWorkShop 插件开发指南(完整版)

> 插件 = 配置根 `plugins/<name>/` 下的一个自包含目录。一个目录同时增强**服务端**
> (工具/API/数据/事件)与**浏览器**(面板组件/多语言/设置 UI),放入即装载,
> 启停即热重载。本文是唯一权威参考;`docs/site/plugins/` 的分页文档与本文同源。
>
> 适用版本:v0.7.29+(插件系统 v2:前端组件注入 / 插件设置 / 插件 i18n / 运行时服务面)

## 一、目录结构与快速开始

```bash
aw plugin create my-plugin            # 脚手架到 ~/.AgentWorkShop/plugins/(用户级)
aw plugin create my-plugin --project  # 或项目级 <repo>/.AgentWorkShop/plugins/
aw plugin list                        # 查看已装插件
```

```
plugins/my-plugin/
├── index.mjs      # 服务端入口(必需): export default { name, setup(ctx), … }
├── client.mjs     # 浏览器增强(可选): export function setup(ctx)
├── i18n.json      # 多语言消息包(可选): { "zh-CN": {...}, "en": {...} }
└── kv.json        # 运行态存储(自动生成,勿手改)
```

三作用域发现:builtin(`<包根>/server/plugins-builtin`)→ project(`<repo>/.AgentWorkShop/plugins`)→ user(`~/.AgentWorkShop/plugins`),同名先到先得(builtin 优先)。启停状态在 `<配置根>/plugins-state.json`,Web 设置页 / `aw plugin enable|disable` 写入后服务自感知热重载。

## 二、插件契约(index.mjs)

```js
export default {
  name: 'my-plugin',         // 必填,全局唯一
  version: '1.1.0',
  description: '…',
  auth: 'user',              // 插件 API 转发层鉴权:none(默认)|user|admin|agent-or-user
  client: './client.mjs',    // 可选:浏览器入口(loader 动态 import)
  settings: [ /* 可选:插件设置声明(见 §4) */ ],
  routes: [                  // 可选:声明式路由,挂 /api/plugins/<name>/**
    { method: 'GET', path: '/health', handler: () => ({ ok: true }) },
  ],
  async setup(ctx) { /* 服务端生命周期(见 §3) */ },
}
```

装载期宿主做形态校验(`validatePluginModule` + `validatePluginSettings`);设置声明校验失败的条目跳过并告警,不阻断装载。装载失败进 `failures`(GET /api/workshop/plugins 可见),错误隔离绝不拖垮主服务。

## 三、生命周期(全周期注入矩阵)

| 阶段 | 服务端 | 浏览器 |
|---|---|---|
| 装载 | 动态 import(`?t=` 防缓存)→ 校验 → `setup(ctx)` | loader(`app/plugins/aw-plugins.client.ts`)拉 manifest → 拉 i18n 包 → 动态 import client → `setup(ctx)` |
| 注入 | 路由/工具/驱动/模板/处理器即时生效;设置描述符并入 SystemConfigService | `client:init` 钩子;面板经 `ctx.ui.registerPanel` 注入页面插槽 |
| 运行 | `event:*` / `daq:sample` / `daq:frame` / `dcw:write` / `line:start|stop` / `plugins:reloaded` | `event:*`(与 WS 同源) / `page:change`(路由切换) / `i18n:changed`(语言切换) |
| 卸载 | 状态文件变化 → 全量 dispose(`ctx.onDispose`)→ 解绑 hooks → 注销工具 → 重装载 | `plugins.reloaded` WS + 15s 轮询 diff → `ctx.dispose()`(订阅回收 + 面板注销 + `client:destroy`) |
| 关机 | `server:close` 钩子 + 逐插件 dispose | 页面 `pagehide` 自动 dispose |

热重载语义:修改插件目录文件后,触碰 `plugins-state.json`(或 Web 启停开关)即触发全量重装载;重装载期间的状态再变化(如 disable→enable 连击)由禁用集快照比对自动补跑,事件不丢失。核心代码(server/ shared/)改动需重启。浏览器侧新启用插件 ≤15s(或 WS 即时)注入。

## 四、插件设置(前端设置页自动渲染)

在 `index.mjs` 导出 `settings` 声明数组,宿主装载后并入 `SystemConfigService`:

```js
settings: [
  { key: 'base_url', type: 'string',  default: 'http://127.0.0.1:8770',
    labelKey: 'plugin.my-plugin.settings.base_url',   // i18n 键(见 §5)
    label: '服务地址(回退文案)', description: '保存即热生效' },
  { key: 'max_turns', type: 'number', default: 0, min: 0, max: 2000, label: '最大轮数' },
  { key: 'auto_enabled', type: 'boolean', default: false, label: '自动模式' },
  { key: 'mode', type: 'select', default: 'a', options: ['a', 'b'], label: '模式' },
],
```

- **键编址**:强制 `plugins.<插件名>.<key>`,与全局 schema 键同一编址空间;插件停用即从设置页消失。
- **渲染**:系统设置 → 运行配置 →「插件」分组自动出现(admin/editor 可见),来源标签(config.yml/runtime)与重置按钮与其他设置一致。
- **读取**:`ctx.config.get('plugins.my-plugin.base_url')`(保存即热生效;可再落 kv 兜底)。运行时覆盖持久化在 `<配置根>/runtime-settings.json`,PATCH `/api/system/settings` 按同一份描述符校验。
- **迁移**:0.7.28 前写死在 `shared/config/schema.json` 的 `plugins.kb.*`/`plugins.diag.*` 已由插件声明取代;服务启动时一次性搬移旧覆盖到新键(新键未注册时保留旧键等下一次 pass,绝不丢数据)。

## 五、插件 i18n(根目录 i18n.json)

```json
{
  "zh-CN": { "settings": { "base_url": "服务地址" }, "panel": { "title": "我的面板" } },
  "en":    { "settings": { "base_url": "Service URL" }, "panel": { "title": "My panel" } }
}
```

- 装载期宿主解析 `i18n.json`(坏文件忽略不阻断),`GET /api/plugins/i18n` 汇编全部启用插件的消息包(免鉴权;**只放 UI 文案,严禁放敏感信息**)。
- 浏览器 loader 拉取后:① 合并进 vue-i18n 命名空间 `plugin.<插件名>` —— 宿主组件(设置页标签 labelKey、面板标题 titleKey)直接解析;② `ctx.t(key)` 提供自解析翻译(`ctx.t('panel.title')` → `plugin.my-plugin.panel.title`,未命中回落声明键)。
- 语言切换广播 `i18n:changed` 钩子,面板监听它重渲染(宿主渲染的标题自动跟随)。
- manifest 暴露 `hasI18n`/`settingsCount`/`hasClient` 供前端展示。

## 六、服务端 ctx 全参考

| 面 | 签名 | 说明 |
|---|---|---|
| 身份 | `ctx.name/scope/dir/sdkVersion` | 插件身份 |
| 钩子 | `ctx.hooks.on/once/off/emit` | 宿主生命周期 + 平台事件;热重载自动解绑 |
| 日志 | `ctx.logger.debug/info/warn/error` | 插件名前缀 |
| 配置 | `ctx.config.get(key)/all()/onChange(fn)` | 系统配置(含本插件 settings)热生效读取 |
| 存储 | `ctx.kv.get/set/all/bump` | 运行态,防抖落盘 `data/plugins/<name>/kv.json` |
| 定时 | `ctx.timer.setInterval/setTimeout` | 关机自动回收 |
| 清理 | `ctx.onDispose(fn)` / `ctx.subscriptions.add` | 卸载回收 |
| 路由 | `ctx.route(method, path, handler)` | 挂 `/api/plugins/<name>/**`,鉴权按 `auth` 声明 |
| 平台 | `ctx.api` | 平台 REST 客户端(自环 origin;自动解信封) |
| 网络 | `ctx.http.get/post(url, {timeoutMs, headers})` | 出站守卫(仅 http/https);headers 透传可带鉴权 |
| 事件 | `ctx.events.on/off(type, fn)` | scene 实时事件糖(=hooks `event:<type>`) |
| 工具 | `ctx.omp.registerTool({name,label,description,parameters,roles,handler})` | Agent 工具注入(全 harness 共享;受团队/Channel 插件开关过滤) |
| 数采 | `ctx.daq.registerDriver/registerProcessor/registerTemplate/onFrame/onSample/query/nodes` | 驱动/处理器/模板注册 + 时序查询 + 节点元数据 |
| 权限 | `ctx.permissions.lineMode/visibleLineIds/listGrants/setGrants` | 产线授权查询与管理 |
| **服务** | `ctx.services.get('daq'\|'lines'\|'channels'\|'plugins')` / `.provide(name, getter)` / `.names()` | **后端运行时对象面**:惰性取数(daq 查询/产线/频道与成员/插件清单);`provide` 以 `<插件名>.<name>` 前缀跨插件供服务 |

## 七、浏览器 client.mjs(ctx 面参考)

```js
export function setup(ctx) {
  ctx.ui.registerPanel({
    slot: 'plugins.page',        // 插槽名(见下)
    name: 'my-panel',            // 同插件内唯一
    titleKey: 'panel.title',     // 解析 plugin.my-plugin.panel.title(或静态 title)
    order: 10,
    mount(el) {                  // el = 面板容器(标题由插槽渲染)
      el.append(ctx.el('p', {}, [ctx.t('panel.hello')]))
      const timer = setInterval(refresh, 30_000)
      return () => clearInterval(timer)   // 清理函数(卸载时调用)
    },
  })
}
```

| 面 | 说明 |
|---|---|
| `ctx.ui.registerPanel(entry)` | 向命名插槽注册面板;返回注销函数;`ctx.dispose` 自动回收 |
| `ctx.t(key, params?)` | 插件命名空间翻译(i18n.json 消息树) |
| `ctx.locale` / `i18n:changed` | 当前语言 / 语言切换广播 |
| `ctx.fetch(path, opt)` | 平台 API 助手(自动带 cookie token、解信封) |
| `ctx.on(type, fn)` | scene 事件订阅(`*` 通配;pagehide 自动回收) |
| `ctx.el / ctx.mount / ctx.root / ctx.log` | DOM 助手 / 挂载 / 兜底根节点 / 日志 |
| `ctx.dispose()` | 卸载:订阅回收 + 面板注销 + `client:destroy` |

**内置插槽**:页面在任意位置放 `<PluginSlot slot-name="…" />` 即接收注入;当前宿主已接入:
- `plugins.page` —— 插件管理页卡片上方(默认落点)
- `settings.plugins` —— 系统设置 → 插件管理区下方
- `dashboard.widgets` —— 仪表盘页尾

新增插槽只需在页面放 `<workshop-plugin-slot slot-name="my.slot" />`(注册表 `usePluginPanels()` 全局单例,无需改动)。

## 八、工具与团队开关

`ctx.omp.registerTool` 注册的工具出现在全部 harness 的工具面(omp RPC 下发 / 其余引擎经 MCP 桥 tools/list / pi 工具文件 / mock 经 REST invoke 直调)。Channel/AgentTeam 级插件开关(`GET|PUT /api/workshop/channels/:id/plugins`、`/api/workshop/teams/:id/plugins`)关闭的插件:工具不注入该团队、dispatch 同源拒绝;建队 `POST /teams` 可带 `plugins` 勾选,部署时传导到 Channel。

## 九、完整示例(rag-bridge 摘录)

```js
// index.mjs(服务端)
export default {
  name: 'rag-bridge', version: '1.1.0', auth: 'user',
  client: './client.mjs',
  settings: [
    { key: 'base_url', type: 'string', default: 'http://127.0.0.1:8770',
      labelKey: 'plugin.rag-bridge.settings.base_url', label: 'rag-knowledge 后端地址' },
    { key: 'token', type: 'string', default: '',
      labelKey: 'plugin.rag-bridge.settings.token', label: 'API Token' },
  ],
  async setup(ctx) {
    const base = () => ctx.config.get('plugins.rag-bridge.base_url')
    ctx.omp.registerTool({ name: 'kb_search', /* … */ handler: async () => ({ text: '…' }) })
    ctx.route('GET', '/health', async () => ({ ok: true }))
  },
}

// client.mjs(浏览器)—— 见 §7;i18n.json —— 见 §5
```

## 十、验证清单(发布前)

1. `aw plugin list` 可见、无 failures;启停开关往返后路由/工具/面板同步生灭(连击不丢事件)。
2. 设置页出现本插件设置,改值后 `ctx.config.get` 立即读到新值。
3. 语言切换:面板标题/文案跟随;`i18n:changed` 清理函数无泄漏。
4. 工具经 agent-tools/list 可见、参数无 url/host 注入口;团队开关关闭后工具消失且 dispatch 拒绝。
