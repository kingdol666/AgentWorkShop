# aw —— AgentWorkShop 指令行工具

> 类似 Claude Code 的体验：`npm i -g agentworkshop` 后，在**任意目录**输入 `aw start` 一键启动；
> 全部配置、数据、自定义指令收敛在用户主目录 `~/.AgentWorkShop`（可用 `AW_HOME` 重定向），
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

装完即注册两个等价全局指令（npm 自动生成 `aw` / `aw.cmd` / `aw.ps1` 三种 shim）：

```bash
aw --help            # 或 agentworkshop --help(同义)
aw --version
```

### 2. 从本仓库安装（开发/内测）

```bash
# 在仓库根目录执行
npm install -g .            # npm 11 对本地目录 = Junction 链接(改代码即时生效,适合本机开发)
npm uninstall -g agentworkshop

# 或打包安装(与发布后用户体验完全一致)
npm pack
npm install -g ./agentworkshop-<version>.tgz --ignore-scripts
```

> `--ignore-scripts` 跳过 postinstall 引导与 `nuxt prepare`，使安装轻量快速；
> 首次 `aw start` / `aw home` 会自动补做 AW Home 引导，无需担心。

### 3. npx 快速使用（不落全局）

```bash
npx agentworkshop start        # 拉取并启动(可加 @version 锁定)
npx -p agentworkshop doctor    # -p 指定包后可用任意子指令
```

## 二、首次启动（Claude Code 式）

```bash
$ aw start
› 首次启动:正在构建生产产物(约 2-5 分钟,仅一次) ...   # 依赖已随包安装,之后秒启
› 生产服务(home 模式) -> http://0.0.0.0:3001
› 配置: C:\Users\you\.AgentWorkShop\config.yml · 数据: ...\data
```

浏览器打开即用；`Ctrl+C` 停止；再次 `aw start` 直接运行已有产物。

**AW Home**（配置根 `.AgentWorkShop`）由安装脚本/首次运行自动创建：

```
# home 模式(全局安装):配置根 = ~/.AgentWorkShop
~/.AgentWorkShop/
├── config.yml               # 主配置(工厂默认种子;改这里改全局行为)
├── runtime-settings.json    # 运行时覆盖(aw config set 写入)
├── .env                     # 密钥(安装时自动生成随机 NUXT_SESSION_PASSWORD)
├── docker-compose.yml       # 数采基础设施(MQTT/Timescale)自拉起定义
├── data/                    # sqlite/JSON 仓库/备份(全部运行数据落这里)
├── logs/
└── commands/                # 用户级自定义指令(放入即注册)
```

> **repo 模式（源码检出）**：配置根 = `<repo>/.AgentWorkShop`（runtime-settings.json/
> data/commands 同上），工厂默认 config.yml/.env 留在检出根随 git 版本化；
> prompts 事实源在 `<repo>/.AgentWorkShop/prompts`（两种模式同构）。
> 旧位置（`data/`、`server/data/`）的运行时文件会在首次启动时自动迁入配置根
> （只复制不删除,sqlite/JSON 仓库/运行时覆盖）。

## 三、双模式路径模型（与环境和路径无关）

| | repo 模式 | home 模式（默认安装形态） |
|---|---|---|
| 触发条件 | cwd 在项目检出内（有 config.yml + nuxt.config.ts） | 任意其他目录 |
| 应用代码 | 检出内源码 | npm 包内载荷（首次 `aw start` 自动构建） |
| 配置根 | `<repo>/.AgentWorkShop` | `~/.AgentWorkShop` |
| 工厂默认 config.yml/.env | `<repo>/config.yml`（git 版本化） | `~/.AgentWorkShop/config.yml` |
| 运行时覆盖 | `<repo>/.AgentWorkShop/runtime-settings.json` | `~/.AgentWorkShop/runtime-settings.json` |
| 运行数据 | `<repo>/.AgentWorkShop/data/` | `~/.AgentWorkShop/data/` |
| prompts | `<repo>/.AgentWorkShop/prompts`（唯一事实源，随包分发） | 同左（`AW_PROMPTS_DIR` 指向包内） |

- `AW_HOME=D:\aw-home` 可把中枢重定向到任意位置；`AW_MODE=home` 强制 home 模式（启动器内部使用）。
- 配置四层优先级（两层共用同一引擎 `shared/config/engine.mjs`）：
  `config.yml 默认 < runtime-settings.json 覆盖 < 环境变量(AW_*/PORT/HOST) < CLI 显式参数`

## 四、指令总览

| 指令 | 别名 | 说明 |
|---|---|---|
| `aw start` | s, prod, preview | **一键启动**生产服务（检出内外皆可;缺产物自动构建） |
| `aw dev` | d | 启动开发服务器（检出内;断连守卫 + .env 预载） |
| `aw build` | b, compile | 生产构建 → .output/ |
| `aw config` | cfg, c | `list/get/set/unset/reset/validate` 运行配置 |
| `aw home` | hw | 查看/初始化 AW Home |
| `aw doctor` | dsk, check-env | 环境/配置/服务健康检查 |
| `aw status` | st, info | 运行态总览（模式/配置源/服务/指令表） |
| `aw register` | reg | 注册自定义指令（本地文件/URL/npm 包） |
| `aw init` | create, new | 脚手架一个新项目检出 |
| `aw version` | v | 版本信息 |

全局参数：`--help/-h`、`--version/-v`、`--json`（机器可读）、`--root <dir>`、`--debug`。

### 常用示例

```bash
aw config set server.prod.port 8080     # 改生产端口(重启生效)
aw config set theme.primaryColor '#41c8f4'
aw config get server.dev.port           # 值 + 来源
aw config list                          # 18 个设置项 + 来源 + 生效方式
aw config validate                      # 校验 config.yml 与覆盖合法性
aw start --port 3002                    # CLI 参数最高优先
aw doctor                               # 体检:Node/pnpm/AW Home/端口/密钥/产物
aw status --json                        # 机器可读运行态
```

## 五、指令注册系统（可扩展机制）

### 注册模型（约定优于配置）

三层扫描、同名后者覆盖（**项目级 > 用户级 > 内建**），放入即注册、无集中清单：

```
1. 内建    <npm 包>/cli/commands/*.mjs
2. 用户级  ~/.AgentWorkShop/commands/*.mjs        (aw register --global)
3. 项目级  <检出>/.AgentWorkShop/commands/*.mjs   (aw register)
```

### 一条指令 = 一个文件

```js
// ~/.AgentWorkShop/commands/hello.mjs
export const meta = {
  name: 'hello',
  group: '自定义',
  summary: '问好',
  usage: 'aw hello [--name <n>]',
  // needsProject: true  → 强制要求项目检出上下文
}
export async function run(argv, ctx) {
  // argv = { flags, positionals, unknown }
  // ctx  = { root, mode: 'repo'|'home', home, config, resolveNuxtBin(), bypassEnv(), json, ... }
  console.log(`你好, ${argv.flags.name ?? 'AW'}! (模式: ${ctx.mode})`)
  return 0   // 退出码
}
```

```bash
aw hello --name 世界      # 立即可用
aw hello --help          # 帮助由 meta 自动生成
```

### 从外部注册

```bash
aw register ./my-tool.mjs              # → 项目级
aw register ./my-tool.mjs --global     # → 用户级(所有项目可用)
aw register ./tools-dir/               # 目录内全部 .mjs
aw register https://example.com/x.mjs  # URL 下载注册
aw register npm:some-cmd-pkg           # npm 包包装注册
aw register ./x.mjs --name better-name --force
```

## 六、发布到 npm（维护者指南）

仓库已配置就绪：`bin`(aw/agentworkshop 双注册)、`files` 白名单（bin/cli/app/server/shared/
i18n/public/scripts/.AgentWorkShop/prompts/各配置文件，3.2MB tarball）、
`prepublishOnly`（发布前强制构建验证）、构建期依赖已全部归入 `dependencies`
（用户机 `npm i` 后即可首启构建）、`postinstall` 引导 AW Home。

```bash
# 1. 发布前自检
npm pack --dry-run          # 检查载荷与体积
npm run build               # 本地构建确认

# 2. 版本与可见性
npm version patch|minor|major
npm pkg delete private      # 本仓库默认 private:true,发布前移除
# (可选)改名/加 scope: npm pkg set name=@yourorg/agentworkshop

# 3. 发布(需 npm 账号,首次加 --access public)
npm login
npm publish --access public

# 4. 用户侧即
npm i -g agentworkshop && aw start
npx agentworkshop start
```

发布模型说明：tarball 只含源码载荷（**不含** .output/node_modules——nitro 产物含
构建机原生二进制，跨平台不可移植），用户机安装后首次 `aw start` 用其本机依赖构建一次，
这是跨平台兼容的正确姿势。

## 七、设计要点（工程说明）

- **薄壳启动器**：全局包只带指令系统与应用载荷；配置引擎
  （`shared/config/engine.mjs`）从运行根动态加载，CLI 与网页设置页、dev/prod
  启动脚本三层共享同一事实源。
- **启动链路复用**：`aw dev` 走 `scripts/dev-guard.mjs`（ECONNRESET 守卫 +
  .env 预载）、`aw start` 走 `scripts/start.mjs`，与 `pnpm dev/start` 完全同链。
- **代理免疫**：aw 启动的全部子进程自动注入 `NO_PROXY=localhost,127.0.0.1,::1`
  （本机系统代理不再劫持回环请求）。
- **安全默认**：AW Home `.env` 安装时生成 24 字节随机 `NUXT_SESSION_PASSWORD`；
  prompts（agent 系统提示词）随包分发、`AW_PROMPTS_DIR` 可覆盖。
- **窗口/Ctrl+C**：子进程 stdio inherit，SIGINT/SIGTERM 转发，Windows Git Bash / CMD / PS 均可。
