---
title: AgentWorkShop 产品演示
description: AgentWorkShop 核心功能实机界面演示，含英文配音、英文字幕与中文字幕。
---

# AgentWorkShop 产品演示

<video controls preload="metadata" poster="/demo/agentworkshop-core-demo-poster.png" style="display:block;width:100%;aspect-ratio:16/9;background:#000">
  <source src="/demo/agentworkshop-core-demo.mp4" type="video/mp4">
  <track kind="captions" label="English" srclang="en" src="/AgentWorkShop/demo/agentworkshop-core-demo.en.vtt" default>
  <track kind="captions" label="简体中文" srclang="zh-Hans" src="/AgentWorkShop/demo/agentworkshop-core-demo.zh-Hans.vtt">
</video>

[下载 MP4](/demo/agentworkshop-core-demo.mp4) · [英文字幕](/demo/agentworkshop-core-demo.en.vtt) · [中文字幕](/demo/agentworkshop-core-demo.zh-Hans.vtt) · [独立配音](/demo/agentworkshop-core-demo-voiceover.mp3)

## 演示内容

视频依次展示控制室仪表盘、实时遥测、EDA 分析管道（导入→代码后处理→图表→模板）、受治理的产线操作、已发布的本体模型、Agent 工作台、插件装载面、分析结果台账与 EDA 图库。解说为英语；播放器支持切换英文与简体中文字幕。

本演示运行在隔离的本地环境：控制节点绑定 Mock 设备驱动，遥测由录制期采样器按 1 秒节拍回放，产线写入流程以受治理路径的只读界面呈现。未连接真实 PLC，也没有向真实设备发送控制写入。画面用于说明产品界面与工作流，不代表现场运行结果。

旁白由 Edge 神经语音（`en-US-AndrewNeural`，-4% 语速）生成，汉英字幕为逐句人工校对；素材为真实实机录屏（CDP screencast，1920×1080，浅色主题）。亦可在[独立播放页](/demo/player.html)打开。

