# 配置系统

一个运行时,一个事实来源。**`config.yml`** 声明默认值;配置根内的
**`runtime-settings.json`** 承载运行时覆盖;环境变量与 CLI 参数在最上层。
每个可编辑键在 `shared/config/schema.json` 中声明一次(类型/范围/枚举/生效方式),
**网页设置页与 aw CLI 消费同一份描述符**。

```
config.yml(默认值)  <  .AgentWorkShop/runtime-settings.json(运行时)  <  环境变量(AW_* / PORT / HOST)  <  CLI 参数
```

## 配置根(双模式)

| 运行形态 | 配置根 | 工厂默认 config.yml / .env |
|---|---|---|
| 源码检出(repo 模式) | `<repo>/.AgentWorkShop` | `<repo>/config.yml`(git 版本化) |
| 全局安装(home 模式) | `~/.AgentWorkShop`(`AW_HOME` 可重定向) | `~/.AgentWorkShop/config.yml`(首启种子) |

配置根内包含:`runtime-settings.json`(运行时覆盖)、`data/`(SQLite/JSON 仓库/备份)、
`logs/`、`commands/`(自定义指令)、`plugins/`(插件)。

## CLI 操作

```bash
aw config list                       # 18 个设置项:有效值 + 来源 + 生效方式
aw config get server.prod.port       # 单键(值 + 来源)
aw config set server.prod.port 8080  # schema 校验 + 原子写盘
aw config set theme.primaryColor '#41c8f4'
aw config unset server.prod.port     # 移除覆盖,回落 config.yml
aw config reset --yes                # 清空全部运行时覆盖
aw config validate                   # 校验 config.yml 与覆盖合法性
```

## 生效方式

- `live` 键:保存即生效(主题、标题、超时等,经服务端事件流推送)。
- `restart` 键(端口、主机):落盘持久化,下一次对应模式启动时生效
  (`aw dev` / `aw start` / `aw config` 均读同一份有效配置)。
- 环境变量可覆盖任意键:`AW_<KEY 点转大写>`,如 `AW_SERVER_DEV_PORT=3100`;
  另支持惯例变量 `PORT` / `NITRO_PORT` / `HOST`。

## 配置层级的目录学(项目级优先,用户兜底)

运行数据的落点由 `shared/config/home.mjs` 统一判定,三层语义:

| 判定顺序 | 条件 | 运行时根 | config.yml |
|---|---|---|---|
| ① 项目级 | `<cwd>/.AgentWorkShop/` 存在 | `<cwd>/.AgentWorkShop` | `<repo>/config.yml`(git 版本化) |
| ② 检出内无项目根 | repo 检出但未初始化项目根 | `~/.AgentWorkShop`(AW_HOME 可重定向) | `<repo>/config.yml` |
| ③ home 模式 | 全局安装 / `AW_MODE=home` | `~/.AgentWorkShop`(AW_HOME 可重定向) | `<home>/config.yml`(首启种子) |

`~/.AgentWorkShop` 由 `postinstall`(`scripts/home-bootstrap.mjs`)与 `aw home`
幂等初始化:种子配置、`.env`(随机 session 密钥)、`commands/`、`plugins/`、`data/`。
`aw config set` 写入的 runtime-settings 与数据目录永远跟随运行时根 —— 同一台机器上
「项目级覆盖用户级」开箱即成立。

## 运行语义组(全键配置化)

v0.7 起,全部运行语义旋钮收编进描述符体系 —— **每个环境变量都有同名 config 键兜底**,
优先级一律为 环境变量 > runtime-settings > config.yml > 描述符默认,不再存在
「代码里硬编码默认值」的旁路。历史环境变量名(含无 `AW_` 前缀的)作为别名继续兼容。

| 组 | config 键(示例) | 历史 env 别名 | 说明 |
|---|---|---|---|
| `memory.*` | `memory.primer_tokens` / `inject_total` / `maintenance_ms` / `expire_days` / `expire_session_days` / `cap` / `reflect_trigger` | `AW_MEMORY_*` | 记忆预算/维护/过期;`embed_*` 三键配置向量检索 |
| `omp.*` | `omp.compact_enabled` / `compact_threshold` / `compact_min_interval_ms` / `compact_wait_ms` | `AW_OMP_COMPACT_*` | 上下文自动压缩 |
| `dcw.*` | `dcw.rollback_cooldown_ms` / `rollback_min_window_ms` / `rollback_baseline_ms` / `rollback_stale_ms` | `DCW_ROLLBACK_*` | 调控闭环回退护栏 |
| `workshop.*` | `workshop.idle_sweep_ms` / `idle_grace_ms` | `WORKSHOP_IDLE_*` | 空闲 agent 卸载 |
| `backup.*` | `backup.disabled` / `interval_hours` / `keep` | `BACKUP_*` | 运行数据自动备份 |
| `retention.*` | `retention.disabled` / `events_days` / `messages_days` / `audit_days` / `approval_days` | `RETENTION_DISABLED` / `AW_EVENTS_RETENTION_D` / `AW_MESSAGES_RETENTION_D` / … | 数据保留清理 |
| `log.*` | `log.level` | `AWSHOP_LOG_LEVEL` | 服务端日志级别 |
| `security.*` | `security.hitl_timeout_ms` | `HITL_TIMEOUT_MS` | HITL 审批超时 |
| `daq.*` | `daq.mqtt.qos` / `mqtt.username` / `mqtt.password` / `mqtt.caFile` / `mqtt.rejectUnauthorized` / `daq.tsRetentionH` / `daq.frameRetentionH` / `daq.alarmWebhookUrl` / `daq.alarmEscalateMinutes` | `DAQ_MQTT_QOS` / `DAQ_TS_RETENTION_H` / `DAQ_FRAME_RETENTION_H` / `ALARM_WEBHOOK_URL` / … | 数采总线/保留期/告警外送 |

两个例外(结构性自举变量,天然先于配置系统存在,不收编):`AW_HOME` / `AW_MODE`
(决定配置根本身)与 `AW_PACKAGE_ROOT` / `AW_PROMPTS_DIR`(启动器注入的载荷定位)。
整串连接覆盖 `DAQ_TSDB_URL` / `DAQ_OS_URL` / `DAQ_MQTT_URL` 保留「URL 最高优先、
config 连接参数拼装兜底」语义。

服务端读取统一走 `server/services/workshop/settings.ts`(类型化组访问器),业务代码
不再直读 `process.env` —— 环境变量的作用点收敛在描述符引擎一处。

## 网页设置页

**系统设置 → 运行配置**按同一份描述符渲染全部可编辑键 —— CLI 写入的值会即时出现在
网页上,网页保存的值也会被 CLI 读到:所有写入方共用一个收敛点。
