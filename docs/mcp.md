# aw 工业 MCP 服务(mcp/)

> 面向外部 skill / MCP 客户端 / 工程师工作台的集成入口:把平台关键 REST 方法暴露为
> 一等 MCP 工具,并**自动发现本机运行实例的端口**——挂上就能用,不要求手填端口。

## 一、它解决什么

平台已有两个 MCP 面,分工如下:

| MCP 面 | 位置 | 面向 | 鉴权 |
| --- | --- | --- | --- |
| **aw 工业 MCP**(本文) | `mcp/aw-mcp-server.mjs`(stdio) | 外部 skill、桌面 MCP 客户端、CI 脚本 | 用户 token(AW_TOKEN 或 AW_EMAIL/AW_PASSWORD) |
| host tools 回程桥 | `server/harness/aw-mcp-bridge.mjs`(stdio) | 频道内 harness 引擎(codex/dsh/opencode…) | agent 实例 token |
| Workshop MCP(Streamable HTTP) | `POST /api/mcp/workshop` | 平台侧任务/消息/设备孪生 | Bearer token |

工业 MCP 暴露的是**工程操作面**(产线/节点绑定/参数映射/配方/优化闭环频道/插件),
与频道内 agent 的 host tool 面(`.AgentWorkShop/prompts/host-tools.json`)互补。

## 二、快速开始

```bash
aw mcp --doctor        # 诊断:自动发现过程 → 健康 → 鉴权,一次讲清
aw mcp --print-config  # 打印 MCP 客户端配置 JSON
aw mcp                 # 启动 stdio 服务(由 MCP 客户端作为子进程拉起)
```

客户端配置(claude_desktop_config.json / codex config.toml 通用形态):

```json
{ "mcpServers": { "aw": { "command": "node", "args": ["<仓库>/mcp/aw-mcp-server.mjs"], "env": {} } } }
```

## 三、端口自动发现(核心机制)

发现优先级(逐级 `GET /api/health` 探活,`data.status==='ok'` 才算命中;全失败才报错):

1. `AW_BASE_URL` —— 显式平台地址
2. `AW_PORT` —— 多实例并存时钉住端口
3. 锁文件 `<configRoot>/.runtime/aw.lock`(`{pid,port,mode}`,`aw start` 端口顺延后回写,
   是实例真实端口的唯一权威记录):
   - 显式 `AW_HOME` 时:先 `AW_HOME/.runtime/aw.lock` 与 `AW_HOME/.AgentWorkShop/.runtime/aw.lock`,
     再 cwd 向上找 repo 锁(**显式 AW_HOME 压过隐式发现,且不回落全局 home 锁**——多实例隔离语义)
   - 未设 `AW_HOME` 时:cwd 向上找 `.AgentWorkShop/.runtime/aw.lock`,再 `~/.AgentWorkShop/.runtime/aw.lock`
4. `PORT` / `NUXT_PORT`(启动惯例变量)
5. `config.yml` 的 `server.dev.port` / `server.prod.port`(零依赖轻量解析)
6. 默认端口 3000(dev)/ 3001(prod)

**确保连接**:会话内缓存发现结果;任何工具调用遇到网络层失败,自动作废缓存重发现一次再重试
(实例顺延换端口后下一发即自愈)。401 时作废 token 懒重登录一次。
登录失败(凭据错误)不触发重发现,直接报错。

## 四、鉴权

- `AW_TOKEN`:直接携带(优先)。
- `AW_EMAIL` + `AW_PASSWORD`:首次鉴权调用时懒登录 `POST /api/users/login`,token 会话内缓存。
- 都没有:工具返回带补救指引的错误;客户端也可在会话里调 `aw_login` 工具显式登录。
- 实例从未初始化管理员:先走 Web `/setup` 注册(首注册即 admin),MCP 不代注册。

## 四点五、集成开关(系统设置)

- 设置项:`系统设置 → MCP 集成 → 启动 MCP 集成`(`mcp.enabled`,live 键,默认**停用**)。
  也可用环境变量 `AW_MCP_ENABLED=true` 覆盖(CI/无人值守场景)。
- 语义:停用期间,除 `aw_status`(自诊断)外的**所有 MCP 工具调用被拒绝**,返回指引文本;
  平台 REST 与频道内 agent 的 host tools 不受影响。切换 ≤3s 传导到 MCP 服务,无需重启。
- 三个项目 skill(`skills/`)的前置步骤 0 都会检查该开关(`aw_status` 的 `mcpEnabled` 字段)。
- 注意:设置页出现「MCP 集成」分组需要实例运行带该描述符的构建(`shared/config/schema.json`,
  2026-09-27 加入);文件路径(写 `<configRoot>/runtime-settings.json`)与 env 路径不依赖构建。

## 五、工具面(35 个)

| 分组 | 工具 |
| --- | --- |
| 连接 | `aw_status`(发现+健康+鉴权状态)、`aw_login` |
| 产线/产品/配方 | `aw_line_list/create/start/stop`、`aw_product_create`、`aw_recipe_create` |
| DCW 节点与参数映射 | `aw_dcw_snapshot/create/write/read`、`aw_param_list/write/read` |
| DAQ 数采 | `aw_daq_create`、`aw_daq_controller`、`aw_daq_samples` |
| 优化闭环频道 | `aw_channel_list/create`、`aw_channel_template_list/instantiate`、`aw_team_provision`(组合:建 agent→team→成员→deploy)、`aw_agent_tool_bind/invoke`、`aw_twin_profile_get/patch`、`aw_task_create/list`、`aw_model_list/promote`、`aw_optimization_judge` |
| 插件 | `aw_plugin_list`、`aw_plugin_toggle` |
| 逃生舱 | `aw_request`(通用 REST,path 必须以 `/api/` 开头) |

`aw_agent_tool_invoke` 可调用频道成员实例的全部宿主工具面
(`optimization_explore` / `mpc_optimize` / `twin_*` / `dcw_control` / `param_control` / `daq_query` 等),
是探索/寻优闭环的执行通道。

## 六、与 skills 的集成

三个项目级 skill 以本服务为执行底座(`skills/` 目录):

- `skills/aw-node-bind/` —— 真实场景节点参数绑定(建线→绑执行点→参数映射→配方开跑→回环验收)
- `skills/aw-opt-channel/` —— 场景优化闭环频道(模板实例化→剧组→探索→AML 门禁→绑定→投用)
- `skills/aw-plugin-dev/` —— 插件开发(脚手架→setup(ctx)→热重载验证→发布清单)

规范校验:`npm run test:skills`(含"skill 引用的工具必须真实存在于 MCP 工具面"的一致性检查)。

## 七、测试

```bash
npm run test:mcp        # 单测(12 断言组):锁解析/发现优先级/RPC 面/懒登录/断线重发现/逃生舱守卫
npm run test:mcp-live   # 真实实例 e2e(34 断言):隔离 home 实例 + 零端口提示自发现 + 全链业务
```

live e2e 的隔离纪律:临时 `AW_HOME` + 端口 3461,结束 `taskkill //T` 清场,不碰真实库。

## 八、已知边界(有意为之)

- `GET /api/workshop/plugins` 等少数端点是裸 `defineEventHandler`(无统一信封),服务端已做信封嗅探兼容。
- MCP 不代理模拟器 REST(presets/export);skill 流程里对模拟器的访问走直连(默认 `http://127.0.0.1:4010`)。
- `aw_request` 限制 method 白名单与 `/api/` 前缀,不代理任意外网。
