# SDK 与 `aw` CLI 审计报告(plugin SDK + 命令行)

- **审计对象**:`D:\codes\ABO\AgentWorkShop`(Nuxt 4/Nitro,Node v24.19.0,pnpm 未安装)
- **审计方式**:逐行阅读 `sdk/*.mjs` `sdk/*.d.mts` `sdk/examples/**`、`cli/aw.mjs` `cli/infra.mjs` `cli/core/*.mjs` `cli/commands/*.mjs`、`bin/aw.mjs`、`package.json`、`pnpm-workspace.yaml`、`docs/sdk.md`、`docs/cli.md`、`server/services/workshop/plugins/host.mjs`,并**实际运行** CLI、`tsc` 探针、HTTP 探针与 stub 服务器实验。
- **只读约束**:未修改任何源文件。实验脚本全部落在 `scripts/_audit/`(可删除),临时脚手架生成在 `$TEMP\aw-init-audit`。审计过程中唯一写入仓库的是 `scripts/_audit/**`;实验产生的 `.AgentWorkShop/plugins/demo-plugin`、`.AgentWorkShop/commands/hello.mjs` 已删除还原。
- **环境限制(重要)**:
  - `npm pack --dry-run` **被沙箱拒绝**(`EPERM ... npm-cache\_cacache\tmp\***`,审批已禁用,未升级)→ 改用 `scripts/_audit/probe-packlist.mjs` 复刻 npm `files` 语义 + 传递相对 import 图核验(见 Q1)。
  - `scripts/test-cli-exit.mjs` **无法在本会话运行**(`spawn EPERM`:受限模式下 Node 无法以管道 stdio 捕获子进程输出)→ 该测试的通过/失败状态标 ⚠UNVERIFIED,但它的断言目标正是本报告 P1-3(退出码 13)。
  - 运行中的实例(`pid=66244`,3001 端口)对若干**已存在**路由返回 500(见文末「范围外观察」),故所有"路由是否存在"的结论均以**路由文件列表 + 404/500 对照 + 响应体形态**三方交叉验证,不单凭状态码。

---

## 0. 逐题作答

**Q1 类型声明漂移 —— 存在 4 类漂移;`sdk/client.d.mts` 存在且基本对齐;`files` 对 `exports` 覆盖完整。**
① `sdk/index.mjs` 的 14 个运行时命名导出中,`isPathInside`、`validatePluginSettings` **在 `sdk/index.d.mts` 中完全没有声明**(TS2614 实测);② `sdk/client.d.mts:103` 反向多出**幻影命名导出** `el`(运行时 `m.el === undefined`,但 TS 认为可 import);③ `createRouteTable()` 运行时返回 `unregisterPlugin`(`sdk/context.mjs:201`),`index.d.mts:113-118` 未声明;`PlatformClient` 运行时含 `permissions`(`sdk/api.mjs:98-103`)而 `index.d.mts:37-57` 未声明,且 `products/recipes/dcwNodes/daqNodes/twins/teams/agents` 的 `get/update/remove` 一律欠声明;④ `PluginContext` 缺 `ctx.daq`/`ctx.omp`/`ctx.services`(host 注入,`host.mjs:437/470/478`,`docs/plugins.md:107-110` 有文档)。`package.json` `files` ⊇ `exports` 全部目标 + `bin`,且从 5 个入口出发的 18 个传递相对 import 文件全部在白名单内 —— **此问无缺陷**。

**Q2 HTTP 客户端路径 —— `api.mjs` 的路径**多数正确但 **8 个已文档化方法指向不存在的路由**;信封错误码在 HTTP-200 分支正确传播,非 2xx 分支丢 `err.code`;`client.mjs` 与 `api.mjs` 存在**重复且语义分歧**的 HTTP 逻辑(浏览器侧吞业务错误)。**
细目见 P1-6 / P1-7 / P2-4。

**Q3 生命周期事件名 —— 清单与发射面不一致:1 个发射了但未入册(`plugins:reloaded`)、2 个入册但永不触发(`config:changed` 全仓无发射点;`permissions:changed` 实际以 `event:permissions:changed` 发射)、客户端 `i18n:changed` 未入册。**
细目见 P1-4 / P1-5 / P2-3。

**Q4 参数解析 —— `--port=3000` 与 `--port 3000` 均正确;布尔全局标志前后置均可;`--root <dir>`(空格形式)置于指令前**必崩**;存在死代码;`bin` 入口的退出码传播正确而 `cli/aw.mjs` 直接入口恒 13。**
细目见 P1-1 / P1-3 / P1-8 / P2-6 / P2-10。

**Q5 重复实现 —— 至少 8 组应抽取到 `cli/core/*`。**
细目见 P2-5(含精确行号:端口解析、nuxt 构建 spawn、`spawnSync`-shell 包装、插件状态文件、数采探测、根探测、killTree、插件目录发现)。

**Q6 文档承诺的指令 —— `docs/cli.md` 少了 `aw plugin`/`aw stop`/`aw tui`(三者都在注册表里,`docs/site/cli/index.md` 已收录);`aw --help` 与注册表一致(14 条),但帮助文案里的指令目录大小写错误。**
细目见 P2-8 / P2-9。

**Q7 实跑记录 —— 三个命令均未崩溃,`--help`/`version` 退出 0,`doctor` 退出 1(4 项"异常"中有 2 项是误报,见 P2-11)。**
原始输出见文末附录;另有 `cli/aw.mjs` 直接入口退出 13 的缺陷(P1-3)。

---

## 1. P0

### [P0] `aw init` 脚手架缺 `sdk/` 与 `tui/`:拷贝出的 server 代码无法解析 `@/sdk/index.mjs`,`aw tui` 直接 MODULE_NOT_FOUND
- **Where**: `cli/commands/init.mjs:22`(`COPY_DIRS`)、`server/services/workshop/plugins/host.mjs:20`、`cli/commands/tui.mjs:16`、被拷贝的 `server/plugins/aw-plugins.ts:6`
- **Evidence**:
```js
// cli/commands/init.mjs:22  —— 没有 'sdk',也没有 'tui'
const COPY_DIRS = ['app', 'server', 'shared', 'i18n', 'public', 'scripts', 'bin', 'cli']
```
```js
// 脚手架产物 server/services/workshop/plugins/host.mjs:20(原样拷贝)
import { HookBus, createPluginContext, createRouteTable, isPathInside, validatePluginModule, validatePluginSettings } from '@/sdk/index.mjs'
```
```js
// nuxt.config.ts:97-99(同样被拷贝) —— '@' 指向项目根
alias: { '@': fileURLToPath(new URL('.', import.meta.url)) },
```
  实测(`node bin/aw.mjs init %TEMP%\aw-init-audit --no-install --silent`,exit 0)后:
```
--- top-level of scaffolded project:
.AgentWorkShop app bin cli data i18n public scripts server shared ... (无 sdk / 无 tui)
--- sdk/ present? False
--- server/plugins/aw-plugins.ts:  import { initPluginHost, shutdownPluginHost } from '@/server/services/workshop/plugins/host.mjs'
--- deps.agentworkshop = undefined      # 派生 package.json 也没把本包列为依赖,无兜底解析
```
  在脚手架内实跑:
```
$ node <scaffold>\bin\aw.mjs tui
✖ tui 执行失败: Cannot find module 'C:\...\aw-init-audit\tui\aw-tui.mjs' imported from C:\...\aw-init-audit\cli\commands\tui.mjs
[exit 1]
```
- **Impact**:`aw init` 的 meta 自述"脚手架一个**可运行**的新项目"(`init.mjs:17`)、`docs/cli.md:113` 也如此承诺,但产物的 `server/plugins/aw-plugins.ts` → `host.mjs` 无法解析 `@/sdk/index.mjs` → Nitro 构建/启动期模块解析失败,插件宿主子系统(及任何 `@/sdk/*` 引用)直接不可用;`aw tui` 也必然失败。`@/sdk` 是仓库内唯一的 SDK 引用方式(`host.mjs:20`、`app/plugins/aw-plugins.client.ts:15`),不是可选面。
- **Fix**:`cli/commands/init.mjs:22` 的 `COPY_DIRS` 补 `'sdk'` 与 `'tui'`(二者体量 <100 KB);若有意不复制 `tui`,则同时从 `COPY_DIRS` 移除 `cli` 中的 tui 指令或在 `tui.mjs:16` 的 import 失败处给出明确降级提示。更稳妥的做法是在 `COPY_DIRS` 旁加一条断言:README/测试中列出「脚手架后必须 `node -e "import('./server/services/workshop/plugins/host.mjs')"` 可解析」。
- **Verification**:
  `node bin/aw.mjs init $env:TEMP\aw-init-audit2 --no-install --silent; Test-Path $env:TEMP\aw-init-audit2\sdk\index.mjs; node $env:TEMP\aw-init-audit2\bin\aw.mjs tui`
  修复前:`sdk/index.mjs` 为 `False`、`aw tui` 报 MODULE_NOT_FOUND;修复后两者分别为 `True` 与正常 TUI 启动(或在 tui 目录被有意排除时给出可读提示)。

---

## 2. P1

### [P1] `aw --root <dir> <cmd>`(空格形式放在指令前)把 root 的取值当成指令名 → 任何指令都变成「未知指令」并退出 2
- **Where**: `cli/aw.mjs:59-71`(`extractCommand`)、`cli/aw.mjs:84`、`cli/aw.mjs:161-163`
- **Evidence**:
```js
// cli/aw.mjs:59-71 —— 只按「是否以 - 开头」判断,不知道前面哪个 flag 需要取值
function extractCommand(argv) {
  let afterDash = false
  for (const tok of argv) {
    if (afterDash) return tok
    if (tok === '--') { afterDash = true; continue }
    if (tok.startsWith('-')) continue
    return tok          // ← '--root' 的值 scripts/_audit/proj 在这里被当成指令名
  }
  return null
}
```
  实测:
```
$ node bin/aw.mjs --root scripts/_audit/proj echoargs --port=3000
✖ 未知指令: scripts/_audit/proj（aw help 查看全部指令）   [exit 2]

$ node bin/aw.mjs --root=scripts/_audit/proj echoargs --port=3000
{"argv":{"flags":{"port":"3000"},...}}                    [exit 0]
```
  `--help` 自己把 `--root <dir>` 列为全局参数(`cli/core/help.mjs:37`),`docs/cli.md:116` 同样承诺,而唯一能用的写法是 `--root=<dir>` 或把 `--root` 放到指令之后(实测 `aw version --root scripts/_audit/proj` 正常,exit 0)。
- **Impact**:文档化的 `aw --root <dir> <cmd>` 完全不可用,且报错信息误导(把路径说成"未知指令"),使用者会以为是自己路径写错。CI/脚本里凡是 `aw --root "$DIR" config list` 这样的调用全部 exit 2。
- **Fix**:解析 argv 时先做一次"取值感知"的扫描,而不是裸 token 判断。最小改动:在 `cli/aw.mjs:84` 用 `parseArgs(argv, { shortMap: … }).positionals[0]`,并把 `parseArgs` 里 `positionals` 的收集逻辑作为唯一事实源(`cli/core/args.mjs:96` 已经在正确的位置 push):`const commandName = globals.positionals[0] ?? null`。同时删掉 `extractCommand`(它已被 `parseArgs` 取代),`idx` 改为 `argv.indexOf(commandName)` 之外更稳的"取 positionals 之后切片"的方式,或继续沿用 `indexOf` 但基于已确认的指令名。
- **Verification**:
  `node bin/aw.mjs --root scripts/_audit/proj echoargs --port=3000` → 修复前 exit 2/`未知指令: scripts/_audit/proj`;修复后 exit 0 且输出 `{"argv":{"flags":{"port":"3000"},...}}`(审计脚本 `scripts/_audit/proj/.AgentWorkShop/commands/echoargs.mjs` 可直接复用)。

### [P1] 项目根有两套判定标准:只有 `config.yml` 的目录被 `aw` 认作项目根,但 `ctx.root` 为 null → `aw dev` 崩溃
- **Where**: `cli/aw.mjs:46-56`(`findUp`,只找 `config.yml`)、`cli/aw.mjs:93-98`、`cli/aw.mjs:147`(needsProject 闸门) vs `cli/core/context.mjs:37-43`(`detectProjectRoot`)+ `shared/config/home.mjs:26-39`(`isRepoRoot` 要求 `config.yml` **且** `nuxt.config.ts`);崩溃点 `cli/commands/dev.mjs:40`
- **Evidence**:
```js
// cli/aw.mjs:46-56
function findUp(startDir, filename) { ... if (existsSync(candidate)) return candidate ... }   // 只看 config.yml
// cli/core/context.mjs:37-43
export function detectProjectRoot({ cwd, explicitRoot } = {}) {
  if (explicitRoot) { const abs = resolve(cwd, explicitRoot); return existsSync(join(abs, 'config.yml')) ? abs : null }
  return findRepoRoot(cwd)          // shared/config/home.mjs:26-27 → isRepoRoot 需要 config.yml + nuxt.config.ts
}
```
  实测(临时目录,只有 `config.yml`):
```
$ node bin/aw.mjs help
项目根:  C:\Users\...\aw-audit-cfgonly  ✓  (repo 模式:配置/数据在项目内)     ← aw.mjs 认为在项目里

$ node bin/aw.mjs dev
✖ dev 执行失败: The "path" argument must be of type string. Received null   [exit 1]
    # dev.mjs:40  const guard = join(root, 'scripts', 'dev-guard.mjs')  ← ctx.root === null
```
  同因:`aw build` 在该目录不会给出"需要项目上下文",而是真的去 `nuxt build`(`cwd: null`),报 `ERROR Cannot resolve module "@nuxt/kit" (from: C:\...\aw-audit-cfgonly\)` 后 exit 1。
- **Impact**:两处根判定不一致 → `needsProject` 闸门形同虚设,`aw dev` 以 null 路径崩溃(报错完全不可读,用户无法自救),`aw build` 在非项目目录里跑一整轮无效构建。仓库内的兄弟目录若只有 `config.yml`(例如把工厂配置放在工作区子目录)即触发。
- **Fix**:让 `cli/aw.mjs` 复用同一个判定:删除 `findUp`(`cli/aw.mjs:46-56`),改为 `const root = detectProjectRoot({ cwd, explicitRoot })`(从 `cli/core/context.mjs` 导入);`--root` 的校验也统一走 `detectProjectRoot`(它已支持 explicitRoot)。随后 `needsProject` 闸门与实际 `ctx.root` 自然一致,`dev.mjs`/`build.mjs` 只需保留现有 `root` 判空(建议在 `dev.mjs:28` 加 `if (!root) throw new CliError('USAGE', '指令 dev 需要项目上下文')` 作为二次防线)。
- **Verification**:
  `mkdir $env:TEMP\aw-cfgonly; Set-Content $env:TEMP\aw-cfgonly\config.yml ''; cd $env:TEMP\aw-cfgonly; node D:\codes\ABO\AgentWorkShop\bin\aw.mjs help; node D:\codes\ABO\AgentWorkShop\bin\aw.mjs dev`
  修复前:`help` 显示"项目根 ✓"、`dev` 报 `Received null`;修复后:`help` 显示 home 模式、`dev` 输出 `✖ 指令 dev 需要项目上下文（未找到 config.yml）…` 且退出码为 1(而非崩溃栈)。

### [P1] `node cli/aw.mjs <cmd>` 恒以退出码 13 收场,且注释断言的因果正好相反
- **Where**: `cli/aw.mjs:191-202`(注释 193-198,代码 199-202)
- **Evidence**:
```js
// cli/aw.mjs:193-202
// 必须用 process.exit(code) 而非 process.exitCode = await main():
// … Node 在 TLA 下因此以 **退出码 13**(ERR_UNSETTLED_TOP_LEVEL_AWAIT)收场 …
const thisEntry = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
if (thisEntry) {
  process.exit(await main())     // ← 实测:这一行才是 13 的来源
}
```
  实测(同一台机器、同一命令,只换入口):
```
$ node cli/aw.mjs version > $null 2>&1 ; $LASTEXITCODE      → 13   (stderr: "Warning: Detected unsettled top-level await at file:///D:/.../cli/aw.mjs:201")
$ node bin/aw.mjs version > $null 2>&1 ; $LASTEXITCODE      → 0
重复 3 次:cli/aw.mjs=13,13,13   bin/aw.mjs=0,0,0
cmd /c "node cli\aw.mjs --help > f 2>&1"  → 13 ; cmd /c "node bin\aw.mjs --help > f 2>&1" → 0
```
  `bin/aw.mjs:6-9` 用的是被注释否定的那种写法(`process.exitCode = await main()`),却是唯一正确的:`--help`/`version`/`config get` 全部 0,未知指令 2。
- **Impact**:任何直接调用 `cli/aw.mjs` 的路径(`pnpm cli` 之外的脚本、CI、以及 `scripts/test-cli-exit.mjs:23` 自己)在成功时也返回 13,并在 stderr 打出 "unsettled top-level await" 警告;把成功当失败。同时注释会误导后续维护者朝错误方向"修复"。
- **Fix**:把 `cli/aw.mjs:199-202` 改成与 `bin/aw.mjs` 相同的写法:
```js
if (thisEntry) { process.exitCode = await main() }
```
  并同步修正 `cli/aw.mjs:193-198` 的注释(现状描述与实测相反);`scripts/test-cli-exit.mjs:11` 的说明文字同理。
- **Verification**:
  `node cli/aw.mjs --help > $null 2>&1; $LASTEXITCODE` → 修复前 13,修复后 0;`node scripts/test-cli-exit.mjs`(本会话因沙箱 spawn EPERM 无法运行,⚠UNVERIFIED,其中 `check('aw --help → 0（非 13）')` 正是该断言)。

### [P1] 钩子事件名不匹配:`permissions:changed` 实际以 `event:permissions:changed` 发射,按 SDK 清单订阅永远收不到
- **Where**: `sdk/lifecycle.mjs:11`、`sdk/context.mjs:142`、`server/services/workshop/permissions.ts:75`、`server/services/workshop/plugins/host.mjs:695-697`
- **Evidence**:
```js
// sdk/lifecycle.mjs:8-19  —— 清单里是裸名
export const LIFECYCLE_EVENTS = Object.freeze([ 'plugin:host:init', 'config:changed', 'permissions:changed', ... ])
// server/services/workshop/permissions.ts:73-76  —— 发射走 emitPluginEvent
void import('@/server/services/workshop/plugins/host.mjs').then((m) => { void m.emitPluginEvent('permissions:changed', { userId }) })
// server/services/workshop/plugins/host.mjs:695-697  —— emitPluginEvent 会加 event: 前缀
export function emitPluginEvent(type, payload) { void g.__awPluginHost?.bus.emit(`event:${type}`, payload) }
```
  ⇒ 实际总线类型是 `event:permissions:changed`;`ctx.hooks.on('permissions:changed', fn)`(文档与清单给的写法)永不触发,只有 `ctx.hooks.on('event:permissions:changed')` 或 `ctx.events.on('permissions:changed')`(`sdk/context.mjs:172` 会补前缀)可用。
- **Impact**:产线授权变更这一唯一的权限热更新通道对插件静默失效——插件缓存的授权视图不会刷新,可能导致按旧授权继续展示/操作。`docs/site/sdk/lifecycle.md:29-31` 与 `docs/sdk.md:5` 一致地把裸名写成权威清单,把错误教给使用者;`sdk/context.mjs:142` 的注释(`变更事件: hooks.on('permissions:changed', { userId })`)同样是错的。
- **Fix**:二选一,推荐改发射侧对齐清单(清单是"单一事实源"):`permissions.ts:75` 改为 `m.emitPluginEvent('permissions.changed', …)` 并让插件用 `ctx.events.on('permissions.changed')`;或在 host 增加 `bus.emit('permissions:changed', …)` 直发裸名同时保留 `event:` 版本。若选择保留现状,则必须把 `sdk/lifecycle.mjs:11` 改成 `'event:permissions:changed'` 并同步 3 处文档。建议再补一条"发射面 ↔ LIFECYCLE_EVENTS"的自动校验(参考 `scripts/test-sdk-surface.mjs` 的集合比对)。
- **Verification**:
  `node -e "…"` 静态比对:`grep -rn "bus.emit('" server/services/workshop/plugins/host.mjs` 的裸名集合与 `sdk/lifecycle.mjs` 求差集(见 P2-3 的脚本化建议);运行期:`permissions.ts` 的 `notifyGrantsChanged` 触发后,写一个订阅 `permissions:changed` 的插件,观察其 `ctx.kv` 是否更新 —— 修复前无变化,修复后更新。

### [P1] `config:changed` 全仓没有任何发射点 → `ctx.config.onChange()` 是死 API(含 SDK 自带示例)
- **Where**: `sdk/context.mjs:116-117`、`sdk/lifecycle.mjs:10`、`server/services/system-config.ts:413,421-430`、`server/services/workshop/plugins/host.mjs:248-256`
- **Evidence**:
```js
// sdk/context.mjs:116-117
/** 运行时覆盖变更订阅(runtime-settings.json 变化;宿主 fs.watch 驱动) */
onChange: fn => hooks.on('config:changed', fn),
```
```js
// server/services/system-config.ts:413  —— 'config:changed' 只是 SystemConfigService 内部监听器的载荷类型
if (changed.length) this.broadcast({ type: 'config:changed', changed, ...out })
// :421-430  —— broadcast 只喂 this.listeners,与插件 HookBus 无关
private broadcast(payload: ConfigEventPayload): void { for (const fn of [...this.listeners]) { ... } }
// host.mjs:248-256  —— 宿主订阅它,但只做 effective 合并,不转发到 bus
getSystemConfigService().subscribe((tail) => { if (config?.effective && tail?.effective) Object.assign(config.effective, tail.effective) })
```
  全仓 `config:changed` 字面量只出现在:`system-config.ts:69/413`、`sdk/lifecycle.mjs:10`、`sdk/context.mjs:117`、`sdk/index.d.mts:124`、`app/stores/runtime-config.ts:38`(前端事件类型)与文档 —— **没有任何 `bus.emit('config:changed')` / `emitPluginEvent('config…')`**。
- **Impact**:`ctx.config.get()` 会读到新值(宿主 merge 了 effective),但 `ctx.config.onChange(fn)` 的回调永不执行 —— 插件无法在被通知时做副作用(重算缓存、重新下发阈值、落 KV)。SDK 自己的示例 `sdk/examples/line-sentinel/index.mjs:31-35` 就依赖它,照抄的用户会得到一个静默失效的订阅。`docs/sdk.md:134,208` 与 `docs/site/sdk/guide.md:134,208` 都把它写成可用能力。
- **Fix**:在 `host.mjs:249-255` 的 `subscribe` 回调里补一次总线广播:`void host.bus.emit('config:changed', { at: new Date().toISOString(), changed: tail?.changed ?? [] })`(注意在 `initPluginHost` 里 `host` 已存在);`sdk/context.mjs:117` 保持不变即可。若坚持"config 变更只经 SystemConfigService",则删除 `ctx.config.onChange` 与其类型声明,并同步 4 处文档与示例。
- **Verification**:
  `node -e "…"` 或直接:`grep -rn "bus.emit('config:changed'\|emitPluginEvent('config" server/` 修复前无输出、修复后命中 host.mjs;运行期:`aw config set theme.primaryColor '#123456'` 后用 `sdk/examples/line-sentinel` 观察 `ctx.kv.get('lastConfigAt')` 是否出现 —— 修复前恒为空。

### [P1] 浏览器端 `ctx.fetch` 吞掉业务错误信封(HTTP 200 + `code!==0` 返回 `null`),与 `api.mjs` 重复实现且语义分歧
- **Where**: `sdk/client.mjs:54-72` vs `sdk/api.mjs:17-48`(分歧点 `api.mjs:36-45`)
- **Evidence**:
```js
// sdk/api.mjs:36-45  —— 明确防了"把 error 信封解包成 null 当成功用"
if (json && typeof json === 'object' && 'code' in json && json.code !== 0) { …throw… }
return json && typeof json === 'object' && 'data' in json && 'code' in json ? json.data : json
// sdk/client.mjs:65-71  —— 同样的解包,但没有 code 检查
if (!res.ok) { const err = new Error(json?.message ?? `HTTP ${res.status} ${path}`); err.status = res.status; throw err }
return json && typeof json === 'object' && 'data' in json ? json.data : json
```
  stub 服务器实验(`scripts/_audit/probe-envelope.mjs`,HTTP 200 + `{code:'LINE_FORBIDDEN',message:'无该产线权限',data:null}`):
```
api.get(/api/biz-error)   -> threw: status=200 code=LINE_FORBIDDEN message=无该产线权限      # api.mjs 正确
ctx.fetch(/api/biz-error) -> NO THROW, returned null  <-- business error swallowed           # client.mjs 缺陷
ctx.fetch(/api/http-500)  -> threw: status=500 code=undefined hasBody=false                  # 错误形状也不一致
```
- **Impact**:插件面板里的 `ctx.fetch` 调用在业务失败时拿到 `null` 当成功用(渲染空列表/误判"无数据"),且丢掉 `message`;`err` 上也没有 `body`/`code`,与 `ctx.api` 的错误契约不一致。平台契约(`server/utils/response.ts:12-13,26-46`)是"成功 `{code:0,…,data}` / 失败带非 2xx",当前服务端不会产生"200 + code≠0",所以是**结构性缺陷 + 未来回归风险**(任何返回 200 信封错误的端点/中间层都会静默);但重复实现的漂移已经可见(错误对象字段不同)。
- **Fix**:抽出单一出口,例如新增 `sdk/http.mjs` 导出 `unwrapEnvelope(json, ctxInfo)` 与 `buildError(res, json, path)`,由 `api.mjs:28-47` 与 `client.mjs:65-71` 共同使用;`client.mjs` 侧补 `if (json && 'code' in json && json.code !== 0) throw …`,并在两处都设 `err.code`/`err.body`。注意 `client.mjs` 需保留 `document.cookie` 取 token 的同源逻辑(`client.mjs:57-59`)。
- **Verification**:
  `node scripts/_audit/probe-envelope.mjs` → 修复后 4 行应分别为:`{"hello":"world"}` / `threw: status=200 code=LINE_FORBIDDEN` / `threw: status=200 code=LINE_FORBIDDEN …` / `threw: status=500 code=INTERNAL_ERROR hasBody=true`。

### [P1] 通用 `resource()` 假设了完整 CRUD,REST 面并不存在 → 8 个已文档化方法运行期 404
- **Where**: `sdk/api.mjs:50-56`(`resource()`)、`:73-97`(各资源挂载点);对照 `server/api/**` 路由文件
- **Evidence**:
```js
// sdk/api.mjs:50-56
const resource = root => ({ list: q => call('GET', `${root}${toQuery(q)}`), get: id => call('GET', `${root}/${id}`),
  create: b => call('POST', root, b), update: (id, p) => call('PATCH', `${root}/${id}`, p), remove: id => call('DELETE', `${root}/${id}`) })
```
  实测判别(404 + h3 裸 "Page not found" = 无此路由;500 + 信封 = 路由存在、处理器执行;`scripts/_audit/probe-routes2.mjs` 对运行实例):
| SDK 方法 | 请求 | 实测 | 服务端路由文件 |
|---|---|---|---|
| `users.update` | PATCH `/api/users/:id` | **404** | 只有 `users/[id].put.ts`(PUT → 500 = 路由存在) |
| `lines.get` | GET `/api/workshop/dcw/lines/:id` | **404** | 只有 `[id].patch.ts`/`[id].delete.ts` |
| `products.list` | GET `/api/workshop/dcw/products` | **404** | 只有 `products/index.post.ts` |
| `products.get` | GET `…/products/:id` | **404** | 无 `[id].get.ts` |
| `recipes.get` | GET `…/recipes/:id` | **404** | 只有 `[id]/versions.get.ts` |
| `dcwNodes.get` | GET `/api/workshop/dcw/:id` | **404** | 无 `dcw/[id].get.ts` |
| `daqNodes.get` | GET `/api/workshop/daq/:id` | **404** | 无 `daq/[id].get.ts` |
| `twins.get` | GET `/api/workshop/device-twins/:id` | **404** | 无 `[id].get.ts` |
  对照组:`lines.update`(PATCH)→500(存在)、`teams.get`/`agents.get` →500(存在)、`dcwNodes.list`/`daqNodes.list`/`twins.list` →401(存在),`/api/workshop/dcw/products` →404 裸体(不存在)。
- **Impact**:`docs/sdk.md:89-93` 的表格逐条承诺了这些方法("api.users … list/get/create/**update**/remove"、"api.lines … CRUD + start/stop"),照文档写代码的集成方在运行期收到 `HTTP 404 /api/…` 或 `业务错误 NOT_FOUND`;`api.users.update` 更隐蔽——服务端有同名语义的 PUT,集成方会以为是权限/参数问题。
- **Fix**:把 `resource()` 从"默认全 CRUD"改成"按挂载点声明方法表":例如 `const resource = (root, methods = ['list','get','create','update','remove']) => ({...})`,并在 `api.mjs:73-97` 显式写入各资源真实支持的集合(`users: ['list','get','create','update(PUT)','remove']`、`products: ['create','update','remove']`、`recipes: ['list','get?','create','update','remove']`、`dcwNodes: ['list','create','update','remove']`、`daqNodes: ['list','create','update','remove','alarms']`、`twins/teams/agents: ['list','create','update','remove']`、`lines: ['list','create','update','remove','start','stop']`),同时把 `users.update` 改为 `call('PUT', …)`。同步更新 `docs/sdk.md:87-98` 与 `sdk/index.d.mts:45-55`。另一条路是补齐服务端 GET 路由(工作量大且改的是 API 面,不建议在 SDK 侧留着假接口)。
- **Verification**:
  `node scripts/_audit/probe-routes2.mjs`(以运行实例为靶);修复后上表 8 行要么从 SDK 面消失,要么返回 401/200 而非 404 裸体。也可加一条静态守卫:解析 `sdk/api.mjs` 生成的 (method, path) 集合与 `server/api/**` 文件路由求差集,差集为空才算通过。

### [P1] 设置了 `AW_HOME` 时,`aw register --global` 写入的目录不在扫描列表里,注册结果永久不可见(且自称"立刻可用")
- **Where**: `cli/aw.mjs:100,105`(扫描目录用 `homedir()`)、`cli/core/registry.mjs:105-111`、`cli/core/context.mjs:113,122,157`、`cli/commands/register.mjs:40`
- **Evidence**:
```js
// cli/core/registry.mjs:105-111  —— 用 homedir()/.AgentWorkShop/commands
if (homeDir) dirs.push(join(homeDir, '.AgentWorkShop', 'commands'))
// cli/core/context.mjs:113,122  —— 用 awHome(env)(AW_HOME 可重定向)
const home = awHome(process.env)              // = env.AW_HOME || ~/.AgentWorkShop
const globalCommands = join(home, 'commands')
// cli/commands/register.mjs:40
const targetDir = global ? ctx.commandsDir.global : ctx.commandsDir.local
```
  实测(`AW_HOME=…\scripts\_audit\awhome`):
```
$ node bin/aw.mjs --root=scripts/_audit/proj register scripts/_audit/hello.mjs --global
› 注册到用户级 (D:\...\scripts\_audit\awhome\commands)
✔ 已注册: hello.mjs  →  D:\...\scripts\_audit\awhome\commands\hello.mjs
  › 立刻可用: aw hello --help
$ node bin/aw.mjs hello-audit
✖ 未知指令: hello-audit（aw help 查看全部指令）   [exit 2]
$ node -e "…commandDirs({packageRoot,projectRoot:null,homeDir:os.homedir()})"
{"scanDirs":["D:\\...\\cli\\commands","C:\\Users\\87287\\.AgentWorkShop\\commands"], "awHome":"D:\\...\\scripts\\_audit\\awhome"}
```
- **Impact**:`AW_HOME`(文档化能力,`docs/cli.md:96`)一旦启用,用户级指令注册就是"写了但永远不生效",而且 CLI 明确承诺"立刻可用"。`AW_HOME` 常用于多实例/CI 隔离,属于正常用法。
- **Fix**:让扫描目录与写入目录同源:`cli/aw.mjs:100` 改为 `const homeDir = awHome(process.env)`(从 `shared/config/home.mjs` 导入,context.mjs 已这样用),或让 `commandDirs()` 接收 `awHome` 而不是 `homedir()`(`cli/core/registry.mjs:105`)。同时把 `cli/core/help.mjs:41` 的目录文案与之一致(见 P2-8)。
- **Verification**:
  `$env:AW_HOME="$PWD\scripts\_audit\awhome"; node bin/aw.mjs register scripts/_audit/hello.mjs --global; node bin/aw.mjs help | Select-String hello`
  修复前 `aw help`/`aw hello-audit` 都找不到(exit 2);修复后 `aw help` 的"audit"分组列出 `hello-audit`,且 `aw hello-audit` 输出 `hello-audit ok` 退出 0。

### [P1] SDK 自带客户端示例与文档教了两种"永不触发"的订阅写法
- **Where**: `sdk/examples/sample-insight/client.mjs:18`、`sdk/examples/line-sentinel/client.mjs:23`、`docs/sdk.md:230,236`、对照 `sdk/client.mjs:49-53` 与 `app/plugins/aw-plugins.client.ts:117,173,190`
- **Evidence**:
```js
// sdk/client.mjs:49-53 —— 非 'event:*' 一律加 event: 前缀
on: (type, fn) => { const off = type === 'event:*' ? hooks.on('*', fn) : hooks.on(`event:${type}`, fn); … }
// app/plugins/aw-plugins.client.ts:190 —— page:change 走 hooks 直发(无前缀)
ctx?.hooks?.emit('page:change', { path })
// app/plugins/aw-plugins.client.ts:117 —— client:init 同理
void ctx.hooks.emit('client:init', { name })
```
  ⇒ `ctx.on('page:change', …)` 实际订阅 `event:page:change`(无人发射);`ctx.on('event:line.start', …)` 实际订阅 `event:event:line.start`,而且 scene 事件里**根本没有 `line.start`/`line.stop`**(全仓 `broadcastSceneEvent` 的类型只有 `device.*`/`daq.*`/`dcw.node.changed`/`ops.log`/`permissions.changed`/`aml.*`/`plugins.reloaded`)。
- **Impact**:`sdk/examples/sample-insight/client.mjs:18` 是官方示例(且该插件已装在本机 user scope),照抄即得到静默 no-op;`docs/sdk.md:236` 把 `page:change` 列为 `ctx.on` 支持的四种 type 之一,`docs/sdk.md:230` 的代码片段同样错。插件作者会花时间排查"为什么客户端收不到路由切换"。
- **Fix**:① 示例改为 `ctx.hooks.on('page:change', …)`/`ctx.hooks.on('client:init', …)`(与 `docs/site/sdk/client.md:28` 的正确说法一致);`sdk/examples/line-sentinel/client.mjs:23-28` 改为订阅真实存在的 `ctx.on('dcw.node.changed', …)` 或直接用 `ctx.hooks.on('line:start')`。② 修正 `docs/sdk.md:230,236` 的四种 type 列表:把 `page:change` 移到"经 `ctx.hooks` 直订"一栏。③ 建议在 `sdk/client.mjs:49-53` 对 `client:`/`page:change`/`i18n:changed` 三个本地钩子名做一次"是本地钩子则不加前缀"的兜底(与 shared/workshop-protocol 的事件命名约定一致),这样两种写法都能工作。
- **Verification**:
  在插件 `client.mjs` 中同时注册 `ctx.on('page:change', h1)` 与 `ctx.hooks.on('page:change', h2)`,切换页面:修复前只有 `h2` 触发;修复后两者都触发。静态验证:`grep -n "ctx.on('page:change'\|ctx.on('event:" sdk/examples docs/sdk.md` 应无残留。

---

## 3. P2

### [P2] 类型声明 4 类漂移(双向:少声明 / 多声明 / 欠声明)
- **Where**: `sdk/index.d.mts:37-57,113-118,119-120`、`sdk/client.d.mts:102-103`、`sdk/index.mjs:22`、`sdk/context.mjs:201,241,258`、`sdk/api.mjs:98-103`、`server/services/workshop/plugins/host.mjs:437,470,478`
- **Evidence**(`scripts/_audit/probe*.ts` + `tsc 5.9.3 -p scripts/_audit/tsconfig.probe.json`,镜像 nuxt app 的 `allowJs/moduleResolution: Bundler`):
```
probe4.ts(2,10): error TS2614: Module '"../../sdk/index.mjs"' has no exported member 'isPathInside'.
probe4.ts(2,24): error TS2614: Module '"../../sdk/index.mjs"' has no exported member 'validatePluginSettings'.
probe3.ts  (import { el } from '../../sdk/client.mjs')  → 无错误(编译通过)
$ node -e "import('./sdk/client.mjs').then(m=>console.log('el named export =', m.el))"  → el named export = undefined
$ node -e "Object.keys(m)"  → sdk/index.mjs 命名导出 14 个,index.d.mts 只声明 12 个(缺上面两个)
```
  另:`index.d.mts:113-118` 的 `createRouteTable()` 返回类型无 `unregisterPlugin`(运行时 `context.mjs:201` 有);`index.d.mts:37-57` 无 `permissions`,且 `products/recipes/dcwNodes/daqNodes/twins/teams/agents` 只声明 `list/create`;`PluginContext`(59-92)无 `daq`/`omp`/`services`(host 注入,`docs/plugins.md:107-110` 有文档)、也无 `version`。
- **Impact**:TS 集成方 `import { isPathInside } from 'agentworkshop/sdk'` 编译失败(必须 `as any`);`import { el } from 'agentworkshop/sdk/client'` 编译通过但运行期 `undefined is not a function`(最危险的一类漂移);`api.permissions.overview()` 等已实现能力在类型上不存在。`docs/sdk.md:8` 承诺"TS 项目零配置获得完整提示"。
- **Fix**:① `sdk/index.d.mts` 补 `export declare function isPathInside(dir: string, p: string): boolean` 与 `validatePluginSettings(pluginName: string, defs: any[]): { descriptors: any[], errors: string[] }`,并在 `createRouteTable` 返回类型补 `unregisterPlugin(name: string): number`;② 删除 `sdk/client.d.mts:102-103` 的 `export declare function el(...)`(改注释说明"仅 default 导出可用"),或把 `sdk/client.mjs:144` 改成同时命名导出 `el`(二者取一并保持文档一致);③ `PlatformClient` 补 `permissions` 与各资源的 `get/update/remove`(与 P1-7 的修正一起做);④ `PluginContext` 补 `daq`/`omp`/`services`(可从 `docs/plugins.md:107-110` 提炼接口)与 `version?: string`(或删掉示例里的 `ctx.version`,见 P2-2)。
- **Verification**:
  `node node_modules/typescript/bin/tsc -p scripts/_audit/tsconfig.probe.json`(当前 exit 0,因 probe 只用了已声明的符号)。把 `scripts/_audit/probe4.ts` 保留在仓库并纳入 CI:修复前 error TS2614 两条,修复后 exit 0;再加一条 `probe5.ts: import { el } from '../../sdk/client.mjs'` 并要求**运行期**断言 `typeof elModule.el === 'function'`(或按 ③ 的另一种修法)。

### [P2] SDK 示例/文档与运行时字段不符(`ctx.version`、`ctx.kv.reset()`、`ctx.scope` 三处不一致)
- **Where**: `sdk/examples/line-sentinel/index.mjs:84`、`docs/sdk.md:182`、`docs/sdk.md:127` vs `sdk/index.d.mts:62` vs `sdk/context.mjs:5` vs `host.mjs:190`
- **Evidence**:
```
$ node -e "…createPluginContext({…}); console.log('version' in ctx, Object.keys(ctx))"
{"hasVersion":false,"keys":["api","config","dataDir","dir","events","hooks","http","kv","logger","name","onDispose","paths","permissions","route","scope","sdkVersion","subscriptions","timer"]}
$ … console.log('kv keys:', Object.keys(ctx.kv), '| reset =>', typeof ctx.kv.reset)
kv keys: get,set,all,bump | reset => undefined
```
  scope 三处不一致:代码注释 `sdk/context.mjs:5` 写 `ctx.scope('home'|'project')`;类型 `sdk/index.d.mts:62` 写 `'builtin' | 'project' | 'user'`;用户文档 `docs/sdk.md:127` 写 `'project' | 'user'`;宿主持有值:`host.mjs:190` 的 `[[builtinDir,'builtin'],[projectDir,'project'],[userDir,'user']]`。
- **Impact**:示例 `/report` 接口里 `version` 恒为 undefined(JSON 里直接消失);文档给的 `ctx.kv.reset()` 一调用就 TypeError;`ctx.scope` 的三套取值让插件做作用域判断时写出漏分支(例如没处理 `'builtin'`)。
- **Fix**:删掉 `sdk/examples/line-sentinel/index.mjs:84` 的 `version: ctx.version`(或按 P2-1 ④ 给 ctx 加 `version`);`docs/sdk.md:182` 的 `ctx.kv.reset()` 改为 `ctx.kv.set(...)`(或给 `PluginKv` 真正实现 `reset()`);`docs/sdk.md:127` 与 `sdk/context.mjs:5` 统一为 `'builtin' | 'project' | 'user'`,并在 `sdk/index.d.mts:61-62` 的注释里补一句 builtin 来自 `<包根>/server/plugins-builtin`。
- **Verification**:
  `node -e "…createPluginContext(…)"` 断言 `('version' in ctx) === false` 与 `ctx.kv.reset === undefined`(作为"文档不得提及"的守卫);`grep -rn "ctx.version\|kv.reset()" sdk docs` 修复后应无命中。

### [P2] 生命周期清单漏了两个真实发射的事件(`plugins:reloaded`、`i18n:changed`)
- **Where**: `sdk/lifecycle.mjs:8-19`(服务端)、`:22-27`(客户端)、`host.mjs:626`、`app/plugins/aw-plugins.client.ts:173`
- **Evidence**:
```js
// host.mjs:626
await host.bus.emit('plugins:reloaded', { plugins: pluginManifest() })
// app/plugins/aw-plugins.client.ts:170-176
watch(localeRef, (loc) => { for (const { ctx } of loaded.values()) { ctx?.hooks?.emit('i18n:changed', { locale: loc }) } })
```
  两者都不在 `LIFECYCLE_EVENTS` / `CLIENT_EVENTS` 里(也不在 `sdk/index.d.mts:124-125` 的元组类型里)。
- **Impact**:插件热重载后无法自证"我已被重新装载"(需硬编码字符串才发现);语言切换广播对客户端插件不可发现。`docs/plugins.md:52` 已经把 `plugins:reloaded` 写进能力表,清单与文档互不一致。
- **Fix**:`sdk/lifecycle.mjs:8-19` 增 `'plugins:reloaded'`;`:22-27` 增 `'i18n:changed'`;同步 `sdk/index.d.mts:124-125` 的字面量元组(这两处是"单一事实源",必须同时改)。建议再加一条脚本守卫:从 `server/**` 抓 `.bus.emit('x')`/`emitPluginEvent('x')`/`emit*(…)` 的裸名集合,与 `LIFECYCLE_EVENTS` 双向求差,纳入 `scripts/test-sdk-surface.mjs`。
- **Verification**:
  `node -e "import('./sdk/lifecycle.mjs').then(m=>console.log(m.LIFECYCLE_EVENTS.includes('plugins:reloaded'), m.CLIENT_EVENTS.includes('i18n:changed')))"` → 修复前 `false false`,修复后 `true true`;`node scripts/test-sdk-surface.mjs` 应保持通过(它已做"声明 ↔ 常量"集合比对)。

### [P2] 非 2xx 错误不回传平台业务码:`err.code` 恒为 undefined(与文档/类型均不一致)
- **Where**: `sdk/api.mjs:29-35`(非 2xx 分支)对照 `:38-45`(HTTP-200 分支)
- **Evidence**:
```
# stub 服务器返回 HTTP 500 + {code:'INTERNAL_ERROR'}:
api.get(/api/http-500)    -> threw: status=500 code=undefined message=服务器内部错误
# 真实实例(已存在的路由 + 未授权):401 {code:'UNAUTHORIZED'} → 同上,只有 err.status/err.body 可用
```
- **Impact**:调用方最自然的写法 `catch (e) { if (e.code === 'LINE_READONLY') … }` 永不成立;而平台错误的 HTTP 状态与业务码是两套语义(`server/utils/response.ts:31-32` 同时给 `setResponseStatus` 与 `code`),丢 `code` 等于丢了业务判别依据。当前只能靠 `err.body.code`(未文档化)。
- **Fix**:把 `sdk/api.mjs:30-34` 改为同时带业务码:`err.code = json?.code; err.body = json`(与 `:41-42` 对齐),并让 `client.mjs` 的错误对象保持一致(见 P1-6 的统一出口)。
- **Verification**:
  `node scripts/_audit/probe-envelope.mjs` 修复后 `/api/http-500` 一行应输出 `code=INTERNAL_ERROR`;对真实实例 `api.get('/api/users/me').catch(e => e.code)` 应为 `'UNAUTHORIZED'`。

### [P2] 子进程 / 服务生命周期 / 配置解析的重复实现(8 组,应抽到 `cli/core/*`)
- **Where / Evidence**(每组给出双方精确行号):
  1. **端口+主机解析与校验**逐字重复:`cli/commands/dev.mjs:30-37` 与 `cli/commands/start.mjs:63-71`(仅键名 `server.dev.port` / `server.prod.port` 不同,含同一段 `Number.isInteger(port) || port<1 || port>65535` 校验、同一 `portSource = flags.port !== undefined ? 'CLI' : eff.sources[...]`)。
  2. **nuxt 构建 spawn**:`cli/commands/build.mjs:27-32` 与 `cli/commands/start.mjs:50-60`(首启自动构建)重复 `runChild(process.execPath,[nuxtBin,'build'],{cwd,stdio:'inherit',env:localBypassEnv()})` + 失败分支。
  3. **`spawnSync` + Windows shell 包装**:`cli/commands/doctor.mjs:25-29`(带 `shell: process.platform === 'win32'`,注释明确说明 `.cmd` 必须经 shell)、`cli/commands/update.mjs:32-39`(`npmRun`),而 `cli/commands/init.mjs:132-140` 的 `spawnSync('pnpm', ['install', …], { cwd: target, stdio })` **没有 shell 选项** → Windows 上必然复现 doctor 注释里描述的 EINVAL,`r.status` 为 null,用户只会看到 `⚠ 依赖安装未完成(status=null)`(⚠UNVERIFIED:本机无 pnpm,未能实测该分支);`cli/infra.mjs:19-23,41-47` 的 `detectDocker`/`composeUp` 是同类包装的第 4、5 份。
  4. **插件启停状态文件**:`cli/commands/plugin.mjs:115-135`(`stateFile/readState/writeState`)与 `server/services/workshop/plugins/host.mjs:162-183`(`statePathFor/readDisabledSet/writeDisabledSet`)各写一份同样的 `{version,updatedAt,disabled[]}` JSON(原子写逻辑同构)。
  5. **数采依赖探测**:`cli/commands/doctor.mjs:39-53` 重抄 `cli/infra.mjs:54-95`(`daqPreflight`)的 host/port 取值与 `probeTcp` 调用(doctor 只是不拉起容器)。
  6. **项目根探测**:`cli/aw.mjs:46-56` 的 `findUp` 与 `shared/config/home.mjs:26-39`(`isRepoRoot/findRepoRoot`)重复且标准不同(见 P1-2)。
  7. **进程树终止**:`cli/commands/stop.mjs:20-51`(`pidAlive` + `killTree`:SIGTERM → 5s 忙等 `Atomics.wait` → SIGKILL)与 `cli/core/child-lifecycle.mjs:41-48,94-118`(`SHUTDOWN_GRACE_MS` + SIGTERM → grace → SIGKILL)语义重复;`stop.mjs:41` 的 `5000` 与 `child-lifecycle.mjs:42` 的 `SHUTDOWN_GRACE_MS` 各写一份,改一处不影响另一处。
  8. **插件目录发现**:`cli/commands/plugin.mjs:152-164`(`findPluginDir/scopes`)与 `host.mjs:186-201`(`discoverPluginDirs`)各写一份;CLI 版**不含** `<包根>/server/plugins-builtin`,并把 `<repo>/.AgentWorkShop/plugins` 标成"内置示例"(`plugin.mjs:161`),而 host 的 builtin 作用域来自 `server/plugins-builtin`(本机 2 个:`diag-bridge`、`rag-bridge`);同日 `plugin.mjs:162` 是死三元(`ctx.commandsDir?.global ? join(ctx.home,'plugins') : join(ctx.home,'plugins')` 两支相同)。
- **Impact**:同一语义多处实现必然漂移(第 3 组已经在文档化行为上分叉:doctor 修了 Windows、init 没修;第 6 组已经造成 P1 崩溃;第 7 组让"优雅终止"两套参数各说各话)。`aw plugin list` 的标签错误直接误导用户(把项目级插件当中包内置示例),且只能管理 project/user 两作用域 —— 仅存在于 `server/plugins-builtin` 的插件在 CLI 侧不可见、`aw plugin enable|disable <name>` 会抛 `NOT_FOUND`(⚠UNVERIFIED:本机两个 builtin 插件恰好也在项目目录里有同名副本,故未能实测该分支)。
- **Fix**:在 `cli/core/` 下新增 3 个模块并替换上述调用点:
  `cli/core/proc.mjs`:`runSync(cmd, args, opts)`(统一 Windows `shell: process.platform === 'win32'`、统一 `error/status` 归一化)、`buildNuxt(ctx, { cwd })`;
  `cli/core/server-opts.mjs`:`resolvePortHost(effective, flags, portKey)`(返回 `{ port, host, portSource }` 并在非法时抛 `CliError('USAGE')`);
  `cli/core/plugin-state.mjs`:`readDisabledSet(home)/writeDisabledSet(home,set)/statePathFor(home)`,直接复用 `server/services/workshop/plugins/host.mjs` 的导出(CLI 已在导入服务端模块,见 `cli/commands/start.mjs:16` 引入 `scripts/home-bootstrap.mjs`);`scopes()` 改为复用 `discoverPluginDirs()` 的三作用域结果。
  另外:`killTree` 抽成 `cli/core/child-lifecycle.mjs` 的 `killTree(pid, { graceMs = SHUTDOWN_GRACE_MS, killSignal })`;`findUp` 删除(P1-2)。
- **Verification**:
  `grep -rn "Number.isInteger(port)" cli/` 修复后应只剩 1 处;`grep -rn "spawnSync('pnpm'\|spawnSync('npm'\|spawnSync('docker'" cli/` 修复后应全部经 `proc.mjs`;对第 3 组:`node -e "…spawnSync('pnpm',['--version'])…"` 在 Windows 上修复前 `status=null,error=EINVAL`(需装 pnpm;⚠UNVERIFIED),修复后 `status=0`。

### [P2] 死代码 / 无效代码 6 处,其中两处直接造成用户可见的静默失效
- **Where / Evidence**:
  1. `cli/core/args.mjs:166-168` `flagValue()` **全仓无人调用**(`grep -rn flagValue` 仅命中定义处)。
  2. `cli/core/args.mjs:91,100` 的 `unknown` 只收集**从不上报**(`grep -rn "\.unknown" cli/` 无命中)→ 未知短选项被静默吞掉:实测 `aw echoargs -g` → `{"flags":{},"positionals":[],"unknown":["-g"]}`,而 `aw register <path> -g`(`register.mjs:23` 的 usage 里写着 `[--global|-g]`,实现读 `flags.global ?? flags.g`)在脚手架内实测输出 `› 注册到项目级 (…\.AgentWorkShop\commands)` —— **`-g` 被忽略,注册到了项目级**,同一问题影响 `aw plugin create <n> -g`(`plugin.mjs:201`)。
  3. `cli/core/logger.mjs:25` 的 `logger.debug` 由 `process.env.AW_DEBUG` 控制,**CLI 内没有任何调用点**(唯一命中是 `plugin.mjs:66` 的模板字符串文本);`--debug` 只在 `cli/aw.mjs:182` 打印一次原始错误栈 ⇒ `help.mjs:38` 承诺的"调试日志"不存在。
  4. `cli/commands/status.mjs:24-26`:`Object.entries(ctx.config.load().overrides).map(([k, v]) => [k, v])` 是同值映射(且 `:20`/`:25` 重复调用 `config.load()` 两次)。
  5. `cli/commands/start.mjs:90`:`ctx.paths?.configRoot ?? …` —— `ctx` 从上到下都没有 `paths` 字段(`cli/core/context.mjs:146-167` 的返回对象里只有 `configRoot`),该分支恒为 `undefined`。
  6. `cli/aw.mjs:155-160` 的注释断言"`aw foo --name --json` 时 `--json` 是 `--name` 的值",与 `cli/core/args.mjs:59` 的实际语义相反(下一 token 以 `-` 开头时不会取值)。实测 `aw echoargs --name --json` → `{"flags":{"name":true}}`(值丢失是 parseArgs 的既定语义,不是 stripGlobals 的效果),注释会误导后续维护者。
- **Impact**:`-g`/`-q` 之类短选项静默无效(用户以为切换了作用域);`--debug` 名不副实;两处纯噪声代码增加误读成本。
- **Fix**:① 删除 `flagValue`;② 在 `cli/aw.mjs:163-168` 解析后检查 `local.unknown.length` 并以 `CliError('USAGE', '未知选项: …')` 报错(或给 `register`/`plugin` 的 meta 补 `short: { g: 'global', f: 'force' }`,与 `cli/aw.mjs:163` 的 `shortMap` 机制对接 —— 这是更符合现有设计的修法);③ `logger.debug` 改为读 `ctx.debug`/全局 `--debug`(`cli/aw.mjs:82` 已有该变量),并在 `dev/start/build/config` 关键分支补少量 `logger.debug`;④ 删掉 `status.mjs:24-26` 的同值 map,`config.load()` 只调一次;⑤ `start.mjs:90` 改为 `ctx.configRoot ?? cwd`;⑥ 修正 `cli/aw.mjs:155-160` 注释(说明 stripGlobals 只保证"值位同名 token 不被误删",不保证"以 - 开头的值能被取值")。
- **Verification**:
  `node bin/aw.mjs --root=scripts/_audit/proj echoargs -g` → 修复前 `unknown:["-g"]` 且静默 exit 0,修复后 exit 2 并提示未知选项;`node bin/aw.mjs --root=$TEMP\aw-init-audit register <x.mjs> -g` → 修复后应打印"用户级";`node bin/aw.mjs --debug config get server.dev.port` → 修复后应出现 `[debug]` 行;`grep -rn "flagValue" cli/` 应为空。

### [P2] `aw plugin` 的作用域语义与文档相反,`--project` 未实现,builtin 目录不参与扫描
- **Where**: `cli/commands/plugin.mjs:159-164,197-205`;`docs/plugins.md:12-13,25`;`docs/site/plugins/index.md:10-11`
- **Evidence**:
```js
// cli/commands/plugin.mjs:202-205
const target = global ? join(ctx.home, 'plugins', name) : join((ctx.root ?? process.cwd()), '.AgentWorkShop', 'plugins', name)
```
  文档却写"`aw plugin create my-plugin            # 脚手架到 ~/.AgentWorkShop/plugins/(用户级)` / `aw plugin create my-plugin --project  # 或项目级 <repo>/.AgentWorkShop/plugins/`"。实测(在脚手架项目内、以仓库为 cwd 的一次运行):`✔ 插件已创建: demo-plugin → D:\codes\ABO\AgentWorkShop\.AgentWorkShop\plugins\demo-plugin` —— 默认即项目级;`grep -rn "flags.project\|--project" cli/` 只命中 usage 字符串与错误文案两处,**没有任何读取 `--project` 的代码**。
- **Impact**:按文档操作的用户拿到的落点与预期相反;`--project` 是"看着有、实际无"的旗标(与 P2-6 的 `-g` 是同一类问题);`aw plugin list` 把 `<repo>/.AgentWorkShop/plugins` 标为"内置示例"、把 `~/.AgentWorkShop/plugins` 标为"用户级扩展",与 `docs/plugins.md:25` 的三作用域说明(builtin = `<包根>/server/plugins-builtin`)不一致。
- **Fix**:① 明确默认作用域:若文档为准,`plugin.mjs:202` 改为 `const global = flags.global === true ? true : (flags.project ? false : true)` 之类"默认 user、`--project` 走项目"的逻辑;若代码为准,则改文档把 `--project` 换成 `--global` 并把默认落点写成 `<repo>/.AgentWorkShop/plugins`。② `scopes()` 增 `{ scope:'builtin', dir: join(ctx.packageRoot,'server','plugins-builtin') }`(与 host 同序,builtin 优先),并把 `:161` 的标签改成 `'项目级'`/`'内置(随包)'`;顺手删掉 `:162` 的同值三元。③ 在 meta 里补 `short: { g:'global', f:'force' }` 让 `-g/-f` 真正生效(见 P2-6 ②)。
- **Verification**:
  `node bin/aw.mjs --root=$TEMP\aw-init-audit plugin create demo2` 与 `… plugin create demo2 --project`:修复后两者落点应符合文档;`node bin/aw.mjs plugin list` 应出现第三个"内置(随包)"分组,且 `diag-bridge`/`rag-bridge` 出现在该组(它们来自 `server/plugins-builtin`,host manifest 的 `scope` 就是 `builtin`)。

### [P2] `aw --help` 里的指令目录大小写错误(与 registry、docs 均不一致)
- **Where**: `cli/core/help.mjs:41` vs `cli/core/registry.mjs:103-111` vs `docs/cli.md:139-141`
- **Evidence**:
```
$ node bin/aw.mjs --help | Select-String "指令注册"
指令注册:    内建(随包) + 用户 ~/.agentworkshop/commands + 项目 .agentworkshop/commands（同名的后者覆盖前者）
```
```js
// registry.mjs:103-104 注释自己就警告过这件事
//  目录名与 shared/config/home.mjs 的 HOME_DIRNAME 保持一致(.AgentWorkShop):
//  Windows 大小写不敏感无感,Linux/macOS 下小写目录会导致注册的指令永远扫描不到。
if (homeDir) dirs.push(join(homeDir, '.AgentWorkShop', 'commands'))
```
- **Impact**:Linux/macOS 用户按 `aw --help` 的指引把指令放到 `~/.agentworkshop/commands`,永远不被扫描(与 P1-8 同类的"写了不生效"体验);`docs/cli.md:140-141` 用的是正确大小写,帮助文案反而错。
- **Fix**:`cli/core/help.mjs:41` 改成 `.AgentWorkShop`(两处),并统一从 `shared/config/home.mjs` 的 `HOME_DIRNAME` 常量插值,避免再次漂移。
- **Verification**:`node bin/aw.mjs --help | Select-String "commands"` 应输出 `~/.AgentWorkShop/commands` 与 `.AgentWorkShop/commands`;`grep -rn "\.agentworkshop" cli/ docs/` 应无残留(文档同理)。

### [P2] `docs/cli.md` 漏了 3 条已注册指令,且设置项数量是过期数字
- **Where**: `docs/cli.md:102-114`(指令表)、`:124`;对照 `cli/commands/*.mjs` 与 `docs/site/cli/index.md:107-116`
- **Evidence**:`aw --help` 实际注册 14 条(`build dev start config home doctor status init plugin register stop tui update version`),`docs/cli.md` 的表只有 11 条 —— 缺 `aw plugin`、`aw stop`、`aw tui`(`docs/site/cli/index.md:107,116` 与 `docs/plugins.md:12-14` 都写了)。另:
```
$ node -e "…createContext({cwd}).config.load().descriptors.length"   → 98
docs/cli.md:124   aw config list   # 18 个设置项 + 来源 + 生效方式      ← 实际 98
docs/site/cli/index.md:127        # 73 个设置项(16 组)               ← 也已过期
```
  `docs/cli.md:181` 对 `files` 的描述("bin/cli/app/server/shared/i18n/public/scripts/.AgentWorkShop/prompts/各配置文件")与 `package.json:26-51` 实际白名单不一致(实际还含 `.output`、`sdk`、`tui`、`server/plugins-builtin`、`docs/{cli,plugins,sdk,tui}.md`)。
- **Impact**:`docs/cli.md` 是**随包发布**的文件(`package.json:46`),用户看到的指令清单不完整(`aw plugin`/`aw stop`/`aw tui` 完全不可发现);数量类数字过期会误导"配置项很少"的判断。
- **Fix**:把 `docs/cli.md:102-114` 的表补齐为 14 条(可直接从 `docs/site/cli/index.md:104-116` 抄),删除具体数量或改为"运行 `aw config list` 查看全部";`:181` 的 `files` 描述改为"见 package.json `files`",或列出实际条目。建议加一条最小守卫:`aw --help` 输出里的指令名集合 ⊆ `docs/cli.md` 表中出现的指令名(反之亦然)。
- **Verification**:
  `node bin/aw.mjs --help` 的指令集合与 `docs/cli.md` 表格求差:修复后差集为空;`node -e "…descriptors.length"` 与文档中数字一致(或不含数字)。

### [P2] `aw stop` 失败路径硬编码 Windows 提示并丢弃失败原因;`runChild` 硬超时恒报 143
- **Where**: `cli/commands/stop.mjs:31-51,96-99`、`cli/core/child-lifecycle.mjs:109-114`
- **Evidence**:
```js
// stop.mjs:96-99  —— 无论在哪个平台都建议 taskkill
catch (err) {
  console.error(`✖ 终止失败:${err.message}`)
  console.error(`  可手动执行:taskkill /PID ${pid} /T /F(Windows)`)
```
```js
// stop.mjs:34  —— taskkill 失败时若 stdout/stderr 为空,message 就是写死的 'taskkill 失败'
if (r.status !== 0) throw new Error((r.stderr || r.stdout || 'taskkill 失败').trim().split(/\r?\n/)[0])
```
  实测(本机沙箱拒绝终止进程,正好走到该分支):`✖ 终止失败:taskkill 失败` + 提示 `可手动执行:taskkill /PID 66244 /T /F(Windows)` —— 丢掉了 `r.status`(退出码)与 `r.error`。
```js
// child-lifecycle.mjs:111-113  —— 硬收口固定按 SIGTERM 计
killTimer = setTimeout(() => finish(signalExitCode('SIGTERM')), graceMs + 5000)   // SIGINT 也报 143
```
- **Impact**:Linux/macOS 上的失败提示指向不存在的 Windows 命令;退出码语义在"硬收口"这一退化路径上与 `:131` 的真实信号映射不一致(Ctrl+C → 期望 130,实际 143)。
- **Fix**:`stop.mjs:98` 改为按平台分支(`process.platform === 'win32' ? 'taskkill /PID <pid> /T /F' : 'kill -TERM/-KILL <pid>'`),并在消息里带 `status`/`error`;`child-lifecycle.mjs:112` 把待决信号记录下来(`let pendingSignal = 'SIGTERM'`,在 `onSignal` 里赋值),硬收口时用 `signalExitCode(pendingSignal)`。
- **Verification**:
  `node bin/aw.mjs stop`(在无权限终止的环境下)→ 修复后消息含退出码且 Linux 上不再出现 `taskkill`;`node scripts/_audit/probe-child.mjs` 已实测 `signalExitCode(SIGINT)=130 / SIGTERM=143 / SIGKILL=137 / 未知=1` 与 `runChild(process.exit(7))→7`、`runChild(干净退出)→0`;硬收口分支可用 `graceMs: 1` 触发观察退出码。

### [P2] `aw doctor` 四项误报/信息缺口:检查错的数据目录、只打印键不打印原因、DEP0190 警告、把自身运行中的服务端口判为异常
- **Where**: `cli/commands/doctor.mjs:63-71,85-90,103-118,24-29`
- **Evidence**:
```js
// doctor.mjs:64  —— 检查 <repo>/data,而 CLI 自己的 ctx.dataDir 是 <配置根>/data
const dataDir = join(ctx.root, 'data')
// cli/core/context.mjs:139  —— 实际数据目录
paths.dataDir = join(paths.configRoot, 'data')      // = <repo>/.AgentWorkShop/data
```
```js
// doctor.mjs:61  —— 失败时只列键名,不列错误原因
add('配置校验', v.ok, v.ok ? `…` : Object.keys(v.keys).join(', '))
```
  实测输出(见附录):`✖ 配置校验  plugins.rag-bridge.token, plugins.diag-bridge.token, …`(无原因)、`✔ 运行中服务 检测到 3001 端口…` 与 `✖ 端口 3001 已被占用` **同时出现**(即 doctor 把自己检测到的运行中实例算作异常)、`✖ pnpm 可用 未找到 pnpm` 伴随 stderr `(node:51628) [DEP0190] DeprecationWarning: Passing args to a child process with shell option true …`(`doctor.mjs:28` 的 `spawnSync(pmBin,['--version'],{shell:true})` 触发的 Node 24 弃用警告,`update.mjs:37` 同)。
- **Impact**:健康的运行态下 `aw doctor` 退出 1(4 项"异常"里至少 2 项是误报),让体检结果失去可信度;`data/ 可写` 检查的是**旧位置**(迁移后会误导);配置失败无法一眼定位;每次运行都在 stderr 打弃用警告(污染 `--json` 消费方)。
- **Fix**:① `doctor.mjs:64` 改用 `ctx.dataDir`(并在 detail 里回显它是 `<配置根>/data`);② 配置校验失败时把 `v.keys[k]` 的**首条原因**一起打印(数据已在 `result.keys` 里,`:61` 只是在丢信息);③ 端口占用检查排除"刚刚检测到的运行中服务端口"(把 `server.port` 从 `occupied` 判定里剔除,或把该项标为"info"而非 fail);④ `doctor.mjs:28`/`update.mjs:37` 改为 `shell: true` 但把参数合并进单字符串调用(`spawnSync('pnpm --version', { shell: true })`)以消除 DEP0190,或统一走 P2-5 的 `cli/core/proc.mjs`。
- **Verification**:
  `node bin/aw.mjs doctor; $LASTEXITCODE` → 修复前 exit 1(含 `✖ 端口 3001 已被占用` 与 `✖ 配置校验 <仅键名>`);修复后:健康运行态应 exit 0(端口项改为 info)、配置校验行含原因文本、stderr 无 DEP0190。`node bin/aw.mjs doctor --json | node -e "…JSON.parse…"` 应可直接解析(stderr 干净)。

---

## 4. 已核验的"无问题"项

- **`files` ↔ `exports` 覆盖完整**:`sdk/index.mjs`、`sdk/index.d.mts`、`sdk/client.mjs`、`sdk/client.d.mts`、`bin/aw.mjs`、`package.json` 全部命中白名单;从 5 个入口出发的 18 个传递相对 import(`cli/**`、`shared/config/home.mjs`、`shared/local-time.mjs`、`scripts/home-bootstrap.mjs`)全部存在且在白名单内(`scripts/_audit/probe-packlist.mjs`,输出 `every reached file exists and is covered by "files"`)。⚠注:`npm pack --dry-run` 因沙箱 EPERM 未能执行,`docs/cli.md:181` 的"3.2MB tarball"数字**未验证**。
- **`sdk/client.d.mts` 存在且成员与 `sdk/client.mjs` 一致**(仅 P2-1 的幻影 `el` 例外);`app/plugins/aw-plugins.client.ts:15` 的 `import { createClientContext, type ClientContext } from '@/sdk/client.mjs'` 在当前代码下可正确解析(`tsc -p scripts/_audit/tsconfig.probe.json` exit 0;全项目 `npm run typecheck` 的 464 行输出中**无任何 `sdk/` 相关错误**;仓库根 `_tc-now.txt:44` 的 TS2614 是 2026-09-08 的旧日志,早于 `sdk/client.d.mts` 的加入,当前不可复现)。
- **`CLIENT_EVENTS` 准确**:`client:init`(`aw-plugins.client.ts:117`)、`page:change`(`:190`)、`client:destroy`(`sdk/client.mjs:114`)三者的发射名与清单逐一吻合;`event:*` 由 `eventBridge` → `hooks.emit('event:'+type)`(`client.mjs:127-132`)正确实现。
- **服务端发射面本身正确**:`daq:sample`(`daq-controller.ts:329`)、`daq:frame`(`:420`)、`dcw:write`(`dcw-controller.ts:578`)、`line:start`/`line:stop`(`start.post.ts:38`/`stop.post.ts:37`)、`plugin:host:init`(`host.mjs:503`)、`server:close`(`host.mjs:763`)与清单同名同序。
- **`bin/aw.mjs` 的退出码语义正确**:`--help`/`version`/`config get` → 0;未知指令/未知设置项/无参数/`help <unknown>` → 2;`dev` 崩溃 → 1。`runChild` 正常退出码透传(自测 `process.exit(7)` → 7;干净退出 → 0),`signalExitCode` 单元正确(130/143/137/1)。⚠注:Windows 上自 `SIGTERM` 的子进程 `close` 回调 `signal=null, code=1`(libuv 语义),故 `code === null → 128+N` 这条路径在本机**未能端到端观测**,⚠UNVERIFIED(代码路径 `child-lifecycle.mjs:131` 与 `stop.mjs` 的 POSIX 分支逻辑正确)。
- **参数解析的基础能力正确**:`--port=3000` 与 `--port 3000` 都得到 `flags.port='3000'`;`--json`/`--debug` 置于指令前后都生效(实测 `aw --json --debug version` 与 `aw version --json`);`--root=<dir>` 置于指令前、`--root <dir>` 置于指令后均正常;`-h`/`-v` 短全局、`aw v`/`aw cfg`/`aw st` 别名正常。
- **`sdk/api.mjs` 的信封契约与平台一致**:`{code:0,message,data}` 成功解包为 `data`;HTTP 200 + `code!==0` 抛错并带 `err.status/err.code/err.body`(stub 实测 `code=LINE_FORBIDDEN`);与 `server/utils/response.ts:12-13,26-46` 的契约(成功 0、失败带非 2xx)一致 —— 唯一缺口是 P2-4(非 2xx 分支丢 code)。
- **`api.templates.daq()/dcw()` 依赖的字段确实存在**:`server/api/workshop/daq/index.get.ts:40` 与 `dcw/index.get.ts:28` 都返回 `templates`,`.then(d => d?.templates ?? [])` 不会静默为空。(但这是**重量级**取数:`daq/index.get.ts:20-22` 会 `tsdbReady`+`provisionLegacyTwins()`,仅为拿模板触发一遍节点供给 —— 属于服务端设计问题,未计入 SDK 缺陷。)
- **`pnpm-workspace.yaml` 无 `packages:` 字段**:该文件只用于 `allowBuilds`/`minimumReleaseAgeExclude`(pnpm 11 合法用法),`aw init` 把它当配置文件复制(`init.mjs:34`)不会产生"空工作区"副作用 —— 无缺陷。

### 范围外观察(不计入本报告缺陷,记录备查)

本机运行实例(pid 66244,3001 端口)对若干**已存在**的 GET 路由返回 500(`/api/users`、`/api/workshop/dcw/lines`、`/api/workshop/channels`、`/api/workshop/teams`、`/api/workshop/agents`、`/api/workshop/permissions`),并对 `GET /api/workshop/nope`(应由 `server/api/workshop/[...path].ts:11-13` 返回 `{code:'NOT_FOUND'}` 的 404 信封)也返回 500 `{"error":true,…,"statusCode":500}`。这与 SDK/CLI 无关(路由文件与 SDK 路径判定不受影响,本报告的"路由是否存在"结论均以文件 + 404/500 对照得出),但说明该实例的错误处理链路处于异常状态,⚠原因未验证,建议单独排查。

---

## 5. 附录:实跑原始输出(Q7)

```
$ node bin/aw.mjs --help            [exit 0]
AgentWorkShop CLI v0.7.29 — 配置驱动 · 指令系统
用法:  aw <command> [options] [args]
项目根:  D:\codes\ABO\AgentWorkShop  ✓  (repo 模式:配置/数据在项目内)
  运行   build / dev / start
  配置   config / home
  诊断   doctor / status
  项目   init
  扩展   plugin
  指令   register
  服务   stop
  交互   tui
  其他   update / version
  全局参数  --help,-h  --version,-v  --json  --root <dir>  --debug
指令注册:    内建(随包) + 用户 ~/.agentworkshop/commands + 项目 .agentworkshop/commands（同名的后者覆盖前者）
```
(14 条指令;唯一异常是最后一行的大小写,见 P2-8。)

```
$ node bin/aw.mjs version          [exit 0]
agentworkshop 0.7.29
  node v24.19.0 · 项目: D:\codes\ABO\AgentWorkShop
  配置: config.yml < data/runtime-settings.json < env

$ node bin/aw.mjs version --json   [exit 0]
{"ok":true,"name":"agentworkshop","version":"0.7.29","node":"v24.19.0","project":"D:\\codes\\ABO\\AgentWorkShop"}
```

```
$ node bin/aw.mjs doctor           [exit 1]
AgentWorkShop doctor  — 环境与项目健康检查
  ✔ Node.js 版本             v24.19.0
  ✖ pnpm 可用                未找到 pnpm
  ✔ AW Home 目录             C:\Users\87287\.AgentWorkShop
  ✔ AW Home config.yml       C:\Users\87287\.AgentWorkShop\config.yml
  ✔ AW Home .env 密钥        已生成(含随机 session 密钥)
  ✖ Docker                 未安装(依赖容器编排不可用,可改配外部依赖)
  ✔ MQTT 连通                127.0.0.1:1883
  ✔ TimescaleDB 连通         127.0.0.1:5432
  ✔ 项目检测                 D:\codes\ABO\AgentWorkShop
  ✔ config.yml 可解析        98 个设置项
  ✖ 配置校验                 plugins.rag-bridge.token, plugins.diag-bridge.token, … (10 个键名,无原因)
  ✔ data/ 可写               D:\codes\ABO\AgentWorkShop\data        ← 非 ctx.dataDir(P2-11)
  ✔ 运行中服务                检测到 3001 端口 /api/system/config 响应
  ✔ 端口 3000               空闲
  ✖ 端口 3001               已被占用                                ← 与上一行自相矛盾(P2-11)
  ✔ 生产 session 密钥        已自定义（或由 env 提供）
  ✔ 生产构建存在              .output/server/index.mjs
  ✔ 指令注册                 14 条指令
发现 4 项异常
[stderr] (node:51628) [DEP0190] DeprecationWarning: Passing args to a child process with shell option true …
```
**未崩溃、无错误输出**;4 项异常中"配置校验"缺少原因、"端口 3001"是误报,`pnpm` 未安装与 `Docker` 未安装是环境实况。

退出码矩阵(全部实测):

| 命令 | 退出码 |
|---|---|
| `bin/aw.mjs --help` / `-v` / `--version` / `version` / `v` / `config get <已知键>` / `help <已注册指令>` / `echoargs -h` | 0 |
| `bin/aw.mjs`(无参数)/ `bogus` / `help bogus` / `config get <未知键>` / `--root <dir> <cmd>`(P1-1)/ `hello-audit`(AW_HOME 下,HTTP 前 P1-8) | 2 |
| `bin/aw.mjs dev`(只有 config.yml 的目录,P1-2)/ `build` 同目录 / `stop`(无法终止) | 1 |
| `cli/aw.mjs --help` / `version` / `config get …`(P1-3) | **13** |

---

## 6. 审计产物

- 报告:`docs/audit/audit-sdk-cli.md`(本文件)
- 实验脚本(可删):`scripts/_audit/probe-packlist.mjs`、`probe-envelope.mjs`、`probe-child.mjs`、`probe-routes.mjs`、`probe-routes2.mjs`、`probe.ts`/`probe2.ts`/`probe3.ts`/`probe4.ts` + `tsconfig.probe.json`、`proj/**`(指令解析靶场)、`hello.mjs`、`awhome/**`(AW_HOME 靶场)、`typecheck-out.txt`(全项目 typecheck 日志)
- 临时产物(仓库外,可删):`$TEMP\aw-init-audit`(脚手架)、`$TEMP\dsh-*\aw-audit-cfgonly`(根判定靶场)
