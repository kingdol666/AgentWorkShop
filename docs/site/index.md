---
layout: home
description: AgentWorkShop 是面向工业场景的 Agent 团队运行时，连接产线数据、受治理的控制流程与数字孪生。
footer:
  message: 依据 Apache License 2.0 发布 · 允许商用与生产部署
  copyright: Copyright © 2026 kingdol (kingdol666)
---

<div class="hw-hero">
<div class="hw-wrap">
<p class="hw-kicker">AGENTWORKSHOP · 工业 AGENT 运行时</p>
<h1 class="hw-title">Agent 团队<span class="x">×</span>产线<span class="x">×</span>数字孪生</h1>
<p class="hw-sub">一个配置驱动的工业 Agent 运行时：团队读取现场遥测，在权限与工艺边界内提出控制动作；节点绑定启用 manual 模式时，由人工审批后执行。统一事件流驱动趋势、审计与 3D 孪生。</p>
<div class="hw-trio">
<div><span class="k">是什么<i>WHAT</i></span><span class="v">面向秒级软实时的监督层，不替代 PLC 与安全系统。</span></div>
<div><span class="k">适合谁<i>FOR WHOM</i></span><span class="v">产线与工艺工程师 · 工业 AI 团队 · 平台开发与研究。</span></div>
<div><span class="k">如何协同<i>HOW</i></span><span class="v">读数 → 分析 → 边界校验 →（manual 模式下人工审批）→ 写入 → 回读与审计。</span></div>
</div>
<div class="hw-cta">
<a class="hw-btn primary" href="/AgentWorkShop/guide/getting-started">快速开始 <span class="arr">→</span></a>
<a class="hw-btn" href="/AgentWorkShop/demo">观看演示 <span class="arr">→</span></a>
<a class="hw-btn quiet" href="https://github.com/kingdol666/AgentWorkShop">GitHub 源码 <span class="arr">↗</span></a>
</div>
<div class="hw-rail-sec">
<div class="hw-rail-cap"><span>FIG.00 · 现场数据如何抵达 Agent 与孪生</span><span>采集 → 存储 → 事件流 → 应用</span></div>
<div class="hw-rail">
<div class="hw-pulse"></div><div class="hw-flow"></div>
<div class="hw-node" style="--i:0"><span class="n">现场设备</span><span class="d">PLC / 传感器</span></div>
<div class="hw-node" style="--i:1"><span class="n">协议驱动 ×6</span><span class="d">MODBUS · OPC UA · MQTT · HTTP · SERIAL</span></div>
<div class="hw-node" style="--i:2"><span class="n">缓冲队列</span><span class="d">INPROC / MQTT</span></div>
<div class="hw-node" style="--i:3"><span class="n">时序数据</span><span class="d">SQLITE / TIMESCALE</span></div>
<div class="hw-node" style="--i:4"><span class="n">事件总线</span><span class="d">WEBSOCKET · SEQ RESUME</span></div>
<div class="hw-node hot" style="--i:5"><span class="n">Agent / 孪生</span><span class="d">同一事实源</span></div>
</div>
<div class="hw-stats">
<div class="hw-stat"><span class="v">6</span><span class="k">现场协议</span></div>
<div class="hw-stat"><span class="v">4</span><span class="k">接入入口</span></div>
<div class="hw-stat"><span class="v">14</span><span class="k">Agent 引擎</span></div>
<div class="hw-stat"><span class="v">126</span><span class="k">运行时设置项</span></div>
<div class="hw-stat"><span class="v">7</span><span class="k">任务状态</span></div>
<div class="hw-stat"><span class="v">1</span><span class="k">共享事件流</span></div>
</div>
<p class="hw-stat-note">协议数量包含 5 个内置驱动与串口插件。设置数依据当前运行时描述符；验收记录见仓库 <code>docs/audit/</code>。</p>
</div>
</div>
</div>

<div class="hw-wrap">
<div class="aw-ruler"></div>

<section class="hw-sec">
<div class="hw-sec-head"><span class="hw-sec-no">01</span><h2 class="hw-sec-title">先看演示，再看真实界面</h2><span class="hw-sec-en">DEMO · INTERFACE</span></div>
<div class="hw-sec-rule"></div>
<p class="hw-lead">67 秒概览展示工作台、Agent 团队与产线管理。下方截图来自运行中的界面，分别呈现数字孪生、数据采集和产线运营。</p>
<figure class="aw-console">
<figcaption class="aw-console-bar"><span class="aw-console-tag">DEMO · 01:07</span><span class="aw-console-title">AGENTWORKSHOP CORE WALKTHROUGH</span><span class="aw-console-meta">英文配音 · EN / ZH 字幕</span></figcaption>
<div class="aw-console-body"><video controls playsinline preload="metadata" poster="/demo/agentworkshop-core-demo-poster.png" aria-label="AgentWorkShop 核心功能演示" style="display:block;width:100%;aspect-ratio:16/9;background:#000"><source src="/demo/agentworkshop-core-demo.mp4" type="video/mp4"><track kind="captions" label="English" srclang="en" src="/AgentWorkShop/demo/agentworkshop-core-demo.en.vtt" default><track kind="captions" label="简体中文" srclang="zh-Hans" src="/AgentWorkShop/demo/agentworkshop-core-demo.zh-Hans.vtt"></video></div>
<p class="aw-console-cap"><b>隔离的模拟场景。</b>演示产线保持停止，使用 Mock PLC；未连接真实设备，也未发送控制写入。<a href="/AgentWorkShop/demo">打开独立演示页并选择字幕 →</a></p>
</figure>
<div class="hw-figs">
<figure class="aw-console"><figcaption class="aw-console-bar"><span class="aw-console-tag">FIG.01</span><span class="aw-console-title">DIGITAL TWIN · 产线孪生</span></figcaption><div class="aw-console-body">

![数字孪生中的产线设备、实时趋势与设备健康状态](/town.png)

</div><p class="aw-console-cap"><b>事件流的空间视图。</b>设备、通道、趋势和告警共享同一运行时数据。</p></figure>
<figure class="aw-console"><figcaption class="aw-console-bar"><span class="aw-console-tag">FIG.02</span><span class="aw-console-title">DAQ · 实时采集</span></figcaption><div class="aw-console-body">

![DAQ 数据采集控制台与节点台账](/daq.png)

</div><p class="aw-console-cap"><b>现场数据有迹可循。</b>查看节点状态、采样值与数据流转。</p></figure>
<figure class="aw-console"><figcaption class="aw-console-bar"><span class="aw-console-tag">FIG.03</span><span class="aw-console-title">LINE OPS · 产线运营</span></figcaption><div class="aw-console-body">

![产线管理页面中的产线、产品与配方](/line-ops.png)

</div><p class="aw-console-cap"><b>配方与批次绑定。</b>产线、产品、配方和运行状态在同一处管理。</p></figure>
</div>
</section>

<section class="hw-cta-sec">
<div class="hw-sec-head"><span class="hw-sec-no">02</span><h2 class="hw-sec-title">一分钟开始</h2><span class="hw-sec-en">QUICK START</span></div>
<div class="hw-sec-rule"></div>
<p class="hw-lead">需要 Node.js 23.4.0 或更高版本。全局安装会自动准备配置目录，启动后即可打开本机界面。</p>

```bash
npm install -g agentworkshop
aw start
# http://localhost:3001
```

<p class="hw-lead">初次使用请先接入模拟器或非生产环境。真实产线连接前，请阅读<a href="/AgentWorkShop/guide/dcw-read-write">写控制指南</a>并检查权限、联锁与人工审批配置。</p>
<p class="hw-lead">继续阅读：<a href="/AgentWorkShop/guide/getting-started">完整上手指南</a> · <a href="/AgentWorkShop/guide/first-session">首次 Agent × 产线会话</a> · <a href="https://github.com/kingdol666/AgentWorkShop/blob/main/README-zh.md">源码仓库 README</a></p>
</section>

<section class="hw-sec">
<div class="hw-sec-head"><span class="hw-sec-no">03</span><h2 class="hw-sec-title">一套运行时，几条清晰边界</h2><span class="hw-sec-en">ARCHITECTURE</span></div>
<div class="hw-sec-rule"></div>
<p class="hw-lead">Web、CLI 与外部 Agent 进入同一运行时。采集数据进入共享事件流；控制请求通过授权与边界校验，节点绑定启用 manual 模式时再经人工审批。</p>
<div class="hw-arch">
<div class="hw-layer"><div class="hw-layer-tag"><span class="l1">入口</span><span class="l2">ENTRY</span></div><div class="hw-cells"><div class="hw-cell"><span class="c1">WebSocket</span><span class="c2">实时事件流</span></div><div class="hw-cell"><span class="c1">REST</span><span class="c2">平台 API</span></div><div class="hw-cell"><span class="c1">MCP</span><span class="c2">工具接入</span></div><div class="hw-cell"><span class="c1">A2A</span><span class="c2">Agent 互通</span></div></div></div>
<div class="hw-layer"><div class="hw-layer-tag"><span class="l1">Agent 运行时</span><span class="l2">RUNTIME</span></div><div class="hw-cells"><div class="hw-cell"><span class="c1">Channels</span><span class="c2">团队与任务</span></div><div class="hw-cell"><span class="c1">Scheduler</span><span class="c2">派发与监督</span></div><div class="hw-cell"><span class="c1">Memory</span><span class="c2">持久记忆</span></div><div class="hw-cell"><span class="c1">Engines ×14</span><span class="c2">统一适配契约</span></div></div></div>
<div class="hw-layer"><div class="hw-layer-tag"><span class="l1">工业边界</span><span class="l2">GOVERNANCE</span></div><div class="hw-cells"><div class="hw-cell"><span class="c1">DAQ</span><span class="c2">采集与历史数据</span></div><div class="hw-cell"><span class="c1">Permissions</span><span class="c2">产线级授权</span></div><div class="hw-cell"><span class="c1">Interlock + HITL</span><span class="c2">工艺边界校验；manual 模式下审批</span></div><div class="hw-cell"><span class="c1">Readback</span><span class="c2">设备回读与审计</span></div></div></div>
<div class="hw-layer"><div class="hw-layer-tag"><span class="l1">持久化与呈现</span><span class="l2">DATA · UI</span></div><div class="hw-cells"><div class="hw-cell"><span class="c1">SQLite</span><span class="c2">运行时状态</span></div><div class="hw-cell"><span class="c1">TimescaleDB</span><span class="c2">可选时序存储</span></div><div class="hw-cell"><span class="c1">3D Twin</span><span class="c2">事件流空间呈现</span></div><div class="hw-cell"><span class="c1">Audit</span><span class="c2">操作记录</span></div></div></div>
</div>
<p class="hw-flow-note">采集：<i>设备 → 驱动 → 事件流 → 趋势 / 孪生 / Agent</i>　｜　控制：<i>授权 → 工艺边界 →（manual 模式下审批）→ 写入 → 回读</i></p>
</section>

<section class="hw-sec">
<div class="hw-sec-head"><span class="hw-sec-no">04</span><h2 class="hw-sec-title">核心能力</h2><span class="hw-sec-en">CAPABILITIES</span></div>
<div class="hw-sec-rule"></div>
<div class="hw-feats">
<div class="hw-f"><span class="tag">AGENTS</span><h3>多引擎团队协作</h3><p>14 种引擎共用统一契约，支持主从团队、任务编排、定时执行与持久记忆。<br><a href="/AgentWorkShop/guide/multi-harness">了解 Agent 团队 →</a></p></div>
<div class="hw-f"><span class="tag">INDUSTRIAL I/O</span><h3>现场采集与控制</h3><p>六种协议连接设备与数据源；实时遥测、配方和批次历史进入同一数据链路。<br><a href="/AgentWorkShop/guide/daq-protocols">查看协议指南 →</a></p></div>
<div class="hw-f"><span class="tag">GOVERNANCE</span><h3>带边界的写控制</h3><p>产线授权、量程与配方联锁、可选 HITL 审批、PLC 回读和审计共同构成写入闭环。<br><a href="/AgentWorkShop/guide/dcw-read-write">查看写控制指南 →</a></p></div>
<div class="hw-f"><span class="tag">TWIN · AML</span><h3>孪生与模型闭环</h3><p>通过数字孪生、自动建模实验室和本体服务理解现场，并在资格门控下开展优化。<br><a href="/AgentWorkShop/guide/aml">了解 AML →</a></p></div>
<div class="hw-f"><span class="tag">OPERATIONS</span><h3>配方、批次与权限</h3><p>按产线范围组织数据与操作，管理配方版本、批次历史、权限和审计。<br><a href="/AgentWorkShop/guide/line-permissions">了解产线权限 →</a></p></div>
<div class="hw-f"><span class="tag">EXTENSIONS</span><h3>API、SDK 与插件</h3><p>使用 REST、WebSocket、MCP、A2A、TypeScript SDK、CLI 和插件连接现有系统。<br><a href="/AgentWorkShop/plugins/">查看扩展文档 →</a></p></div>
</div>
</section>

<section class="hw-sec">
<div class="hw-sec-head"><span class="hw-sec-no">05</span><h2 class="hw-sec-title">适用场景与安全边界</h2><span class="hw-sec-en">USE CASES · SCOPE</span></div>
<div class="hw-sec-rule"></div>
<div class="hw-scenes">
<div class="hw-sc"><span class="ico">01</span><div class="bd"><h3>产线监督与运营</h3><p>在统一界面查看设备、采集通道、配方、批次、趋势和告警。</p></div></div>
<div class="hw-sc"><span class="ico">02</span><div class="bd"><h3>Agent 辅助分析</h3><p>让团队基于有范围的数据分析工艺趋势、形成建议并保留依据。</p></div></div>
<div class="hw-sc"><span class="ico">03</span><div class="bd"><h3>工业 AI 研究与教学</h3><p>用协议适配器、模拟环境和统一 Agent 契约构建可复现工作流。</p></div></div>
<div class="hw-sc"><span class="ico">04</span><div class="bd"><h3>系统集成与扩展</h3><p>通过 SDK、API 与插件将平台能力接入现有软件和工程流程。</p></div></div>
</div>
<div class="hw-note"><span class="t">边界</span><p>AgentWorkShop 是秒级软实时监督层，不是 PLC、SIS 或硬实时控制器。任何安全联锁、伺服与毫秒级闭环必须留在现场控制系统；此处的建议值仍受现场逻辑约束。</p></div>
</section>

<section class="hw-final">
<h2>从指南开始，按你的现场逐步扩展</h2>
<p>先熟悉本机运行与模拟工作流，再配置现场协议、权限和受审批的控制链路。完整说明、API 契约与研究证据均可从文档站进入。</p>
<div class="hw-cta"><a class="hw-btn primary" href="/AgentWorkShop/guide/getting-started">打开快速上手 <span class="arr">→</span></a><a class="hw-btn" href="/AgentWorkShop/sdk/">SDK <span class="arr">→</span></a><a class="hw-btn" href="/AgentWorkShop/plugins/">插件开发 <span class="arr">→</span></a><a class="hw-btn quiet" href="https://github.com/kingdol666/AgentWorkShop/tree/main/docs/audit">验收记录 <span class="arr">↗</span></a></div>
</section>
</div>
