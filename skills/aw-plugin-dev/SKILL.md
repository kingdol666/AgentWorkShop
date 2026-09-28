---
name: aw-plugin-dev
description: AgentWorkShop 插件开发 skill。当需要为 AgentWorkShop 开发、调试、启停或发布插件(服务端钩子/API 路由/Agent 工具/数采扩展/混合孪生 Provider)时使用。覆盖脚手架、index.mjs 入口契约、setup(ctx) 服务面、热重载验证与发布前清单,经 aw 工业 MCP 服务做装载验证。
---

# AgentWorkShop 插件开发

从脚手架到热重载验证的插件开发闭环:create → 实现 setup(ctx)(钩子/路由/工具/孪生 Provider)
→ enable 验证装载 → 按发布清单自检。

## 前置条件

- **MCP 集成开关已启用**:平台 Web「系统设置 → MCP 集成 → 启动 MCP 集成」打开(或 env `AW_MCP_ENABLED=true`);未启用时除 `aw_status` 外全部工具被拒。
- 在 AgentWorkShop 仓库工作区内(`aw plugin create` 落 project 级)。
- 实例运行中(热重载验证需要;`aw_status` 确认 `mcpEnabled=true` 与鉴权)。插件改动 ~1s 自动重装载,无需重启。
- 权威参考:`docs/plugins.md`(契约与 ctx 全参考)、`docs/sdk.md` §ctx.twin(孪生 Provider SDK)。
  实现前先读对应章节,不要凭记忆写契约。

## 工作流程

### 1. 脚手架

```
aw plugin create <name>            # project 级:.AgentWorkShop/plugins/<name>/
aw plugin create <name> --global   # user 级:~/.AgentWorkShop/plugins/<name>/
```

生成 `index.mjs`(入口)+ `client.mjs`(浏览器增强,可选)+ `README.md`。
同名优先级 builtin > project > user(宿主先扫先占)——命名前先 `aw_plugin_list` 查重。

### 2. 实现入口契约(index.mjs)

default export:`{ name, version?, description?, auth?, client?, settings?, configGroups?,
routes?, setup(ctx) }`。入口保持零导入依赖、自包含。

`setup(ctx)` 服务面(细节以 docs/plugins.md 为准):

- `ctx.hooks.on(event, fn)`:daq:sample / daq:frame / dcw:write / line:start|stop /
  config:changed / plugins:reloaded / event:*(scene 全事件)/ server:close;通配 `'*'`。
- `ctx.events`:同事件总线;高频事件勿无脑全订。
- `ctx.kv.get/set/all/bump`:插件私有 KV,落 `<configRoot>/data/plugins/<name>/kv.json`
  (**不在插件目录**;没有 reset)。
- `ctx.config.groups()/fields()`:配置分组;`settings[]` 声明式字段 + 运行时注册。
- `ctx.logger.debug/info/warn/error`:自动前缀。
- `ctx.http.get/post(url, opt)`:出站请求,只校验协议(http/https),默认超时 8s。
- `ctx.route`:注册插件 API 路由(挂 `/api/plugins/<name>/...`)。
- `ctx.services.names()/get(name)/provide(name, getter)`:get('daq'|'lines'|'channels'|'plugins');
  provide 自动加 `<插件名>.` 前缀。
- `ctx.twin`(混合孪生 Provider):registerPhysicsProvider / registerScenePack /
  registerObjectiveProfile / registerTrainingAdapter / registerSolverAdapter +
  listProviders / getProviderHealth / resolveProvider / validateProvider / retireProvider /
  isRegistryAvailable。内置 twinCore 经 `ctx.services.get('twinCore')` 取
  createInjectionProvider / defaultInjectionScene。

### 3. 孪生 Provider 插件(可选)

Provider manifest 要点:`apiVersion: 'twin-provider.v1'`、`providerId`、`version`、
`sceneKinds[]`、`backend`、四类变量表(control/target/feature/ disturbance)、
`parameterPriors`、`capabilities`、`artifactContract`;生命周期
DISCOVERED→VALIDATED→REGISTERED→READY→DRAINING→RETIRED(按 generation 热替换)。

- 参考实现:外部插件 `.AgentWorkShop/plugins/twin-thermal-demo/index.mjs`(~100 行,
  只用 ctx.twin);内置 `server/plugins-builtin/twin-injection-default/index.mjs`。
- SDK 与类型:`sdk/index.mjs`(definePlugin)+ `sdk/index.d.mts`;示例在 `sdk/examples/`。
- 查询面:`aw_request { method:'GET', path:'/api/workshop/aml/twin/providers' }` 看注册结果
  与 generation/健康(装裁验证的孪生侧证据)。

### 4. 前端增强(可选)

`client.mjs`:订阅面板事件、插槽注入。注意高频事件的通配订阅在玻璃页/后台页不可达
(详见 docs/plugins.md「通配与不可达的订阅」),勿在 client 里做数据总线。

### 5. i18n(可选)

`i18n.json` 多语言键值;前端按当前 locale 取。

### 6. 启停与热重载验证

1. 新脚手架目录的首次装载:触碰 plugins-state.json(create 完成时的输出会提示)或
   直接 `aw_plugin_toggle { name, enabled: true }` —— 宿主监视该文件,~1s 全量重装载。
2. `aw_plugin_list`(MCP)或 `aw plugin list`:确认插件出现、loaded 无 failures。
3. 改代码 → 保存:保存后触碰 plugins-state.json(或任意启停操作)触发热重载(ESM cache-bust)。
4. `aw_plugin_toggle { name, enabled: false }` 再 true:验证启停回路。
5. 有路由的插件:curl 实测 `GET /api/plugins/<name>/health` 等。
6. 装载失败看 `aw_plugin_list` 的 `failures`(错误隔离,单插件失败不拖垮主服务)。

### 7. 测试

- 生命周期:`node scripts/test-plugin-lifecycle.mjs`
- 孪生 SDK:`npm run test:twin-provider`(tests/aml-twin-provider-registry.test.ts)
- 自写验证脚本参考 `scripts/test-twin-plugin-sdk.mjs`

### 8. 发布前清单

按 docs/plugins.md §十三逐条过:契约完整/settings 类型正确/路由鉴权/KV 只走 ctx.kv/
事件订阅有对应清理/README 与 i18n 齐备。

## 治理红线

- 插件不得绕过平台治理面直接写 PLC 或改库;数据访问走 ctx.services 与事件。
- KV 只经 ctx.kv(原子落盘),不要自己在插件目录写状态文件。
- dev 进程的 ESM alias 坑:裸相对导入按输出目录重算会溢出盘符根——插件保持自包含,
  确需引宿主模块先读 docs/plugins.md 故障排查章节。

## 验收清单

- [ ] aw_plugin_list 无 failures,插件 enabled
- [ ] setup 内日志出现(前缀 [aw-plugins] [<插件名>])
- [ ] 热重载后行为更新(改一行文案验证)
- [ ] 启停回路 enable/disable 通过
- [ ] 路由/钩子/KV 行为与声明一致
- [ ] 发布前清单(docs/plugins.md §十三)全过
