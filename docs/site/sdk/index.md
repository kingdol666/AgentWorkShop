# SDK 总览 —— 作为项目服务的客户端

SDK 是 AgentWorkShop 的**编程客户端与扩展基座**:外部项目经它消费平台 REST 服务;
插件经它获得宿主注入的运行时上下文。零第三方运行时依赖,Node ≥ 23.4 与现代浏览器双端可用。

## 两种身份,一个 SDK

| 身份 | 形态 | SDK 的角色 |
|---|---|---|
| **外部集成者** | 普通依赖 | 直接调用 `createPlatformClient()` 消费平台 REST 面 |
| **插件作者** | 导出 `{ name, setup(ctx) }` | `ctx` 即宿主注入的 SDK 上下文 —— 零导入依赖 |

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

## 导入路径与版本

`package.json` 的 `exports` 只开放四个入口;深路径(如 `agentworkshop/sdk/api.mjs`)
没有导出,导入会抛 `ERR_PACKAGE_PATH_NOT_EXPORTED`。

| 导入 | 解析到 | 内容 |
|---|---|---|
| `agentworkshop` | `sdk/index.mjs` | 与 `agentworkshop/sdk` **同一个门面** |
| `agentworkshop/sdk` | `sdk/index.mjs` | 全部门面(服务端 + 浏览器端 + REST 客户端 + 类型) |
| `agentworkshop/sdk/client` | `sdk/client.mjs` | 仅浏览器端(`createClientContext`) |
| `agentworkshop/package.json` | `package.json` | 包元数据 |

**版本**:SDK 自带常量 `SDK_VERSION = '0.3.0'`(服务端)与 `CLIENT_SDK_VERSION = '0.3.0'`(浏览器端)。
它们是 **SDK 自身接口的版本号**,与 npm 包版本(当前 0.7.36)**独立演进**,不同步是预期行为。

自带 `index.d.mts` / `client.d.mts` 类型声明,TS 项目零配置获得 IntelliSense
(声明覆盖范围的现状见[完整指南](/sdk/guide) §7)。

## 快速示例:外部项目集成产线

```js
import { createPlatformClient } from 'agentworkshop/sdk'

const api = createPlatformClient({ baseUrl: 'http://plant.local:3001' })
const { token } = await api.users.login('you@example.com', 'secret')
api.setToken(token)

await api.lines.create({ name: '一号产线' })

// 产线列表是 { lines, states },不是数组
const { lines } = await api.lines.list()
const line = lines[0]

// 数采节点列表同样是对象,取 .nodes
const { nodes } = await api.daqNodes.list()
console.log(`产线 ${line?.name ?? '(无)'},节点 ${nodes.length} 个`)

// 产线授权面(admin):overview() 全量,set() 批量写
// const { lines: all, users } = await api.permissions.overview()
// await api.permissions.set({ userId: users[0].id, grants: [{ lineId: all[0].id, mode: 'readonly' }] })
```

## 快速示例:插件(宿主注入 ctx)

```js
// ~/.AgentWorkShop/plugins/my-plugin/index.mjs —— 零导入依赖
export default {
  name: 'my-plugin',
  auth: 'user',                 // 插件路由的声明式鉴权
  async setup(ctx) {
    const { lines } = await ctx.api.lines.list()                // 平台 REST 客户端(默认无 token)
    ctx.hooks.on('daq:sample', () => ctx.kv.bump('samples'))    // 生命周期钩子
    ctx.events.on('daq.reading', r => ctx.logger.debug(r.nodeId))  // scene 事件(自动补 event: 前缀)
    ctx.route('GET', '/stats', () => ctx.kv.all())              // 插件自有 API → /api/plugins/my-plugin/stats
  },
}
```

## 子页导航

- [平台 REST 客户端](/sdk/api-client) —— `createPlatformClient` 完整 API、真实路由支持情况、响应形状
- [插件上下文 ctx](/sdk/context) —— 运行时完整变量面(含宿主注入的 `permissions` / `daq` / `omp` / `services`)
- [生命周期事件](/sdk/lifecycle) —— 服务端 11 + 客户端 5,逐项 payload 与订阅写法
- [浏览器端 SDK](/sdk/client) —— `createClientContext`、UI 注入与事件订阅规则
- [完整指南](/sdk/guide) —— 全部内容单页版(单一事实源)
