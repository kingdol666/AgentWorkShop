# 第一次「Agent × 产线」会话（约 2 分钟）

> 首次体验请仅使用隔离的模拟环境：独立 `AW_HOME`、独立平台/模拟器端口和 `simulated=true` 测试线。下面的建线、启动、配方提案和审批会改变测试数据；不要连接或操作共享模拟器、未经批准的真实设备或生产线。具体准备步骤见[产线集成指南](/guide/line-integration)。

1. **登录** —— 打开测试实例地址并注册/登录。隔离环境首个注册账号自动成为 admin；不要在共用或生产实例上为测试创建账号。
2. **准备模拟线** —— 按[产线集成指南](/guide/line-integration)从审签后的蓝图生成独立模拟孪生，再接入 `simulated=true` 测试线；不要把真实端点填入示例配置。
3. **建团队与 Session** —— 创建 Agent/Channel，integrated Channel 创建 Session 时绑定可信产品；`generic` Channel 不会因填写 `lineId` 获得产线权限。
4. **绑定节点** —— 绑定数采节点与所需写控/配方节点。只读绑定用于取数；写入是否进入 HITL 由 Channel、产线总闸和绑定模式共同决定。
5. **提交目标** —— 在模拟测试线中请求分析最近 5 分钟的温度；如需变更，只提出配方候选，不要求直写设备。
6. **核对结果** —— 仅在确认目标是本次隔离模拟线且审批策略要求时处理 HITL；核对 DCW 回读、DAQ 后续样本与 journal，再报告结果。模拟通过不代表物理 HIL 或生产投用通过。

## 全程发生了什么

```text
目标 → integrated Channel / product-bound Session → line_context 与记忆检索
     → 标量 DAQ 或帧读取 → recipe_propose → 按有效策略进入 HITL（如要求）
     → 模拟设备回读 / DAQ 响应 / journal 对账
```

## 用 CLI 验证

```bash
aw config get server.prod.port          # 端口来源
aw status                               # 运行态总览
aw plugin enable line-sentinel          # 示例插件默认停用:先启用,否则其路由不注册
curl -X POST http://localhost:3001/api/plugins/line-sentinel/threshold \
  -H 'content-type: application/json' -d '{"threshold":100}'   # 插件 API(示例插件 line-sentinel)
```

> 首启引导会把 `line-sentinel` / `ops-notifier` / `sample-insight` 等示例插件种子到
> `~/.AgentWorkShop/plugins`,并在 `plugins-state.json` 中**记为停用**;被停用的插件路由
> 根本不注册,直接 curl 会 404 —— 先 `aw plugin enable line-sentinel`(约 1s 热重载生效)。
> 插件作用域优先级为 builtin > project > user;`aw plugin create` 默认落 project 级,
> `--global` / `-g` 落 user 级。
