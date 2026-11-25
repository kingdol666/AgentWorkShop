---
title: AgentWorkShop 产品演示
description: AgentWorkShop 0.20.1 的 90 秒系统片与 3 分钟核心演示，含真实桌面作业、分镜索引与真实性边界。
---

# AgentWorkShop 产品演示

## 2026-11 版：90 秒系统片（真实 0.20.1 桌面作业）

<video controls preload="metadata" :poster="'/AgentWorkShop/demo/agentworkshop-0.20.1-promo-poster.jpg'" style="display:block;width:100%;aspect-ratio:16/9;background:#000">
  <source :src="'/AgentWorkShop/demo/agentworkshop-0.20.1-promo.mp4'" type="video/mp4">
</video>

**外链与下载**：[直接下载 MP4](/AgentWorkShop/demo/agentworkshop-0.20.1-promo.mp4) ·
[静态海报](/AgentWorkShop/demo/agentworkshop-0.20.1-promo-poster.jpg) ·
[README 入口](https://github.com/kingdol666/AgentWorkShop#watch-the-90-second-film)

**成片规格**：87.70 秒 · 1920×1080 @30fps · H.264 High@4.1 + AAC 48k · 约 15.7 MB（faststart）·
中文烧录字幕 · 无配音（字幕驱动）· 19 镜，7 处叠化/压黑/擦除 + 12 处硬切。

**分镜索引**：

| 时间 | 段落 | 内容 |
|---|---|---|
| 00:00 | 片头 | AI 团队，不只对话；读产线 · 写参数 · 交证据 |
| 00:07 | 一套代码 | 真实启动页；`aw desktop` / `aw web` 两个入口、同一份 `~/.AgentWorkShop`、单写者锁 |
| 00:13 | 更新治理 | 0.20.1 更新中心：明确同意、三条线路、SHA-256 校验（非发布者签名） |
| 00:20 | Agent 团队 | 频道即工位、14 个执行引擎 |
| 00:29 | 数字孪生 | 产线在同一频道里；真实任务列表、状态时间线与交付物 |
| 00:46 | 产业闭环 | 传感器 → 证据链；写控拒绝也是证据 |
| 00:57 | 统计口径 | 67 分钟 / 270 个 15 秒桶 / 185.048℃ / 偏差 +0.048℃ |
| 01:06 | 治理与版本 | 0.20.1、回归数字、失败如何变成可读状态 |
| 01:19 | 收尾 | 品牌、GitHub / 文档 / npm 入口、合规脚注 |

**真实性边界**：画面来自真实 0.20.1 桌面实例（隔离 home、演练产线 `ln-cca0c356`，`simulated=true`）。
任务 `0c3e927d` 的 `daq_query` / `daq_export` 与统计为真实工具调用，交付物 `review-report.md` 5,153 字节；
同轮 lead 任务 `6ba58e33` 在工具目录遍历后停滞并被取消，保留在任务板，片内不展示其特写。
有效数据只有 2026-11-25 13:54:11–15:01:23 约 67 分钟，片内不写成 7 天连续趋势。
**模拟证据不等于物理 HIL 或投产批准**；Mimosa 审计 `partial / inconclusive`，不作安全背书；安装包未签名，SHA-256 不是发布者签名。

## 2026-10 版：3 分钟核心演示（英文界面 / 英中字幕）

<video controls preload="metadata" :poster="'/AgentWorkShop/demo/agentworkshop-core-demo-poster.png'" style="display:block;width:100%;aspect-ratio:16/9;background:#000">
  <source :src="'/AgentWorkShop/demo/agentworkshop-core-demo.mp4'" type="video/mp4">
  <track kind="captions" label="English" srclang="en" :src="'/AgentWorkShop/demo/agentworkshop-core-demo.en.vtt'" default>
  <track kind="captions" label="简体中文" srclang="zh-Hans" :src="'/AgentWorkShop/demo/agentworkshop-core-demo.zh-Hans.vtt'">
</video>

**外链与下载**(不依赖本页,可直接分享):

[独立播放页](https://kingdol666.github.io/AgentWorkShop/demo/player.html) ·
[直接下载 MP4](https://kingdol666.github.io/AgentWorkShop/demo/agentworkshop-core-demo.mp4) ·
[英文字幕 VTT](/AgentWorkShop/demo/agentworkshop-core-demo.en.vtt) ·
[中文字幕 VTT](/AgentWorkShop/demo/agentworkshop-core-demo.zh-Hans.vtt) ·
[独立配音 MP3](/AgentWorkShop/demo/agentworkshop-core-demo-voiceover.mp3)

**成片规格**:3 分 00 秒 · 1920×1080 @30fps · H.264 + AAC(约 13 MB,faststart) ·
英文旁白(Edge 神经语音 `en-US-AndrewNeural`,−4% 语速) · 英/中双字幕 · 11 幕 0.5 s 叠化转场。

### 2026-10 版演示内容（11 幕）

1. **标题卡** —— AgentWorkShop · Industrial Agent Runtime;
2. **控制室仪表盘** —— 实时趋势与产线总览;
3. **DAQ 实时遥测** —— 6 个数采节点全英文台账,1 Hz 遥测流入;
4. **EDA 分析管道** —— CSV 导入 40 行 → 代码过滤 35 行 → 配置 → 图表 → 在线查看器 → 存模板;
5. **受治理工具目录** —— 125 个工具的角色/可用性检索,写族全部声明引用校验;
6. **已发布本体** —— 概览 / 实体 / 规则 / 绑定 / 版本 / 编译预览六 tab;
7. **Agent 工作区 ×4** —— 多引擎团队频道与作业流;
8. **插件面** —— 11 个已装载插件;
9. **分析台账详情** —— 受治理写入核验(提议 → 审批 → 回读留痕);
10. **EDA 工坊** —— 散点图看板;
11. **结尾卡**。

想深入某一幕,对应指南:[数据管理台与 EDA 工坊](/guide/eda) ·
[本体与 AI 先行模型闭环](/guide/ontology) · [HITL 人机协同审批](/guide/hitl) ·
[六协议数采与数控](/guide/daq-protocols)。

### 2026-10 版真实性边界

本演示运行在隔离的本地环境:产线与控制节点绑定 Mock 设备驱动,遥测由 Mock DAQ 驱动按 1 秒节拍生成;
分析报告与本体为演示用种子数据,用于展示界面与工作流。**未连接真实 PLC,也没有向真实设备发送控制写入。**
画面不代表现场运行结果。

素材为真实实机录屏(CDP screencast,1920×1080,浅色主题、英文界面),非合成 UI;
旁白由 Edge 神经语音生成,汉英字幕按句校对。制作过程与逐幕证据见
`docs/audit/evidence/2026-10-26-demo-video/report.md`。

## 历史版本

- [agentworkshop-demo.mp4(2026-09 版,约 2 分钟)](/AgentWorkShop/demo/agentworkshop-demo.mp4) ——
  早期章节化运镜版本,已被上面的 3 分钟英文界面版取代,仅作归档保留。
