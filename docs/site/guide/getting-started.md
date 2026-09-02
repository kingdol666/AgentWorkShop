# 快速开始

## 前置条件

```bash
node -v   # ≥ 23.4.0(需要内置 node:sqlite)
```

> `omp` harness(真实 Agent 作业推荐)需要在 PATH 中安装 `omp` CLI;`mock` harness 开箱即用。
> 可选数采基础设施(MQTT broker + TimescaleDB)在 Docker 可达时自动拉起(`docker compose up -d`)。

## 方式 A —— 从 npm 安装(推荐)

```bash
npm install -g agentworkshop     # → `aw` / `agentworkshop` 进入 PATH
aw start                         # 首次运行构建一次(约 2-3 分钟)→ http://localhost:3001
```

首次启动时一切初始化进配置根 **`~/.AgentWorkShop`**:默认 `config.yml`、含随机会话密钥的
`.env`、`runtime-settings.json`、docker-compose 种子、空的 `data/` 目录。
全部运行数据(SQLite/JSON 仓库/备份/日志)都落在配置根 —— **配置与数据跟着安装走,与当前
工作目录和环境无关**。

不想安装、只想跑一次?

```bash
npx agentworkshop start          # 拉取即运行,全局零残留
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
- [SDK 指南](/sdk/) —— 用代码消费平台服务
- [插件开发](/plugins/) —— 对前后端做插入增强
