# 快速开始

## 前置条件

```bash
node -v   # ≥ 23.4.0(需要内置 node:sqlite)
```

> 真实 Agent 作业需要一个执行引擎。内置 **14 个引擎**,按接入形态分三类:
> 进程内(`mock` / `claude`)、常驻会话(`omp` / `codex` / `dsh` / `qwen` / `hermes` / `opencode`)、
> 无头 CLI(`gemini` / `copilot` / `cursor` / `crush` / `goose` / `pi`)。
> `mock` 开箱即用;其余需在 PATH 中安装对应 CLI(或 `claude` 的 SDK 依赖),
> 选择与凭据见[多 Harness Agent 团队](/guide/multi-harness)。
> 可选数采基础设施(MQTT broker + TimescaleDB)在 Docker 可达时自动拉起(`docker compose up -d`)。

## 方式 A —— 从 npm 安装(推荐)

```bash
npm install -g agentworkshop     # → `aw` / `agentworkshop` 进入 PATH
aw start                         # 发布包自带预构建 .output/,直接启动 → http://localhost:3001
```

发布到 npm 的 tarball 已包含生产构建产物(`prepublishOnly` 打包前构建一次),
因此 `aw start` **不会重新构建**,也无需 `pnpm install`;只有**源码检出**在缺
`.output/` 时会首启构建一次(约 2-3 分钟)。

首次启动时一切初始化进配置根 **`~/.AgentWorkShop`**:默认 `config.yml`、含随机会话密钥的
`.env`、`runtime-settings.json`、docker-compose 种子、空的 `data/` 目录。
全部运行数据(SQLite/JSON 仓库/备份/日志)都落在配置根 —— **配置与数据跟着安装走,与当前
工作目录和环境无关**。

不想安装、只想跑一次?

```bash
npx agentworkshop start          # 拉取即运行(仍会引导 ~/.AgentWorkShop 配置根,并非零残留)
```

## 方式 B —— 源码运行

```bash
git clone https://github.com/kingdol666/AgentWorkShop.git && cd AgentWorkShop
pnpm install
pnpm dev          # → http://localhost:3000(端口取自 config.yml)
```

生产部署(源码):

```bash
pnpm build        # nuxt build → .output/
pnpm start        # 端口取自 config.yml → server.prod.port
```

> 在源码检出内,配置根是项目里的 **`.AgentWorkShop/`** 文件夹(运行时覆盖/数据/项目级插件),
> 而 `config.yml` / `.env` 留在检出根,作为版本化的工厂默认值。

## 更新

```bash
aw update                              # 检查 + 就地更新全局安装
aw update --check                      # 只报告,不安装
npm install -g agentworkshop@latest    # 手动等效
```

版本遵循 semver;每次 `aw start` 会校验配置根并在新版变更布局时就地迁移 —— **升级不丢数据**。
(注意:国内 npmmirror 镜像同步官方源有分钟级延迟,取最新版可加
`--registry https://registry.npmjs.org`。)

## 下一步

- [配置系统](/guide/configuration) —— 四层优先级与配置根
- [第一次 Agent × 产线会话](/guide/first-session) —— 2 分钟跑通全链
- [五协议数采与数控](/guide/daq-protocols) —— Modbus/OPC UA/MQTT/HTTP 驱动
- [Recipe 版本管理](/guide/recipe-versions) —— 归因历史与回退
- [SDK 指南](/sdk/) —— 用代码消费平台服务
- [插件开发](/plugins/) —— 对前后端做插入增强
