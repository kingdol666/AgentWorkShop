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

视频依次展示仪表盘、频道模板、三角色 Agent 团队控制台、产线管理，以及演示产线的节点/产品/配方数量和待机状态。解说为英语；播放器支持切换英文与简体中文字幕。

本演示运行在隔离的本地环境，控制节点绑定 Mock PLC 模拟器，产线保持停止。未连接真实 PLC，也没有发送控制写入。画面用于说明产品界面和配置流程，不代表现场运行结果。

旁白由 Kokoro `af_bella` 以本地 ONNX 推理生成。脚本、时间轴、逐屏截图与论文图注位于 [`docs/video/agentworkshop-core-demo`](https://github.com/kingdol666/AgentWorkShop/tree/main/docs/video/agentworkshop-core-demo)。
