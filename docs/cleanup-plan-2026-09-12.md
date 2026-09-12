# 冗余清理清单（2026-09-12 盘点，待确认后执行）

> 原则：宁可少删漏删，不可误删。以下全部条目**未执行**，等用户逐项确认。
> 背景：并行会话已在 7627e7e 清理过一轮（300.6 MB / 650 项），本清单是之后仍存的冗余。
> 磁盘：D 盘 1.9T 总量，已用 1.6T，**剩 229G**（清理前已确认）。

## A. 高价值（建议清理，收益大）

| # | 路径 | 体积 | 理由 | 影响面 |
|---|---|---|---|---|
| A1 | `<repo>/data/tmp/` | **506 MB**（15,255 个文件，仅 17 个是近 7 天） | agent 跑批的临时脚本残骸（`_deliver_*.mjs`、`_verify*.cjs` 等），全部可再生成 | 无；建议按龄删（>7 天） |
| A2 | `<repo>/data/backups/` | **160 MB** | 2026-08-25~09-04 的 sqlite `.bak`（daq-timeseries/users），保留策略之外的陈旧备份 | 无（当前热备在 `.AgentWorkShop/data/backups`） |
| A3 | `scripts/.mimosa/` | 534 KB（39+ 文件） | 安全钩子会话状态；**已渗入 npm pack 本地产物**（registry 包里没有） | 删后会自动重建；另建议加 `scripts/.npmignore`（内容 `.mimosa`）防再渗入 |
| A4 | `<repo>/data/` 根下的陈旧构建/走查日志与图片 | ~6 MB | `build-*.log`（19 个）、`apng-test.png`、`strip.png`(4.8M)、`gif-frames/`、`dev-server-ui-polish.log` 等 | 无（历史走查产物） |

## B. 视需要（默认保留，列出备查）

| # | 路径 | 体积 | 说明 |
|---|---|---|---|
| B1 | `.e2e-shots/` | 3.6 MB | 截图产物，可随时重生成；本轮验收还要用，建议测试收官后再删 |
| B2 | `bench/` | 36 KB | 微基准脚本，体积可忽略 |
| B3 | `.omo/` | 9 KB | 工具状态，极小 |
| B4 | `exec-cli.rs` | 9.8 KB | 孤立 Rust 试验文件（codex_protocol 实验），与仓库技术栈无关；确认无用可删 |
| B5 | `<repo>/data/workspaces/`（722 个频道工作区目录） | 42 MB | **不可全删**：`runtime/manager.ts:1183` 仍以 `cwd/data/workspaces` 为活动工作区根；只能删「频道已不存在」的孤儿目录（需逐个比对 workshop.sqlite） |

## C. 结构性发现（不动文件，提请决策）

| # | 发现 | 建议 |
|---|---|---|
| C1 | agent 工作区根在 `process.cwd()/data/workspaces`，绕过了「单一数据根 `.AgentWorkShop/data`」原则（test-data-root 套件未覆盖此路径） | 后续把 workspaceRoot 收编进配置根解析 |
| C2 | `.AgentWorkShop/data` 之外，`docs/site/node_modules`(97M)/`.nuxt`(10M)/`.output`(63M)/`node_modules`(1.2G) 均为可再生成构建产物 | 保留（磁盘尚充裕），不列入清理 |

## 不碰清单（明确保护）

`paper/`、`paper-show/`（用户论文交付物）、`.omc/`（计划文档）、`.AgentWorkShop/`（运行时数据根）、`docs/`、`scripts/_audit/detached-start.mjs`（并行会话新工具）。

## 执行后验证（确认后我会做）

`npm run build` → Phase 1 静态回归五连（data-root/rollback/configroot/plugin-lifecycle/sdk-surface）→ api-live 64 项抽样 → 对比清理前后 assertion 数一致。
