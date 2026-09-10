# 浏览器端 SDK(createClientContext)

插件 `client.mjs` 是**自包含 ESM**(无裸导入——浏览器原生动态加载),导出 `setup(ctx)`。
应用启动时,loader(`app/plugins/aw-plugins.client.ts`)拉取插件清单并动态装载,
事件与浏览器 WS 完全同源。

## 创建(宿主调用;插件只写 setup)

```js
import { createClientContext } from 'agentworkshop/sdk/client'

const ctx = createClientContext({
  name: 'my-plugin',
  eventBridge: (dispatch) => townBus.subscribe((e) => dispatch(e.type, e.payload)),
  baseUrl: '',   // 同源;跨域集成时可填平台地址
})
```

## ctx 成员

| 成员 | 说明 |
|---|---|
| `ctx.on(type, fn)` | 订阅 **scene 实时事件**(与浏览器 WS 同源):`daq.reading` / `daq.frame` / `device.updated` / `ops.log` / `task.status` …(内部转 `event:<type>`,`'*'` 通配);返回退订函数,**pagehide 自动回收**。注意:`daq:sample` 等带冒号的是**服务端钩子**,客户端收不到 |
| `ctx.fetch(path, opt?)` | 同源平台 API(JSON;自动解 `{data}` 信封;非 2xx 抛错;自动携带 cookie token) |
| `ctx.el(tag, attrs, children)` | DOM 构建(`style`/`class`/`on*` 事件 attrs 特判) |
| `ctx.root()` | 插件私有挂载点 `#aw-plugin-<name>`(右下角,懒创建) |
| `ctx.mount(target, node)` | 挂载到任意选择器/元素(缺失时落到 root) |
| `ctx.hooks` | 本地 HookBus:`client:init` / `page:change` / `client:destroy` 走这里**直订**(无 `event:` 前缀);scene 事件经 `ctx.on` 订阅 |
| `ctx.log` | 前缀 console(info/warn/error) |
| `ctx.dispose()` | 卸载:回收全部订阅 + 清空挂载点 + 广播 `client:destroy`(幂等;页面隐藏也触发) |
| `ctx.ui.registerPanel(entry)` | **UI 注入(v2)**:向命名插槽注册面板 `{slot, name, title?, titleKey?, order?, mount(el)}`;`mount` 返回清理函数则在卸载时调用;返回注销函数,`ctx.dispose` 自动回收。内置插槽:`plugins.page` / `settings.plugins` / `dashboard.widgets` |
| `ctx.t(key, params?)` | **插件命名空间翻译(v2)**:`ctx.t('panel.title')` → `plugin.<name>.panel.title`(消息来自插件根目录 i18n.json;未命中回落声明键) |
| `ctx.locale` | 当前界面语言;语言切换广播 `i18n:changed` 钩子(`ctx.hooks.on('i18n:changed', fn)`) |

## 完整示例

```js
export function setup(ctx) {
  const badge = ctx.el('div', {
    style: 'padding:8px 12px;border:1px solid #35e0a0;border-radius:10px;color:#35e0a0',
  }, ['⌁ 0'])
  ctx.root().append(badge)

  let n = 0
  ctx.on('daq.reading', () => { badge.textContent = `⌁ ${++n}` })   // scene 事件

  ctx.hooks.on('page:change', ({ path }) => ctx.log.info('page →', path))   // 页面生命周期

  // 消费平台 API(同源;登录用户 Cookie 鉴权)
  ctx.fetch('/api/workshop/dcw/lines').then(d => ctx.log.info('产线', d.length))
}
```

## 约束与信任

- **自包含**:不能裸导入 `vue` 等第三方包(浏览器原生 import 解析不到);
  需要 UI 组件就用原生 DOM(`ctx.el`)。
- **信任模型**:客户端脚本由平台服务端点提供,与 aw commands 同级信任——只装可信插件。
- **隔离**:单插件装载失败仅 console 告警,不影响应用与其他插件。
