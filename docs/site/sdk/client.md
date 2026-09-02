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
| `ctx.on(type, fn)` | 订阅事件:`daq:sample` / `event:<type>` / `event:*` / `page:change`;返回退订函数,**pagehide 自动回收** |
| `ctx.fetch(path, opt?)` | 同源平台 API(JSON;自动解 `{data}` 信封;非 2xx 抛错) |
| `ctx.el(tag, attrs, children)` | DOM 构建(`style`/`class`/`on*` 事件 attrs 特判) |
| `ctx.root()` | 插件私有挂载点 `#aw-plugin-<name>`(右下角,懒创建) |
| `ctx.mount(target, node)` | 挂载到任意选择器/元素(缺失时落到 root) |
| `ctx.hooks` | 本地 HookBus(`client:init` / `event:*` / `page:change` / `client:destroy`) |
| `ctx.log` | 前缀 console(info/warn/error) |
| `ctx.dispose()` | 卸载:回收全部订阅 + 清空挂载点 + 广播 `client:destroy`(幂等) |

## 完整示例

```js
export function setup(ctx) {
  const badge = ctx.el('div', {
    style: 'padding:8px 12px;border:1px solid #35e0a0;border-radius:10px;color:#35e0a0',
  }, ['⌁ 0'])
  ctx.root().append(badge)

  let n = 0
  ctx.on('daq:sample', () => { badge.textContent = `⌁ ${++n}` })

  ctx.on('page:change', ({ path }) => ctx.log.info('page →', path))

  // 消费平台 API(同源;登录用户 Cookie 鉴权)
  ctx.fetch('/api/workshop/dcw/lines').then(d => ctx.log.info('产线', d.length))
}
```

## 约束与信任

- **自包含**:不能裸导入 `vue` 等第三方包(浏览器原生 import 解析不到);
  需要 UI 组件就用原生 DOM(`ctx.el`)。
- **信任模型**:客户端脚本由平台服务端点提供,与 aw commands 同级信任——只装可信插件。
- **隔离**:单插件装载失败仅 console 告警,不影响应用与其他插件。
