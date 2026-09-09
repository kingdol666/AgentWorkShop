---
layout: home

hero:
  name: "AgentWorkShop"
  text: "Agent teams × production lines × digital twin"
  tagline: A configuration-driven runtime where AI agent teams read real telemetry and write
    setpoints through human-approved control — every event streaming into a 3D twin.
    Install with npm, extend with an SDK and plugins.
  actions:
    - theme: brand
      text: Get started
      link: /en/guide/getting-started
    - theme: alt
      text: SDK guide
      link: /en/sdk/
    - theme: alt
      text: Plugin guide
      link: /en/plugins/

features:
  - icon: '<span class="aw-tag">PKG</span>'
    title: One-command install
    details: npm i -g agentworkshop, then `aw start` from any directory. First run builds and
      initializes the ~/.AgentWorkShop config root — independent of cwd and environment.
  - icon: '<span class="aw-tag">PLC</span>'
    title: Five-protocol DAQ & control
    details: Modbus TCP / Modbus RTU (serial gateway) / OPC UA / MQTT / HTTP — bidirectional
      drivers with connection pools, classified error diagnostics and per-driver connection
      tests. Full acquisition + write-control E2E runs over the real protocols.
  - icon: '<span class="aw-tag">HITL</span>'
    title: Human-approved write control
    details: Safe-range ∩ recipe-window interlock → HITL approval → PLC write → readback
      verification → signed write history. Agent dispatches pend for review; approving
      executes for real, and every decision is audited.
  - icon: '<span class="aw-tag">RCT</span>'
    title: Recipe versioning & governance
    details: Every parameter change is versioned with attribution (user/agent/system,
      operator, reason). Roll back to any revision or the last-known-good batch. Agents
      save best parameters, inspect diffs and roll back through tools.
  - icon: '<span class="aw-tag">HRN</span>'
    title: Multi-harness agent teams
    details: omp / codex / dsh / opencode / mock / claude behind one AgentInterface — each
      channel picks harness → provider → model. Environment availability probing disables
      not-installed engines; dispatch is hard-checked before execution. Four engines run
      real line scenarios in parallel, verified by E2E.
  - icon: '<span class="aw-tag">R/W</span>'
    title: Read-write control nodes
    details: Every control node reads its PLC value back through the same calibration path
      it writes with — periodic, on-demand and agent reads surface SET vs ACT side by side
      (reads are passive and never interlocked).
  - icon: '<span class="aw-tag">OPS</span>'
    title: Full-operation audit log
    details: Three provenance sources (user / agent / system); operators recorded as
      "Channel/Member". Query by line, product, recipe, source, kind or keyword — streamed
      live over WS. Agents self-audit their lines through tools.
  - icon: '<span class="aw-tag">PLG</span>'
    title: Plugins on both sides
    details: Server hooks (daq:sample / dcw:write / scene events) + custom DAQ drivers,
      processors, node templates + hot-injected agent tools; the SDK ships a typed REST
      client and a permission-aware plugin context.
  - icon: '<span class="aw-tag">TEA</span>'
    title: Team-scoped plugin switches
    details: Pick plugins at team creation or toggle them later in the team dialog — each
      channel keeps its own switch set (channel_plugins). A disabled plugin's tools are not
      injected into that team's agents and dispatch rejects them. Plugins themselves are
      hot-managed via the /plugins page and `aw plugin enable/disable`.
  - icon: '<span class="aw-tag">TWN</span>'
    title: 3D digital twin
    details: A Three.js town renders line equipment, node health, alarms and trends in real
      time — fed by the same event bus the agents consume. An adaptive quality ladder
      (DPR / shadow / bloom tiers with a wall-clock FPS budget) matches the machine, and
      window.__townStats exposes real render metrics (fps / drawCalls / tier / dpr).

footer:
  message: Licensed under PolyForm Noncommercial 1.0.0
  copyright: Copyright © 2026 kingdol (kingdol666)
---

<div class="aw-ruler" aria-hidden="true"></div>

<figure class="aw-console">
  <figcaption class="aw-console-bar">
    <span class="aw-console-tag">FIG.01</span>
    <span class="aw-console-title">DIGITAL TWIN · LINE OVERVIEW</span>
    <span class="aw-console-meta">THREE.JS · LIVE EVENT STREAM</span>
  </figcaption>
  <div class="aw-console-body">

![Digital-twin control room — line equipment, DAQ channels, trends and device monitoring on one screen](/town.png)

  </div>
</figure>
<p class="aw-cap">9 devices · 51 DAQ nodes · 51 channels — fed by the same event stream the agents consume</p>

<figure class="aw-console">
  <figcaption class="aw-console-bar">
    <span class="aw-console-tag">FIG.02</span>
    <span class="aw-console-title">LINE OPERATIONS</span>
    <span class="aw-console-meta">MODBUS TCP / OPC UA</span>
  </figcaption>
  <div class="aw-console-body">

![Line operations — lines/products/recipes/batch isolation with an interlocked write-control entry](/line-ops.png)

  </div>
</figure>
<p class="aw-cap">Lines / recipes / batch isolation · interlocked write control · per-sample batch tagging</p>

```bash
npm i -g agentworkshop
aw start        # any directory → http://localhost:3001
```

<div class="aw-statusbar">

<span>WS / MCP / A2A / REST</span>
<span>Nuxt 4 · node:sqlite</span>
<span>PolyForm NC 1.0</span>

</div>
