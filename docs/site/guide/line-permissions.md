# 产线级权限（用户 × 产线三态授权）

AgentWorkShop 对工业数据（数采/数控）实施**产线级**访问控制。每个用户对每条产线处于三种状态之一：

| 状态 | 数采节点 | 数控（写控）节点 | 可见性 |
|---|---|---|---|
| **无权**（普通用户默认） | 隐藏 | 隐藏 | 后端不返回该产线数据——产线运营 / 数采中心 / 数字孪生均不可见 |
| **仅查看** | 只读 | ✕ | 产线可见、实时值可看；不可写控、不可下发参数、不可绑定设备 |
| **可操控** | 读取 | 读取 + 写入 | 全量能力：设定值下发、参数下发、设备绑定 |

`admin` / `editor` 为运营管理角色，不受授权约束（全量全权）。

## 管理入口

管理员登录后，侧边栏出现「**权限管理**」（`/permissions`，仅 admin 可见）：

1. 用户表：全部注册用户（角色 / 状态 / Channel 数 / 已授权产线摘要），支持搜索。
2. 点「授权管理」进入用户详情：
   - 基本信息（邮箱 / 角色 / 状态 / 注册时间）；
   - 该用户创建的全部 Channel；
   - **产线授权矩阵**：每条产线一行，三态单选（无权 / 仅查看 / 可操控），批量保存。

## 强制点（数据面，而非仅前端隐藏）

- 列表接口（`GET /api/workshop/daq`、`GET /api/workshop/dcw`、`GET /api/workshop/dcw/lines`）按授权过滤——无权产线的节点与产线信息**不会离开服务端**；
- 写控端点（设定值下发 / 连接测试 / 设备绑定 / 数采参数下发）按产线模式校验，越权返回人话 403（如「该产线为仅查看权限:只读数采可见,写控/操作需管理员授予『可操控』」）；
- Agent ↔ 节点绑定：数采绑定需「仅查看」及以上，写控绑定需「可操控」；
- Agent 写授权三轨：`kind='dcw'` 节点绑定 = **点位写授权**（对当前活动配方的 trial/apply 生效；绑了 dcw 即把下发收窄到这些点位，未绑任何 dcw 时持配方级授权默认全参数可发）；`kind='recipe'` 配方绑定 = **单配方操作权**（含版本写入/回退）；`kind='line-recipe'` 产线配方管理权 = 对该产线**全部配方**（含未来新建）可 查看/新建/修改/回退（nodeId 字段 = 产线 id，授予需「可操控」，首绑 manual）。直写工具仍恒拒；
- **控制模式切换 = 摘闸门，必须显式确认**：绑定的 `mode` 决定每次写是否要人工批准。`manual→auto` 与"委派授予 auto"（`team_grant_nodes` / `dispatch_task.grant_node_ids`）都必须携带 `confirm: true`，否则 400 拒绝且不做任何变更；缺省一律 `manual`（不继承 lead 自身的 auto）。每次切换/授予都会写 `binding.mode` 审计；
- 数字孪生的实体基线来自同一批 REST 接口，未授权产线在孪生界面同样不可见。

## 程序化访问（SDK / 插件）

```js
// SDK REST 客户端（admin token）
const client = createPlatformClient({ baseUrl, token })
const overview = await client.permissions.overview()   // 全量产线 + 用户(含 channels/grants)
await client.permissions.set({ userId, grants: [{ lineId, mode: 'operate' }] })

// 插件 ctx.permissions（宿主注入）
const mode = ctx.permissions.lineMode(user, lineId)          // 'none' | 'readonly' | 'operate'
const visible = ctx.permissions.visibleLineIds(user)          // Set<lineId> | null(全量)
const grants = ctx.permissions.listGrants(userId)             // [{ lineId, mode, grantedBy, grantedAt }]
await ctx.permissions.setGrants(userId, [{ lineId, mode }])   // 写授权(自动广播)

// 授权变更：前端消费 scene 事件，插件订阅 permissions:changed
ctx.events.on('permissions:changed', ({ userId }) => { /* 刷新缓存 */ })
```

授权变更会广播 `permissions.changed`（scene 实时事件，前端经 WS 消费）与
`permissions:changed`（插件事件）。插件侧订阅必须走 `ctx.events.on(...)` ——
宿主给平台事件统一加 `event:` 前缀，`ctx.hooks.on('permissions:changed')` 永远不触发。
