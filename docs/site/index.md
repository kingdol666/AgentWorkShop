---
layout: home

footer:
  message: 依据 PolyForm Noncommercial 1.0.0 开源 · 未经许可不得商用
  copyright: Copyright © 2026 kingdol (kingdol666)
---

<div class="hw-hero">
  <div class="hw-wrap">
    <p class="hw-kicker">AGENTWORKSHOP · INDUSTRIAL AGENT RUNTIME</p>
    <h1 class="hw-title">Agent 团队<span class="x">×</span>产线<span class="x">×</span>数字孪生</h1>
    <p class="hw-sub">
      一个配置驱动的运行时——<b>AI Agent 团队</b>读取真实遥测、经人工审批写入设定值,
      每个事件实时流进 <b>3D 孪生小镇</b>。监督层定位,秒级软实时;协议真实,断言可复跑。
    </p>
    <div class="hw-cta">
      <a class="hw-btn primary" href="/AgentWorkShop/guide/getting-started">快速开始 <span class="arr">→</span></a>
      <a class="hw-btn" href="/AgentWorkShop/guide/first-session">第一次 Agent × 产线会话</a>
      <a class="hw-btn" href="https://github.com/kingdol666/AgentWorkShop">GitHub ↗</a>
    </div>

<div class="hw-rail-sec">
      <div class="hw-rail-cap">
        <span>FIG.00 · 数据管线 —— 产品即这条链路</span>
        <span>SAMPLING → STORAGE → STREAM → AGENT</span>
      </div>
      <div class="hw-rail">
        <div class="hw-pulse"></div>
        <div class="hw-node"><span class="n">现场设备</span><span class="d">PLC / 传感器</span></div>
        <div class="hw-node"><span class="n">驱动 ×5</span><span class="d">MODBUS TCP/RTU·OPC UA·MQTT·HTTP</span></div>
        <div class="hw-node"><span class="n">队列</span><span class="d">INPROC / MQTT</span></div>
        <div class="hw-node"><span class="n">时序库</span><span class="d">TIMESCALE</span></div>
        <div class="hw-node"><span class="n">WS HUB</span><span class="d">AEP v1 · SEQ 续传</span></div>
        <div class="hw-node hot"><span class="n">Agent / 孪生</span><span class="d">同一事件流</span></div>
      </div>
      <div class="hw-stats">
        <div class="hw-stat"><span class="v">5</span><span class="k">现场协议</span></div>
        <div class="hw-stat"><span class="v">4</span><span class="k">接入入口</span></div>
        <div class="hw-stat"><span class="v">14</span><span class="k">执行引擎</span></div>
        <div class="hw-stat"><span class="v">99</span><span class="k">设置项 · 16 组</span></div>
        <div class="hw-stat"><span class="v">124<i>*</i></span><span class="k">验收断言 全过</span></div>
      </div>
    </div>
  </div>
</div>

<div class="hw-wrap">

  <figure class="aw-console">
    <figcaption class="aw-console-bar">
      <span class="aw-console-tag">FIG.01</span>
      <span class="aw-console-title">DIGITAL TWIN · 产线孪生总览</span>
      <span class="aw-console-meta">THREE.JS · 实时事件流</span>
    </figcaption>
    <div class="aw-console-body">

![数字孪生控制室 —— 产线设备、数采通道、趋势分析与设备监控实时同屏](/town.png)

</div>
  </figure>
  <p class="aw-cap">真实运行画面 · 设备健康 · 告警 · 趋势 · 数采通道同屏,与 Agent 消费同一事件流</p>

  <section class="hw-sec">
    <div class="hw-sec-head">
      <span class="hw-sec-no">01</span>
      <h2 class="hw-sec-title">架构</h2>
      <span class="hw-sec-en">ARCHITECTURE</span>
    </div>
    <div class="hw-sec-rule"></div>
    <p class="hw-lead">
      一个 manager 坐在每扇门后:四个入口汇入同一运行时;工业栈与 Agent
      运行时共享同一事件总线。每一格都是仓库里可点开的真实模块。
    </p>
    <div class="hw-arch">
      <div class="hw-layer">
        <div class="hw-layer-tag"><span class="l1">入口</span><span class="l2">ENTRY</span></div>
        <div class="hw-cells">
          <div class="hw-cell"><span class="c1">WS</span><span class="c2">AEP v1 事件流 · seq 续传</span></div>
          <div class="hw-cell"><span class="c1">MCP</span><span class="c2">约 25 个进程内工具</span></div>
          <div class="hw-cell"><span class="c1">A2A</span><span class="c2">JSON-RPC 2.0 + AgentCard</span></div>
          <div class="hw-cell"><span class="c1">REST</span><span class="c2">/api/workshop/**</span></div>
        </div>
      </div>
      <div class="hw-layer">
        <div class="hw-layer-tag"><span class="l1">运行时</span><span class="l2">RUNTIME</span></div>
        <div class="hw-cells">
          <div class="hw-cell"><span class="c1">AgentChannelManager</span><span class="c2">频道与实例编排</span></div>
          <div class="hw-cell"><span class="c1">SchedulerLoop</span><span class="c2">lead 监督 · 规则引擎兜底</span></div>
          <div class="hw-cell"><span class="c1">TaskEngine</span><span class="c2">7 态任务机</span></div>
          <div class="hw-cell"><span class="c1">AgentMemory</span><span class="c2">FTS5 + 可选向量</span></div>
        </div>
      </div>
      <div class="hw-layer">
        <div class="hw-layer-tag"><span class="l1">工业栈</span><span class="l2">INDUSTRIAL</span></div>
        <div class="hw-cells">
          <div class="hw-cell"><span class="c1">DAQ 网关</span><span class="c2">逐节点边缘运行时</span></div>
          <div class="hw-cell"><span class="c1">DCW 写控</span><span class="c2">联锁 → HITL → 回读</span></div>
          <div class="hw-cell"><span class="c1">队列</span><span class="c2">inproc / MQTT · 离线缓冲</span></div>
          <div class="hw-cell"><span class="c1">TSDB</span><span class="c2">SQLite / Timescale</span></div>
        </div>
      </div>
      <div class="hw-layer">
        <div class="hw-layer-tag"><span class="l1">执行引擎</span><span class="l2">HARNESS ×14</span></div>
        <div class="hw-cells c2col">
          <div class="hw-cell"><span class="c1">mock</span><span class="c2">进程内 · 剧本</span></div>
          <div class="hw-cell"><span class="c1">claude</span><span class="c2">进程内 · Agent SDK</span></div>
        </div>
      </div>
      <div class="hw-layer hw-sub">
        <div class="hw-layer-tag"><span class="l1">常驻会话</span><span class="l2">PERSISTENT SESSION · 6</span></div>
        <div class="hw-cells c6col">
          <div class="hw-cell"><span class="c1">omp</span><span class="c2">stdio RPC</span></div>
          <div class="hw-cell"><span class="c1">codex</span><span class="c2">app-server JSON-RPC</span></div>
          <div class="hw-cell"><span class="c1">dsh</span><span class="c2">ACP v1</span></div>
          <div class="hw-cell"><span class="c1">qwen</span><span class="c2">ACP(旧版 Zed)</span></div>
          <div class="hw-cell"><span class="c1">hermes</span><span class="c2">ACP v1</span></div>
          <div class="hw-cell"><span class="c1">opencode</span><span class="c2">serve + HTTP/SSE</span></div>
        </div>
      </div>
      <div class="hw-layer hw-sub">
        <div class="hw-layer-tag"><span class="l1">无头 CLI</span><span class="l2">HEADLESS CLI · 6</span></div>
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
      采样:<i>驱动 → 队列 → 消费泵</i> 三路分发(WS 直推 · TSDB 落库 · 孪生回写)&nbsp;&nbsp;|&nbsp;&nbsp;
      下发:<i>联锁 → 审批 → PLC 写入 → 回读校验</i>&nbsp;&nbsp;|&nbsp;&nbsp;存储:<i>SQLite(channels · agents · tasks · messages · events)</i>
    </p>
  </section>

  <section class="hw-sec">
    <div class="hw-sec-head">
      <span class="hw-sec-no">02</span>
      <h2 class="hw-sec-title">设计思路</h2>
      <span class="hw-sec-en">DESIGN PRINCIPLES</span>
    </div>
    <div class="hw-sec-rule"></div>
    <div class="hw-prin">
      <div class="hw-p">
        <span class="no">01</span>
        <h3>服务端权威</h3>
        <p>界面是事实的渲染,不是事实的来源。节点、任务、授权以服务端为唯一事实源——有多少 Node,界面就有多少数采点。</p>
      </div>
      <div class="hw-p">
        <span class="no">02</span>
        <h3>数据面强制</h3>
        <p>产线权限三态(无权/仅查看/可操控)在数据面执行:无权产线的信息不离开服务端,而不是靠前端隐藏。</p>
      </div>
      <div class="hw-p">
        <span class="no">03</span>
        <h3>诚实可观测</h3>
        <p>丢弃计数、丢失指标、管线水位全部真实暴露;运维日志三源归属到「Channel/成员」。<code>window.__townStats</code> 连渲染指标也不说谎。</p>
      </div>
      <div class="hw-p">
        <span class="no">04</span>
        <h3>配置驱动</h3>
        <p><code>config.yml &lt; runtime-settings &lt; env</code>,同一份描述符同时驱动 CLI 与设置页——99 个设置项(32 live / 67 restart),代码零硬编码默认。</p>
      </div>
      <div class="hw-p">
        <span class="no">05</span>
        <h3>协议真实验证</h3>
        <p>E2E 跑在真实 Modbus/OPC UA/MQTT/HTTP 栈上:真写 PLC、真回读、真审批——不是 mock 自证。当前 head 上 124 项验收断言全过(v0.7.20 历史基线 156 项)。</p>
      </div>
      <div class="hw-p">
        <span class="no">06</span>
        <h3>人在环路</h3>
        <p>Agent 提议,人批准,系统执行,全程留痕。manual 绑定的下发挂起待审,批准即真实写入,裁决人入审计日志。</p>
      </div>
    </div>
  </section>

  <section class="hw-sec">
    <div class="hw-sec-head">
      <span class="hw-sec-no">03</span>
      <h2 class="hw-sec-title">能力全景</h2>
      <span class="hw-sec-en">CAPABILITIES</span>
    </div>
    <div class="hw-sec-rule"></div>
    <div class="hw-feats">
      <div class="hw-f"><span class="tag">PROTOCOL</span><h3>五协议数采与数控</h3><p>Modbus TCP/RTU · OPC UA · MQTT · HTTP 双向驱动——连接池、故障分类诊断、逐驱动连接测试;插件可注册新协议。</p></div>
      <div class="hw-f"><span class="tag">R/W</span><h3>数控读写一体</h3><p>每个控制节点沿写链路同一套标定读回 PLC 当前值——SET 与 ACT 并排呈现,读为被动观测,免审批。</p></div>
      <div class="hw-f"><span class="tag">HITL</span><h3>人机协同写控</h3><p>安全量程 ∩ 配方窗口联锁 → 人工审批 → PLC 写入 → 回读校验 → 签名写历史;裁决人留痕审计。</p></div>
      <div class="hw-f"><span class="tag">RCT</span><h3>Recipe 版本化治理</h3><p>参数按版本入史(来源+操作者+原因),一键回退任意版本或已知良好批次——非破坏,历史完整。</p></div>
      <div class="hw-f"><span class="tag">HRN</span><h3>多引擎 Agent 团队</h3><p>十四个引擎一个契约(进程内 / 常驻会话 / 无头 CLI 三类),每频道可选 harness → provider → model;可用性探测 + 执行前强校验。</p></div>
      <div class="hw-f"><span class="tag">TEAM</span><h3>团队级插件开关</h3><p>每 Channel 独立插件开关组——被关闭插件的工具不注入该团队;插件本体热管理。</p></div>
      <div class="hw-f"><span class="tag">PERM</span><h3>产线级权限</h3><p>三态授权在数据面强制,无权产线信息不离开服务端;Agent 绑定校验产线授权。</p></div>
      <div class="hw-f"><span class="tag">OPS</span><h3>全操作运维日志</h3><p>用户/Agent/系统三源归属「Channel/成员」,按产线/Recipe/来源检索,WS 实时推送。</p></div>
      <div class="hw-f"><span class="tag">MEM</span><h3>持久记忆</h3><p>私有 + 共享双域,FTS5 CJK 切分,可选向量混合检索;团队编年史与空闲反思持续沉淀。</p></div>
    </div>
  </section>

  <section class="hw-sec">
    <div class="hw-sec-head">
      <span class="hw-sec-no">04</span>
      <h2 class="hw-sec-title">应用前景</h2>
      <span class="hw-sec-en">WHERE IT FITS</span>
    </div>
    <div class="hw-sec-rule"></div>
    <div class="hw-scenes">
      <div class="hw-sc">
        <span class="ico">S.1</span>
        <div class="bd">
          <h3>产线监督与孪生运维</h3>
          <p>多产线设备、数采通道、告警与趋势在一张 3D 总览上;秒级软实时,浏览器随处可达。</p>
        </div>
      </div>
      <div class="hw-sc">
        <span class="ico">S.2</span>
        <div class="bd">
          <h3>Agent 辅助工艺优化</h3>
          <p>「分析趋势 → 提议设定值 → 人工批准 → 写入回读 → 数值判定」的受控闭环,每一步可审计、可回退。</p>
        </div>
      </div>
      <div class="hw-sc">
        <span class="ico">S.3</span>
        <div class="bd">
          <h3>工业 AI 教学与科研</h3>
          <p>五协议数采/写控、多引擎编排、真实模拟器栈开箱即用——论文与课程的实验床,协议真实验证。</p>
        </div>
      </div>
      <div class="hw-sc">
        <span class="ico">S.4</span>
        <div class="bd">
          <h3>平台化二次开发</h3>
          <p>SDK 类型化 REST 客户端 + 插件注册驱动/处理器/工具;四入口把能力开放给外部系统与 Agent。</p>
        </div>
      </div>
    </div>
    <div class="hw-note">
      <span class="t">定位</span>
      <p>AgentWorkShop 是监督层(SCADA 邻接),运行在秒级软实时。它不是硬实时控制器:任何 &lt;10ms 的关键回路(联锁/安全/伺服)必须留在 PLC 内——此处写入的设定值是建议值,产线侧逻辑可以否决。</p>
    </div>
  </section>

  <section class="hw-cta-sec">
    <div class="hw-sec-head">
      <span class="hw-sec-no">05</span>
      <h2 class="hw-sec-title">一分钟上手</h2>
      <span class="hw-sec-en">QUICK START</span>
    </div>
    <div class="hw-sec-rule"></div>
    <div class="hw-term">
      <div class="hw-term-bar"><i>●</i> aw · zsh — repo / home 双模式</div>
      <div class="hw-term-body">
        <span class="cm"># 全局安装,任意目录启动(发布包自带预构建产物,无需再构建)</span><br>
        <span class="pr">$</span> npm i -g agentworkshop<br>
        <span class="pr">$</span> aw start&nbsp;&nbsp;&nbsp;&nbsp;<span class="cm"># → http://localhost:3001 · 配置根 ~/.AgentWorkShop</span>
      </div>
    </div>
    <p class="hw-lead" style="margin-top:18px">
      深入一步:<a href="/AgentWorkShop/guide/first-session">第一次 Agent × 产线会话</a>(约 2 分钟跑通全链) ·
      <a href="/AgentWorkShop/sdk/">SDK 开发指南</a> ·
      <a href="/AgentWorkShop/plugins/">插件开发指南</a> ·
      <a href="/AgentWorkShop/cli/">aw CLI 手册</a>
    </p>
  </section>

</div>
