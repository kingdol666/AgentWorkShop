# 插件开发指南

> 插件 = 配置根 `plugins/<name>/` 下的一个 node 项目。基于内置 SDK 的生命周期钩子,
> 同时增强**服务端**(数据/事件/API)与**浏览器**(面板/遥测/交互)。
> 与 `aw` 指令同哲学:放入目录即装载,约定优于配置。

## 快速开始

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

## 插件契约

`index.mjs` 导出**普通对象**(零导入依赖——`ctx` 由宿主注入):

```js
export default {
  name: 'my-plugin',            // 必填,全局唯一
  version: '1.0.0',
  description: '…',
  client: './client.mjs',       // 可选:浏览器增强入口(相对路径)
  routes: [                     // 可选:声明式 API(也可 setup 里 ctx.route())
    { method: 'GET', path: '/health', handler: () => ({ ok: true }) },
  ],
  async setup(ctx) { /* 服务端生命周期 */ },
}
```

## 装载流程(项目启动时自动发现)

```
服务启动(nitro 插件 server/plugins/aw-plugins.ts)
  └─ 宿主扫描(双作用域,同名项目级覆盖用户级)
       ├─ <检出>/.AgentWorkShop/plugins/*/index.mjs   (project)
       └─ ~/.AgentWorkShop/plugins/*/index.mjs        (user / AW_HOME 重定向)
  └─ 逐插件: 动态 import → 形态校验 → createPluginContext → setup(ctx)
  └─ 注册插件路由(/api/plugins/<name>/**) + 解析客户端入口
  └─ emit plugin:host:init
```

- **错误隔离**:单插件装载/执行失败记入 `failures` 并告警,绝不拖垮主服务。
- **修改插件文件后需重启服务**(插件目录不在热更新监听范围)。

## 服务端 ctx 全成员

| 分组 | 成员 | 说明 |
|---|---|---|
| 钩子 | `ctx.hooks` | HookBus:`on/once/off/emit`(异步串行、错误隔离、`'*'` 通配、连续失败 8 次熔断) |
| 日志 | `ctx.logger` | `debug/info/warn/error`,自动前缀 `[插件名]` |
| 配置 | `ctx.config.get / all / onChange` | 有效配置只读 + 变更订阅 |
| 存储 | `ctx.kv.get / set / all / bump` | 插件私有 KV(内存态 + 防抖落盘,高频钩子零竞态) |
| 定时 | `ctx.timer.setInterval / setTimeout` | 服务关闭自动回收 |
| 清理 | `ctx.onDispose(fn)` / `ctx.subscriptions.add(d)` | `server:close` 前逐个执行 |
| 路由 | `ctx.route(method, path, handler)` | 插件 API → `/api/plugins/<name><path>` |
| 平台 | `ctx.api` | 平台 REST 客户端([详见 SDK 指南](/sdk/api-client)) |
| 网络 | `ctx.http.get / post` | 通用请求(仅 http/https,默认 8s 超时) |
| 事件 | `ctx.events.on(type, fn)` | scene 实时事件订阅 |
| 数采扩展 | `ctx.daq.registerDriver / registerProcessor / registerTemplate` | 插件驱动 / 下沉处理器 / 数采节点模板(v0.6 帧管线;同名覆盖) |
| OMP 工具 | `ctx.omp.registerTool(tool)` | 注册 omp host 工具 → 全部在跑 agent 会话**运行时热注入**(v0.6) |

## 插件 API(增强后端)

```js
ctx.route('GET', '/stats', () => ctx.kv.all())
ctx.route('POST', '/reset', (event) => {
  const body = event.awBody          // 宿主已预读 JSON body
  ctx.kv.reset()
  return { ok: true }
})
```

→ `/api/plugins/<name><path>`;v1 鉴权由插件自理(handler 内可 `resolveUser(event)`)。

## 多形态数采与 omp 工具扩展(v0.6)

数采不止单点数值:模板可声明 `signalKind: 'vector'`(测厚仪/扫描仪多点轮廓)或 `'image'`(CCD 图像)。
向量与帧元数据入 Timescale(`daq_frames`),图像像素入对象存储(MinIO,不可达自动降级本地磁盘)。

```js
// 注册下沉处理器:模板 sink 配置 { name: 'demo-roughness' } 即生效
ctx.daq.registerProcessor('vector', 'demo-roughness', (frame, args) => ({
  ...frame, metrics: { ...frame.metrics, roughness: computeRoughness(frame.points) },
}))

// 注册节点模板(出现在 /daq 模板目录与创建向导;用户建节点即套用自定义管线)
ctx.daq.registerTemplate({
  key: 'plug-my-sensor', name: '我的传感器', unit: 'mm',
  min: 0.4, max: 0.6, base: 0.5, amp: 0.02, decimals: 3, icon: 'tension',
  signalKind: 'vector', vector: { points: 32, min: 0.4, max: 0.6 },
  sink: { processors: [{ name: 'resample', args: { n: 32 } }, { name: 'demo-roughness' }] },
  metrics: [{ key: 'roughness', label: '粗糙度', alarmHigh: 0.05 }],
})

// 注册 omp host 工具:全部在跑 agent 会话运行时热注入(不重 spawn)
ctx.omp.registerTool({
  name: 'sensor_log',
  description: '查询/登记传感器标定结论',
  parameters: { type: 'object', properties: { sensor: { type: 'string' } }, required: ['sensor'] },
  handler: async (args, agent) => ({ text: `...` }),
})
```

- 派生指标阈值越限(模板 `metrics` 声明)走平台既有告警链路(落库 + WS + webhook)。
- 完整 API 语义与示例见仓库 `docs/plugins.md` §八/§九 与示例插件 `daq-vector-demo` / `omp-sensor-tools`。

## 浏览器增强(client.mjs)

自包含 ESM 导出 `setup(ctx)`(完整成员见 [SDK 浏览器端](/sdk/client)):

```js
export function setup(ctx) {
  const badge = ctx.el('div', { style: 'color:#35e0a0' }, ['⌁ 0'])
  ctx.root().append(badge)
  let n = 0
  ctx.on('daq:sample', () => { badge.textContent = `⌁ ${++n}` })
}
```

## 调试与陷阱

| 现象 | 原因 / 处理 |
|---|---|
| 改了插件代码没生效 | 插件目录不在热更新范围——**重启 `aw start` / `aw dev`** |
| 客户端徽标没出现 | 浏览器 console 看 `[aw-plugins]` 告警;确认 manifest `hasClient: true` |
| 插件路由 404 | exact-match;注意 method 与 path 前导 `/` |
| `ctx.api` 401 | 鉴权端点需 `setToken`;免鉴权端点(manifest/ping)无需 |
| 装载失败 | 启动日志有 `[aw-plugins] 装载失败` 详情;修复后重启 |

**信任模型**:插件是任意 node 代码,与 aw commands 同级——只安装/启用你信任的插件。

## 作用域与发布

- 用户级(全局):`~/.AgentWorkShop/plugins/`(`AW_HOME` 重定向)。
- 项目级(检出):`<repo>/.AgentWorkShop/plugins/`(团队可 git 版本化)。
- 卸载 = 删除目录后重启。
