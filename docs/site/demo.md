---
title: AgentWorkShop 产品演示
description: 67 秒核心功能演示，提供英文旁白、英文字幕与简体中文字幕。
---

<div class="hw-wrap aw-demo-page">

<p class="aw-tag">DEMO · 01:07 · EN / ZH</p>

# AgentWorkShop 产品演示

<p class="hw-lead">从 Agent 工作空间进入团队控制台，再查看产线节点、产品、配方与待机状态。使用播放器控件播放，并可在字幕菜单切换英文或简体中文。</p>

<figure class="aw-console">
<figcaption class="aw-console-bar"><span class="aw-console-tag">DEMO</span><span class="aw-console-title">CORE PRODUCT WALKTHROUGH</span><span class="aw-console-meta">英文配音 · H.264</span></figcaption>
<div class="aw-console-body"><video controls playsinline preload="metadata" poster="/demo/agentworkshop-core-demo-poster.png" aria-label="AgentWorkShop 核心功能演示"><source src="/demo/agentworkshop-core-demo.mp4" type="video/mp4"><track kind="captions" label="English" srclang="en" src="/AgentWorkShop/demo/agentworkshop-core-demo.en.vtt" default><track kind="captions" label="简体中文" srclang="zh-Hans" src="/AgentWorkShop/demo/agentworkshop-core-demo.zh-Hans.vtt"></video></div>
<p class="aw-console-cap"><b>建议使用播放器的字幕菜单。</b>字幕可单独下载；若浏览器不支持内嵌字幕，请打开下方 VTT 文件。</p>
</figure>

<p class="hw-cta">
<a class="hw-btn primary" href="/demo/agentworkshop-core-demo.mp4">下载 MP4 <span class="arr">↓</span></a>
<a class="hw-btn" href="/demo/agentworkshop-core-demo.en.vtt">English captions <span class="arr">↗</span></a>
<a class="hw-btn" href="/demo/agentworkshop-core-demo.zh-Hans.vtt">简体中文字幕 <span class="arr">↗</span></a>
<a class="hw-btn quiet" href="https://github.com/kingdol666/AgentWorkShop/blob/main/README-zh.md">返回项目 README <span class="arr">↗</span></a>
</p>

<div class="hw-note"><span class="t">演示范围</span><p>录屏运行于隔离本地环境，产线绑定 Mock PLC 并保持停止。未连接真实 PLC、未启动产线，也未发送控制写入。画面展示产品界面与配置流程，不代表现场运行结果。</p></div>

<section class="hw-sec">
<div class="hw-sec-head"><span class="hw-sec-no">01</span><h2 class="hw-sec-title">演示章节</h2><span class="hw-sec-en">CHAPTERS</span></div>
<div class="hw-sec-rule"></div>
<div class="hw-scenes">
<div class="hw-sc"><span class="ico">00:00</span><div class="bd"><h3>统一工作空间</h3><p>Agent 团队、任务与运行状态的工作台入口。</p></div></div>
<div class="hw-sc"><span class="ico">00:12</span><div class="bd"><h3>频道模板</h3><p>从可复用模板组织新的工作场景。</p></div></div>
<div class="hw-sc"><span class="ico">00:21</span><div class="bd"><h3>团队控制台</h3><p>查看 lead、工艺工程师与分析角色的协同状态。</p></div></div>
<div class="hw-sc"><span class="ico">00:31</span><div class="bd"><h3>产线配置</h3><p>检查节点、产品与配方等运行上下文。</p></div></div>
<div class="hw-sc"><span class="ico">00:43</span><div class="bd"><h3>待机清单</h3><p>示例线包含一个控制节点、一个产品和一个配方，保持待机。</p></div></div>
<div class="hw-sc"><span class="ico">00:51</span><div class="bd"><h3>模拟边界</h3><p>确认无 PLC 硬件连接，启动控件未触碰，也没有发出控制命令。</p></div></div>
</div>
</section>

<p>旁白使用本地 Kokoro `af_bella` ONNX 推理生成。制作脚本、分镜时间轴、录屏截图和论文图注位于 <a href="https://github.com/kingdol666/AgentWorkShop/tree/main/docs/video/agentworkshop-core-demo">演示素材目录</a>。</p>

</div>
