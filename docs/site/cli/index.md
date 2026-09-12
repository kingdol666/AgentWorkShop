# aw —— AgentWorkShop 指令行工具

> 类似 Claude Code 的体验：`npm i -g agentworkshop` 后，在**任意目录**输入 `aw start` 一键启动；
> 全部配置、数据、自定义指令收敛在配置根 `~/.AgentWorkShop`（可用 `AW_HOME` 重定向），
> 与当前工作目录和环境路径无关。

```
__     __        __  __
\ \   / /__  _ _|  \/  |___ _ _ ___
 \ \ / / _ \| '_| |\/| / _ \ ' _(_-<
  \_/\_\___/|_| |_|  |_\___/_| |/__/
```

## 一、安装

### 1. 从 npm registry 安装（发布后的标准路径）

```bash
npm install -g agentworkshop
# 或免安装一次性执行(npx 会自动拉包)
npx agentworkshop start
```

`package.json` 的 `bin` 只有两个条目、都指向 `bin/aw.mjs`：`aw` 与 `agentworkshop`
（npm 安装时自动生成 `aw` / `aw.cmd` / `aw.ps1` 三种 shim）。二者完全等价，
所有子命令都必须经由它们调用：

```bash
aw --help                 # 或 agentworkshop --help(同义)
aw --version              # agentworkshop --version
npx agentworkshop doctor  # 没有独立的 doctor / tui 可执行文件
npx -p agentworkshop aw doctor   # -p 指定包后执行包内 bin,等效写法
```

### 2. 从本仓库安装（开发/内测）

```bash
# 在仓库根目录执行
npm install -g .            # npm 11 对本地目录 = Junction 链接(改代码即时生效,适合本机开发)
npm uninstall -g agentworkshop

# 或打包安装(与发布后用户体验一致;tarball 已含生产构建 .output)
npm pack
npm install -g ./agentworkshop-<version>.tgz
```

> `--ignore-scripts` 跳过 `postinstall`（`node scripts/home-bootstrap.mjs`，AW Home 引导）
> 与 `prepare`（husky 初始化），使安装轻量快速；`prepare` 只跑 husky，包内不存在 Nuxt 侧的
> prepare 脚本，安装期也不涉及任何构建——发布的 tarball 已自带 `.output` 生产构建。
> 首次 `aw start` / `aw home` 会自动补做 AW Home 引导，无需担心。

仓库内开发走 pnpm（`packageManager: pnpm@11.9.0`）：

```bash
pnpm install
pnpm cli --help      # 仓库内的 CLI 入口(没有名为 aw 的 package script)
pnpm tui             # 终端工作台
```

### 3. npx 快速使用（免全局安装）

```bash
npx agentworkshop start            # 拉取并启动(可锁定版本: npx agentworkshop@0.7.38 start)
npx agentworkshop doctor           # 子命令照常可用
npx -p agentworkshop aw doctor     # 需要 aw 这个名字时用 -p 指定包
```

> 「免全局安装」不等于「不落盘」：`postinstall` 或首次 `aw start` 仍会在
> `~/.AgentWorkShop` 创建配置根并写入种子文件（见第二节）。要彻底隔离可设 `AW_HOME`。

### 4. 运行时要求

| 项 | 值 |
|---|---|
| Node.js | `>= 23.4.0`（`engines.node`） |
| 包管理器 | `pnpm@11.9.0`（`packageManager`，仅源码开发需要） |
| 模块形态 | ESM（`type: module`） |
| 许可证 | `PolyForm-Noncommercial-1.0.0` |
| 当前版本 | `0.7.38`（`package.json`） |

## 二、首次启动（Claude Code 式）

```bash
# A. npm 安装(tarball 已含 .output 生产构建):直接启动,不重新构建
$ aw start
› 生产服务(home 模式) -> http://0.0.0.0:3001  (端口来源: config.yml)
› 配置: C:\Users\you\.AgentWorkShop\config.yml · 数据: C:\Users\you\.AgentWorkShop\data
› 停止: Ctrl+C

# B. 源码检出首启(尚无 .output):先构建一次
$ aw start
› 首次启动:正在构建生产产物(约 2-5 分钟,仅一次) ...
› 生产服务(repo 模式) -> http://0.0.0.0:3001  (端口来源: config.yml)
› 配置: D:\codes\ABO\AgentWorkShop\config.yml · 数据: D:\codes\ABO\AgentWorkShop\.AgentWorkShop\data
› 停止: Ctrl+C
```

- 浏览器打开输出的地址即用；`Ctrl+C` 停止；再次 `aw start` 直接复用已有产物。
- 端口取自有效配置（默认 `server.prod.port` = 3001），`--port` 优先级最高；
  输出里的 `(端口来源: config.yml|runtime|env|CLI)` 指出这次用的是哪一层。
- `aw stop` 依单实例锁 `<配置根>/.runtime/aw.lock` 终止运行中的实例。

**AW Home**（用户级配置根，默认 `~/.AgentWorkShop`）由 `postinstall`
（`scripts/home-bootstrap.mjs`）或首次 `aw start` / `aw home` 幂等创建，绝不覆盖已有文件：

```
~/.AgentWorkShop/
├── config.yml               # 主配置(工厂默认种子;改这里改全局行为)
├── runtime-settings.json    # 运行时覆盖(aw config set 写入)
├── .env                     # 密钥(引导时生成 24 字节随机 NUXT_SESSION_PASSWORD)
├── .env.example             # 密钥键位示例(随包分发)
├── docker-compose.yml       # 数采基础设施(MQTT/Timescale)自拉起定义
├── plugins-state.json       # 插件启停状态(sdk/examples 种子默认记为停用)
├── data/                    # sqlite/JSON 仓库/备份(全部运行数据落这里)
├── logs/
├── commands/                # 用户级自定义指令(放入即注册)
├── plugins/                 # 用户级插件目录(种子来自 sdk/examples/*,只补缺失)
└── prompts/                 # Agent 提示词(首启从包内资产播种,只补缺失不覆盖)
```

> **repo 模式（源码检出）**：配置根 = `<repo>/.AgentWorkShop`（runtime-settings.json/
> data/commands/plugins 同上），工厂默认 config.yml/.env 留在检出根随 git 版本化；
> prompts 按 `<project>/.AgentWorkShop/prompts` → `~/.AgentWorkShop/prompts` 顺序解析
> （两种模式同构，首启自动从包内资产播种；`AW_PROMPTS_DIR` 可显式覆盖）。
> 旧位置（`data/`、`server/data/`）的运行时文件会在首次启动时自动迁入配置根——
> 只复制不删除，sqlite/JSON 仓库与运行时覆盖按「最新者胜」（比较 mtime）收敛。

## 三、双模式路径模型（与环境和路径无关）

| | repo 模式 | home 模式（默认安装形态） |
|---|---|---|
| 触发条件 | cwd 在项目检出内（有 config.yml + nuxt.config.ts） | 任意其他目录 |
| 应用代码 | 检出内源码（缺 `.output` 时首启构建一次） | npm 包内载荷（tarball 已含 `.output` 生产构建，直接可跑） |
| 配置根 | `<repo>/.AgentWorkShop` | `~/.AgentWorkShop` |
| 工厂默认 config.yml/.env | `<repo>/config.yml`（git 版本化） | `~/.AgentWorkShop/config.yml` |
| 运行时覆盖 | `<repo>/.AgentWorkShop/runtime-settings.json` | `~/.AgentWorkShop/runtime-settings.json` |
| 运行数据 | `<repo>/.AgentWorkShop/data/` | `~/.AgentWorkShop/data/` |
| prompts | `<project>/.AgentWorkShop/prompts` → 回退 `~/.AgentWorkShop/prompts` | 同左（首启从包内资产播种） |

### 配置根解析（三条规则）

`shared/config/home.mjs` 的 `resolveRunMode()` 按顺序判定，**先命中先返回**：

| # | 条件 | 生效配置根 | 生效 config.yml |
|---|---|---|---|
| 1 | cwd 向上能找到真实存在的 `./.AgentWorkShop` 目录 | 该目录（repo 模式；纯工作区亦可） | 检出根 `config.yml`；非检出则配置根内 `config.yml`，缺失回退包内 |
| 2 | cwd 向上是源码检出（config.yml + nuxt.config.ts）但**没有** `./.AgentWorkShop` | `~/.AgentWorkShop`（repo 模式） | `<检出根>/config.yml`（工厂默认仍读检出） |
| 3 | 其余任意目录 | `~/.AgentWorkShop`（home 模式） | 配置根 `config.yml`，缺失回退包内 |

- `AW_HOME=D:\aw-home` 覆盖用户级根（三条规则里的 `~/.AgentWorkShop` 全部改指此处）。
- `AW_MODE=home` 强制 home 形态（跳过规则 1、2；启动器对全局安装的应用载荷注入，
  防止包目录自身含 config.yml + nuxt.config.ts 被误判为检出）。
- `AW_DATA_DIR` 可单独指定运行数据目录（默认取配置根 `data/`）。

### 设置与环境变量模型

- 优先级（CLI 与网页设置页、dev/prod 启动脚本共用同一引擎 `shared/config/engine.mjs`）：
  `config.yml 默认 < runtime-settings.json 运行时覆盖 < 环境变量 / CLI 显式参数`。
- 设置描述符共 **98 项、16 组**（`aw config list` 即打印 98 行）：

| 组 | 项数 | 组 | 项数 | 组 | 项数 | 组 | 项数 |
|---|---|---|---|---|---|---|---|
| `server` | 3 | `app` | 2 | `api` | 4 | `theme` | 2 |
| `i18n` | 1 | `security` | 2 | `daq` | 27 | `memory` | 10 |
| `omp` | 4 | `harness` | 12 | `dcw` | 4 | `workshop` | 2 |
| `backup` | 3 | `retention` | 5 | `log` | 1 | `aml` | 16 |

  其中 `live`（保存即生效）32 项、`restart`（重启对应模式后生效）66 项，
  `aw config list` 每行末尾会标注 `live` 或 `restart`。
- 环境变量映射：`AW_<KEY 大写、点转下划线>`（如 `AW_SERVER_DEV_PORT`），
  另加描述符显式声明的历史 `aliases`（优先级：`AW_<KEY>` 高于 `aliases` 声明顺序）。
- 惯例变量 `PORT`/`NITRO_PORT`/`NUXT_PORT` 与 `HOST`/`NITRO_HOST` **仅在传入 mode 时**生效
  （只有启动器链路才知道该映射到 dev 还是 prod 端口）。
- `aw config set` 写入**配置根**的 `runtime-settings.json`（源码检出内配置根可能与
  `~/.AgentWorkShop` 不同，成功行会打印实际 `settingsPath`）。

## 四、指令总览

内建指令共 **14** 条（`cli/commands/*.mjs`，一文件一指令）：

| 指令 | 别名 | 参数 | 说明 |
|---|---|---|---|
| `aw start` | `s`, `prod`, `preview` | `--port <n>` `--host <h>` `--skip-infra` | 生产服务（检出内外皆可；缺产物自动构建一次） |
| `aw dev` | `d` | `--port <n>` `--host <h>` | 开发服务器（需项目检出；断连守卫 + .env 预载） |
| `aw build` | `b`, `compile` | — | 生产构建 → `.output/`（需项目检出） |
| `aw stop` | — | `--home` | 依单实例锁终止运行中的实例（`--home` 强制以 home 配置根为目标） |
| `aw config` | `cfg`, `c` | 子命令 `list`(`ls`) / `get` / `set` / `unset` / `reset`(`--yes`/`-y`/`--force`) / `validate`(`check`) | 读取 / 写入 / 校验运行配置 |
| `aw plugin` | `plugins`, `plug` | 子命令 `list`(`ls`) / `create`(`new`/`add`) / `enable` / `disable`；`create` 另接 `--global`/`-g`、`--project`、`--force`/`-f` | 插件管理（三作用域查看 / 脚手架 / 启停，热重载） |
| `aw home` | `hw` | — | 查看 / 初始化配置根（幂等） |
| `aw init` | `create`, `new` | `--force` `--no-install` `--silent` | 脚手架一个新项目检出 |
| `aw register` | `reg`, `install-cmd` | `--name <n>` `--global`/`-g` `--force`/`-f` | 注册指令模块（本地文件 / 目录 / URL / npm 包） |
| `aw doctor` | `dsk`, `check-env` | — | 环境 / 配置 / 服务健康检查（`--json` 输出 `{ ok, checks }`） |
| `aw status` | `st`, `info` | — | 运行态总览（模式 / 配置源 / 服务 / 构建 / 指令数 / 关键有效配置） |
| `aw update` | `upgrade` | `--check` `--registry <url>` `--yes` | 对比 npm 远端最新版本，有新版就地更新全局安装 |
| `aw tui` | `tui` | `--url <baseUrl>` `--token <ut-*>` `--channel <名>` | 终端工作台 |
| `aw version` | `v` | — | 版本信息 |

> `aw status` 报告模式、配置路径、构建产物是否存在、运行时覆盖键、指令条数与关键有效配置；
> **不含 uptime**，版本号只在 `aw status --json` 的 `package.version` 字段里出现。

### 全局参数

全局项只有 `cli/core/args.mjs` 的 `GLOBAL_OPTS` 这 5 条：

| 参数 | 说明 |
|---|---|
| `--json` | 机器可读输出（成功 / 失败信封见下） |
| `--debug` | 调试日志（未预期异常额外打印堆栈） |
| `--help`, `-h` | 总帮助，或指定指令帮助（`aw help <cmd>` 同义） |
| `--version`, `-v` | 打印 `agentworkshop <version>` |
| `--root <dir>` | 显式指定项目根（该目录须含 `config.yml`） |

`--port` / `--host` 是 `start` / `dev` 的**指令级**参数，不是全局参数；
`AW_HOME` / `AW_MODE=home` / `AW_DATA_DIR` 是**环境变量**，不是命令行参数。

### 退出码与 `--json` 契约

| 退出码 | 含义 |
|---|---|
| `0` | 成功 |
| `1` | 运行错误（`CliError` 且 `code !== 'USAGE'`、`needsProject` 未满足、未预期异常） |
| `2` | 用法错误（未知指令、未给出指令、`CliError` 且 `code === 'USAGE'`） |

`--json` 下失败统一输出 `{ ok: false, error: <code> }` 信封（不打印堆栈）：

| `error` | 触发条件 | 退出码 |
|---|---|---|
| `unknown-command` | 指令名不在注册表内（含 `aw --help <未知指令>`），另带 `name` | 2 |
| `usage` | 未给出任何指令，另带 `hint: 'no command'` | 2 |
| `cli-error` / 具体 `CliError.code` | 指令内部用法或运行错误，另带 `message` | 2（USAGE）/ 1（其他） |
| `no-project` | 标记 `needsProject` 的指令在非检出目录执行 | 1 |
| `internal` | 未预期异常，另带 `message` | 1 |

成功侧由各指令自带 `{ ok: true, ... }` 载荷（`config list/get/set/unset/reset/validate`、
`status`、`home`、`version`、`doctor`）。注意服务端 REST 响应（如
`GET /api/workshop/plugins`）不套 `{ code, data }` 信封，与 CLI 的 `--json` 无关。

### 常用示例

```bash
aw config set server.prod.port 8080     # 改生产端口(重启生效)
aw config set theme.primaryColor '#41c8f4'
aw config get server.dev.port           # 值 + 来源
aw config list                          # 99 个设置项(16 组) + 来源 + 生效方式
aw config validate                      # 校验 config.yml 与运行时覆盖合法性
aw start --port 3002                    # CLI 参数最高优先(输出标注 端口来源: CLI)
aw doctor                               # 体检:Node/pnpm/AW Home/Docker/MQTT/端口/密钥/产物
aw status --json                        # 机器可读运行态(含 package.version)
aw plugin list                          # 三作用域插件清单(含启停态)
aw plugin create my-plugin              # 默认脚手架到 <检出>/.AgentWorkShop/plugins/(无检出自取 cwd)
aw plugin create my-plugin --global     # 或脚手架到 ~/.AgentWorkShop/plugins/(用户级)
aw plugin disable my-plugin             # 停用(写 plugins-state.json,运行中服务约 1s 热重载)
aw stop                                 # 依单实例锁停掉正在跑的 aw 服务
```

### 插件管理（`aw plugin` 的三作用域）

宿主按**先扫先占**发现插件，同名优先级 **`builtin` > `project` > `user`**：

```
1. builtin  <packageRoot>/server/plugins-builtin/<name>/index.mjs   (随包发布,永远存在)
2. project  <检出>/.AgentWorkShop/plugins/<name>/index.mjs          (aw plugin create 默认落点)
3. user     ~/.AgentWorkShop/plugins/<name>/index.mjs               (aw plugin create --global)
```

> 方向提醒：指令注册表是「后扫覆盖 → 项目级 > 用户级 > 内建」，
> 插件发现是「先扫先占 → 内建 > 项目级 > 用户级」，两者相反，不要互相类推。

- `aw plugin create <name>`：默认落 project 级；`--global`/`-g` 落 user 级；
  `--project` 是显式写法、与默认等价；`--force`/`-f` 覆盖已存在插件。
  名字须匹配 `^[a-z][a-z0-9-]{1,31}$`（小写字母开头、2–32 位 a-z0-9-）。
  脚手架生成 `index.mjs`、`client.mjs`、`README.md`。
- `aw plugin list`：列出三个作用域的启停态（`已启用` / `已停用`，带 `+client` 表示有浏览器增强）。
- `aw plugin enable|disable <name>`：按同一顺序（builtin → project → user）查找首个同名插件并切换。
- 启停写入 `<home>/plugins-state.json`，其中 `home = $AW_HOME || ~/.AgentWorkShop`——
  **不是配置根**（源码检出内两者不同，配置根是 `<repo>/.AgentWorkShop`）。
- 运行中的服务监听该文件（`fs.watch` + 400ms debounce + 10s 轮询兜底），约 1s 内热重载。
  触发源只有这个状态文件（或一次 enable/disable 往返）——**改插件代码本身不会触发重载**：
  宿主没有插件目录 watcher，但热重载时入口以 `?t=<timestamp>` 破缓存重新 import，
  所以改完代码后**触碰 `plugins-state.json`（或 enable/disable 一次）**即可让宿主装载新模块，
  不需要重启进程；只有 `server/`、`shared/` 核心改动需要重启。
- `aw plugin list` 不显示装载失败；失败清单只在 `GET /api/workshop/plugins` 返回的
  `{ plugins, failures }`（另带 `initedAt`）里，该响应不带 `{ code, data }` 信封。
- 插件契约与生命周期钩子（`daq:sample` / `daq:frame` / `dcw:write` / `line:start|stop` /
  `config:changed` / `plugins:reloaded` / `event:*` / `server:close`）见 `docs/plugins.md`。

### 相关模块

- **TUI 终端工作台**：`aw tui`（频道 / 成员管理、任务下发、实时监控、HITL 作答），
  手册见 `docs/tui.md` 与 `tui/README.md`。
- **AML 自动建模**：网页 `/aml` 页（`aml` 组 16 项设置）、
  `server/api/workshop/aml/**` 下 26 个路由模块、10 个 `aml_*` Agent 工具、
  内置团队 `team-aml-shadow`，手册见 `docs/aml.md`。

## 五、指令注册系统（可扩展机制）

### 注册模型（约定优于配置）

三层扫描、同名后者覆盖（**项目级 > 用户级 > 内建**），放入即注册、无集中清单：

```
1. 内建    <packageRoot>/cli/commands/*.mjs        (随包发布,永远存在)
2. 用户级  ~/.AgentWorkShop/commands/*.mjs         (aw register --global)
3. 项目级  <检出>/.AgentWorkShop/commands/*.mjs    (aw register)
```

- 只扫描 `*.mjs` / `*.js` / `*.cjs` 文件，忽略以 `_` 开头的文件；
  单个模块加载失败只记入 `registry.failures`（`aw doctor` 会列出），不阻断其他指令。
- 目录名是 **`.AgentWorkShop`**（大写 A / W / S）。Linux、macOS 的文件系统区分大小写，
  目录名大小写写错的指令目录永远扫不到。

### 一条指令 = 一个文件

```js
// ~/.AgentWorkShop/commands/hello.mjs
export const meta = {
  name: 'hello',
  group: '自定义',
  summary: '问好',
  usage: 'aw hello [--name <n>]',
  aliases: ['hi'],        // 可选
  // needsProject: true   // 强制要求项目检出上下文
}
export async function run(argv, ctx) {
  // argv = { flags, positionals, unknown }
  // ctx  = { root, mode: 'repo'|'home', home, config, resolveNuxtBin(), bypassEnv(),
  //          json, debug, commandsDir, configRoot, configPath, settingsPath, dataDir,
  //          registry, EXIT }
  console.log(`你好, ${argv.flags.name ?? 'AW'}! (模式: ${ctx.mode})`)
  return 0   // 返回数字 → 即进程退出码
}
```

```bash
aw hello --name 世界      # 放入文件即注册,立即可用
aw hello --help          # 帮助由 meta 自动生成
```

### 从外部注册

```bash
aw register ./my-tool.mjs              # → 项目级(复制 <name>.mjs 进扫描目录)
aw register ./my-tool.mjs --global     # → 用户级(所有项目可用)
aw register ./tools-dir/               # 目录内全部 .mjs/.js/.cjs
aw register https://example.com/x.mjs  # URL 下载注册
aw register npm:some-cmd-pkg           # 生成包装模块(dynamic import 包内 { meta, run })
aw register ./x.mjs --name better-name --force
```

`aw register` 只把模块写进扫描目录，没有登记清单；项目级注册需要项目上下文
（非检出且未加 `--global` 时报 `NO_PROJECT`，退出码 1）。

## 六、发布到 npm（维护者指南）

仓库已配置就绪：`bin`（`aw` / `agentworkshop` 双注册，均指向 `bin/aw.mjs`）、
`files` 白名单（`.output`、`bin`、`cli`、`sdk`、`app`、`server`、`shared`、`i18n`、`public`、
`scripts`、`server/plugins-builtin`、`.AgentWorkShop/prompts`、`tui` 与各配置文件）、
`prepublishOnly`（打包前强制 `node bin/aw.mjs build`）、`postinstall`（AW Home 引导）。

```bash
# 1. 发布前自检
npm pack --dry-run          # 检查载荷与体积(应含 .output/)
node bin/aw.mjs build       # prepublishOnly 已自动执行;本地确认可手动跑

# 2. 版本与可见性
npm version patch|minor|major
# private 标志已移除;若恢复过可再删: npm pkg delete private
# (可选)改名/加 scope: npm pkg set name=@yourorg/agentworkshop

# 3. 发布(需 npm 账号;本机默认 registry 是 npmmirror 只读镜像,发布必须指定官方源)
npm login --registry=https://registry.npmjs.org
npm publish --access public --registry=https://registry.npmjs.org

# 4. 用户侧
npm i -g agentworkshop && aw start
npx agentworkshop start
aw update                   # 或让用户用内置指令自更新(--check 只查不装)
```

**发布模型**：`files` 白名单包含 `.output`（连同 `.output/server/node_modules` 里的运行期依赖），
`prepublishOnly` 会在打包前跑一次 `node bin/aw.mjs build`，因此**发布的 tarball 自带生产构建与依赖**：
npm 安装的用户 `aw start` 直接启动，不会重新构建，也不需要 `pnpm install`；
只有**源码检出**在缺 `.output` 时会首启构建一次。

**版本号事实源**：`npm version` 只改 `package.json`；`config.yml` 里的 `app.version`
只是**回退值**，不是权威——`nuxt.config.ts` 以 `package.json` 版本优先，所以构建期注入的
版本与 `/api/health` 回显都跟包版本走；该字段历史上的字面量长期与包版本不同步，
需要版本号时请读 `package.json`（或 `aw status --json` 的 `package.version`），不要依赖它。

**仓库脚本清单**（`package.json`）：`dev` / `build` / `start` 经 `node bin/aw.mjs <cmd>`，
`preview` 等同 `start`，`generate` 是 `nuxt generate`，另有 `cli`、`tui`、`postinstall`、
`prepublishOnly`、`lint`、`lint:fix`、`typecheck`、`prepare`（husky）、`game:*`、`test:api-live`。
**没有名为 `aw` 的 script**——仓库内的 CLI 入口是 `pnpm cli`，TUI 是 `pnpm tui`。

## 七、设计要点（工程说明）

- **薄壳启动器**：全局包只带指令系统与应用载荷；配置引擎
  （`shared/config/engine.mjs`）从运行根动态加载，CLI 与网页设置页、dev/prod
  启动脚本三层共享同一事实源。
- **启动链路复用**：`aw dev` 走 `scripts/dev-guard.mjs`（ECONNRESET 守卫 +
  .env 预载）、`aw start` 走 `scripts/start.mjs`，与 `pnpm dev` / `pnpm start` 完全同链。
- **代理免疫**：aw 启动的全部子进程自动注入 `NO_PROXY=localhost,127.0.0.1,::1`
  （本机系统代理不再劫持回环请求）。
- **安全默认**：AW Home `.env` 引导时生成 24 字节随机 `NUXT_SESSION_PASSWORD`；
  prompts（agent 系统提示词）随包分发，首次启动按
  `<project>/.AgentWorkShop/prompts` → `~/.AgentWorkShop/prompts` 播种（只补缺失、不覆盖用户定制），
  `AW_PROMPTS_DIR` 可显式覆盖，但不再被钉死在包内。
- **单实例**：运行实例在配置根写 `.runtime/aw.lock`（`{ pid, startedAt, mode, port }`），
  `aw stop` 据此终止进程树（Windows `taskkill /PID <pid> /T /F`，POSIX 先 SIGTERM 宽限 5s 再 SIGKILL）。
- **窗口/Ctrl+C**：子进程 stdio inherit，SIGINT/SIGTERM 转发，Windows Git Bash / CMD / PS 均可。
