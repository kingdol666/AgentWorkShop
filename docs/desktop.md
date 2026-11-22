# AgentWorkShop 桌面版（Windows x64）

桌面版使用 Electron 显示同一份 Nuxt 工作台，由随安装器提供的独立 Node.js 24 运行完整 Nitro 后端。桌面和 Web 共用 SSR、REST、WebSocket、SQLite、Agent/Channel/Project、插件和 AML 实现；不是静态网页壳，也不需要系统安装 Node。允许联网的功能仍需要各自的凭据和外部服务；真实产线使用需要现场验收，模拟结果不代表投产批准。

## 三种入口

- 桌面：运行 Windows NSIS 安装程序，从开始菜单启动。也可从 npm CLI 输入 `aw desktop`（默认安装路径可以自动发现，或用 `--executable <path>` 指定）。仅有 npm 包时，该命令使用可选的 Electron 依赖；第一次启动可能下载对应 Electron 二进制。
- Web：`aw web` 是 `aw start` 的别名。只在本机使用时可加 `--host 127.0.0.1`。npm 发行包要求机器上的 Node 符合 `package.json`。
- TUI：服务启动后用 `aw tui --url <baseUrl>`，或省略地址让 TUI 优先查看当前配置根的实例锁，再查看桌面数据目录（显式 `AW_HOME` 时只查询指定配置根）。若实例仍在启动，TUI 会有限等待，不会改连其他端口。没有运行中的本机实例时才尝试保存的连接或默认 Web 端口。TUI 是频道协作/监控客户端，不覆盖所有 Web 管理面板。

桌面默认与 Web/CLI 共用 `~/.AgentWorkShop`（`AW_DESKTOP_HOME` 或 `AW_HOME` 可重定向），配置、插件、SQLite、日志和 `aml/` 都落在这个目录，因此桌面和 Web 读写同一份数据。两者不能同时写同一个 home：先停止其中一个实例，再启动另一个；桌面检测到已有写入者会拒绝启动第二个。`electron/` 是 Chromium 的用户数据。桌面后端只监听 `127.0.0.1`；Electron 不向网页开放 Node 或特权 IPC。退出先调后端优雅停机，再关闭桌面。桌面会话密钥默认只在进程环境中存在，重启后浏览器可能需重新登录。需要持续会话时可通过私有环境提供 `NUXT_SESSION_PASSWORD`。

## 桌面外观与品牌

桌面窗口使用无边框 `BrowserWindow`：顶部 40px 是随应用分发的标题栏文档（`desktop/chrome/titlebar.html`），下方内容区是独立 `WebContentsView`，加载与 Web 端完全相同的 Nitro 页面，不做 DOM 注入或布局改写。标题栏提供品牌标识、当前页面标题、本机服务状态和自绘的最小化/最大化/关闭按钮；窗口按钮经 `desktop/chrome/preload.cjs` 的白名单 IPC 触达主进程。标题栏跟随应用的 `html.dark` 主题切换，在亮色下使用暖纸白，在暗色下使用深海军蓝与信号绿。

品牌图标源文件是 `desktop/brand/icon.svg`（绿/青「A + 信号总线」标记）；`desktop/build/icon.png` 与 `desktop/build/icon.ico` 由它生成，供安装器、可执行文件和标题栏共用。设计原型与状态板见 `docs/design/desktop-chrome/prototype.html`（截图 `prototype.png`）。图标是从 SVG 渲染的 512px 圆角方形（四角透明），改动图标时同时更新 PNG/ICO。

标题栏与桌面入口回归测试：`node --import tsx --test tests/desktop-chrome.test.ts tests/desktop-terminal-entry.test.ts`。

## 更新通道

桌面版启动 4 秒后检查 GitHub Releases 最新版本，此后每 30 分钟检查一次；发现比当前版本更新的 release 时，标题栏出现「更新 vX.Y.Z」。点击后把安装包下载到系统临时目录，并用 release 附带的 `SHA256SUMS.txt` 校验 SHA-256；再次确认后退出应用、静默运行 NSIS 安装包并重启。安装/重启由一个独立的无控制台 WSH 助手（`wscript.exe` + 固定 VBS，路径经环境变量传入）执行：应用先退出以释放被占用的文件，助手等待 6 秒后以 `/S` 安装并重新启动当前安装目录中的可执行文件。不使用 `cmd.exe` 命令串（引号会被 Node 转义破坏），也不使用 PowerShell（以 `DETACHED_PROCESS` 启动时立即退出）。`AW_UPDATE_AUTOINSTALL=1` 只用于验收测试，跳过确认对话框。下载只允许 `api.github.com`、`github.com`、`objects.githubusercontent.com`、`release-assets.githubusercontent.com` 四个 HTTPS 主机，逐跳校验重定向、拒绝凭据/非常规端口/非公网 DNS，校验失败不会执行安装包。`AW_UPDATE_CHECK=0` 可关闭检查；`AW_UPDATE_TEST_VERSION` 只用于验收测试。安装包当前未签名，信任锚是 HTTPS + 固定仓库 + SHA-256，不是 Authenticode。

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
npm install -g --ignore-scripts --prefix D:\aw-artifacts\prefix D:\aw-artifacts\agentworkshop-0.17.4.tgz
npm --prefix desktop ci
npm --prefix desktop run build -- --backend D:\aw-artifacts\prefix\node_modules\agentworkshop --out D:\aw-artifacts\desktop
```

没有随 Node 可执行文件存放的许可证时用 `--node-license` 指定；必要时用 `--node-bin` 指定同平台独立 Node。`--out` 必须是新目录。没有签名配置时所得安装器是未签名的本地候选，不代表公共发布。升级前备份桌面数据目录；第三方插件只安装可信代码。
