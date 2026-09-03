# 生命周期事件

宿主在运行时的关键节点触发事件,插件经 `ctx.hooks.on(event, fn)` 消费。
**全部事件也是配置根事件流的一部分**——`event:*` 可通配订阅。

## 服务端事件(9 个)

### `plugin:host:init`
- **时机**:宿主装载完所有插件后(一次性)。
- **payload**:`{ plugins: string[], failures: number }`。
- **用途**:就绪自证、延迟初始化。

### `daq:sample`
- **时机**:数采**下发级**采样——与 WS `daq.reading` 同点、按节点 `publishIntervalMs` 节拍。
- **payload**:`{ nodeId, templateRef, value, state, at }`。
- **示例**:
  ```js
  ctx.hooks.on('daq:sample', (s) => {
    if (s.value > (ctx.kv.get('threshold') ?? 180)) ctx.kv.bump('alarms')
  })
  ```

### `daq:frame`
- **时机**:数采**多形态帧**下发级(向量/图像节点;与 WS `daq.frame` 同点、按 `publishIntervalMs` 节拍)。
- **payload**:`{ nodeId, templateRef, kind: 'vector'|'image', at, preview?, metrics?, thumbUrl? }`——**不含像素 blob**。
- **消费**:`ctx.daq.onFrame(fn)`(糖衣)或 `ctx.hooks.on('daq:frame', fn)`。

### `dcw:write`
- **时机**:写控 ACK 之后观察(与运维入册同点、同 10s 去重)——**不影响写控决策**。
- **payload**:`{ nodeId, name, eng, prevValue, ok, source, lineId, at }`。
- **`source`**:`manual` / `recipe` / `agent` / `rollback`。

### `line:start`
- **时机**:产线开跑(批次窗口开启)。
- **payload**:`{ lineId, runId, recipeId, productName? }`。

### `line:stop`
- **时机**:产线停止(批次窗口关闭,样本不再打标,节点收敛 offline)。
- **payload**:`{ lineId, runId }`。

### `event:<scene-type>` 与 `event:*`
- **时机**:scene 全部实时事件——`device.created|updated|deleted`、`daq.reading`、
  `daq.node.changed`、`daq.controller`、`ops.log` …(与浏览器 WS 完全同源)。
- **消费**:`ctx.events.on('daq.reading', fn)`(糖衣)或 `ctx.hooks.on('event:*', ({type,payload}) => …)`。

### `config:changed`
- **时机**:`runtime-settings.json` 变化(`aw config set` / 网页设置写入;宿主 fs.watch 防抖 300ms)。
- **payload**:`{ at }`;配合 `ctx.config.get/all()` 读取新值。

### `server:close`
- **时机**:服务关闭——**在逐插件执行 `ctx.onDispose` 清理队列之后**。
- **payload**:`{ at }`。

## 客户端事件(4 个)

| 事件 | 时机 |
|---|---|
| `client:init` | 客户端脚本 `setup(ctx)` 完成后 |
| `event:<scene-type>` / `event:*` | scene 实时事件(与 WS 同源,经 TownBus 桥) |
| `page:change` | Vue Router 页面切换完成(`{ path }`) |
| `client:destroy` | 页面隐藏/卸载,`ctx.dispose()` 回收前 |

## 关闭序列

```
服务关闭信号(nitro close)
  └─ 逐插件执行 ctx.onDispose 队列(逐个 try/catch)
      └─ 广播 server:close
```

> v1 钩子为**观察语义**——不改变联锁/写控决策;veto(拦截/改写)钩子在路线图。
