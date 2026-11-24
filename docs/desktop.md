# AgentWorkShop 桌面版（Windows x64）

桌面版使用 Electron 显示同一份 Nuxt 工作台，由随安装器提供的独立 Node.js 24 运行完整 Nitro 后端。桌面和 Web 共用 SSR、REST、WebSocket、SQLite、Agent/Channel/Project、插件和 AML 实现；不是静态网页壳，也不需要系统安装 Node。允许联网的功能仍需要各自的凭据和外部服务；真实产线使用需要现场验收，模拟结果不代表投产批准。

## 三种入口

- 桌面：运行 Windows NSIS 安装程序，从开始菜单启动。也可从 npm CLI 输入 `aw desktop`（默认安装路径可以自动发现，或用 `--executable <path>` 指定）。仅有 npm 包时，该命令使用可选的 Electron 依赖；第一次启动可能下载对应 Electron 二进制。
- Web：`aw web` 是 `aw start` 的别名。只在本机使用时可加 `--host 127.0.0.1`。npm 发行包要求机器上的 Node 符合 `package.json`。
- TUI：服务启动后用 `aw tui --url <baseUrl>`，或省略地址让 TUI 优先查看当前配置根的实例锁，再查看桌面数据目录（显式 `AW_HOME` 时只查询指定配置根）。若实例仍在启动，TUI 会有限等待，不会改连其他端口。没有运行中的本机实例时才尝试保存的连接或默认 Web 端口。TUI 是频道协作/监控客户端，不覆盖所有 Web 管理面板。

桌面默认与 Web/CLI 共用 `~/.AgentWorkShop`（`AW_DESKTOP_HOME` 或 `AW_HOME` 可重定向），配置、插件、SQLite、日志和 `aml/` 都落在这个目录，因此桌面和 Web 读写同一份数据。两者不能同时写同一个 home：先停止其中一个实例，再启动另一个；桌面检测到已有写入者会拒绝启动第二个。`electron/` 是 Chromium 的用户数据。桌面后端只监听 `127.0.0.1`；Electron 不向网页开放 Node 或特权 IPC。真正退出（托盘「退出」或关闭到托盘关闭后的关闭按钮）会先调后端优雅停机，再关闭桌面；默认的关闭按钮只隐藏窗口，后端继续运行。桌面会话密钥默认只在进程环境中存在，重启后浏览器可能需重新登录。需要持续会话时可通过私有环境提供 `NUXT_SESSION_PASSWORD`。

## 桌面外观与品牌

桌面窗口使用无边框 `BrowserWindow`：顶部 40px 是随应用分发的标题栏文档（`desktop/chrome/titlebar.html`），下方内容区是独立 `WebContentsView`，加载与 Web 端完全相同的 Nitro 页面，不做 DOM 注入或布局改写。标题栏提供窗口级服务状态、更新入口和自绘的最小化/最大化/关闭按钮；当下方 Web 壳已有可见品牌区时，标题栏自动收起重复字标，窄屏抽屉或无品牌页才保留简洁备用标识。窗口按钮经 `desktop/chrome/preload.cjs` 的白名单 IPC 触达主进程。标题栏跟随应用的 `html.dark` 主题切换，在亮色下使用暖纸白，在暗色下使用深海军蓝与信号绿。

品牌母版是 `desktop/brand/mark.svg`（门架 A 字标，单一剪影、无渐变）、`badge.svg`（512 应用铭牌：深墨底 + 3px 内缘线）与 `tray-dark.svg` / `tray-light.svg`（托盘裸字标，深色任务栏用信号绿、浅色任务栏用深玉绿）。二进制图标不手工导出：`pnpm brand:desktop`（`scripts/desktop-brand.mjs`）用本机 Chrome 按目标尺寸光栅化 SVG，并封装 `desktop/build/icon.ico`（16–64 BMP、128/256 PNG，共 9 个条目）、`icon.png`、两个 32px 托盘图与 Web 端 `public/icon-180.png` / `icon-512.png`。托盘图标随 `nativeTheme` 切换；改字形只需改 SVG 再重跑该脚本。侧栏、标题栏、启动页、favicon 与 docs 站 favicon 共用同一条 `d`。设计研究、方向记录与启动动画关键帧见 `docs/design/desktop-chrome/brand-spec.md`、`direction-approved.md` 与 `*-20261124.png`。

标题栏与桌面入口回归测试：`node --import tsx --test tests/desktop-chrome.test.ts tests/desktop-tray-splash.test.ts tests/desktop-terminal-entry.test.ts`。

## 托盘、设置与启动动画

桌面默认把标题栏的关闭按钮理解为「关闭到托盘」：窗口隐藏，Electron 主进程、本机 Nitro 服务、SQLite、Channel/Session 与正在执行的任务都继续运行。单击或双击托盘图标恢复窗口；需要真正退出时用托盘菜单的「退出 AgentWorkShop」，或在托盘「设置」中关闭「关闭时最小化到托盘」，此后关闭按钮直接退出并优雅停止后端。第二次启动可执行文件不会启动第二套后端，而是把已有窗口恢复并聚焦（单实例锁）。

托盘菜单包含：本机服务状态与 `127.0.0.1:<port>`、重新加载界面、重启本地服务（先确认）、检查更新、打开数据目录、打开日志目录、诊断信息，以及「设置」子菜单。设置均为持久化开关，保存在 `<home>/electron/settings.json`：

| 设置 | 默认 | 作用 |
| --- | --- | --- |
| 关闭时最小化到托盘 | 开 | 关闭按钮隐藏窗口而不是退出 |
| 开机自动启动 | 关 | 安装版写入 Windows 登录项；源码模式不写系统 |
| 启动后最小化到托盘 | 关 | 后端就绪后不显示主窗口，留在托盘 |
| 托盘通知 | 开 | 隐藏、重启服务、设置变更等提示 |
| 自动检查更新 | 开 | 启动后及运行期间检查版本，只提示，不下载、不安装；手动检查不受影响 |
| 更新网络 | 跟随系统代理 | 仅供桌面更新器使用，可切换为手动代理或直连；不会修改系统、Web 或本机服务的网络设置 |

启动时 Electron 立即创建托盘并显示 660×440 的无边框初始化窗口（`desktop/chrome/splash.html`），按真实阶段展示：准备运行环境 → 初始化工作区 → 启动本机服务 → 装配智能体工作台 → 就绪。启动页是一段一次性的通电序列：扫描线掠过、绿色细线把 A 字标描出来再交给实心字、品牌横线变成四站启动轨（每个站点落在该阶段的真实进度上）；窗口同时显示带时间戳的启动记录、实时耗时与进度；装配阶段沿字形再复检一次。只有 `/api/health` 返回 `status=ok` 且 `workshop=ready`、并且主页面加载完成后才显示主窗口。最小展示时间为 2 秒，避免界面闪烁；失败时显示错误、日志路径与「重试 / 打开日志 / 退出」，不会静默退出。等待期间没有循环动效；动画支持 `prefers-reduced-motion`（保留全部状态、去掉位移与描边），文档 CSP 为 `default-src 'none'` 且只使用内联本地资源。

主进程会把 `phase`、`bootStage`、`port`、`trayCreated`、`windowVisible`、设置与 `lastError` 写入 `<home>/electron/desktop-status.json`，便于诊断与验收；「诊断信息」对话框展示同一组状态并提供数据/日志目录入口。`AW_DESKTOP_TEST_AUTOQUIT_MS` 与 `AW_DESKTOP_TEST_TRAY_MENU_MS` 仅用于自动化验收。

## 更新通道

从桌面标题栏或托盘打开「桌面设置与更新」。更新网络和自动检查偏好保存在 `<home>/electron/settings.json`，不出现在 Web 设置中。默认**跟随系统代理**：更新器使用独立的 Electron 网络会话，按 Windows 代理及 PAC 规则访问 GitHub；如果 PAC 对某个地址返回 `DIRECT`，系统会直连。也可选择**手动代理**，填写无凭据的 HTTP、HTTPS 或 SOCKS5 地址与端口；密码不由应用保存或代填。切换到「直连」后不使用系统代理。应用不会在代理报错时自行切换线路。用「测试连接」检查线路；该操作验证更新端点，不下载整个安装包。速度取决于代理、CDN 和本地网络。

更新分三步：**检查更新 → 下载 → 重启并安装**。自动检查只发现并提示新版本，关闭后仍可手动检查。下载显示已传输量、可用时的总量、速率和剩余时间。可以暂停、继续或取消；短暂网络错误会有限重试。若服务器不提供可验证的断点续传，继续时会重新下载。更新器只管理 `<home>/electron/updates/` 内自己的缓存；应用重开后可通过检查更新找回可恢复的下载，不会自行继续。下载完毕后必须通过对应版本的 `SHA256SUMS.txt` 完整校验，才显示「重启并安装」。

下载结束、关闭窗口、退出应用或在确认框选择默认项「稍后」，都不会运行安装器。只有明确确认才会停止本机服务；在跑的作业可能受影响，请先保存工作。服务未确认停止时不启动安装。安装使用内置 WSH 助手；它等待旧桌面进程退出，才运行 NSIS `/S`，安装成功才启动新版。失败时可重新打开应用查看状态，也可手动运行发布页的安装器。

更新目标限固定仓库和 `api.github.com`、`github.com`、`objects.githubusercontent.com`、`release-assets.githubusercontent.com` 四个 HTTPS 主机：每一跳都校验端口、主机和公网 DNS，拒绝 URL 内凭据。直连固定到已验证的公网地址；系统代理可在代理端解析域名，这部分依赖系统配置的代理。更新器不会使用 Web 会话凭据。安装包当前未签名，信任基础是 HTTPS、固定仓库及发布校验文件；SHA-256 不是独立的发布者签名。`AW_UPDATE_CHECK=0` 可停用定时检查，`AW_UPDATE_TEST_VERSION` 仅在源码模式可用。

发布 release 时需上传安装器 `AgentWorkShop-Setup-<version>-win-x64.exe`、`SHA256SUMS.txt` 和 npm tarball。

## AML 运行环境

Node/TypeScript 负责数据集、作业与评估调度、门禁和模型注册；随包分发的 `amlkit.py`、参考训练器、`aml_eval.py` 和求解进程 `worker.py` 都是直接编写的 Python 文件。Node 可以将用户提交的 Python 训练代码写成作业的 `train.py`，但不把训练逻辑转译成 Python。内置线性/静态辨识训练器用 TypeScript 实现。ONNX 预测由平台的原生 ONNX Runtime 执行。

在 `/aml` 的「运行环境」中安装官方固定版本 uv 或选择已有解释器，再创建 `.venv`。有 uv 时，平台以 uv 供给 Python（需要时）、建 venv 并安装 wheel；训练、复评和 Optimizer 随后运行该 venv 的解释器，不要求在终端手动激活。未配置包索引时使用 PyPI，自定义 HTTPS 索引须由部署方在 `AML_PYTHON_INDEX_ALLOWLIST` 显式列出。uv 安装资产有逐跳公网校验和完整性校验；uv/pip 自身的后续连接仍由它们管理。训练进程的环境变量受限，但不等于 OS 级文件或网络沙箱，不能运行不可信训练代码。

标准安装包提供 AML 功能和 Python 资产，不内置 PyTorch、CPython wheel 或用户模型。首次供给需要可用网络或由运维预先准备环境。离线 Python 依赖包和其它平台安装器不在 Windows 基础安装器的交付范围内。

## 本地构建安装器

用 Windows x64 和受信任的独立 Node.js 24 x64（同时准备其 `LICENSE`），在干净检出中先执行生产构建，然后把压缩包装入空的全局前缀。示例使用 PowerShell，输出路径按本机调整：

```powershell
pnpm install --frozen-lockfile
pnpm build
npm pack --ignore-scripts --pack-destination D:\aw-artifacts
npm install -g --ignore-scripts --prefix D:\aw-artifacts\prefix D:\aw-artifacts\agentworkshop-0.19.0.tgz
npm --prefix desktop ci
npm --prefix desktop run build -- --backend D:\aw-artifacts\prefix\node_modules\agentworkshop --out D:\aw-artifacts\desktop
```

没有随 Node 可执行文件存放的许可证时用 `--node-license` 指定；必要时用 `--node-bin` 指定同平台独立 Node。`--out` 必须是新目录。没有签名配置时所得安装器是未签名的本地候选，不代表公共发布。升级前备份桌面数据目录；第三方插件只安装可信代码。
