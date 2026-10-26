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

[下载 MP4](/AgentWorkShop/demo/agentworkshop-core-demo.mp4) · [英文字幕](/AgentWorkShop/demo/agentworkshop-core-demo.en.vtt) · [中文字幕](/AgentWorkShop/demo/agentworkshop-core-demo.zh-Hans.vtt) · [独立配音](/AgentWorkShop/demo/agentworkshop-core-demo-voiceover.mp3)

## 演示内容

视频以英文界面展示：控制室仪表盘、实时遥测、EDA 分析管道（导入→代码后处理→图表→模板）、受治理的工具目录、已发布的本体模型、四个 Agent 工作区、插件装载面、分析结果台账与 EDA 工坊。解说为英语；播放器支持切换英文与简体中文字幕。

本演示运行在隔离的本地环境：产线与控制节点绑定 Mock 设备驱动，遥测由 Mock DAQ 驱动按 1 秒节拍生成；分析报告与本体为演示用种子数据，用于展示界面与工作流。未连接真实 PLC，也没有向真实设备发送控制写入。画面不代表现场运行结果。

旁白由 Edge 神经语音（`en-US-AndrewNeural`，-4% 语速）生成，汉英字幕按句校对；素材为真实实机录屏（CDP screencast，1920×1080，浅色主题、英文界面）。亦可在[独立播放页](https://kingdol666.github.io/AgentWorkShop/demo/player.html)打开。

