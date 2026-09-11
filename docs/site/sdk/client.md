# 浏览器端 SDK(createClientContext)

插件 `client.mjs` 是**自包含 ESM**(无裸导入 —— 浏览器原生动态加载),导出 `setup(ctx)`。
应用启动时,loader(`app/plugins/aw-plugins.client.ts`)拉取插件清单并动态装载,
事件与浏览器 WS 完全同源。

## 装载契约

- 入口必须在插件定义里声明:`client: './client.mjs'`。
- loader 经 `GET /api/plugins/client/<插件名>` 取回脚本,再动态 `import` 它。
- 脚本必须导出 `setup(ctx)`;缺少时 loader 只告警并跳过该插件。
- 单插件装载失败仅 console 告警,**不影响应用与其他插件**。

## 创建(宿主调用;插件只写 setup)

```js
import { createClientContext } from 'agentworkshop/sdk/client'

// 宿主侧装配(示意);插件作者只需要写 client.mjs 的 setup(ctx)
const listeners = new Set()
const townBus = {
  subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn) },
}

const ctx = createClientContext({
  name: 'my-plugin',
  // 事件桥:宿主把 WS 总线的每条消息交给 dispatch
  eventBridge: dispatch => townBus.subscribe(e => dispatch(e.type, e.payload)),
  baseUrl: '',                              // 同源;跨域集成时可填平台地址
  ui: { slots: ['plugins.page'], registerPanel: () => () => {} },
  t: key => `plugin.my-plugin.${key}`,      // 宿主传入真正的翻译助手
  getLocale: () => 'zh-CN',
})
```

## ctx 成员

| 成员 | 说明 |
|---|---|
| `ctx.name` / `ctx.sdkVersion` | 插件名与 `CLIENT_SDK_VERSION` |
| `ctx.on(type, fn)` | 订阅 **scene 实时事件**:`type` 传**场景事件名本身**(`daq.reading` / `daq.frame` / `daq.alarm` / `daq.alarm.changed` / `dcw.written` / `daq.node.changed` / `device.updated` / `ops.log` …),内部装到 `event:<type>`;返回退订函数,**pagehide 时自动回收**。唯一通配写法是字面量 `'event:*'` |
| `ctx.fetch(path, opt?)` | 同源平台 API(JSON;自动解 `{data}` 信封;非 2xx 抛错;自动携带 cookie 里的平台 token) |
| `ctx.el(tag, attrs, children)` | DOM 构建(`style`/`class`/`on*` 事件 attrs 特判) |
| `ctx.root()` | 插件私有挂载点 `#aw-plugin-<name>`(右下角,懒创建) |
| `ctx.mount(target, node)` | 挂载到任意选择器 / 元素(缺失时落到 root) |
| `ctx.ui` | UI 注入面:`slots` 与 `registerPanel(entry)` |
| `ctx.t(key, params?)` | 插件命名空间翻译:`ctx.t('panel.title')` → `plugin.<name>.panel.title`(消息来自插件根目录 `i18n.json`;未命中回落原键)。**`params` 目前被忽略,不做插值** |
| `ctx.locale` | 当前界面语言(只读 getter);语言切换广播 `i18n:changed` |
| `ctx.log` | 前缀 console:`info` / `warn` / `error`(**没有 `debug`**) |
| `ctx.hooks` | 本地 `HookBus`:`client:init` / `page:change` / `i18n:changed` / `client:destroy` 走这里**直订**(无 `event:` 前缀) |
| `ctx.dispose()` | 卸载:广播 `client:destroy` → 跑本地 disposables → 移除 `root()`。**幂等**,绑定在浏览器 `pagehide` 上;不负责注销面板(loader 在停用 / 热重载时做) |

## 事件订阅规则

| 想收什么 | 正确写法 | 错误写法及其后果 |
|---|---|---|
| scene 事件 | `ctx.on('daq.reading', fn)` | `ctx.on('event:line.start', fn)` → 二次加前缀成 `event:event:line.start`,永不触发 |
| 全部 scene 事件 | `ctx.on('event:*', fn)` | `ctx.on('*', fn)` → 永不触发 |
| 客户端本地钩子 | `ctx.hooks.on('page:change', fn)` | `ctx.on('page:change', fn)` → 永不触发 |
| 服务端钩子(`daq:sample` 等) | 不支持 | 服务端钩子从不下发到浏览器 |

`ctx.on` 注册的订阅会在浏览器 `pagehide` 时自动回收。**注意**:回收绑定的是 `pagehide`
(导航离开 / bfcache 入栈),不是「标签页隐藏」—— 切标签页不会让插件失效。

## 完整示例

```js
export function setup(ctx) {
  const badge = ctx.el('div', {
    style: 'padding:8px 12px;border:1px solid #35e0a0;border-radius:10px;color:#35e0a0',
  }, ['samples: 0'])
  ctx.root().append(badge)

  let n = 0
  ctx.on('daq.reading', () => { badge.textContent = `samples: ${++n}` })   // scene 事件
  ctx.on('event:*', (payload) => ctx.log.info('scene 事件', payload))     // 唯一通配写法

  ctx.hooks.on('page:change', ({ path }) => ctx.log.info('page →', path)) // 本地钩子:直订

  // 消费平台 API(同源;cookie 鉴权):产线列表是 { lines, states },不是数组
  ctx.fetch('/api/workshop/dcw/lines').then(({ lines }) => ctx.log.info('产线数', lines.length))
}
```

## UI 注入 ctx.ui.registerPanel

```js
let samples = 0
ctx.on('daq.reading', () => { samples += 1 })

const off = ctx.ui.registerPanel({
  slot: 'dashboard.widgets',        // 'plugins.page' | 'settings.plugins' | 'dashboard.widgets'
  name: 'my-widget',
  title: '采样统计',
  titleKey: 'plugin.my-plugin.widget.title',   // 有 titleKey 时优先
  order: 100,                        // 越小越靠前,缺省 100
  mount(el) {
    el.textContent = `samples: ${samples}`
    const tick = setInterval(() => { el.textContent = `samples: ${samples}` }, 1000)
    return () => clearInterval(tick)   // 面板卸载时调用
  },
})
off()   // 返回的注销函数;ctx.dispose() 不自动调它,loader 停用插件时统一回收
```

内置插槽就是 `ctx.ui.slots`,值为 `['plugins.page', 'settings.plugins', 'dashboard.widgets']`;
宿主页面在对应位置放 `<PluginSlot slot-name="…" />` 即接收注入。

## 约束与信任

- **自包含**:不能裸导入 `vue` 等第三方包(浏览器原生 import 解析不到);
  需要 UI 组件就用原生 DOM(`ctx.el`)。
- **信任模型**:客户端脚本由平台服务端点提供,与 aw commands 同级信任 —— 只装可信插件。
- **隔离**:单插件装载失败仅 console 告警,不影响应用与其他插件。
