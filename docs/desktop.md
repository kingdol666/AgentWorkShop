# AgentWorkShop 桌面版（Windows x64）

桌面版使用 Electron 显示同一份 Nuxt 工作台，由随安装器提供的独立 Node.js 24 运行完整 Nitro 后端。桌面和 Web 共用 SSR、REST、WebSocket、SQLite、Agent/Channel/Project、插件和 AML 实现；不是静态网页壳，也不需要系统安装 Node。允许联网的功能仍需要各自的凭据和外部服务；真实产线使用需要现场验收，模拟结果不代表投产批准。

## 三种入口

- 桌面：运行 Windows NSIS 安装程序，从开始菜单启动。也可从 npm CLI 输入 `aw desktop`（默认安装路径可以自动发现，或用 `--executable <path>` 指定）。仅有 npm 包时，该命令使用可选的 Electron 依赖；第一次启动可能下载对应 Electron 二进制。
- Web：`aw web` 是 `aw start` 的别名。只在本机使用时可加 `--host 127.0.0.1`。npm 发行包要求机器上的 Node 符合 `package.json`。
- TUI：服务启动后用 `aw tui --url <baseUrl>`。未指定地址时优先使用保存的连接，或从当前配置根的实例锁发现端口。桌面实例地址可在桌面数据目录的 `.runtime/aw.lock` 中找到。TUI 是频道协作/监控客户端，不覆盖所有 Web 管理面板。

桌面默认用独立的 `~/.AgentWorkShop-desktop`（`AW_DESKTOP_HOME` 可重定向），其中的配置、插件、SQLite、日志和 `aml/` 不属于安装目录。`electron/` 是 Chromium 的用户数据。桌面后端只监听 `127.0.0.1`；Electron 不向网页开放 Node 或特权 IPC。退出先调后端优雅停机，再关闭桌面。桌面会话密钥默认只在进程环境中存在，重启后浏览器可能需重新登录。需要持续会话时可通过私有环境提供 `NUXT_SESSION_PASSWORD`。

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
npm install -g --ignore-scripts --prefix D:\aw-artifacts\prefix D:\aw-artifacts\agentworkshop-0.16.0.tgz
npm --prefix desktop ci
npm --prefix desktop run build -- --backend D:\aw-artifacts\prefix\node_modules\agentworkshop --out D:\aw-artifacts\desktop
```

没有随 Node 可执行文件存放的许可证时用 `--node-license` 指定；必要时用 `--node-bin` 指定同平台独立 Node。`--out` 必须是新目录。没有签名配置时所得安装器是未签名的本地候选，不代表公共发布。升级前备份桌面数据目录；第三方插件只安装可信代码。
