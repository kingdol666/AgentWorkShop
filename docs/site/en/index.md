---
layout: home
description: AgentWorkShop is an industrial agent runtime connecting production-line data, governed control workflows, and a digital twin.
footer:
  message: Licensed under the Apache License 2.0 · Commercial and production use permitted
  copyright: Copyright © 2026 kingdol (kingdol666)
---

<div class="hw-hero">
<div class="hw-wrap">
<p class="hw-kicker">AGENTWORKSHOP · INDUSTRIAL AGENT RUNTIME</p>
<h1 class="hw-title">Agent teams<span class="x">×</span>the line<span class="x">×</span>the twin</h1>
<p class="hw-sub">A configuration-driven industrial runtime: teams read plant telemetry and propose actions within permissions and process bounds. Human approval applies when a node binding uses manual mode. One event stream powers trends, audit history, and the 3D twin.</p>
<div class="hw-trio">
<div><span class="k">WHAT<i>是什么</i></span><span class="v">A second-level supervisory layer, not a replacement for PLCs or safety systems.</span></div>
<div><span class="k">FOR WHOM<i>适合谁</i></span><span class="v">Line and process engineers · industrial AI teams · platform developers and researchers.</span></div>
<div><span class="k">HOW<i>如何协同</i></span><span class="v">Read → analyze → validate bounds → (approve in manual mode) → write → read back and audit.</span></div>
</div>
<div class="hw-cta">
<a class="hw-btn primary" href="/AgentWorkShop/en/guide/getting-started">Get started <span class="arr">→</span></a>
<a class="hw-btn" href="/AgentWorkShop/en/demo">Watch the demo <span class="arr">→</span></a>
<a class="hw-btn quiet" href="https://github.com/kingdol666/AgentWorkShop">Source on GitHub <span class="arr">↗</span></a>
</div>
<div class="hw-rail-sec">
<div class="hw-rail-cap"><span>FIG.00 · HOW PLANT DATA REACHES AGENTS AND THE TWIN</span><span>ACQUIRE → STORE → STREAM → ACT</span></div>
<div class="hw-rail">
<div class="hw-pulse"></div><div class="hw-flow"></div>
<div class="hw-node" style="--i:0"><span class="n">Field devices</span><span class="d">PLC / SENSORS</span></div>
<div class="hw-node" style="--i:1"><span class="n">6 protocols</span><span class="d">MODBUS · OPC UA · MQTT · HTTP · SERIAL</span></div>
<div class="hw-node" style="--i:2"><span class="n">Buffer</span><span class="d">INPROC / MQTT</span></div>
<div class="hw-node" style="--i:3"><span class="n">Time series</span><span class="d">SQLITE / TIMESCALE</span></div>
<div class="hw-node" style="--i:4"><span class="n">Event stream</span><span class="d">WEBSOCKET · SEQ RESUME</span></div>
<div class="hw-node hot" style="--i:5"><span class="n">Agent / Twin</span><span class="d">ONE SOURCE OF TRUTH</span></div>
</div>
<div class="hw-stats">
<div class="hw-stat"><span class="v">6</span><span class="k">field protocols</span></div>
<div class="hw-stat"><span class="v">4</span><span class="k">entry points</span></div>
<div class="hw-stat"><span class="v">14</span><span class="k">agent engines</span></div>
<div class="hw-stat"><span class="v">126</span><span class="k">runtime settings</span></div>
<div class="hw-stat"><span class="v">7</span><span class="k">task states</span></div>
<div class="hw-stat"><span class="v">1</span><span class="k">shared event stream</span></div>
</div>
<p class="hw-stat-note">The protocol count includes five built-in drivers and the serial plugin. The settings count follows the current runtime descriptor registry; acceptance reports live in <code>docs/audit/</code>.</p>
</div>
</div>
</div>

<div class="hw-wrap">
<div class="aw-ruler"></div>

<section class="hw-sec">
<div class="hw-sec-head"><span class="hw-sec-no">01</span><h2 class="hw-sec-title">Watch the system, then explore the UI</h2><span class="hw-sec-en">DEMO · INTERFACE</span></div>
<div class="hw-sec-rule"></div>
<p class="hw-lead">The 67-second walkthrough introduces the workspace, agent teams, and line management. The screens below show the twin, data acquisition, and line operations from a running interface.</p>
<figure class="aw-console">
<figcaption class="aw-console-bar"><span class="aw-console-tag">DEMO · 01:07</span><span class="aw-console-title">AGENTWORKSHOP CORE WALKTHROUGH</span><span class="aw-console-meta">ENGLISH VOICE · EN / ZH CAPTIONS</span></figcaption>
<div class="aw-console-body"><video controls playsinline preload="metadata" poster="/demo/agentworkshop-core-demo-poster.png" aria-label="AgentWorkShop core product demo" style="display:block;width:100%;aspect-ratio:16/9;background:#000"><source src="/demo/agentworkshop-core-demo.mp4" type="video/mp4"><track kind="captions" label="English" srclang="en" src="/AgentWorkShop/demo/agentworkshop-core-demo.en.vtt" default><track kind="captions" label="Simplified Chinese" srclang="zh-Hans" src="/AgentWorkShop/demo/agentworkshop-core-demo.zh-Hans.vtt"></video></div>
<p class="aw-console-cap"><b>Isolated simulator scenario.</b> The demo line remains stopped on a Mock PLC; no physical device is connected and no control write is issued. <a href="/AgentWorkShop/en/demo">Open the dedicated demo page and choose captions →</a></p>
</figure>
<div class="hw-figs">
<figure class="aw-console"><figcaption class="aw-console-bar"><span class="aw-console-tag">FIG.01</span><span class="aw-console-title">DIGITAL TWIN · LINE OVERVIEW</span></figcaption><div class="aw-console-body">

![Production equipment, live trends, and device health in the 3D twin](/town.png)

</div><p class="aw-console-cap"><b>A spatial view of the event stream.</b> Equipment, channels, trends, and alarms share one runtime.</p></figure>
<figure class="aw-console"><figcaption class="aw-console-bar"><span class="aw-console-tag">FIG.02</span><span class="aw-console-title">DAQ · LIVE ACQUISITION</span></figcaption><div class="aw-console-body">

![DAQ console with node inventory and live telemetry](/daq.png)

</div><p class="aw-console-cap"><b>Traceable field data.</b> Inspect node health, sampling values, and data flow.</p></figure>
<figure class="aw-console"><figcaption class="aw-console-bar"><span class="aw-console-tag">FIG.03</span><span class="aw-console-title">LINE OPS · PRODUCTION OPERATIONS</span></figcaption><div class="aw-console-body">

![Line operations page with production lines, products, and recipes](/line-ops.png)

</div><p class="aw-console-cap"><b>Recipes and batches stay connected.</b> Manage lines, products, recipes, and run state together.</p></figure>
</div>
</section>

<section class="hw-cta-sec">
<div class="hw-sec-head"><span class="hw-sec-no">02</span><h2 class="hw-sec-title">Start in a minute</h2><span class="hw-sec-en">QUICK START</span></div>
<div class="hw-sec-rule"></div>
<p class="hw-lead">Requires Node.js 23.4.0 or newer. Install globally to initialize the config directory and launch the local interface.</p>

```bash
npm install -g agentworkshop
aw start
# http://localhost:3001
```

<p class="hw-lead">Start with a simulator or non-production environment. Before connecting a live line, read the <a href="/AgentWorkShop/en/guide/dcw-read-write">write-control guide</a> and review permissions, interlocks, and human-approval settings.</p>
<p class="hw-lead">Next: <a href="/AgentWorkShop/en/guide/getting-started">full getting-started guide</a> · <a href="/AgentWorkShop/en/guide/first-session">first agent × line session</a> · <a href="https://github.com/kingdol666/AgentWorkShop/blob/main/README.md">repository README</a></p>
</section>

<section class="hw-sec">
<div class="hw-sec-head"><span class="hw-sec-no">03</span><h2 class="hw-sec-title">One runtime, explicit boundaries</h2><span class="hw-sec-en">ARCHITECTURE</span></div>
<div class="hw-sec-rule"></div>
<p class="hw-lead">The web app, CLI, and external agents enter the same runtime. Acquired data flows into a shared event stream; control requests pass authorization and configured bounds, with human approval when the binding uses manual mode.</p>
<div class="hw-arch">
<div class="hw-layer"><div class="hw-layer-tag"><span class="l1">Entry</span><span class="l2">ENTRY</span></div><div class="hw-cells"><div class="hw-cell"><span class="c1">WebSocket</span><span class="c2">live event stream</span></div><div class="hw-cell"><span class="c1">REST</span><span class="c2">platform API</span></div><div class="hw-cell"><span class="c1">MCP</span><span class="c2">tool access</span></div><div class="hw-cell"><span class="c1">A2A</span><span class="c2">agent interoperability</span></div></div></div>
<div class="hw-layer"><div class="hw-layer-tag"><span class="l1">Agent runtime</span><span class="l2">RUNTIME</span></div><div class="hw-cells"><div class="hw-cell"><span class="c1">Channels</span><span class="c2">teams and tasks</span></div><div class="hw-cell"><span class="c1">Scheduler</span><span class="c2">dispatch and supervision</span></div><div class="hw-cell"><span class="c1">Memory</span><span class="c2">persistent recall</span></div><div class="hw-cell"><span class="c1">Engines ×14</span><span class="c2">one adapter contract</span></div></div></div>
<div class="hw-layer"><div class="hw-layer-tag"><span class="l1">Industrial boundary</span><span class="l2">GOVERNANCE</span></div><div class="hw-cells"><div class="hw-cell"><span class="c1">DAQ</span><span class="c2">acquisition and history</span></div><div class="hw-cell"><span class="c1">Permissions</span><span class="c2">line-scoped grants</span></div><div class="hw-cell"><span class="c1">Interlock + HITL</span><span class="c2">bounded writes; review in manual mode</span></div><div class="hw-cell"><span class="c1">Readback</span><span class="c2">device verification and audit</span></div></div></div>
<div class="hw-layer"><div class="hw-layer-tag"><span class="l1">Persistence and UI</span><span class="l2">DATA · UI</span></div><div class="hw-cells"><div class="hw-cell"><span class="c1">SQLite</span><span class="c2">runtime state</span></div><div class="hw-cell"><span class="c1">TimescaleDB</span><span class="c2">optional time series</span></div><div class="hw-cell"><span class="c1">3D twin</span><span class="c2">spatial event view</span></div><div class="hw-cell"><span class="c1">Audit</span><span class="c2">operation history</span></div></div></div>
</div>
<p class="hw-flow-note">Acquisition: <i>device → driver → event stream → trends / twin / agents</i>　|　Control: <i>authorization → process bounds → (approval in manual mode) → write → readback</i></p>
</section>

<section class="hw-sec">
<div class="hw-sec-head"><span class="hw-sec-no">04</span><h2 class="hw-sec-title">Core capabilities</h2><span class="hw-sec-en">CAPABILITIES</span></div>
<div class="hw-sec-rule"></div>
<div class="hw-feats">
<div class="hw-f"><span class="tag">AGENTS</span><h3>Multi-engine teams</h3><p>Fourteen engines share one contract, with lead-worker teams, task orchestration, schedules, and persistent memory.<br><a href="/AgentWorkShop/en/guide/multi-harness">Explore agent teams →</a></p></div>
<div class="hw-f"><span class="tag">INDUSTRIAL I/O</span><h3>Field acquisition and control</h3><p>Six protocols connect equipment and data sources; telemetry, recipes, and batch history share one data path.<br><a href="/AgentWorkShop/en/guide/daq-protocols">Read the protocol guide →</a></p></div>
<div class="hw-f"><span class="tag">GOVERNANCE</span><h3>Bounded write control</h3><p>Line grants, process and recipe interlocks, optional HITL approval, PLC readback, and audit form one control loop.<br><a href="/AgentWorkShop/en/guide/dcw-read-write">Read the write-control guide →</a></p></div>
<div class="hw-f"><span class="tag">TWIN · AML</span><h3>Twin and model loop</h3><p>Use the digital twin, Auto-Modeling Lab, and ontology services to understand the process and qualify optimization.<br><a href="/AgentWorkShop/en/guide/aml">Explore AML →</a></p></div>
<div class="hw-f"><span class="tag">OPERATIONS</span><h3>Recipes, batches, and access</h3><p>Organize data and actions by line; manage recipe versions, batch history, permissions, and audit records.<br><a href="/AgentWorkShop/en/guide/line-permissions">Explore line permissions →</a></p></div>
<div class="hw-f"><span class="tag">EXTENSIONS</span><h3>APIs, SDK, and plugins</h3><p>Connect existing systems through REST, WebSocket, MCP, A2A, the TypeScript SDK, CLI, and plugins.<br><a href="/AgentWorkShop/en/plugins/">Explore extensions →</a></p></div>
</div>
</section>

<section class="hw-sec">
<div class="hw-sec-head"><span class="hw-sec-no">05</span><h2 class="hw-sec-title">Use cases and safety scope</h2><span class="hw-sec-en">USE CASES · SCOPE</span></div>
<div class="hw-sec-rule"></div>
<div class="hw-scenes">
<div class="hw-sc"><span class="ico">01</span><div class="bd"><h3>Line supervision</h3><p>View equipment, acquisition channels, recipes, batches, trends, and alarms in one place.</p></div></div>
<div class="hw-sc"><span class="ico">02</span><div class="bd"><h3>Agent-assisted analysis</h3><p>Let teams analyze scoped process data, form recommendations, and preserve the evidence behind them.</p></div></div>
<div class="hw-sc"><span class="ico">03</span><div class="bd"><h3>Industrial AI research</h3><p>Build reproducible workflows with protocol adapters, simulator environments, and a shared agent contract.</p></div></div>
<div class="hw-sc"><span class="ico">04</span><div class="bd"><h3>System integration</h3><p>Bring platform capabilities into existing software and engineering workflows through APIs, SDKs, and plugins.</p></div></div>
</div>
<div class="hw-note"><span class="t">SCOPE</span><p>AgentWorkShop is a second-level supervisory layer, not a PLC, SIS, or hard real-time controller. Safety interlocks, servo control, and millisecond loops belong in the plant control system; plant-side logic can always veto a proposed setpoint.</p></div>
</section>

<section class="hw-final">
<h2>Start with the guide. Extend it for your plant.</h2>
<p>Explore the local runtime and simulator workflow first, then configure field protocols, permissions, and reviewed control. The docs site links to detailed guides, API contracts, and research evidence.</p>
<div class="hw-cta"><a class="hw-btn primary" href="/AgentWorkShop/en/guide/getting-started">Open the getting-started guide <span class="arr">→</span></a><a class="hw-btn" href="/AgentWorkShop/en/sdk/">SDK <span class="arr">→</span></a><a class="hw-btn" href="/AgentWorkShop/en/plugins/">Plugin development <span class="arr">→</span></a><a class="hw-btn quiet" href="https://github.com/kingdol666/AgentWorkShop/tree/main/docs/audit">Acceptance records <span class="arr">↗</span></a></div>
</section>
</div>
