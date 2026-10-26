---
title: AgentWorkShop Product Demo
description: A recorded walkthrough of the AgentWorkShop interface with English narration and English and Chinese captions.
---

# AgentWorkShop Product Demo

<video controls preload="metadata" poster="/demo/agentworkshop-core-demo-poster.png" style="display:block;width:100%;aspect-ratio:16/9;background:#000">
  <source src="/demo/agentworkshop-core-demo.mp4" type="video/mp4">
  <track kind="captions" label="English" srclang="en" src="/AgentWorkShop/demo/agentworkshop-core-demo.en.vtt" default>
  <track kind="captions" label="简体中文" srclang="zh-Hans" src="/AgentWorkShop/demo/agentworkshop-core-demo.zh-Hans.vtt">
</video>

[Download MP4](/demo/agentworkshop-core-demo.mp4) · [English captions](/demo/agentworkshop-core-demo.en.vtt) · [Chinese captions](/demo/agentworkshop-core-demo.zh-Hans.vtt) · [Narration audio](/demo/agentworkshop-core-demo-voiceover.mp3)

## What the video shows

The walkthrough moves from the dashboard and channel-template catalogue to a three-role agent-team console, then into line management and the demo line's node, product, recipe, and standby status. The narration is in English; the player offers English and Simplified Chinese captions.

This recording uses an isolated local environment and a Mock PLC simulator. The line stays stopped throughout: no physical PLC is connected and no control write is issued. The footage demonstrates the product interface and configuration workflow; it does not present a live factory run.

The narration was generated locally with Kokoro `af_bella` using ONNX inference. The [scripts, timing, screenshots, and paper caption](https://github.com/kingdol666/AgentWorkShop/tree/main/docs/video/agentworkshop-core-demo) are available in the repository.
