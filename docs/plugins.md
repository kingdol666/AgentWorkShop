# AgentWorkShop 插件开发指南

> 插件 = 配置根 `plugins/<name>/` 下的一个 node 项目。基于内置 SDK 的生命周期钩子,
> 同时增强**服务端**(数据/事件/API)与**浏览器**(面板/遥测/交互)。
> 与 `aw` 指令同哲学:放入目录即装载,约定优于配置。
> SDK 全部成员的逐项详解见 [sdk.md](./sdk.md)——本文聚焦插件视角的装配与生命周期。

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

## 二、装载流程(项目启动时自动发现)

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
- 客户端插件由 `app/plugins/aw-plugins.client.ts` loader 在浏览器侧动态装载,互不影响。

## 三、插件契约

`index.mjs` 导出**普通对象**(零导入依赖——`ctx` 由宿主注入;TypeScript 可 type-only
导入 `agentworkshop/sdk` 获得类型,运行时擦除):

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

## 四、服务端生命周期(完整)

装载完成后,以下事件按业务发生顺序流经 `ctx.hooks`(**每个都可直接 `ctx.hooks.on` 消费**):

### 4.1 `plugin:host:init`
- **时机**:宿主装载完所有插件后(一次性)。
- **payload**:`{ plugins: string[], failures: number }`。
- **用途**:就绪自证;延迟初始化(依赖其他插件已注册路由的场景)。

### 4.2 `daq:sample`
- **时机**:数采**下发级**采样——与 WS `daq.reading` 同一点、按节点 `publishIntervalMs` 节拍。
- **payload**:`{ nodeId, templateRef, value, state, at }`。
- **用途**:越限告警、采样统计、实时联动。
- **示例**:
  ```js
  ctx.hooks.on('daq:sample', (s) => {
    if (s.value > (ctx.kv.get('threshold') ?? 180)) ctx.kv.bump('alarms')
  })
  ```

### 4.2b `daq:frame`
- **时机**:数采**多形态帧**下发级(向量/图像节点;与 WS `daq.frame` 同点、按 `publishIntervalMs` 节拍)。
- **payload**:`{ nodeId, templateRef, kind: 'vector'|'image', at, preview?, metrics?, thumbUrl? }`。
  **不含像素 blob**——图像只有缩略图 URL 与派生指标(brightness/contrast…),防止插件侧内存放大。
- **用途**:帧级质检、缺陷计数、图像指标联动。

### 4.3 `dcw:write`
- **时机**:写控 ACK 之后(与运维入册同点、同 10s 去重节流)——**观察语义,不影响写控决策**。
- **payload**:`{ nodeId, name, eng, prevValue, ok, source('manual'|'recipe'|'agent'|'rollback'), lineId, at }`。
- **用途**:写审计、下发趋势、回写记录。

### 4.4 `line:start` / `line:stop`
- **时机**:产线开跑/停止(批次窗口开/闭)。
- **payload**:`{ lineId, runId, recipeId?, productName? }` / `{ lineId, runId }`。
- **用途**:批次开始联动、停线报告。

### 4.5 `event:<type>` / `event:*`
- **时机**:scene 全部实时事件(`device.created|updated|deleted`、`daq.reading`、
  `daq.node.changed`、`daq.controller`、`ops.log` …)——与浏览器 WS 完全同源。
- **消费**:`ctx.events.on('daq.reading', fn)`(糖衣)或 `ctx.hooks.on('event:daq.reading', fn)`。
- **用途**:任意平台事件的观察与增强,无需自建 WS 连接。

### 4.6 `config:changed`
- **时机**:`runtime-settings.json` 变化(`aw config set` / 网页设置写入;宿主 fs.watch 防抖 300ms)。
- **payload**:`{ at }`;配合 `ctx.config.get/all()` 读取新值。
- **用途**:阈值热更新、联动参数刷新。

### 4.7 `server:close`
- **时机**:服务关闭——**先逐插件执行 `ctx.onDispose` 队列,再广播本事件**。
- **payload**:`{ at }`。
- **用途**:最终落盘、对外通知。

## 五、服务端 ctx 全成员

| 分组 | 成员 | 说明 |
|---|---|---|
| 身份 | `ctx.name / scope / dir / sdkVersion` | 插件名 / `'project'\|'user'` / 目录 / SDK 版本 |
| 钩子 | `ctx.hooks` | HookBus:`on/once/off/emit`(异步串行、错误隔离、`'*'` 通配、连续失败 8 次熔断) |
| 日志 | `ctx.logger` | `debug/info/warn/error`,自动前缀 `[插件名]` |
| 配置 | `ctx.config.get(key)` / `all()` / `onChange(fn)` | 有效配置只读 + 变更订阅 |
| 存储 | `ctx.kv.get/set/all/bump` | 插件私有 KV(内存态 + 200ms 防抖落盘,高频钩子零竞态) |
| 定时 | `ctx.timer.setInterval/setTimeout` | **服务关闭自动回收**,杜绝定时器泄漏 |
| 清理 | `ctx.onDispose(fn)` / `ctx.subscriptions.add(d)` | `server:close` 前逐个执行(先于广播) |
| 路由 | `ctx.route(method, path, handler)` | 插件 API → `/api/plugins/<name><path>` |
| 平台 | `ctx.api` | 平台 REST 客户端(自环 origin;鉴权端点 `ctx.api.setToken(token)`) |
| 网络 | `ctx.http.get/post` | 通用请求(仅 http/https,默认 8s 超时) |
| 事件 | `ctx.events.on(type, fn)` | scene 实时事件订阅 |
| DAQ 扩展 | `ctx.daq.registerDriver(driver)` / `registerProcessor(kind, name, fn)` | 注册自定义采集驱动 / 下沉处理器(同名覆盖内置;详见 §九) |
| 路径 | `ctx.paths` | `{ home, configRoot, dataDir }` |

> **鉴权说明**:`ctx.api` 自环调用遵循平台 REST 鉴权——免鉴权端点(manifest/ping)开箱即用;
> 鉴权端点需 `ctx.api.setToken(token)`(token 可经 `AW_TOKEN` 环境变量注入插件)。
> 仅需进程内数据时优先 `ctx.events`/`ctx.hooks`(零鉴权、零开销)。

## 六、浏览器增强(client.mjs)

`client.mjs` 为**自包含 ESM**(无裸导入),导出 `setup(ctx)`。loader
(`app/plugins/aw-plugins.client.ts`) 启动期经 `/api/plugins/manifest` 发现并动态装载,
事件与 WS 完全同源:

| 成员 | 说明 |
|---|---|
| `ctx.on(type, fn)` | `daq:sample` / `event:<type>` / `event:*` / `page:change` 订阅(pagehide 自动回收) |
| `ctx.fetch(path, opt?)` | 同源平台 API(JSON + 信封解包,非 2xx 抛错) |
| `ctx.el(tag, attrs, children)` | DOM 构建 |
| `ctx.root()` / `ctx.mount(target, node)` | 私有挂载点 / 任意位置挂载 |
| `ctx.hooks` | 本地 HookBus(`client:init` / `page:change` / `client:destroy`) |
| `ctx.dispose()` | 卸载(回收订阅 + 清空挂载点;pagehide 自动触发) |

```js
export function setup(ctx) {
  const badge = ctx.el('div', { style: 'color:#35e0a0' }, ['⌁ 0'])
  ctx.root().append(badge)
  let n = 0
  ctx.on('daq:sample', () => { badge.textContent = `⌁ ${++n}` })
}
```

## 七、插件 API(增强后端)

```js
ctx.route('GET', '/stats', () => ctx.kv.all())
ctx.route('POST', '/reset', (event) => {
  const body = event.awBody          // 宿主已预读 JSON body
  ctx.kv.reset()
  return { ok: true }
})
```

→ `/api/plugins/<name><path>`。宿主 catchall 转发(exact-match),body 预读挂 `event.awBody`;
v1 鉴权由插件自理(可在 handler 内 `resolveUser(event)` 复用业务鉴权)。

## 八、多形态数采扩展(v2 帧管线)

数采不止单点数值:模板可声明 `signalKind: 'vector'`(测厚仪/扫描仪多点轮廓)或 `'image'`(CCD 图像)。
向量/元数据入 Timescale(`daq_frames`),图像像素入对象存储(MinIO,disk 降级)。插件两种扩展点:

```js
// ① 自定义下沉处理器(推荐入口):模板 sink 配置 { name: 'demo-roughness', args: { window: 8 } } 即生效
ctx.daq.registerProcessor('vector', 'demo-roughness', (frame, args) => {
  // frame = { kind, points? | blob?(仅图像生产侧), metrics }
  // 返回变换后的 frame;单步异常被网关捕获(保留原帧,不阻塞采集)
  return { ...frame, metrics: { ...frame.metrics, roughness: computeRoughness(frame.points) } }
})

// ② 注册自定义节点模板(出现在 /daq 模板目录与创建向导;用户可即刻建节点使用)
ctx.daq.registerTemplate({
  key: 'plug-my-sensor',              // 必填,建议 plug-<name>-<信号> 命名;同名覆盖(热重载幂等)
  name: '我的传感器', code: 'MY · SNS', ch: '自定义信号', unit: 'mm',
  base: 0.5, amp: 0.02, min: 0.4, max: 0.6, decimals: 3, icon: 'tension',
  signalKind: 'vector',               // scalar(缺省)/ vector / image
  vector: { points: 32, min: 0.4, max: 0.6 },
  sink: { processors: [{ name: 'resample', args: { n: 32 } }, { name: 'my-derive' }] },   // 下沉管线(入库+下发前加工)
  metrics: [{ key: 'avg', label: '均值', unit: 'mm', alarmHigh: 0.55 }],                    // 派生指标阈值告警
})

// ③ 自定义采集驱动(任意协议/设备):实现与内置驱动同契约
ctx.daq.registerDriver({
  kind: 'my-ccd',                       // 节点 driver 字段引用;与内置同名会覆盖并告警
  available: async () => true,
  sample: async ({ ctx, config, driverConfig, signalKind, vector }) => {
    if (signalKind === 'image') {
      const blob = await grabJpeg(driverConfig.url)   // Buffer
      return { frame: { kind: 'image', blob, mime: 'image/jpeg', width: 640, height: 480 } }
    }
    if (signalKind === 'vector') {
      return { frame: { kind: 'vector', points: readProfile(), metrics: {} } }
    }
    return readScalar()
  },
  test: async () => ({ ok: true, message: 'ok' }),
})
```

- 处理器内置件:`resample` / `derive-metric` / `zones` / `thumbnail` / `quality-gate`;
- 指标阈值在模板 `metrics` 声明(如 `{ key: 'roughness', alarmHigh: 0.05 }`),越限走平台既有告警链路;
- 帧消费:`ctx.daq.onFrame(fn)` / `ctx.daq.onSample(fn)`(分别对应 daq:frame / daq:sample 钩子别名);
- 完整示例见 `.AgentWorkShop/plugins/daq-vector-demo/`(处理器+模板,project 作用域,可直接改)。

## 九、omp 自定义工具(运行时热注入)

插件经 `ctx.omp.registerTool(tool)` 注册 omp host 工具:工具 schema 自动并入 agent 工具面
(随 `set_host_tools` 下发),**注册表变更即时热注入全部在跑 agent 会话**(无需重启/重spawn);
`handleHostTool` 对插件工具名分发执行,handler 收到 `(args, agent={agentId,channelId,role,name})`。

```js
ctx.omp.registerTool({
  name: 'sensor_calibration_log',     // 与内置 host tool 同名会被忽略(内置优先)
  label: '标定记录本',
  description: '查询/登记各传感器的标定结论…',
  parameters: { type: 'object', properties: { action: { type: 'string', enum: ['get','put','list'] } }, required: ['action'] },
  roles: ['lead', 'worker'],          // 缺省双角色;['lead'] = 仅 lead 工具面
  handler: async (args, agent) => ({ text: `结果…` }),   // isError: true 按工具错误呈现
})
```

- 示例插件:`.AgentWorkShop/plugins/omp-sensor-tools/`(传感器标定记录本)。
- 热注入语义:插件装载/停用/重载 → 工具面变更 → 全部在跑 omp 子进程收到新的 set_host_tools。

## 十、真实案例:line-sentinel(产线哨兵)

用户级安装,展示 SDK 全部能力面——源码 `~/.AgentWorkShop/plugins/line-sentinel/`:

- **`ctx.api`**:启动读取平台产线清单(自环 REST)
- **`ctx.hooks.on('daq:sample')`**:逐样本计数 + 越限告警(阈值可调)
- **`ctx.hooks.on('line:start'/'line:stop')`**:运行态跟踪
- **`ctx.config.onChange`**:配置热更新感知
- **`ctx.timer`**:5s 心跳 + 免鉴权 manifest ping 自证 REST 通道
- **`ctx.route`**:`GET /report` 综合报告、`POST /threshold` 阈值设置(`event.awBody`)
- **`client.mjs`**:右下角实时徽标(样本数 + 告警数)

实测记录(dev 3127 / prod 3601 双形态):8 秒采样计数 288+、12 节点越限告警、
心跳间隔 ~1s 内新鲜、浏览器徽标挂载零 pageerror。

## 十一、调试与陷阱

| 现象 | 原因 / 处理 |
|---|---|
| 改了插件代码没生效 | 插件目录不在热更新范围——**重启 `aw start` / `aw dev`** |
| 客户端徽标没出现 | 打开浏览器 console 看 `[aw-plugins]` 告警;确认 manifest 中 `hasClient: true` |
| 插件路由 404 | 路由为 exact-match;注意 method 与 path 前导 `/` |
| `ctx.api` 鉴权 401 | 鉴权端点需 `ctx.api.setToken(token)`;免鉴权端点(manifest/ping)无需 |
| 插件装载失败 | `aw dev/start` 启动日志有 `[aw-plugins] 装载失败` 详情;修复后重启 |

**信任模型**:插件是任意 node 代码,与 aw commands 同级——只安装/启用你信任的插件。

## 十二、发布与作用域

- 用户级(全局):`~/.AgentWorkShop/plugins/` —— `AW_HOME` 可重定向。
- 项目级(检出):`<repo>/.AgentWorkShop/plugins/` —— 团队可 git 版本化共享。
- 同名指令式覆盖规则与 commands 一致:**项目级 > 用户级 > 内建**。
- 卸载 = 删除目录后重启。
