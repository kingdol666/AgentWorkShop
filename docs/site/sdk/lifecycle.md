# 生命周期事件

宿主在运行时的关键节点触发事件,插件经 `ctx.hooks` / `ctx.events` 消费。
**全部事件也是配置根事件流的一部分。**
权威清单 = SDK 导出的 `LIFECYCLE_EVENTS`(11 项)与 `CLIENT_EVENTS`(5 项)
(`sdk/lifecycle.mjs`,下表与之同源,并逐条对着宿主发射点核过)。

## 服务端事件(11 个)

| 事件名(总线 type) | 触发时机 | payload |
|---|---|---|
| `plugin:host:init` | 宿主装载完所有插件(含停用)之后,一次性 | `{ plugins: string[], failures: number }` |
| `plugins:reloaded` | 热重载收尾(启停插件、`plugins-state.json` 变化触发) | `{ plugins: <清单条目数组> }` |
| `config:changed` | `runtime-settings.json` 变化(`aw config set` / 设置页写入,经 SystemConfigService 桥接) | `{ type: 'config:changed', changed: string[], effective: object, sources: object }` |
| `event:permissions:changed` | 产线授权写入成功后 | `{ userId }` |
| `event:*` | **订阅条目,不是被发射的事件** | — |
| `daq:sample` | 数采**下发级**采样(与 WS `daq.reading` 同点、按节点 `publishIntervalMs` 节拍) | `{ nodeId, templateRef, value, state, at, lineId }` |
| `daq:frame` | 多形态帧(向量 / 图像)下发级,与 `daq:sample` 同一条帧入账路径 | `{ nodeId, templateRef, kind, at, lineId, preview?, metrics, thumbUrl?, state }` |
| `dcw:write` | 写控 ACK 之后观察(**不影响写控决策**) | `{ nodeId, name, eng, prevValue, ok, source, lineId, at }` |
| `line:start` | 产线开跑(批次窗口开启) | `{ lineId, runId, recipeId, productName? }` |
| `line:stop` | 产线停止(批次窗口关闭,样本不再打标,节点收敛 offline) | `{ lineId, runId }` |
| `server:close` | 服务关闭,逐插件 dispose 队列跑完之后 | `{ at }` |

补充说明:

- `dcw:write` 的 `source` 取 `'manual'` / `'recipe'` / `'agent'` / `'rollback'`;
  载荷里**没有 `message` 字段**。
- `config:changed` 的载荷里**没有 `at` 字段** —— `changed` / `effective` / `sources` 三者之外
  没有时间戳,时间语义请自己取 `Date.now()`。
- `event:*` 是清单里的订阅条目名,不是一个被 emit 的事件。服务端通配只有裸 `'*'`
  (`ctx.hooks.on('*', ({ type, payload }) => …)`);`ctx.hooks.on('event:*')` **永不触发**。
- scene 事件以 `event:<type>` 进入总线。`ctx.events.on('<type>', fn)` 是补前缀的糖衣,
  所以场景事件 `permissions.changed` 的正确订阅是 `ctx.events.on('permissions.changed', fn)`。
- 可用的 scene 事件名(与浏览器 WS 完全同源)包括:`device.created` / `device.updated` /
  `device.deleted`、`daq.reading` / `daq.frame` / `daq.node.changed` / `daq.controller` /
  `daq.alarm` / `daq.alarm.changed`、`dcw.node.changed` / `dcw.written`、`ops.log`、
  `task.status`、`permissions.changed`、`plugins.reloaded` 等。

### 示例

```js
ctx.hooks.on('daq:sample', (s) => {
  if (s.value > (ctx.kv.get('threshold') ?? 180)) ctx.kv.bump('alarms')
})

ctx.hooks.on('dcw:write', (e) => {
  if (!e.ok) ctx.logger.warn(`写控失败 node=${e.nodeId} source=${e.source}`)
})

ctx.events.on('daq.alarm', a => ctx.logger.warn('告警', a.id))
```

## 客户端事件(5 个)

| 事件 | 触发时机 | payload | 订阅方式 |
|---|---|---|---|
| `client:init` | 客户端脚本 `setup(ctx)` 执行完成之后 | `{ name }` | `ctx.hooks.on('client:init', fn)` |
| `event:*` | scene 实时事件(与 WS 同源,经事件桥) | 事件自身 payload | `ctx.on('event:*', fn)`(唯一通配写法) |
| `page:change` | 路由切换完成(`page:finish`) | `{ path }` | `ctx.hooks.on('page:change', fn)` |
| `i18n:changed` | 界面语言切换 | `{ locale }` | `ctx.hooks.on('i18n:changed', fn)` |
| `client:destroy` | `ctx.dispose()` 回收前 | `{ name }` | `ctx.hooks.on('client:destroy', fn)` |

客户端的三条硬规则:

- **服务端钩子从不下发**:`daq:sample` / `dcw:write` / `line:start` / `line:stop` 在浏览器里收不到;
  对应物是 scene 事件(`daq.reading` / `daq.frame` / `dcw.written` …),用 `ctx.on('<scene-type>')` 订阅。
- **客户端本地钩子不能走 `ctx.on`**:`client:init` / `page:change` / `i18n:changed` / `client:destroy`
  要用 `ctx.hooks.on(...)` 直订。
- **`ctx.on('*')` 永不触发**:唯一通配写法是字面量 `'event:*'`;
  `ctx.on('event:line.start')` 会被二次加前缀成 `event:event:line.start`,同样永不触发。

## HookBus 语义

| 性质 | 行为 |
|---|---|
| 调度 | 同 type 监听器按注册序**异步串行** `await` |
| 载荷 | 每个监听器收到**同一个未改动的 payload**(扇出语义,**不是 waterfall**) |
| 返回值 | `emit()` 只返回「最后一个非 `undefined` 的返回值」,值不在监听器间传递 |
| 错误 | 单监听器抛错被隔离并计数,上报后不影响兄弟监听器与主服务 |
| 熔断 | 同一监听器**连续**失败 8 次自动摘除;任意一次成功即把计数清零 |
| 通配 | 服务端裸 `'*'`,回调收到 `{ type, payload }`,在具名监听器之后执行 |
| 拦截 | v1 **没有** veto / 拦截 / 改写能力(纯观察语义) |
| 清理 | 经 `ctx.hooks` 注册的监听器在**插件热重载**时自动解绑 |

## 关闭与热重载序列

```text
服务关闭(nitro close → shutdownPluginHost)
  └─ 逐插件执行 ctx.onDispose 队列(逐个 try/catch):定时器 clear、kv 同步落盘、订阅解绑…
      └─ 广播 server:close { at }

插件热重载(plugins-state.json 变化 / 启停插件 / 10s 轮询兜底)
  └─ 逐插件执行 ctx.onDispose 队列
      └─ 解绑经 ctx.hooks 注册的全部监听器
          └─ 重新装载 → 广播 plugins:reloaded
              └─ 广播 scene 事件 plugins.reloaded(浏览器端 loader 据此热注入 / 卸载客户端插件)
```

> v1 钩子为**观察语义** —— 不改变联锁 / 写控决策;veto(拦截 / 改写)钩子在路线图。
