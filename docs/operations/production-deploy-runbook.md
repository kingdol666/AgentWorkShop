# 生产部署 Runbook（上线清单与恢复演练）

> 配套：`docs/audit/2026-11-08-production-readiness/FINAL-REPORT.md`（审计与优化计划）、
> `docs/plans/2026-11-08-production-readiness-execution-plan.md`（PR 序列）。

## 0. 上线前硬性检查（逐项打勾）

| # | 项 | 命令 / 位置 | 通过判据 |
|---|---|---|---|
| 1 | 引擎构造契约 | `npm run test:unit` | 1255+ tests、0 fail；含 `harness-construction-contract` 16 条 |
| 2 | 类型检查 | `npm run typecheck` | `✔ 类型检查通过` |
| 3 | 产线节点无 mock 驱动 | `GET /api/workshop/daq` + `/dcw` 检索 `driver=mock` 且 `lineId` 非空 | 结果为空（创建端点已强制显式 driver，历史数据需人工整改） |
| 4 | Project 均显式 leaderHarness | 查 `projects.config_json.leaderHarness` | 无缺失（创建端点已 400 兜底） |
| 5 | 会话密钥 ≥32 字符 | `NUXT_SESSION_PASSWORD` | 启动日志无 fail-loud 告警（`server/plugins/security.ts`） |
| 6 | Timescale 口令非缺省 | `.AgentWorkShop/data/daq-infra-credentials.json` 或 `AW_TS_PASSWORD` | 非 `awshop` |
| 7 | 备份可用 | 环境不设 `BACKUP_DISABLED=1`；看 `/api/metrics` 的 `awshop_backup_last_success_timestamp` | 非 0 |
| 8 | 引擎装配失败指标 | `/api/metrics` → `awshop_engine_activate_failures_total` | 0（非 0 即查该 channel 成员 harness 配置） |
| 9 | 反向代理限流 | 网关层（Nginx/Traefik）对 `/api/**` 限流 | 配置入库并在 staging 验证 |

## 1. 配置优先级（务必理解，避免"改了不生效"）

```
描述符默认 < config.yml < runtime-settings.json(设置页/CLI 写入) < 环境变量(AW_*)
```

- **env 静默压过 UI/CLI 改动**：排查"设置不生效"先查同名 `AW_*` 环境变量。
- `live` 键：服务端文件监听自动重载（通常 <1s）。
- `restart` 键（含全部 `harness.*`）：改后需重启实例。

## 2. 环境变量固定清单（建议写进部署清单并纳入版本管理）

| 变量 | 用途 | 备注 |
|---|---|---|
| `AW_MODE=home` + `AW_HOME=<dir>` | 隔离数据根 | **两者必须同时给**；缺 `AW_MODE` 时仓库内 `./.AgentWorkShop` 优先会吞掉 `AW_HOME` |
| `PORT` | 监听端口 | `node .output/server/index.mjs` 不认 `--port` |
| `NUXT_SESSION_PASSWORD` | 会话签名 | ≥32 字符，缺失/过短 fail-loud |
| `AW_ACTIVATE_TIMEOUT_MS` | Channel 装配 deadline | 缺省 30000；慢盘/大频道可上调 |
| `AW_MCP_ENABLED` | MCP 工具面 | 使用者需开启才有 `aw_*` 工具 |
| `BACKUP_DISABLED` | 备份开关 | **生产勿设**（仅压测/演示临时关闭） |
| `AW_IDENT_GATE=0` | 可辨识性门逃生 | 仅测试面；生产保持缺省（开启） |

## 3. Token 与凭据轮换

1. **Agent token**：`POST /api/workshop/channels/:cid/agents/:aid/rotate-token`，旧 token 有 60s 双接受窗（v31 `prev_token`），窗口内完成切换。
2. **用户会话**：改 `NUXT_SESSION_PASSWORD` 后所有会话失效，需重新登录（建议维护窗执行）。
3. **Timescale/MinIO**：改密后同步更新 `daq-infra-credentials.json`；**该 json 是读取源**，`.env` 仅为 docker `--env-file` 导出形态。
4. **MES secretRef**：凭据只进环境变量 `AW_MES_<REF>_TOKEN`，配置里只存 secretRef；PATCH 节点时 secretRef 视图为掩码，**须显式给真值或不动该字段**。

## 4. 升级流程（含前置快照）

1. 停服前：确认 `/api/metrics` 备份时间戳新鲜；手动触发一次备份。
2. **迁移自保护（P4 计划项）**：schema 变更前应先做 `backups/pre-upgrade-<stamp>/` 三库 + 配置快照——本期已列入计划，若本次升级尚无该自动保护，**人工先复制 `.AgentWorkShop/` 到旁路目录**。
3. 替换 `.output/` → 启动 → 观察启动日志：迁移条数、`[restore] channel … 恢复失败` 告警（P0-1 已改为逐 channel 兜底，单 channel 失败不再中断）。
4. 验证：`/api/health`、`/api/metrics`（引擎失败计数）、任选一条产线跑 `verify-line` 冒烟。

## 5. 恢复演练（上线前必做一次）

```bash
# 1) 备份产物
ls -la <dataRoot>/backups/ | tail -3
# 2) 停服，把 .AgentWorkShop 移走（保留副本）
# 3) 从备份 bundle 还原三库 + 配置
# 4) 启动，检查
curl -s localhost:$PORT/api/health
curl -s -H "authorization: Bearer $TOKEN" localhost:$PORT/api/metrics | grep -E "engine_activate|backup_last"
# 5) 选一条产线跑 verify-line（V1-V6）
node scripts/onboarding/verify-line.mjs <verify-config.json>
```

判据：health ok / 数据行数与备份前一致 / verify-line 全绿 / 无引擎装配失败。

## 6. 故障处置速查

| 现象 | 首先看 | 常见原因 |
|---|---|---|
| 某引擎 channel activate 500/504 | `/api/metrics` 引擎失败计数 + 服务端日志 | harness 命令未安装 / 配置缺失；P0-1 后构造崩溃已修，剩余多为 CLI 缺失 |
| 项目卡在待验收 | `GET /projects/:id/results` 是否有 draft | 实例已释放（见审计指控5，P6 待修）；owner 可走 REST 提交，或重派工作项 |
| 插件页清单为空但功能正常 | 响应体是否 `{plugins:[...]}`（**无 data 包裹**） | 客户端解析错键（本审计踩过） |
| 设置改了不生效 | 同名 `AW_*` env；键的 `applies` 值 | env 优先级更高 / restart 键需重启 |
| 数据不再增长 | `awshop_daq_running`、节点 `enabled` | 采集总控未启动 / 节点停用 |
| 备份时间戳不动 | 是否设了 `BACKUP_DISABLED` | 演示实例常被禁用 |
