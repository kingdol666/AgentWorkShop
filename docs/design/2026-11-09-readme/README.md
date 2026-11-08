# README / VitePress 重设计（2026-11-09）

> 目标：把 README（中/英）与文档站首页从“功能清单”推进到**可扫读、可展示、可复验**的开源项目首页。
> 视觉方向：**Control Room × Quiet Harness** —— 深色工业铭牌负责品牌，浅色 Harness 实拍负责产品；
> 发丝线、等宽读数、单一暖橙/绿色强调，不用渐变洗底与装饰性 emoji。

## 1. 设计画布

画布目录：`docs/design/2026-11-09-readme/canvas/`

```bash
node "$HOME/.zcode/skills/claude-design/scripts/artifact.mjs" open \
  "docs/design/2026-11-09-readme/canvas"
```

| 画板 | 内容 | 截图 |
|---|---|---|
| `Main.dc.html` | README 首屏：品牌 / 主张 / 徽章 / CTA / 四个数字 + 新版 Channel 控制台观察窗 | [`canvas-shots/01-readme-hero.png`](canvas-shots/01-readme-hero.png) |
| `Sections.dc.html` | README 正文：release notes 三卡 / 能力表 / 快速开始 / 验收数字带 | [`canvas-shots/02-readme-sections.png`](canvas-shots/02-readme-sections.png) |
| `DocsHome.dc.html` | VitePress 首页：hero / 本月新增 / 起步三卡 / 指南网格 | [`canvas-shots/03-vitepress-home.png`](canvas-shots/03-vitepress-home.png) |

画布只做原型，不参与生产构建；`canvas/project/*.dc.html` 是设计源文件。

## 2. 落地范围

### README

- `README.md` / `README-zh.md` 重写：新增 **What's new in 0.10.0**（Harness UI / Channel 多会话 / Project 交付）、
  **Agent 团队模型**（Channel / Session / Agent / Project / Attempt / Deliverable）、更新能力表与验收矩阵；
- 首屏 hero 重出图：`docs/readme-assets/hero.png`（1300×560 @2x），窗内是 2026-11 新版 Channel 控制台实拍；
- 新增截图：`docs/readme-assets/harness-channel.png` / `harness-project.png` / `harness-projects-list.png`；
- 版本号与口径统一到 **v0.10.0**（14 引擎 / 6 协议 / 126 宿主工具 / 143 运行时设置 / 1253 单测）。

### VitePress

- 新增三篇双语指南：
  - [`docs/site/guide/harness-ui.md`](../../site/guide/harness-ui.md) / [`en`](../../site/en/guide/harness-ui.md)
  - [`docs/site/guide/channels-sessions.md`](../../site/guide/channels-sessions.md) / [`en`](../../site/en/guide/channels-sessions.md)
  - [`docs/site/guide/projects.md`](../../site/guide/projects.md) / [`en`](../../site/en/guide/projects.md)
- 首页新增 `00 / 本月新增` 区块与三张能力卡；侧栏/顶栏加入 Project 入口；
- 文档截图入库到 `docs/site/public/harness-ui/`；
- 版本历史补充 v0.10.0 节点。

## 3. 设计决策

1. **双表面**：README 首屏维持深色控制室气质（与既有 hero、论文/产线叙事一致），
   观察窗里换成新版浅色 Harness 控制台——一眼看出“工业外壳 + ChatGPT 级会话”。
2. **数字带**：首屏只保留 14 / 6 / 4 / 1253 四个可数事实，避免徽章堆叠；
   详细验收数字放到正文“Verification”，并给出证据路径。
3. **release notes 三卡**：每张卡一个结构变化，配一个极简示意图；
   不用花哨插画，保证 GitHub 明暗主题下都可读。
4. **文档站**：沿用既有 `hw-*` 组件族，不引入新样式；新增区块只用现有类，避免主题漂移。
5. **不删旧内容**：历史套件、论文、插件/扩展、部署/开发全部保留，只重排层级与口径。

## 4. 验证

- 画布 `artifact.mjs check`：`problems: 0`；
- `npm run readme:lint`：README.md / README-zh.md 全部通过（标签配平、图片/链接存在、表格列数一致）；
- `docs:build`（VitePress 1.6.4）：build complete，`ignoreDeadLinks: false` 下零死链；
- 新增页面在构建产物中可访问：`dist/guide/{harness-ui,channels-sessions,projects}.html`，图片带 `/AgentWorkShop/` base；
- 实机 UI 截图来自 `docs/design/2026-11-08-harness-ui/after/`（真实运行实例，非渲染稿）。
