# 产线日志域隔离与检索验收（2026-10-19）

## 1. 问题与实测证据

改造前 `GET /api/workshop/ops-logs` 直接返回整张 `audit_log`。生产实例 652 行审计中混入大量与产线无关的全局事件：

| action | 行数 | 是否应进产线日志 |
| --- | ---: | --- |
| `auth.login` | 124 | 否 |
| `system.backup.run` | 81 | 否 |
| `system.settings.update` | 7 | 否 |
| `user.create` | 1 | 否 |
| `approval.approve/reject` | 22 | 否（在审批台账） |

同时部分真实产线操作缺少归属维度：REST `recipe.apply` 3 行无 `line_id`；Agent 开/停线只有线没有配方；报警确认、频道换线、数控节点增删改等未落产线域。

## 2. 改造内容

### 2.1 写入侧

- **显式域标识**：`audit_log` 新增 `scope` 列（`line` / `system`）。`recordOps`/仓储 `append` 共用 `normalizeAuditScope` 在写入时确定域标识：`lineId` 非空 = `line`，否则 = `system`；显式 `scope='line'` 但缺 `lineId` 时 fail-closed 降级为 `system`。老库**首次补列**时按 `line_id` 回填；后续启动只强制「`scope=line` 必须有 `line_id`」，不改写显式 `system` 语义。
- `recordOps()` 的实时帧只广播 `scope=line` 的记录：登录/设置/备份等全局事件仍写 `audit_log`，但不再进入 `/logs`、`/operations` 的实时轨。
- 补齐产线/配方/产品维度：
  - REST `recipe.apply` 增加 `lineId`；
  - Agent `line_start` / `line_stop` / 自动停线增加 `recipeId` 与 `productId`；
  - `recipe.dispatch.ack` 增加 `productId`；
  - `daq.alarm.raise` / `daq.alarm.ack` 回填产线与活动批次的产品/配方；
  - `channel.line.rebind` 增加目标 `lineId`；
  - `dcw.create` / `dcw.patch` / `dcw.delete` 改走 `recordOps` 并带 `lineId`；
  - 新增 `line.update`、`recipe.create`、`recipe.delete` 产线域审计；
  - `dcw.write.rejected` 回填活动批次的 `productId/recipeId`。
- `audit_log(scope, at DESC)`、`audit_log(line_id, at DESC)` 与 `audit_log(recipe_id, at DESC)` 索引在补列迁移之后创建（老库先补列再建索引）。

### 2.2 查询侧

- `GET /api/workshop/ops-logs` **默认 `scope=line`**：只返回 `audit_log.scope='line'` 的产线域记录；`scope=system` 只返回全局事件；`scope=all` 返回全部（admin 安全审计）。每行投影都带 `scope`。
- `recipeId`/`productId` 是可选过滤：按 `lineId` 查询时，没有 recipe/product 的产线事件（如 `line.update`、`dcw.create`、`dcw.delete`）仍然返回；一旦传 `recipeId`，无该配方的记录被排除。
- 时间参数 `from/to` 接受任意 `Date.parse` 可解析格式，统一归一为配置时区 ISO；非法时间/倒置区间返回 400 `VALIDATION_ERROR`。
- 时间比较与排序改用 `julianday(at)`：`at` 是带偏移的本地 ISO，跨时区历史行按字符串比较会错序。
- `limit` 在 API 与仓储双层收敛到 1..500 / 1..1000。
- 人工记录若给了 `productId/recipeId` 会自动补全并交叉校验 `lineId`，不允许把 A 线配方写进 B 线日志。

### 2.3 Agent 工具

`ops_log` 新参数：`line_id / recipe_id / product_id / node_id / kind / actor_kind / from / to / minutes / limit / mine`。

- 只返回 `scope=line` 的产线域记录；每条结果带 `scope=line 产线=名称[id] 配方=名称[id] 产品=名称[id]`。
- `recipe_id`/`product_id` 均可选；不传时按线返回全部产线事件（含无 recipe 的记录），传 `recipe_id` 时收窄到该配方并排除无 recipe 记录。
- 默认产线优先级：显式 `line_id` → `recipe_id` 所属线 → `product_id` 所属线 → 节点所属线 → 频道绑定线 → 全部可读线。
- `recipe_id/product_id/node_id` 只能缩小范围；越权、产线冲突、配方不存在均返回可行动错误。
- 只读面允许引用“可读产线上的任意节点”（与频道绑线只读扩权同口径），写工具不受此放宽影响。
- **`line_log`** 是 `ops_log` 的显式别名：handler/schema/dispatch/tool-verify/观察面白名单全部可用，回包与 `ops_log` 完全一致。
- `recipe_log` 新参数：`line_id / recipe_id / product_id / from / to / minutes / limit`；按 `action LIKE 'recipe.%'` 跨 `kind` 取全族（含 `kind=write` 的下发回执），再叠加 `optimization.*` 回退记录；回包逐行带 `scope=line` 与产线/配方/产品归属。

### 2.4 前端

- `/logs` 页标题改为「产线日志」，副标题明确“登录与系统管理事件不入册”。
- 筛选区新增「开始时间 / 结束时间」原生 `datetime-local` 输入；非法/倒置区间在客户端提示。
- 人工记录弹窗必须先选产线（否则不入产线日志）；提交时服务端再次校验归属。
- WS 实时轨与产线操作流水在客户端兜底只接收 `scope=line` 且 `lineId` 非空的帧；REST 行缺 `scope` 时按 `lineId` 推导。

## 3. 验收结果

| 项 | 结果 | 证据 |
| --- | --- | --- |
| 全量单测 | **242/242 PASS** | `pnpm test:unit` |
| 新增单测（scope/无 recipe/跨时区/limit/fail-closed） | **14/14 PASS** | `tests/audit-query.test.ts`、`tests/ops-log-query.test.ts` |
| 类型检查 | PASS | `pnpm typecheck` |
| 生产构建 | PASS | `pnpm build` |
| 产线日志专项 E2E（隔离实例，真实 HTTP + Agent 工具桥） | **24/24 PASS** | `pnpm test:line-log` |
| 生产库 scope 迁移 | **line 327 / system 327；badLine=0；badSys=0** | 3001 `.AgentWorkShop/data/workshop.sqlite` 只读核验 |
| 生产实例 Agent 实调 | `line_log`/`ops_log`/`recipe_log` 200 且回包带 `scope=line` | 3001 `x-aw-agent-token` 实调 |
| 改动文件 ESLint | 0 error | 本轮改动文件 |

专项 E2E 覆盖（24 项）：

- `G1` 隔离实例 ready + admin 注册。
- `G2` 建线/节点/产品/配方/频道(lead)/频道绑线。
- `G3` 真实操作：`recipe.apply`、`recipe.dispatch.ack`、`line.start/stop`、`line.update`、`dcw.create`、人工记录。
- `G4` 生成 `user.create` + `auth.login` 系统域事件。
- `G5a` 默认查询全部 `scope=line` 且 `line_id` 非空；`G5b` 登录/用户创建/系统事件为 0。
- `G5c/d` 按产线过滤全部命中且不串线，包含无 recipe 的 `dcw.create`/`line.update`。
- `G5e` 按产线+配方过滤命中下发/回执/开停线/人工记录，且排除无 recipe 事件。
- `G5f` 按时间区间过滤全部落在窗口内。
- `G5g` 倒置时间区间 400 `VALIDATION_ERROR`。
- `G5h` `scope=all` 仍可查登录/用户创建（安全审计未丢失）。
- `G5i` `scope=system` 只返回系统域记录（含登录、不含 line.start）。
- `G6a` Agent `ops_log(line+recipe)` 回包逐行带 `scope=line` + 产线/配方/产品归属。
- `G6b` 只传 `recipe_id + from/to` 自动收窄产线并命中。
- `G6c` Agent `recipe_log(recipe_id)` 命中创建/下发/回执且带 `scope=line`。
- `G6d` `node_id` 在频道绑线只读面内可查。
- `G6e` 越权产线被拒并列出可读产线。
- `G6f` Agent 倒置时间区间被拒。
- `G6g` 不传 `line_id` 默认频道绑定产线。
- `G6h` `line_log` 显式别名可用且与 `ops_log` 同口径。
- `G6i` Agent 按线查询包含无 recipe 事件（`dcw.create`/`line.update`，`配方=-`）。
- `G6j` Agent 按 recipe 查询排除无 recipe 事件。

`ops_log` 实际回包样例（E2E G6a）：

```text
产线日志(产线 日志线A-llhbbj[ln-e3256f70]; 配方 日志配方-llhbbj[rc-d6deb199], 近 60 分钟, 6 条, 新→旧):
- [10-19 16:48:04] scope=line 产线=日志线A-llhbbj[ln-e3256f70] 配方=日志配方-llhbbj[rc-d6deb199] 产品=- | 来源=用户 操作者=ll-admin-llhbbj | ops.manual | 人工值班记录-llhbbj
- [10-19 16:48:04] scope=line 产线=日志线A-llhbbj[ln-e3256f70] 配方=日志配方-llhbbj[rc-d6deb199] 产品=日志产品-llhbbj[pd-4a7ac8e1] | 来源=用户 操作者=ll-admin-llhbbj | line.stop | 产线停止采集...
- [10-19 16:48:04] scope=line 产线=日志线A-llhbbj[ln-e3256f70] 配方=日志配方-llhbbj[rc-d6deb199] 产品=日志产品-llhbbj[pd-4a7ac8e1] | 来源=用户 操作者=ll-admin-llhbbj | line.start | 产线开跑...
- [10-19 16:48:04] scope=line 产线=日志线A-llhbbj[ln-e3256f70] 配方=日志配方-llhbbj[rc-d6deb199] 产品=日志产品-llhbbj[pd-4a7ac8e1] | 来源=用户 操作者=ll-admin-llhbbj | recipe.apply | 一键下发配方批次...
- [10-19 16:48:04] scope=line 产线=日志线A-llhbbj[ln-e3256f70] 配方=日志配方-llhbbj[rc-d6deb199] 产品=日志产品-llhbbj[pd-4a7ac8e1] | 来源=系统 操作者=产线系统 | recipe.dispatch.ack | 批次 ... ACK 鉴定...
```

生产实例（3001）Agent `line_log` 实调样例（真实历史）：

```text
产线日志(产线 注塑验收线(模拟4036)[ln-dd4d6163], 近 5000 分钟, 12 条, 新→旧):
- [10-18 13:02:34] scope=line 产线=注塑验收线(模拟4036)[ln-dd4d6163] 配方=注塑基线配方[rc-fb3371f8] 产品=- | 来源=Agent 操作者=注塑验收线优化频道(4036)/生产主管 | analysis.save | Agent 留痕分析报告...
- [10-18 12:24:08] scope=line 产线=注塑验收线(模拟4036)[ln-dd4d6163] 配方=- 产品=- | 来源=Agent 操作者=注塑验收线优化频道(4036)/数据分析师 | analysis.save | ...（无 recipe 的产线事件仍按线返回）
```

## 4. 复跑

```bash
pnpm test:unit
pnpm typecheck
pnpm build
pnpm test:line-log
```

`test:line-log` 自行启动隔离实例（临时 `AW_HOME`，端口 3990–3993），不触碰现有生产实例。

## 5. 行为说明

- 历史行不改写：已有的无 `line_id` 旧记录（如早期 REST `recipe.apply`）仍保留在 `scope=all` 安全审计中，不会出现在产线日志；新写入已补齐维度。
- 全局安全审计入口：`GET /api/workshop/audit`（admin）与 `GET /api/workshop/ops-logs?scope=all`。
- 人工记录 API 仍接受不带 `lineId` 的全局备注（兼容旧脚本），但这种记录不会进入产线日志；前端已强制先选产线。
