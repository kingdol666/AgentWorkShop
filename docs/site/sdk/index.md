# SDK 总览 —— 作为项目服务的客户端

SDK 是 AgentWorkShop 的**编程客户端与扩展基座**:外部项目经它消费平台 REST 服务;
插件经它获得宿主注入的运行时上下文。零第三方运行时依赖,Node ≥ 23.4 与现代浏览器双端可用。

## 两种身份,一个 SDK

| 身份 | 形态 | SDK 的角色 |
|---|---|---|
| **外部集成者** | 普通依赖 | 直接调用 `createPlatformClient()` 消费平台 REST 面 |
| **插件作者** | 导出 `{ name, setup(ctx) }` | `ctx` 即宿主注入的 SDK 上下文——零导入依赖 |

> 为什么插件不直接 import SDK?全局安装的插件目录不在 node_modules 解析链上,
> 宿主注入是唯一零坑形态(VSCode `activate(context)` 同范式)。

## 获取与导入

```bash
npm install -g agentworkshop     # 全局(含 CLI 与平台本体)
npm install agentworkshop        # 或作为你项目的依赖(集成形态)
```

```js
import { createPlatformClient, definePlugin, HookBus } from 'agentworkshop/sdk'
import { createClientContext } from 'agentworkshop/sdk/client'   // 仅浏览器端
```

自带 `index.d.mts` 类型声明,TS 项目零配置获得完整 IntelliSense。

## 快速示例:外部项目集成产线

```js
import { createPlatformClient } from 'agentworkshop/sdk'

const api = createPlatformClient({ baseUrl: 'http://plant.local:3001' })
const { token } = await api.users.login('you@example.com', 'secret')
api.setToken(token)

await api.lines.create({ name: '一号产线' })
await api.lines.start((await api.lines.list())[0].id)
```

## 快速示例:插件(宿主注入 ctx)

```js
// ~/.AgentWorkShop/plugins/my-plugin/index.mjs —— 零导入依赖
export default {
  name: 'my-plugin',
  async setup(ctx) {
    const lines = await ctx.api.lines.list()          // 平台 REST 客户端
    ctx.hooks.on('daq:sample', (s) => ctx.kv.bump('samples'))   // 生命周期钩子
    ctx.route('GET', '/stats', () => ctx.kv.all())     // 插件自有 API
  },
}
```

## 子页导航

- [平台 REST 客户端](/sdk/api-client) —— createPlatformClient 完整 API
- [插件上下文 ctx](/sdk/context) —— 运行时完整变量面
- [生命周期事件](/sdk/lifecycle) —— 服务端 8 + 客户端 4,逐项详解
- [浏览器端 SDK](/sdk/client) —— createClientContext 与 DOM 增强
