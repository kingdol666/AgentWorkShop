---
layout: home

---

<div class="hw-hero">
  <div class="hw-wrap">
    <p class="hw-kicker">AGENTWORKSHOP · INDUSTRIAL AGENT RUNTIME</p>
    <h1 class="hw-title">Agent teams<span class="x">×</span>the line<span class="x">×</span>the twin</h1>
    <p class="hw-sub">
      A configuration-driven runtime where <b>AI agent teams</b> read real telemetry and write
      setpoints through human approval — every event streaming live into a <b>3D digital twin</b>.
      Supervisory by design, second-level soft real-time, protocol-real and assertion-verifiable.
    </p>
    <div class="hw-cta">
      <a class="hw-btn primary" href="/AgentWorkShop/en/guide/getting-started">Get started <span class="arr">→</span></a>
      <a class="hw-btn" href="/AgentWorkShop/en/guide/first-session">Your first agent × line session</a>
      <a class="hw-btn" href="https://github.com/kingdol666/AgentWorkShop">GitHub ↗</a>
    </div>

<div class="hw-rail-sec">
      <div class="hw-rail-cap">
        <span>FIG.00 · THE DATA PIPELINE — THE PRODUCT IS THIS CHAIN</span>
        <span>SAMPLING → STORAGE → STREAM → AGENT</span>
      </div>
      <div class="hw-rail">
        <div class="hw-pulse"></div>
        <div class="hw-node"><span class="n">Field devices</span><span class="d">PLC / SENSORS</span></div>
        <div class="hw-node"><span class="n">Drivers ×5</span><span class="d">MODBUS TCP/RTU·OPC UA·MQTT·HTTP</span></div>
        <div class="hw-node"><span class="n">Queue</span><span class="d">INPROC / MQTT</span></div>
        <div class="hw-node"><span class="n">TSDB</span><span class="d">TIMESCALE</span></div>
        <div class="hw-node"><span class="n">WS HUB</span><span class="d">AEP v1 · SEQ RESUME</span></div>
        <div class="hw-node hot"><span class="n">Agent / Twin</span><span class="d">SAME EVENT STREAM</span></div>
      </div>
      <div class="hw-stats">
        <div class="hw-stat"><span class="v">5</span><span class="k">FIELD PROTOCOLS</span></div>
        <div class="hw-stat"><span class="v">4</span><span class="k">ENTRY POINTS</span></div>
        <div class="hw-stat"><span class="v">14</span><span class="k">ENGINES</span></div>
        <div class="hw-stat"><span class="v">98</span><span class="k">SETTINGS · 16 GROUPS</span></div>
        <div class="hw-stat"><span class="v">124<i>*</i></span><span class="k">ACCEPTANCE CHECKS PASS</span></div>
      </div>
    </div>
  </div>
</div>

<div class="hw-wrap">

  <figure class="aw-console">
    <figcaption class="aw-console-bar">
      <span class="aw-console-tag">FIG.01</span>
      <span class="aw-console-title">DIGITAL TWIN · LINE OVERVIEW</span>
      <span class="aw-console-meta">THREE.JS · LIVE EVENT STREAM</span>
    </figcaption>
    <div class="aw-console-body">

![Digital twin control room — line equipment, DAQ channels, trends and device monitoring on one screen](/town.png)

</div>
  </figure>
  <p class="aw-cap">Real running system · equipment health · alarms · trends · DAQ channels, fed by the same event stream the agents consume</p>

  <section class="hw-sec">
    <div class="hw-sec-head">
      <span class="hw-sec-no">01</span>
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
          <div class="hw-cell"><span class="c1">MCP</span><span class="c2">~25 in-process tools</span></div>
          <div class="hw-cell"><span class="c1">A2A</span><span class="c2">JSON-RPC 2.0 + AgentCard</span></div>
          <div class="hw-cell"><span class="c1">REST</span><span class="c2">/api/workshop/**</span></div>
        </div>
      </div>
      <div class="hw-layer">
        <div class="hw-layer-tag"><span class="l1">Runtime</span><span class="l2">RUNTIME</span></div>
        <div class="hw-cells">
          <div class="hw-cell"><span class="c1">AgentChannelManager</span><span class="c2">channel & instance orchestration</span></div>
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
        <div class="hw-layer-tag"><span class="l1">Persistent</span><span class="l2">PERSISTENT SESSION · 6</span></div>
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
        <div class="hw-layer-tag"><span class="l1">Headless CLI</span><span class="l2">HEADLESS CLI · 6</span></div>
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
      <span class="hw-sec-no">02</span>
      <h2 class="hw-sec-title">Design principles</h2>
      <span class="hw-sec-en">DESIGN PRINCIPLES</span>
    </div>
    <div class="hw-sec-rule"></div>
    <div class="hw-prin">
      <div class="hw-p">
        <span class="no">01</span>
        <h3>Server-authoritative</h3>
        <p>The UI renders facts; it is not their source. Nodes, tasks and grants live server-side — as many DAQ points as the server holds, that is exactly what the screen shows.</p>
      </div>
      <div class="hw-p">
        <span class="no">02</span>
        <h3>Enforced in the data plane</h3>
        <p>Line permissions (none / read-only / operate) are enforced in the data plane: unauthorized line data never leaves the server, rather than being hidden by the frontend.</p>
      </div>
      <div class="hw-p">
        <span class="no">03</span>
        <h3>Honest observability</h3>
        <p>Drop counters, loss metrics and pipeline watermarks are exposed as they are; the ops log attributes every action to "Channel/Member". Even <code>window.__townStats</code> refuses to lie about rendering.</p>
      </div>
      <div class="hw-p">
        <span class="no">04</span>
        <h3>Config-driven</h3>
        <p><code>config.yml &lt; runtime-settings &lt; env</code> — one descriptor registry drives both the CLI and the Settings UI. 98 settings across 16 groups (32 live / 66 restart), zero hardcoded defaults.</p>
      </div>
      <div class="hw-p">
        <span class="no">05</span>
        <h3>Protocol-real verification</h3>
        <p>E2E suites run on a real Modbus/OPC UA/MQTT/HTTP stack: real PLC writes, real readbacks, real approvals — not mock self-certification. 124 acceptance assertions pass at current head (156 was the v0.7.20 baseline).</p>
      </div>
      <div class="hw-p">
        <span class="no">06</span>
        <h3>Human in the loop</h3>
        <p>Agents propose, humans approve, the system executes, everything is audited. Manual-mode writes pend for review; approving performs a real, readback-verified PLC write.</p>
      </div>
    </div>
  </section>

  <section class="hw-sec">
    <div class="hw-sec-head">
      <span class="hw-sec-no">03</span>
      <h2 class="hw-sec-title">Capabilities</h2>
      <span class="hw-sec-en">CAPABILITIES</span>
    </div>
    <div class="hw-sec-rule"></div>
    <div class="hw-feats">
      <div class="hw-f"><span class="tag">PROTOCOL</span><h3>Five-protocol DAQ & control</h3><p>Modbus TCP/RTU · OPC UA · MQTT · HTTP, both directions — connection pools, classified errors, per-driver connection tests; plugins register new protocols.</p></div>
      <div class="hw-f"><span class="tag">R/W</span><h3>Read-write control nodes</h3><p>Every control node reads its PLC value back through the same calibration path it writes with — SET vs ACT side by side, passive and never interlocked.</p></div>
      <div class="hw-f"><span class="tag">HITL</span><h3>Human-approved writes</h3><p>Safe-range ∩ recipe-window interlock → approval → PLC write → readback → signed history; every decision audited.</p></div>
      <div class="hw-f"><span class="tag">RCT</span><h3>Recipe versioning</h3><p>Parameter changes versioned with attribution (source + operator + reason); roll back to any revision or last-good batch, non-destructively.</p></div>
      <div class="hw-f"><span class="tag">HRN</span><h3>Multi-harness teams</h3><p>Fourteen engines behind one contract, in three transport classes (in-process / persistent session / headless CLI); each channel picks harness → provider → model, with availability probing and dispatch-time checks.</p></div>
      <div class="hw-f"><span class="tag">TEAM</span><h3>Team-scoped plugins</h3><p>Each channel keeps its own plugin switch set — a disabled plugin's tools never enter that team; plugins themselves are hot-managed.</p></div>
      <div class="hw-f"><span class="tag">PERM</span><h3>Line-level permissions</h3><p>Three-state grants enforced in the data plane; agent bindings validate line grants too.</p></div>
      <div class="hw-f"><span class="tag">OPS</span><h3>Full-operation audit log</h3><p>User / agent / system actions attributed to "Channel/Member", queryable by line, recipe, source and kind — streamed live.</p></div>
      <div class="hw-f"><span class="tag">MEM</span><h3>Persistent memory</h3><p>Private + shared domains, FTS5 with CJK segmentation, optional vector hybrid recall; team chronicle and idle reflections accrue.</p></div>
    </div>
  </section>

  <section class="hw-sec">
    <div class="hw-sec-head">
      <span class="hw-sec-no">04</span>
      <h2 class="hw-sec-title">Where it fits</h2>
      <span class="hw-sec-en">APPLICATIONS</span>
    </div>
    <div class="hw-sec-rule"></div>
    <div class="hw-scenes">
      <div class="hw-sc">
        <span class="ico">S.1</span>
        <div class="bd">
          <h3>Line supervision & twin ops</h3>
          <p>Multi-line equipment, DAQ channels, alarms and trends on one 3D overview — second-level soft real-time, reachable from any browser.</p>
        </div>
      </div>
      <div class="hw-sc">
        <span class="ico">S.2</span>
        <div class="bd">
          <h3>Agent-assisted optimization</h3>
          <p>The controlled loop: analyze trends → propose a setpoint → human approval → write & readback → numeric verdict. Auditable and reversible at every step.</p>
        </div>
      </div>
      <div class="hw-sc">
        <span class="ico">S.3</span>
        <div class="bd">
          <h3>Industrial AI research & teaching</h3>
          <p>Five-protocol acquisition/write-control and multi-engine orchestration out of the box — an experiment bed with protocol-real verification.</p>
        </div>
      </div>
      <div class="hw-sc">
        <span class="ico">S.4</span>
        <div class="bd">
          <h3>Platform & ecosystem</h3>
          <p>Typed REST SDK plus plugins that register drivers, processors and agent tools; four entry points open the platform to external systems.</p>
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
      <span class="hw-sec-no">05</span>
      <h2 class="hw-sec-title">Up and running in a minute</h2>
      <span class="hw-sec-en">QUICK START</span>
    </div>
    <div class="hw-sec-rule"></div>
    <div class="hw-term">
      <div class="hw-term-bar"><i>●</i> aw · zsh — repo / home dual mode</div>
      <div class="hw-term-body">
        <span class="cm"># install globally, run from any directory (the published tarball ships a prebuilt .output/)</span><br>
        <span class="pr">$</span> npm i -g agentworkshop<br>
        <span class="pr">$</span> aw start&nbsp;&nbsp;&nbsp;&nbsp;<span class="cm"># → http://localhost:3001 · config root ~/.AgentWorkShop</span>
      </div>
    </div>
    <p class="hw-lead" style="margin-top:18px">
      Go deeper: <a href="/AgentWorkShop/en/guide/first-session">your first agent × line session</a> (about 2 minutes) ·
      <a href="/AgentWorkShop/en/sdk/">SDK guide</a> ·
      <a href="/AgentWorkShop/en/plugins/">Plugin guide</a> ·
      <a href="/AgentWorkShop/en/cli/">aw CLI manual</a>
    </p>
  </section>

</div>
