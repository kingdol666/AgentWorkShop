# 插件生命周期详解

## 装载与关闭全景

```
                ┌─────────────────────── 服务启动 ───────────────────────┐
nitro 插件 aw-plugins.ts
  └─ initPluginHost:双作用域扫描 → 逐插件 import → 校验 → setup(ctx) → 路由/客户端登记
      └─ emit plugin:host:init { plugins, failures }
                └─────────────────────── 运行中 ────────────────────────┘
daq:sample(下发级采样) ──┐
dcw:write(写控 ACK)     ──┤
line:start / line:stop  ──┼──▶ ctx.hooks(错误隔离/熔断)──▶ 插件消费
event:* (scene 全事件)  ──┘      │
config:changed(设置变化) ────────┘
                ┌─────────────────────── 服务关闭 ───────────────────────┐
nitro close
  └─ 逐插件执行 ctx.onDispose 队列(try/catch)
      └─ 广播 server:close
```

## 服务端事件逐项

### `plugin:host:init`
- **时机**:全部插件 setup 完成后(一次性)。
- **payload**:`{ plugins: string[], failures: number }`。
- **用途**:就绪自证;依赖其他插件路由的延迟初始化。

### `daq:sample` —— 数采样本流
- **时机**:节点采样经管线汇聚后的**下发级**出口(与 WS `daq.reading` 同点;
  按节点 publishIntervalMs 节拍,不是每个原始采样)。
- **payload**:`{ nodeId, templateRef, value, state, at }`。
- **实测**:单节点 1s 节拍下 8s 计数 288(多节点并发)。
- **示例(越限告警)**:
  ```js
  ctx.hooks.on('daq:sample', (s) => {
    if (s.value > (ctx.kv.get('threshold') ?? 180)) ctx.kv.bump('alarms')
  })
  ```

### `dcw:write` —— 写控观察
- **时机**:写控 ACK 落账后(含 10s 同值去重)。
- **payload**:`{ nodeId, name, eng, prevValue, ok, source, lineId, at }`;
  `source ∈ manual | recipe | agent | rollback`,`ok` = 回读校验结论。
- **用途**:下发审计、告警联动、外系统通知(经 ctx.http)。

### `line:start` / `line:stop`
- **时机**:批次窗口开/闭。
- **payload**:`{ lineId, runId, recipeId?, productName? }` / `{ lineId, runId }`。
- **示例(运行态跟踪)**:
  ```js
  ctx.hooks.on('line:start', (p) => { ctx.kv.set('running', true); ctx.kv.bump('runningCount') })
  ctx.hooks.on('line:stop', () => ctx.kv.set('running', false))
  ```

### `event:<scene-type>` / `event:*`
- **时机**:任一 `broadcastSceneEvent(type, payload)`(与浏览器 WS 完全同源)。
  常见:`daq.reading` · `daq.node.changed` · `daq.controller` · `device.created|updated|deleted` · `ops.log`。
- **示例**:
  ```js
  ctx.events.on('daq.node.changed', (p) => ctx.logger.debug?.(p?.op))
  ctx.hooks.on('event:*', ({ type, payload }) => { /* 全事件审计 */ })
  ```

### `config:changed`
- **时机**:`runtime-settings.json` 变化(`aw config set` / 网页设置;fs.watch 防抖 300ms)。
- **payload**:`{ at }`;`ctx.config.get/all()` 已在事件前刷新为新值。
- **示例(阈值热更新)**:
  ```js
  ctx.config.onChange(() => { ctx.logger.info('配置已变更', ctx.config.get('theme.primaryColor')) })
  ```

### `server:close`
- **时机**:nitro close —— **先逐插件执行 `ctx.onDispose` 队列,再广播本事件**。
- **payload**:`{ at }`。

## 客户端事件逐项

| 事件 | 时机 | payload |
|---|---|---|
| `client:init` | `setup(ctx)` 完成 | `{ name }` |
| `event:<scene-type>` / `event:*` | WS 实时事件(经 TownBus 桥) | 事件 payload |
| `page:change` | Vue Router 页面切换完成 | `{ path }` |
| `client:destroy` | 页面隐藏/卸载,`ctx.dispose()` 回收前 | `{ name }` |

## 错误隔离与熔断

- HookBus 的 `emit` **永不抛错**:单监听器异常被捕获、计数并经 `onError` 上报告警。
- 同一监听器**连续失败 ≥ 8 次**自动摘除——病态插件不会刷垮事件流。
- 插件装载失败(语法错误/缺 name)只记入 `host.failures`,`aw plugin list` 与启动日志可见。

## 已知边界(v1)

- 钩子为**观察语义**,无 veto(拦截/改写)能力——写控联锁完整性优先,拦截钩子在路线图。
- 插件目录不在热更新监听范围——修改后重启服务生效。
- `server:close` / `onDispose` 依赖优雅关闭信号(Windows 强杀进程不触发;
  KV 防抖落盘 200ms,数据丢失窗口极小)。
