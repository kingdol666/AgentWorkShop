---
title: AgentWorkShop 产品演示
description: AgentWorkShop 核心功能实机界面演示，含英文配音、英文字幕与中文字幕。
---

# AgentWorkShop 产品演示

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

## 演示内容(11 幕)

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

## 真实性边界

本演示运行在隔离的本地环境:产线与控制节点绑定 Mock 设备驱动,遥测由 Mock DAQ 驱动按 1 秒节拍生成;
分析报告与本体为演示用种子数据,用于展示界面与工作流。**未连接真实 PLC,也没有向真实设备发送控制写入。**
画面不代表现场运行结果。

素材为真实实机录屏(CDP screencast,1920×1080,浅色主题、英文界面),非合成 UI;
旁白由 Edge 神经语音生成,汉英字幕按句校对。制作过程与逐幕证据见
`docs/audit/evidence/2026-10-26-demo-video/report.md`。

## 历史版本

- [agentworkshop-demo.mp4(2026-09 版,约 2 分钟)](/AgentWorkShop/demo/agentworkshop-demo.mp4) ——
  早期章节化运镜版本,已被上面的 3 分钟英文界面版取代,仅作归档保留。
