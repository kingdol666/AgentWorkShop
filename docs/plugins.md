# AgentWorkShop 插件开发指南（SDK）

> 插件 = 配置根 `plugins/<name>/` 下的一个 node 项目。基于内置 SDK 的生命周期钩子,
> 可以同时增强**服务端**(数据/事件/API)与**浏览器**(面板/遥测/交互)。
> 与 `aw` 指令同哲学:放入目录即装载,约定优于配置。

## 一、快速开始

```bash
aw plugin create my-plugin            # 脚手架到 ~/.AgentWorkShop/plugins/(用户级)
aw plugin create my-plugin --project  # 或项目级 <repo>/.AgentWorkShop/plugins/
aw plugin list                        # 查看两处已装插件
aw start                              # 重启即自动装载
```

目录结构(标准 node 项目形态):

```
plugins/my-plugin/
├── index.mjs      # 服务端入口(必需): export default { name, setup(ctx) }
├── client.mjs     # 浏览器增强(可选): export function setup(ctx)
└── README.md
```

## 二、插件契约

`index.mjs` 导出**普通对象**(零导入依赖——ctx 由宿主注入,这是全局安装零解析链约束下的标准形态;TypeScript 作者可 `import type { definePlugin } from 'agentworkshop/sdk'` 获得类型提示,构建期擦除):

```js
export default {
  name: 'my-plugin',            // 必填,全局唯一
  version: '1.0.0',
  description: '…',
  client: './client.mjs',       // 可选:浏览器增强入口(相对路径)
  routes: [                     // 可选:声明式 API(也可在 setup 里 ctx.route())
    { method: 'GET', path: '/health', handler: () => ({ ok: true }) },
  ],
  async setup(ctx) { /* 服务端生命周期 */ },
}
```

## 三、服务端 ctx(SDK 注入)

| 成员 | 说明 |
|---|---|
| `ctx.name / scope('project'\|'user') / dir` | 身份 |
| `ctx.hooks` | 全局 HookBus:`on / once / off / emit`(异步串行、错误隔离、`*` 通配、连续失败熔断) |
| `ctx.logger` | `debug/info/warn/error`,自动带插件名前缀 |
| `ctx.config.get(key) / all()` | 有效配置只读(四层引擎) |
| `ctx.kv` | 插件私有持久化:`get/set/all/bump`(内存态 + 200ms 防抖落盘 `data/plugins/<name>/kv.json`,高频钩子零竞态) |
| `ctx.route(method, path, handler)` | 注册插件 API → `**/api/plugins/<name><path>**` |
| `ctx.http.get/post(url, …)` | 带超时 fetch(仅 http/https,拒绝其他协议) |
| `ctx.events.on(type, fn)` | scene 实时事件订阅(`event:*` 桥的糖) |
| `ctx.paths` | `{ home, configRoot, dataDir }` |

## 四、生命周期钩子(服务端)

| 钩子 | 触发时机 | payload |
|---|---|---|
| `plugin:host:init` | 宿主装载完所有插件后 | `{ plugins, failures }` |
| `daq:sample` | DAQ 下发级采样(与 WS `daq.reading` 同点、同节拍) | `{ nodeId, templateRef, value, state, at }` |
| `dcw:write` | 写控 ACK 后观察(与运维入册同点同去重) | `{ nodeId, name, eng, prevValue, ok, source, lineId, at }` |
| `line:start` / `line:stop` | 产线开跑/停止 | `{ lineId, runId, recipeId? }` |
| `event:<type>` / `event:*` | **scene 全部实时事件**(device.created · daq.node.changed · ops.log · daq.reading … 与 WS 同源) | 事件 payload |
| `server:close` | 服务关闭 | `{ at }` |

> v1 钩子为**观察语义**(不改变联锁/写控决策)。veto 类(拦截/改写)钩子在路线图中。

## 五、浏览器增强(client.mjs)

`client.mjs` 是**自包含 ESM**(不可用裸导入如 `vue`——浏览器原生动态加载),导出 `setup(ctx)`:

| 成员 | 说明 |
|---|---|
| `ctx.on('daq:sample', fn)` / `ctx.on('event:daq.reading', fn)` / `ctx.on('*', fn)` | 实时事件订阅(与 WS 同源;另支持 `page:change`) |
| `ctx.el(tag, attrs, children)` | DOM 构建 |
| `ctx.root()` | 插件私有挂载点(右下角,懒创建 `#aw-plugin-<name>`) |
| `ctx.mount(target, node)` | 挂载到任意选择器/元素 |
| `ctx.hooks` | 客户端本地 HookBus(`client:init` / `event:*` / `page:change`) |
| `ctx.log` | 前缀 console |

客户端脚本由服务端端点 `/api/plugins/client/<name>` 以 `text/javascript` 提供,应用启动时
`aw-plugins.client.ts` loader 自动动态 import 并装载。

```js
// client.mjs
export function setup(ctx) {
  const badge = ctx.el('div', { style: 'color:#35e0a0' }, ['⌁ 0'])
  ctx.root().append(badge)
  let n = 0
  ctx.on('daq:sample', () => { badge.textContent = `⌁ ${++n}` })
}
```

## 六、插件 API(增强后端)

```js
ctx.route('GET', '/stats', () => ctx.kv.all())
ctx.route('POST', '/reset', () => { ctx.kv.set('samples', 0); return { ok: true } })
```

→ `GET/POST /api/plugins/my-plugin/stats|reset`。鉴权 v1 由插件自理(可在 handler 内复用
`resolveUser(event)` 走业务鉴权)。

## 七、完整示例

`sdk/examples/sample-insight/` —— 订阅采样计数 + 统计 API + 浏览器徽标:

```bash
cp -r sdk/examples/sample-insight ~/.AgentWorkShop/plugins/
aw start   # → GET /api/plugins/sample-insight/stats · 浏览器右下角徽标
```

## 八、发布与信任模型

- 插件是**任意 node 代码**,与 aw commands 同信任模型:只安装/启用你信任的插件。
- 插件随配置根走:repo 检出内 = `<repo>/.AgentWorkShop/plugins`(团队可 git 版本化);
  全局安装 = `~/.AgentWorkShop/plugins`(AW_HOME 可重定向)。
- 服务端生命周期结束(`server:close`)、卸载插件 = 直接删目录重启。

## 九、SDK 版本对照

| SDK | 随包 | 说明 |
|---|---|---|
| `sdk/hooks.mjs` | `agentworkshop/sdk`(0.2.2+) | HookBus(可独立用于任何 node 项目) |
| `sdk/context.mjs` | 同上 | 服务端 ctx 工厂 + 路由表 + 插件校验 |
| `sdk/client.mjs` | 同上 | 浏览器 ctx 工厂 |
