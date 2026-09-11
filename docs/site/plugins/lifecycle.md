# 插件生命周期详解

## 装载与关闭全景

```
                ┌─────────────────────── 服务启动 ───────────────────────┐
nitro 插件 aw-plugins.ts
  └─ initPluginHost:三作用域扫描(同名先到先得:builtin > project > user)
      → 逐插件 动态 import(?t= 破缓存)→ 形态校验 → 跳过 disabled
      → createPluginContext → setup(ctx) → 注册 routes[]
      └─ emit plugin:host:init { plugins, failures }
                └─────────────────────── 运行中 ────────────────────────┘
daq:sample(下发级采样) ──┐
daq:frame(多形态帧)     ──┤
dcw:write(写控 ACK)     ──┤
line:start / line:stop  ──┼──▶ ctx.hooks(HookBus:串行 await / 错误隔离 / 连续失败 8 次熔断)──▶ 插件消费
config:changed(设置变化)──┤
event:<scene-type>      ──┤
'*'(全事件通配)          ──┘
                ┌─────────────────────── 热重载 ────────────────────────┐
plugins-state.json 变化(fs.watch 目录 + 10s mtime 轮询兜底)
  └─ 逐插件 await dispose → 解绑全部 hooks → 清空路由表 → 重新装载
      → emit plugins:reloaded → 广播 scene 事件 plugins.reloaded(浏览器即时同步)
                ┌─────────────────────── 服务关闭 ───────────────────────┐
nitro close
  └─ 逐插件执行 dispose 队列(try/catch;含 KV 同步落盘)
      └─ 广播 server:close
```

## 服务端事件逐项

### `plugin:host:init`
- **时机**:全部插件 setup 完成后(一次性)。
- **payload**:`{ plugins: string[], failures: number }`。
- **用途**:就绪自证;依赖其他插件路由的延迟初始化。

### `plugins:reloaded`
- **时机**:热重载收尾(全量重装载 + 设置重新同步之后)。
- **payload**:`{ plugins: <manifest> }`。
- **用途**:重载后自证;浏览器侧同时收到 scene 事件 `plugins.reloaded`(经 WS)。

### `daq:sample` —— 数采样本流
- **时机**:节点采样经管线汇聚后的**下发级**出口(与 WS `daq.reading` 同点;
  按节点 publishIntervalMs 节拍,不是每个原始采样)。
- **payload**:`{ nodeId, templateRef, value, state, at, lineId }`。
- **示例(越限告警)**:
  ```js
  ctx.hooks.on('daq:sample', (s) => {
    if (s.value > (ctx.kv.get('threshold') ?? 180)) ctx.kv.bump('alarms')
  })
  ```

### `daq:frame` —— 多形态帧观察
- **时机**:向量/图像帧入账后(只含元数据、指标与预览,**不含 blob**)。
- **payload**:`{ nodeId, templateRef, kind, at, lineId, preview?, metrics, thumbUrl?, state }`。
- **用途**:派生指标旁路计算、帧级外部通知。

### `dcw:write` —— 写控观察
- **时机**:写控 ACK 落账后(含 10s 同值去重)。
- **payload**:`{ nodeId, name, eng, prevValue, ok, source, lineId, at }`;
  `source ∈ manual | recipe | agent | rollback`,`ok` = 回读校验结论(**没有 `message` 字段**)。
- **用途**:下发审计、告警联动、外系统通知(经 ctx.http)。

### `line:start` / `line:stop`
- **时机**:批次窗口开/闭。
- **payload**:`{ lineId, runId, recipeId: string, productName: string }` / `{ lineId, runId }`;
  两个键**总是存在**,但可能是空字符串 —— 消费方请判**真值**,不要判字段有无。
- **示例(运行态跟踪)**:
  ```js
  ctx.hooks.on('line:start', (p) => { ctx.kv.set('running', true); ctx.kv.bump('runningCount') })
  ctx.hooks.on('line:stop', () => ctx.kv.set('running', false))
  ```

### `event:<scene-type>` 与通配 `'*'`
- **时机**:任一 `broadcastSceneEvent(type, payload)`(与浏览器 WS 完全同源)。
  常见:`daq.reading` · `daq.frame` · `daq.alarm` · `daq.alarm.changed` · `daq.node.changed` ·
  `daq.controller` · `daq.template.changed` · `dcw.node.changed` ·
  `device.created|updated|deleted` · `ops.log` · `permissions.changed` · `plugins.reloaded`。
- **通配写法**:服务端是**裸星号 `'*'`**,回调收到 `{ type, payload }` 包装;
  `ctx.hooks.on('event:*', fn)` 是**错的**,永不触发。
- **示例**:
  ```js
  ctx.events.on('daq.node.changed', (p) => ctx.logger.debug?.('节点变更', p?.op))
  ctx.hooks.on('*', ({ type }) => { /* 全事件审计 */ void type })
  ```

### 权限变更 `permissions.changed`
- **时机**:产线授权写入后(宿主把平台事件统一加 `event:` 前缀)。
- **payload**:`{ userId, at }`。
- **正确订阅方式**:`ctx.events.on('permissions.changed', fn)`;
  `ctx.hooks.on('permissions:changed', fn)` **永远不触发**(原始总线名字是 `event:permissions:changed`)。

### `config:changed`
- **时机**:`runtime-settings.json` 变化(`aw config set` / 网页设置;fs.watch 防抖 300ms)。
- **payload**:`{ type, changed: string[], effective, sources }` —— **没有 `at` 字段**;
  `ctx.config.get/all()` 已在事件前刷新为新值。
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
| `event:<scene-type>` / `event:*` | WS 实时事件(经 TownBus 桥)。唯一通配写法是字面量 `'event:*'`;`ctx.on(type)` 的 type 传**事件名本身** | 事件 payload |
| `page:change` | Vue Router 页面切换完成 | `{ path }` |
| `i18n:changed` | 界面语言切换(v2;面板据此重渲染) | `{ locale }` |
| `client:destroy` | 页面隐藏/卸载,`ctx.dispose()` 回收前 | `{ name }` |

客户端订阅面有三条硬规则:

1. `ctx.on(type, fn)` 只装 **scene 事件**(内部装到 `event:<type>`);通配只能写 `'event:*'`,
   `ctx.on('*')` 与 `ctx.on('event:line.start')` 都是**死订阅**。
2. **服务端钩子不过桥**:`ctx.on('daq:sample' | 'dcw:write' | 'line:start' | 'line:stop')` 静默永不触发。
3. **生命周期钩子不在 `ctx.on` 面上**:`client:init` / `page:change` / `i18n:changed` / `client:destroy`
   必须用 `ctx.hooks.on(...)`。

### 面板生命周期(v2 UI 注入)

`ctx.ui.registerPanel({slot,name,title?,titleKey?,order?,mount(el)})` 注册的面板:

- **注入**:宿主页面 `<workshop-plugin-slot slot-name="…" />` 感知注册表变化,挂载容器并调用
  `mount(el)`;`mount` 返回的清理函数在面板卸载时调用。
- **回收**:`ctx.dispose()` 回收插件自己的订阅并移除 `root()`,但**不注销面板** ——
  面板由 loader 在停用/热重载时 `unregisterPlugin(name)` 回收。
- **隔离**:单面板 `mount` 抛错只影响自身,其余面板与页面不受影响。
- **内置插槽**:`plugins.page` · `settings.plugins` · `dashboard.widgets`。

## 错误隔离与熔断

- HookBus 的 `emit` **永不抛错**:监听器按注册序**串行 await**,每个监听器收到**同一个未被改写的 payload**;
  单监听器异常被捕获、计数并经 `onError` 上报告警。
- 同一监听器**连续失败 8 次**自动摘除(成功即清零,偶发失败不累积)——病态插件不会刷垮事件流。
- 插件装载失败(语法错误/缺 name/setup 抛错)只记入 `host.failures`;**半注册状态**(路由、hooks、
  omp 待注入工具)按插件名回滚,保证「要么完整装载,要么完全无痕」。
- **失败可见性**:`GET /api/workshop/plugins` 返回 `{ plugins, failures, initedAt }`(**无 `{code,data}` 信封**);
  `aw plugin list` **不显示**装载失败。

## 热重载机制与竞态防护

- **触发源**:`<home>/plugins-state.json`(`home = $AW_HOME || ~/.AgentWorkShop`,**不是配置根**)。
  宿主 `fs.watch` 其所在目录(目录监听对 tmp+rename 原子写稳定),另有 **10s mtime 轮询**兜底。
- **破缓存**:重新装载用 `import(entry + '?t=' + Date.now())`,所以**改插件代码无需重启进程**;
  宿主没有独立的插件目录 watcher —— 改完代码触碰状态文件(或 enable/disable 往返一次)即可生效。
- **核心代码仍需重启**:`server/` 与 `shared/` 不在插件热重载范围内。
- **竞态防护**:重装载进行期间状态文件再次变化(如 disable→enable 连击):去抖回调撞上 in-flight
  守卫会被合并,装载结束后宿主比对**禁用集快照**,有差异自动补跑一次重装载,启停事件绝不丢失。
- **浏览器侧**:WS scene 事件 `plugins.reloaded` 即时同步,另有 15s 轮询兜底。

## 已知边界(v2)

- 钩子为**观察语义**,无 veto(拦截/改写)能力——写控联锁完整性优先,拦截钩子在路线图。
- `ctx.http` 出站守卫**只校验协议**(仅 http/https),**不限制 host**;需要白名单请插件自校验。
- `ctx.t(key, params)` 的 `params` 当前被忽略(不做插值)。
- `server:close` / `onDispose` 依赖优雅关闭信号(Windows 强杀进程不触发;
  KV 防抖落盘 200ms,数据丢失窗口极小)。
- 浏览器侧新启用插件注入延迟 ≤15s(WS 可用时即时)。
