# SDK + 插件系统设计与实施计划（pending approval → 用户本轮已明确要求实现）

日期：2026-09-02 · 状态：已按用户本轮明确指令进入实施 · 模式：omc-plan direct

## 需求摘要

1. npm 发布/更新链持续正常（0.2.1 已在线,本迭代出 0.2.2 交付 SDK）。
2. `sdk/` 目录：hook、context、runtime 生命周期操作,随 npm 包分发。
3. `~/.AgentWorkShop/plugins/` 插件目录：插件=入口文件+生命周期+node 项目架构,基于 SDK。
4. 插件能对**前后端内容插入增强**。
5. 满足优秀可扩展插件/SDK 项目标准开发范式。

## 框架勘察结论（注入点事实,均已核实）

| 注入点 | 文件 | 事实 |
|---|---|---|
| 无频道实时事件总线 | `server/services/workshop/scene-events.ts:47` | `broadcastSceneEvent(type,payload)` 全员直推,daq.reading/ops.log/device.created 等全部经此 |
| DAQ 下发级采样 | `server/services/workshop/daq/daq-controller.ts:196` | `this.broadcast?.('daq.reading',…)` 按节点 publishIntervalMs 门控 |
| Nitro 插件单例范式 | `server/plugins/workshop.ts` | `globalThis.__workshopManager` 防热重载重复装配 |
| 客户端插件范式 | `app/plugins/runtime-config.client.ts` | `defineNuxtPlugin` + import.meta.client |
| 客户端事件桥 | `app/composables/workshop/useTownBus.ts` | 全局 `__townBus` 单例,scene 事件客户端同源 |
| 命令注册表范式 | `cli/core/registry.mjs` | 三层扫描/错误隔离/约定优于配置(插件系统同哲学) |

## RALPLAN-DR 摘要

**原则**：① 插件零导入依赖(宿主注入 ctx,VSCode activate 范式)→ 免解析地狱;② 错误隔离(单插件故障不拖垮主服务);③ 同哲学复用(commands 三层扫描/配置引擎/globalThis 单例,不发明新机制);④ 观察优先(v1 钩子只读,不改变写控联锁语义;veto 类钩子留 roadmap);⑤ 前后端同构生命周期(setup/client 两面,同一清单)。

**决策驱动**：① 插件必须能增强前后端;② 用户机全局安装形态(repo/home 双模式)下插件解析必须零依赖可用;③ 不破坏既有 AEP/联锁/配置契约。

**可行选项**：
- **A(选定)宿主注入 ctx + 静态导出对象**：插件=导出 `{name,setup(ctx),client,routes}` 的普通 ESM;宿主动态 import+装载。优:零依赖解析/最小契约/与 commands 哲学一致;劣:无模块级 SDK 树摇。**B(否)插件 import 'agentworkshop/sdk'**：全局安装下 ~/.AgentWorkShop/plugins/ 不在 node_modules 解析链上,需要软链/依赖安装,用户机必踩坑;否决。
- 前端增强:**A(选定)宿主端点服务 client.mjs + 客户端 loader 动态 import(@vite-ignore)**;B(否)编译期注入 SFC——要求用户机构建链,违背"装完即用";C(否)iframe 沙箱——隔离过重,无法增强面板。

## 契约设计

插件入口(index.mjs,零导入)：
```js
export default {
  name: 'demo', version: '1.0.0',
  setup(ctx) {           // 服务端:ctx.hooks/config/logger/kv/route/http/events
    ctx.hooks.on('daq:sample', s => ctx.kv.bump('samples'))
    ctx.route('GET', '/stats', () => ctx.kv.all())
  },
  client: './client.mjs', // 浏览器:export function setup(ctx){ctx.on(...);ctx.el(...)}
}
```

生命周期钩子：`plugin:host:init` · `event:*`(scene 全事件桥) · `daq:sample`(下发级) · `dcw:write`(ACK 后观察) · `line:start`/`line:stop` · `server:close`;客户端 `client:init`/`event:*`/`page:change`/`dom:ready`。

## 实施步骤

1. `sdk/`：index.mjs(SDK_VERSION/definePlugin 校验糖/导出)、hooks.mjs(HookBus: on/once/off/emit 异步串行+错误隔离+`*` 通配)、context.mjs(createPluginContext: config/logger/kv/route/http/events/paths)、client.mjs(客户端 ctx 工厂)、examples/sample-insight/ 示例。
2. 宿主：`server/services/workshop/plugins/host.mjs`(发现 repo+home 双目录/project 同名覆盖/错误隔离/路由表/globalThis 单例);nitro 薄插件 `server/plugins/aw-plugins.ts`(init+close);桥接 scene-events(1 行)与 daq-controller(1 行)。
3. API：`server/api/workshop/plugins/index.get.ts`(manifest,免鉴权只读 name/hasClient/scope);`server/api/plugins/client/[name].get.ts`(text/javascript);`server/api/plugins/[name]/[...path].ts`(插件路由转发,exact-match)。
4. 客户端 loader：`app/plugins/aw-plugins.client.ts`(fetch manifest → @vite-ignore 动态 import → 错误隔离 → page:change 桥)。
5. CLI：`cli/commands/plugin.mjs`(list/create 脚手架,--project/--global)。
6. `home-bootstrap.mjs` 种子 `plugins/` 目录 + README;`docs/plugins.md` 完整指南;package.json files 加 "sdk";版本 0.2.2。
7. 验证：create→manifest→插件路由→client JS→浏览器 console 无错→发布 0.2.2→npm view 验证。

## 验收标准（可测）

- [ ] `aw plugin create demo --project` 生成可用骨架;`aw plugin list` 两目录识别
- [ ] 服务启动后 GET /api/workshop/plugins 列出已装载插件(含 scope/hasClient)
- [ ] 示例插件路由 GET /api/plugins/sample-insight/stats 返回 JSON 计数
- [ ] GET /api/plugins/client/sample-insight 返回 text/javascript 且可被动态 import 执行
- [ ] daq:sample 钩子在启线采样后计数增长(事件桥真实)
- [ ] 浏览器加载无新增 console 错误,客户端徽标增强出现
- [ ] npm 0.2.2 发布成功,npm view 可见;aw update --check 可见新版

## 风险与缓解

| 风险 | 缓解 |
|---|---|
| 插件死循环/抛错拖垮事件桥 | HookBus emit 单监听器 try/catch + 错误计数,连续失败自动摘除 |
| 客户端动态 import 被 Vite 改写 | `/* @vite-ignore */` + 绝对路径字符串 |
| 循环导入 TDZ(scene-events→host) | host 不反向 import scene-events;单向依赖 |
| 插件任意代码=任意权限 | 与 aw commands 同信任模型,文档明示仅装可信插件 |

## ADR

**决策**：宿主注入 ctx 的普通对象插件 + 端点服务式客户端增强 + 单例 HookBus。
**为什么**：唯一在"全局安装零解析链"约束下同时满足前后端增强的架构;与 commands/config 哲学同构,心智负担最低。
**后果**：插件无类型运行时导入(TS 作者 type-only import agentworkshop/sdk);客户端插件需自包含(v1)。**后续**：veto 钩子/插件市场索引/TS 类型包 `agentworkshop/sdk` d.ts。
