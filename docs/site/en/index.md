---
layout: home

footer:
  message: Licensed under the Apache License 2.0 · Commercial and production use allowed
  copyright: Copyright © 2026 kingdol (kingdol666)
---

<!--
  ⚠️ HTML indentation here is constrained by markdown-it's HTML block rule:
  a line indented ≥4 spaces that follows a blank line becomes an *indented code
  block* and is emitted escaped ("Element is missing end tag" at build time).
  So block-level elements indent at most 2 spaces; deeper indentation may only
  appear inside the same chunk (i.e. with no blank line above it).
-->

<div class="hw-hero">
  <div class="hw-wrap">
    <p class="hw-kicker">AGENTWORKSHOP · INDUSTRIAL AGENT RUNTIME</p>
    <h1 class="hw-title">Agent teams<span class="x">×</span>the line<span class="x">×</span>the twin</h1>
    <p class="hw-sub">
      A configuration-driven industrial agent runtime: teams read telemetry and issue setpoints through
      governed controls (manual mode requires human approval). Events can stream to a 3D twin.
      Real protocol stacks, reproducible assertions; simulation evidence is distinct from physical HIL.
    </p>
    <div class="hw-trio">
      <div>
        <span class="k">WHAT<i>是什么</i></span>
        <span class="v">A supervisory runtime, SCADA-adjacent · second-level soft real-time</span>
      </div>
      <div>
        <span class="k">FOR WHOM<i>给谁用</i></span>
        <span class="v">Line engineers · process &amp; ops · industrial AI research &amp; teaching · platform extension</span>
      </div>
      <div>
        <span class="k">WHY<i>凭什么值</i></span>
        <span class="v">6 driver classes (incl. serial plugin) · interlocks → policy-based approval → audited readback · 14 engines, one contract</span>
      </div>
    </div>
    <div class="hw-cta">
      <a class="hw-btn primary" href="/AgentWorkShop/en/guide/getting-started">Get started <span class="arr">→</span></a>
      <a class="hw-btn" href="#film">Watch the 90s film <span class="arr">→</span></a>
      <a class="hw-btn" href="/AgentWorkShop/en/demo">Product demo <span class="arr">→</span></a>
      <a class="hw-btn" href="https://github.com/kingdol666/AgentWorkShop">GitHub <span class="arr">↗</span></a>
      <span class="hw-cta-sep"></span>
      <a class="hw-btn quiet" href="/AgentWorkShop/en/guide/first-session">Your first agent × line session <span class="arr">→</span></a>
    </div>
    <div class="hw-rail-sec">
      <div class="hw-rail-cap">
        <span>FIG.00 · THE DATA PIPELINE — THE PRODUCT IS THIS CHAIN (SCHEMATIC)</span>
        <span>SAMPLING → STORAGE → STREAM → AGENT</span>
      </div>
      <div class="hw-rail">
        <div class="hw-pulse"></div>
        <div class="hw-flow"></div>
        <div class="hw-node" style="--i:0"><span class="n">Field devices</span><span class="d">PLC / SENSORS</span></div>
        <div class="hw-node" style="--i:1"><span class="n">Drivers ×6</span><span class="d">MODBUS TCP/RTU · OPC UA · MQTT · HTTP · SERIAL (plugin)</span></div>
        <div class="hw-node" style="--i:2"><span class="n">Queue</span><span class="d">INPROC / MQTT · OFFLINE BUFFER</span></div>
        <div class="hw-node" style="--i:3"><span class="n">TSDB</span><span class="d">SQLITE / TIMESCALE</span></div>
        <div class="hw-node" style="--i:4"><span class="n">WS HUB</span><span class="d">AEP v1 · SEQ RESUME</span></div>
        <div class="hw-node hot" style="--i:5"><span class="n">Agent / Twin</span><span class="d">SAME EVENT STREAM</span></div>
      </div>
      <div class="hw-stats">
        <div class="hw-stat"><span class="v">6</span><span class="k">field protocols</span></div>
        <div class="hw-stat"><span class="v">4</span><span class="k">entry points</span></div>
        <div class="hw-stat"><span class="v">14</span><span class="k">engines</span></div>
        <div class="hw-stat"><span class="v">144</span><span class="k">runtime settings</span></div>
        <div class="hw-stat"><span class="v">2355</span><span class="k">unit tests</span></div>
        <div class="hw-stat"><span class="v">7</span><span class="k">task states</span></div>
      </div>
      <p class="hw-stat-note">
        Unit-test count from the 2026-11-25 local re-run (2,354 pass / 0 fail / 1 conditional skip);
        isolated production-build acceptance covered REST 73/73, DAQ 17/17, prefab binding 15/15 and line onboarding V1–V6 8/0.
        **This is simulator evidence, not physical PLC/HIL acceptance.** Report:
        <code>docs/audit/evidence/2026-11-25-stability-audit/REPORT.md</code>.
        The 2026-09-24 historical full-coverage wave (~1100 assertions) remains archived in
        <code>docs/audit/e2e-2026-09-24-full-coverage.md</code> and
        <code>docs/audit/e2e-2026-09-24-all-features.md</code>.
        The rest are countable facts: 6 driver classes (5 built-in + the serial-bridge plugin) / 4 entry points (WS · MCP · A2A · REST) /
        14 harnesses (<code>agents/registry.ts</code>) / 144 settings in 19 groups (<code>aw config list</code>) / 7 task states.
      </p>
      <div class="aw-statusbar">
        <span>Version <i>v0.20.1 · released</i></span>
        <span>License <i>Apache License 2.0</i></span>
        <span>Runtime <i>Node ≥ 23.4.0 · Nuxt 4 · Vue 3.5 · TypeScript 5.7</i></span>
        <span>Docs <i>简体中文 / English</i></span>
      </div>
    </div>
  </div>
</div>

<div class="hw-wrap">

  <div class="aw-ruler"></div>

  <section class="hw-sec">
    <div class="hw-sec-head">
      <span class="hw-sec-no">00</span>
      <h2 class="hw-sec-title">What's new</h2>
      <span class="hw-sec-en">CURRENT SOURCE · v0.20.1 (RELEASED 2026-11-25)</span>
    </div>
    <div class="hw-sec-rule"></div>
    <p class="hw-lead">
      v0.20.1 (2026-11-25) does not add a feature surface; it fixes how the system behaves when something goes wrong. DAQ time-series readiness is set only after the adapter finishes initializing (or explicitly degrades to SQLite), and collectors, flushes and acceptance scripts wait on it; online recovery, offline retry and stale rollup attaches are guarded by generation checks. Timescale initialization fails closed when any required table, hypertable, tag column or hot-path index fails, releasing the pool; optional indexes and compression policies only warn. SQLite writes self-heal their schema, and writing through Timescale before initialization throws <code>TSDB_NOT_READY</code>. CI adds a production boot smoke; omp, line-spawn and the Claude Agent SDK scrub inherited host secrets by name. The 0.20.0 desktop update contract remains: checks only report, download and restart-install are separate user choices, and system/PAC, bounded manual proxy and direct HTTPS never leak into each other. Only an exact checksum match becomes installable.
      The capability surface delivered earlier this month — AgentPrefabs, the standard Skill supply chain and review-gated external MCP — still bounds itself with read-only review, immutable revisions and per-invocation re-authorization; see the
      <a href="/AgentWorkShop/en/guide/agent-prefabs">AgentPrefabs / Skills / MCP guide</a>.
    </p>
    <div class="hw-feats">
      <div class="hw-f">
        <span class="tag">READINESS</span>
        <h3>Readiness is a real barrier</h3>
        <p>Ready is set only after adapter initialization (or explicit SQLite degradation); online recovery, offline retry and stale rollup attaches are generation-guarded; a rejected barrier is logged but no longer freezes the flush buffer.</p>
        <p><a href="https://github.com/kingdol666/AgentWorkShop/blob/main/docs/audit/evidence/2026-11-25-stability-audit/REPORT.md">Audit report →</a></p>
      </div>
      <div class="hw-f">
        <span class="tag">FAIL-CLOSED</span>
        <h3>Required schema fails closed</h3>
        <p>Required Timescale tables, hypertables, tag columns and hot-path indexes no longer swallow errors; a failure releases the pool. Optional indexes only warn, and SQLite writes self-heal.</p>
        <p><a href="https://github.com/kingdol666/AgentWorkShop/blob/main/docs/engineering/tsdb-storage-retention.md">Storage &amp; retention →</a></p>
      </div>
      <div class="hw-f">
        <span class="tag">HARDENING</span>
        <h3>Failures become readable states</h3>
        <p>CI runs a production boot smoke; three harness child families scrub host secrets by name while preserving <code>AW_ENGINE_*</code> and explicit provider keys; <code>TSDB_NOT_READY</code> is explicit.</p>
        <p><a href="https://github.com/kingdol666/AgentWorkShop/blob/main/changelog.md">Changelog →</a></p>
      </div>
    </div>
    <div class="hw-note">
      <span class="t">Verification</span>
      <p>v0.20.1 (2026-11-25): on an isolated production build — line onboarding V1–V6 <b>8/0</b> (V6 skipped), REST <b>73/73</b>, DAQ <b>17/17</b> with the degraded path still fail-closed, prefab binding <b>15/15</b>; a real omp goal task COMPLETED with a 5,153-byte, data-grounded deliverable; full unit suite <b>2,355 tests / 2,354 pass / 0 fail / 1 skip</b> on re-run (one <code>http-drivers</code> libuv teardown transient in the first run cleared at 10/10); i18n 3,496/3,496, docs 101/0, typecheck, lint and the production boot smoke green. Simulator evidence is not physical HIL; Mimosa <code>inconclusive</code>, no security-pass claim. See the <a href="https://github.com/kingdol666/AgentWorkShop/blob/main/docs/audit/evidence/2026-11-25-stability-audit/REPORT.md">stability audit report</a> and the <a href="https://github.com/kingdol666/AgentWorkShop/blob/main/docs/audit/evidence/2026-11-21-agent-prefab-acceptance/REPORT.md">Prefab/Skills/MCP live report</a>.</p>
    </div>
  </section>

  <section class="hw-sec" id="film">
    <div class="hw-sec-head">
      <span class="hw-sec-no">01</span>
      <h2 class="hw-sec-title">The system in 90 seconds</h2>
      <span class="hw-sec-en">SYSTEM FILM · v0.20.1 · 2026-11-25</span>
    </div>
    <div class="hw-sec-rule"></div>
    <p class="hw-lead">
      A task replayed on a real 0.20.1 desktop instance: submit a goal → query telemetry → two independent statistics → write a deliverable →
      check the update centre. Not a UI render and not a concept film; the numbers come from task <code>0c3e927d</code> and can be read back
      in the task list, the status timeline and the artifact drawer. On-screen text is Chinese; the English scene index is on the
      <a href="/AgentWorkShop/en/demo">demo page</a>.
    </p>
    <figure class="aw-console">
      <figcaption class="aw-console-bar">
        <span class="aw-console-tag">FILM.01</span>
        <span class="aw-console-title">AGENTWORKSHOP 0.20.1 · SYSTEM FILM</span>
        <span class="aw-console-meta">87.7s · 1920×1080 · Chinese on-screen captions</span>
      </figcaption>
      <div class="aw-console-body">
<video controls preload="metadata" :poster="'/AgentWorkShop/demo/agentworkshop-0.20.1-promo-poster.jpg'" :src="'/AgentWorkShop/demo/agentworkshop-0.20.1-promo.mp4'" style="display:block;width:100%;background:#000"></video>
</div>
      <p class="aw-console-cap">
        <b>A real task, not a mock.</b>
        A data analyst completed 270 15-second buckets / 1,912 raw points / mean 185.048 °C / +0.048 °C deviation in 6 m 37 s.
        Only 67 minutes of valid data exist, and both the film and the deliverable say so. The demo line <code>ln-cca0c356</code>
        is a shadow simulation (<code>simulated=true</code>); simulator evidence is not physical HIL or production approval;
        Mimosa is <code>inconclusive</code>, no security endorsement.
        <a href="/AgentWorkShop/en/demo">Scene index and specs →</a>
      </p>
    </figure>
  </section>

  <section class="hw-sec">
    <div class="hw-sec-head">
      <span class="hw-sec-no">02</span>
      <h2 class="hw-sec-title">Interface</h2>
      <span class="hw-sec-en">INTERFACE</span>
    </div>
    <div class="hw-sec-rule"></div>
    <p class="hw-lead">
      Every screen below was recorded from a running instance, not a render. The three share one
      event bus — a sample written by a DAQ channel is at once the twin's input, a point on the
      trend curve, and the row an agent reads.
    </p>

  <figure class="aw-console">
    <figcaption class="aw-console-bar">
      <span class="aw-console-tag">FIG.00-B</span>
      <span class="aw-console-title">CORE DEMO · 3'00" · ENGLISH UI · EN/ZH CAPTIONS</span>
      <span class="aw-console-meta">REAL UI RECORDING · ISOLATED MOCK LINE</span>
    </figcaption>
    <div class="aw-console-body">
<video controls preload="metadata" :poster="'/AgentWorkShop/demo/agentworkshop-core-demo-poster.png'" :src="'/AgentWorkShop/demo/agentworkshop-core-demo.mp4'" style="display:block;width:100%;background:#000">
  <track kind="captions" label="English" srclang="en" src="/AgentWorkShop/demo/agentworkshop-core-demo.en.vtt" default>
  <track kind="captions" label="简体中文" srclang="zh-Hans" src="/AgentWorkShop/demo/agentworkshop-core-demo.zh-Hans.vtt">
</video>
</div>
    <p class="aw-console-cap">
      <b>From the control room to the EDA studio.</b>
      Dashboard → live DAQ → EDA analysis pipeline → governed tool catalog → published ontology → four agent workspaces → plugins → analysis ledger → EDA studio. It runs on an isolated mock line with mock DAQ drivers; no physical PLC is connected and no control command is sent to real equipment. The analysis records and ontology are seeded demo data.
    </p>
  </figure>


  <figure class="aw-console">
    <figcaption class="aw-console-bar">
      <span class="aw-console-tag">FIG.01</span>
      <span class="aw-console-title">DIGITAL TWIN · LINE OVERVIEW</span>
      <span class="aw-console-meta">THREE.JS · LIVE EVENT STREAM</span>
    </figcaption>
    <div class="aw-console-body">

![Digital twin control room — line equipment, DAQ channels, trends and device monitoring on one screen](/town.png)

</div>
    <p class="aw-console-cap">
      <b>The twin is a render of the same event bus.</b>
      Equipment ledger, DAQ channels, live trends, alarm strip and device health on one screen; the
      real render readout sits top-right (129 FPS) and the quality ladder (DPR / shadows / bloom)
      tracks a wall-clock frame budget, so mid-range machines stay honest too.
    </p>
  </figure>

  <div class="aw-figs">

  <figure class="aw-console">
    <figcaption class="aw-console-bar">
      <span class="aw-console-tag">FIG.02</span>
      <span class="aw-console-title">DAQ CONSOLE · ACQUISITION</span>
      <span class="aw-console-meta">51 NODES · WS FAN-OUT</span>
    </figcaption>
    <div class="aw-console-body">

![DAQ centre — gauge strip, per-node ledger, sampling period and WS fan-out state](/daq.png)

</div>
    <p class="aw-console-cap">
      <b>The acquisition chain, end to end.</b>
      Under the gauge strip (nodes / published / consumed / lost / stored) sits the per-node ledger:
      live value, sampling period, WS fan-out state, driver type — and for control nodes the
      SET / ACT pair read back through the very calibration path used to write.
    </p>
  </figure>

  <figure class="aw-console">
    <figcaption class="aw-console-bar">
      <span class="aw-console-tag">FIG.03</span>
      <span class="aw-console-title">LINE OPERATIONS · LINE OPS</span>
      <span class="aw-console-meta">LINES · PRODUCTS · RECIPES · BATCHES</span>
    </figcaption>
    <div class="aw-console-body">

![Line operations — line cards, recipe binding, control-node counts and start entry](/line-ops.png)

</div>
    <p class="aw-console-cap">
      <b>Starting a line = gating acquisition with its recipe window.</b>
      From then on every sample carries product / recipe / batch; control nodes only declare
      classification parameters and process ranges — the actual write still passes interlock and approval.
    </p>
  </figure>

  </div>

  </section>

  <section class="hw-sec">
    <div class="hw-sec-head">
      <span class="hw-sec-no">03</span>
      <h2 class="hw-sec-title">Architecture</h2>
      <span class="hw-sec-en">ARCHITECTURE</span>
    </div>
    <div class="hw-sec-rule"></div>
    <p class="hw-lead">
      One manager behind every door: four entry points converge into one runtime; the industrial
      stack and the agent runtime share the same event bus. Every cell below is a real module you
      can open in the repository.
    </p>
    <div class="hw-arch">
      <div class="hw-layer">
        <div class="hw-layer-tag"><span class="l1">Entry</span><span class="l2">ENTRY</span></div>
        <div class="hw-cells">
          <div class="hw-cell"><span class="c1">WS</span><span class="c2">AEP v1 stream · seq resume</span></div>
          <div class="hw-cell"><span class="c1">MCP</span><span class="c2">25 in-process tools (+ 38-tool stdio gateway)</span></div>
          <div class="hw-cell"><span class="c1">A2A</span><span class="c2">JSON-RPC 2.0 + AgentCard</span></div>
          <div class="hw-cell"><span class="c1">REST</span><span class="c2">/api/workshop/**</span></div>
        </div>
      </div>
      <div class="hw-layer">
        <div class="hw-layer-tag"><span class="l1">Runtime</span><span class="l2">RUNTIME</span></div>
        <div class="hw-cells">
          <div class="hw-cell"><span class="c1">AgentChannelManager</span><span class="c2">channel &amp; instance orchestration</span></div>
          <div class="hw-cell"><span class="c1">SchedulerLoop</span><span class="c2">lead supervision · rule fallback</span></div>
          <div class="hw-cell"><span class="c1">TaskEngine</span><span class="c2">7-state task machine</span></div>
          <div class="hw-cell"><span class="c1">AgentMemory</span><span class="c2">FTS5 + optional vectors</span></div>
        </div>
      </div>
      <div class="hw-layer">
        <div class="hw-layer-tag"><span class="l1">Industrial</span><span class="l2">INDUSTRIAL</span></div>
        <div class="hw-cells">
          <div class="hw-cell"><span class="c1">DAQ gateway</span><span class="c2">per-node edge runtimes</span></div>
          <div class="hw-cell"><span class="c1">DCW write control</span><span class="c2">interlock → HITL → readback</span></div>
          <div class="hw-cell"><span class="c1">Queue</span><span class="c2">inproc / MQTT · offline buffer</span></div>
          <div class="hw-cell"><span class="c1">TSDB</span><span class="c2">SQLite / Timescale</span></div>
        </div>
      </div>
      <div class="hw-layer">
        <div class="hw-layer-tag"><span class="l1">Engines</span><span class="l2">HARNESS ×14</span></div>
        <div class="hw-cells c2col">
          <div class="hw-cell"><span class="c1">mock</span><span class="c2">in-process · scripted</span></div>
          <div class="hw-cell"><span class="c1">claude</span><span class="c2">in-process · Agent SDK</span></div>
        </div>
      </div>
      <div class="hw-layer hw-sub">
        <div class="hw-layer-tag"><span class="l1">Persistent</span><span class="l2">PERSISTENT · 6</span></div>
        <div class="hw-cells c6col">
          <div class="hw-cell"><span class="c1">omp</span><span class="c2">stdio RPC</span></div>
          <div class="hw-cell"><span class="c1">codex</span><span class="c2">app-server JSON-RPC</span></div>
          <div class="hw-cell"><span class="c1">dsh</span><span class="c2">ACP v1</span></div>
          <div class="hw-cell"><span class="c1">qwen</span><span class="c2">ACP (legacy Zed)</span></div>
          <div class="hw-cell"><span class="c1">hermes</span><span class="c2">ACP v1</span></div>
          <div class="hw-cell"><span class="c1">opencode</span><span class="c2">serve + HTTP/SSE</span></div>
        </div>
      </div>
      <div class="hw-layer hw-sub">
        <div class="hw-layer-tag"><span class="l1">Headless CLI</span><span class="l2">HEADLESS · 6</span></div>
        <div class="hw-cells c6col">
          <div class="hw-cell"><span class="c1">gemini</span><span class="c2">stream-json</span></div>
          <div class="hw-cell"><span class="c1">copilot</span><span class="c2">JSONL</span></div>
          <div class="hw-cell"><span class="c1">cursor</span><span class="c2">stream-json</span></div>
          <div class="hw-cell"><span class="c1">crush</span><span class="c2">run -q</span></div>
          <div class="hw-cell"><span class="c1">goose</span><span class="c2">stream-json</span></div>
          <div class="hw-cell"><span class="c1">pi</span><span class="c2">-p --mode json</span></div>
        </div>
      </div>
    </div>
    <p class="hw-flow-note">
      Sampling: <i>driver → queue → consumer</i> three-way fan-out (WS push · TSDB write · twin writeback)&nbsp;&nbsp;|&nbsp;&nbsp;
      Write: <i>interlock → approval → PLC write → readback</i>&nbsp;&nbsp;|&nbsp;&nbsp;Storage: <i>SQLite (channels · agents · tasks · messages · events)</i>
    </p>
  </section>

  <section class="hw-sec">
    <div class="hw-sec-head">
      <span class="hw-sec-no">04</span>
      <h2 class="hw-sec-title">Design principles</h2>
      <span class="hw-sec-en">DESIGN PRINCIPLES</span>
    </div>
    <div class="hw-sec-rule"></div>
    <div class="hw-prin">
      <div class="hw-p">
        <span class="no">01</span>
        <h3>Server-authoritative</h3>
        <p>The UI renders facts; it is not their source. Nodes, tasks and grants live server-side — the screen shows exactly as many DAQ points as the server holds.</p>
      </div>
      <div class="hw-p">
        <span class="no">02</span>
        <h3>Enforced in the data plane</h3>
        <p>Line permissions (none / read-only / operate) are enforced in the data plane: unauthorized line data never leaves the server — it is not merely hidden by the frontend.</p>
      </div>
      <div class="hw-p">
        <span class="no">03</span>
        <h3>Honest observability</h3>
        <p>Drop counters, loss metrics and pipeline watermarks are exposed as they are; the audit log attributes every action to "Channel/Member". Even <code>window.__townStats</code> refuses to lie about rendering.</p>
      </div>
      <div class="hw-p">
        <span class="no">04</span>
        <h3>Config-driven</h3>
        <p><code>config.yml &lt; runtime-settings &lt; env</code> — one descriptor registry drives both the CLI and the Settings UI. 144 settings, zero hardcoded defaults.</p>
      </div>
      <div class="hw-p">
        <span class="no">05</span>
        <h3>Protocol-stack simulation</h3>
        <p>E2E uses Modbus/OPC UA/MQTT/HTTP stacks with a PLC simulator to verify writes, readbacks and approvals; this is not physical PLC/HIL evidence. The 2026-09-24 historical wave passed ~1100+ baseline assertions; follow-up items remain individually reported.</p>
      </div>
      <div class="hw-p">
        <span class="no">06</span>
        <h3>Human in the loop</h3>
        <p>Agents propose, humans decide where policy requires, and every action is audited. Manual-mode writes wait for review; auto mode retains interlocks and audit and is never a physical-safety substitute.</p>
      </div>
    </div>
  </section>

  <section class="hw-sec">
    <div class="hw-sec-head">
      <span class="hw-sec-no">05</span>
      <h2 class="hw-sec-title">Capabilities</h2>
      <span class="hw-sec-en">CAPABILITIES</span>
    </div>
    <div class="hw-sec-rule"></div>
    <div class="hw-feats">
      <div class="hw-f"><span class="tag">UI</span><h3>ChatGPT-style harness console</h3><p>800px reading column, full-width agent blocks, a harness chip on every reply and a 26px composer; Channel / Project / entry pages rebuilt with every data-testid and interaction preserved, usable at 390px.</p></div>
      <div class="hw-f"><span class="tag">SESS</span><h3>Channel sessions</h3><p>Template → channel → session; clone base members with isolated runtime / mailbox / execution lock / engine process / memory domain. Serial inside a session, parallel across sessions; closing one leaves the rest running.</p></div>
      <div class="hw-f"><span class="tag">PRJ</span><h3>Project delivery mode</h3><p>Blueprint instantiation → plan approval → WBS with dependsOn → L1 technical review → L2 owner acceptance → deliverables; observe / supervised / auto, with CAL-3 78/78 on a real line.</p></div>
      <div class="hw-f"><span class="tag">PROTOCOL</span><h3>Six-protocol DAQ &amp; control</h3><p>Modbus TCP/RTU · OPC UA · MQTT · HTTP in both directions + the built-in serial plugin (direct RS-232/485) — connection pools, classified errors, per-driver connection tests. Protocols are plugins: newly injected protocols appear in the frontend with zero form changes.</p></div>
      <div class="hw-f"><span class="tag">R/W</span><h3>Read-write control nodes</h3><p>Every control node reads its PLC value back through the same calibration path it writes with — SET vs ACT side by side, passive and never interlocked.</p></div>
      <div class="hw-f"><span class="tag">HITL</span><h3>Human-approved writes</h3><p>Safe-range ∩ recipe-window interlock → approval → PLC write → readback → signed history; every decision audited.</p></div>
      <div class="hw-f"><span class="tag">RCT</span><h3>Recipe versioning &amp; governance</h3><p>Parameter changes versioned with attribution (source + operator + reason); roll back to any revision or last-good batch, non-destructively.</p></div>
      <div class="hw-f"><span class="tag">BATCH</span><h3>Evidence scoped to the running batch</h3><p><code>daq_query</code> resolves the active run and filters by <code>run_id</code> + <code>recipe_id</code> — after a recipe switch an agent only ever reads the recipe currently running, with the scope echoed in the header; <code>scope:'all'</code> widens it for cross-recipe review.</p></div>
      <div class="hw-f"><span class="tag">TWIN</span><h3>Hybrid twin × MPC</h3><p>Grey-box physics core + bounded PyTorch residual; TwinSnapshot / VirtualTrial / RecommendationCertificate with UQ/OOD screening and all-trajectory gates; the <code>hybrid_twin</code> profile injects twelve twin/mpc tools and stays recommendation-only by default.</p></div>
      <div class="hw-f"><span class="tag">HRN</span><h3>Multi-harness teams</h3><p>Fourteen engines behind one contract, in three transport classes (in-process / persistent session / headless CLI); each channel picks harness → provider → model, with availability probing and dispatch-time checks.</p></div>
      <div class="hw-f"><span class="tag">TEAM</span><h3>Team-scoped plugins</h3><p>Each channel keeps its own plugin switch set — a disabled plugin's tools never enter that team; plugins themselves are hot-managed.</p></div>
      <div class="hw-f"><span class="tag">PERM</span><h3>Line-level permissions</h3><p>Three-state grants enforced in the data plane; agent bindings validate line grants too.</p></div>
      <div class="hw-f"><span class="tag">OPS</span><h3>Full-operation audit log</h3><p>User / agent / system actions attributed to "Channel/Member", queryable by line, recipe, source and kind — streamed live.</p></div>
      <div class="hw-f"><span class="tag">MEM</span><h3>Persistent memory</h3><p>Private + shared domains, FTS5 with CJK segmentation, optional vector hybrid recall; team chronicle and idle reflections accrue.</p></div>
      <div class="hw-f"><span class="tag">CHAT</span><h3>Channel group chat</h3><p>A member's request becomes a trackable job, not a lost message; native HITL (omp ask → approval → receipt), member permissions and notifications first-class.</p></div>
      <div class="hw-f"><span class="tag">SCHED</span><h3>Scheduled tasks</h3><p>Attach any channel task to an interval or daily schedule — per-run history, busy-guard, consecutive-failure circuit breaker. Line patrol runs unattended.</p></div>
      <div class="hw-f"><span class="tag">QOS</span><h3>Root queue &amp; leases</h3><p>FIFO root queue with visible queue positions; queued roots never burn execution budget while waiting, and a deterministic lead-rescue sweep revives starved admissions; assignment generation + execution-lease fencing drops stale worker events; the supervision watchdog tells stuck from slow.</p></div>
      <div class="hw-f"><span class="tag">PROD</span><h3>Production hardening (v0.7.58)</h3><p>Hold-heartbeat lifecycle governance (failed writes never occupy the setpoint · change-point value clearing · line-active gate); silent mock fallback blocked; frame pixel sha256 fingerprints + day-directory object GC with DB cross-check; Timescale daily chunks + columnstore compression; heap watermark watch with child auto-respawn; governance windows persisted; grant re-checks include the channel-bound line.</p></div>
      <div class="hw-f"><span class="tag">EDA</span><h3>Data workbench &amp; EDA studio (/data · /studio)</h3><p>Three data shapes (scalars, array profiles, CCD images) with compound queries, bulk export job ledger (manifest + merged.csv) and WS live mirroring; the studio adds charts &amp; grid dashboards, golden phase-referenced deviation scoring, FDC reference-band features, SPC control charts (Nelson/I-MR/EWMA/CUSUM), commonality analysis, OCAP dispositions, virtual metrology (OOD rejection) and derived datasets — all line-scoped and preflight-checked.</p></div>
      <div class="hw-f"><span class="tag">OPT</span><h3>Process optimizer &amp; solver (v0.7.71)</h3><p>End-to-end parameter optimization: process model (lineage-verified dataset + eligibility gates) → AML training (G1–G3 gates) → profile freeze &amp; binding → hash-pinned ProblemIR compile → OSQP/SLSQP worker (process pool, timeout degradation, NaN fail-closed) → independent TS crosscheck (≤1e-6) → governed dispatch (single HITL throat, eight re-verifications, device read-back ackSummary). Agent tools, REST and MCP share one chain; optimizer tools are injected only with a valid binding.</p></div>
      <div class="hw-f"><span class="tag">GOV</span><h3>Declarative tool-face governance (v0.7.71)</h3><p>Reference checks moved onto the tool definitions themselves (104 host tools fully declared; write-family tools without a declaration are rejected at registration); plugin tools join the same check once declared, with full auditing; per-agent full-tool stdio bridge (ETag/304 incremental polling); token rotation with grace windows; DAQ push fallback requires line <code>operate</code> plus a default ±1h backfill window.</p></div>
      <div class="hw-f"><span class="tag">ONTO</span><h3>Ontology service (v0.8.0)</h3><p>Control-oriented ontology: 10 entity kinds × 8 closed relation kinds × three evidence levels × five-state lifecycle; four compiled artifacts (process model / ProblemIR delta / scene patch / guard set) under a tighten-only invariant with per-rule traces; runtime guards fail closed, ontology hashing is separated from solver IR hashing. Six-tab /ontology console (the graph tab is an interactive node-edge view with 1/2-hop neighbourhood drawer) + ten agent tools.</p></div>
      <div class="hw-f"><span class="tag">LOOP</span><h3>AI-first model loop (v0.8.0)</h3><p>Agents build the virtual model themselves — scene discovery → human-approved freeze → physics-spec skeleton → server-sampled snapshot → virtual trial — then train, propose adoption via optimizer_profile_propose, and a HITL approval publishes + rebinds so the next solve runs the new model. Verified live across two consecutive rounds (v1→v2→v3) with zero device writes.</p></div>
    </div>
  </section>

  <section class="hw-sec">
    <div class="hw-sec-head">
      <span class="hw-sec-no">06</span>
      <h2 class="hw-sec-title">Where it fits</h2>
      <span class="hw-sec-en">APPLICATIONS</span>
    </div>
    <div class="hw-sec-rule"></div>
    <div class="hw-scenes">
      <div class="hw-sc">
        <span class="ico">S.1</span>
        <div class="bd">
          <h3>Line supervision &amp; twin ops</h3>
          <p>Multi-line equipment, DAQ channels, alarms and trends on one 3D overview — second-level soft real-time, reachable from any browser.</p>
        </div>
      </div>
      <div class="hw-sc">
        <span class="ico">S.2</span>
        <div class="bd">
          <h3>Agent-assisted optimization</h3>
          <p>The controlled loop: analyze trends → propose a setpoint → human approval → write &amp; readback → numeric verdict. Auditable and reversible at every step.</p>
        </div>
      </div>
      <div class="hw-sc">
        <span class="ico">S.3</span>
        <div class="bd">
          <h3>Industrial AI research &amp; teaching</h3>
          <p>Six-protocol acquisition/write-control (serial as a plugin), multi-engine orchestration and a real simulator stack out of the box — a testbed for papers and courses, with protocol-real verification.</p>
        </div>
      </div>
      <div class="hw-sc">
        <span class="ico">S.4</span>
        <div class="bd">
          <h3>Platform extension</h3>
          <p>Typed REST SDK plus plugins that register drivers, processors and agent tools; four entry points open the platform to external systems and agents.</p>
        </div>
      </div>
    </div>
    <div class="hw-note">
      <span class="t">SCOPE</span>
      <p>AgentWorkShop is a supervisory (SCADA-adjacent) layer running at second-level soft real-time. It is not a hard real-time controller: any &lt;10 ms critical loop (interlocks, safety, servo) must live inside the PLC — setpoints written here are advisory and plant-side logic may veto.</p>
    </div>
  </section>

  <section class="hw-cta-sec">
    <div class="hw-sec-head">
      <span class="hw-sec-no">07</span>
      <h2 class="hw-sec-title">Up and running in a minute</h2>
      <span class="hw-sec-en">QUICK START</span>
    </div>
    <div class="hw-sec-rule"></div>

```bash
# install globally, run from any directory (the published tarball ships a prebuilt .output/)
npm i -g agentworkshop
aw start            # → http://localhost:3001 · config root ~/.AgentWorkShop
```

  <p class="hw-lead" style="margin-top:22px">
    Go deeper: <a href="/AgentWorkShop/en/guide/first-session">your first agent × line session</a> (the whole chain in ~2 minutes) ·
    <a href="/AgentWorkShop/en/guide/harness-ui">Harness console</a> ·
    <a href="/AgentWorkShop/en/guide/channels-sessions">Channel sessions</a> ·
    <a href="/AgentWorkShop/en/guide/projects">Project mode</a> ·
    <a href="/AgentWorkShop/en/sdk/">SDK guide</a> ·
    <a href="/AgentWorkShop/en/plugins/">plugin guide</a> ·
    <a href="/AgentWorkShop/en/cli/">aw CLI manual</a>
  </p>

  </section>

  <section class="hw-sec">
    <div class="hw-sec-head">
      <span class="hw-sec-no">08</span>
      <h2 class="hw-sec-title">Research paper</h2>
      <span class="hw-sec-en">RESEARCH PAPER</span>
    </div>
    <div class="hw-sec-rule"></div>
    <p class="hw-lead">
      The platform's mechanisms are documented in a submission-ready manuscript:
      <strong>"Agent-Mediated Online Data Acquisition and Governed Setpoint Control in Industrial
      Production Lines"</strong> (IEEE Transactions on Industrial Informatics, anonymous
      review draft, 10 pages, IEEEtran). Source and compiled PDF live in
      <code>paper/tii/TII-SUBMISSION-PACKAGE-20261112/</code>. The paper's mechanism claims are backed by
      archives in this repository: <code>docs/benchmarks/</code> (October 2026 deployment-scale
      regression campaign — 14 pipeline executions, 1134 checks, zero failed, including graded
      write-acknowledgment and HITL evidence legs), <code>docs/experiments/</code> (cast-film
      closed-loop reports) and <code>docs/audit/</code> (acceptance reports).
      <code>AW_BENCH_MODE=1</code> re-runs the same paper pipeline locally via
      <code>bench/PIPELINE.md</code>.
    </p>
  </section>

  <section class="hw-final">
    <h2>Put an agent team on a real production line</h2>
    <p>
      14 engines, 6 field protocols, 144 runtime settings and 1100+ baseline acceptance assertions (plus the follow-up wave reports) are
      already in the repository. Supervisory by design, second-level soft real-time;
      protocol-real, assertion-reproducible.
    </p>
    <div class="hw-cta">
      <a class="hw-btn primary" href="/AgentWorkShop/en/guide/getting-started">Get started <span class="arr">→</span></a>
      <a class="hw-btn" href="https://github.com/kingdol666/AgentWorkShop">View on GitHub <span class="arr">↗</span></a>
      <a class="hw-btn quiet" href="/AgentWorkShop/en/guide/license">License <span class="arr">→</span></a>
    </div>
  </section>

</div>
