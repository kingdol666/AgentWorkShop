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

## 网页设置页

**系统设置 → 运行配置**按同一份描述符渲染全部可编辑键 —— CLI 写入的值会即时出现在
网页上,网页保存的值也会被 CLI 读到:所有写入方共用一个收敛点。
