---
layout: home

hero:
  name: "AgentWorkShop"
  text: "Agent 团队 × 产线 × 数字孪生"
  tagline: 一个配置驱动的运行时 —— AI Agent 团队读取真实遥测、经人工审批写入设定值,
    每个事件实时流进 3D 孪生小镇。npm 一键安装,SDK 集成,插件增强。
  actions:
    - theme: brand
      text: 快速开始
      link: /guide/getting-started
    - theme: alt
      text: SDK 开发指南
      link: /sdk/
    - theme: alt
      text: 插件开发指南
      link: /plugins/

features:
  - icon: '<span class="aw-tag">PKG</span>'
    title: 一键安装 · 任意目录启动
    details: npm i -g agentworkshop 后,任意目录 aw start。首次启动自动构建并初始化
      ~/.AgentWorkShop 配置根 —— 与工作目录和环境无关。
  - icon: '<span class="aw-tag">PLC</span>'
    title: 五协议数采与数控
    details: Modbus TCP / Modbus RTU(串口网关透传)/ OPC UA / MQTT / HTTP 双向驱动
      —— 连接池、故障分类诊断、逐驱动连接测试;真实协议下完成数采与写控全链 E2E。
  - icon: '<span class="aw-tag">HITL</span>'
    title: 人机协同写控(HITL)
    details: 安全量程 ∩ 配方窗口联锁 → HITL 人工审批 → PLC 写入 → 回读校验 → 签名写历史;
      Agent 下发挂起待审,批准即执行,裁决人留痕审计。
  - icon: '<span class="aw-tag">RCT</span>'
    title: Recipe 版本化治理
    details: 配方参数按版本入史(来源 用户/Agent/系统 + 操作者 + 原因),一键回退到任意
      历史版本或已知良好批次;Agent 可经工具保存最佳参数、查询版本 diff、执行回退。
  - icon: '<span class="aw-tag">HRN</span>'
    title: 多 Harness Agent 团队
    details: omp / codex / dsh / opencode / mock / claude 一个 AgentInterface —— 每频道可选
      harness → provider → model;环境可用性探测(未安装禁选)+ 执行前强校验,四引擎
      并行真实产线作业 E2E 验证。
  - icon: '<span class="aw-tag">R/W</span>'
    title: 数控读写一体
    details: 每个控制节点沿写链路同一套标定读回 PLC 当前值 —— 周期读/手动读取/Agent
      dcw_read 三通道,SET 与 ACT 在数控页与孪生面板并排呈现(读为被动观测,免审批)。
  - icon: '<span class="aw-tag">OPS</span>'
    title: 全操作运维日志
    details: 用户 / Agent / 系统三源归属,操作者落到「Channel名/成员名」;按产线/产品/
      Recipe/来源/分类/关键词检索,WS 实时推送;Agent 可经工具自查负责产线的日志与
      Recipe 变更史。
  - icon: '<span class="aw-tag">PLG</span>'
    title: 插件 · 前后端双面增强
    details: 服务端钩子(daq:sample / dcw:write / scene 全事件)+ 自定义数采驱动/处理器/
      节点模板 + omp 工具热注入;SDK 提供类型化 REST 客户端与权限感知上下文。
  - icon: '<span class="aw-tag">TEA</span>'
    title: 团队级插件开关
    details: 建队勾选或团队弹层随时切换(每 Channel 独立,channel_plugins 表承载);
      被关闭插件的工具不注入该团队 Agent、派发同源拒绝。插件本体支持热管理
      (/plugins 管理页 + aw plugin list/enable/disable)。
  - icon: '<span class="aw-tag">TWN</span>'
    title: 3D 数字孪生
    details: Three.js 小镇实时呈现产线设备、节点健康、告警与趋势 —— 与 Agent 消费同一
      事件流。自适应画质阶梯(DPR/阴影/Bloom 分档 + 墙钟 FPS 预算)自动匹配机器,
      window.__townStats 暴露 fps/drawCalls/tier 等真实渲染指标。

footer:
  message: 依据 PolyForm Noncommercial 1.0.0 开源 · 未经许可不得商用
  copyright: Copyright © 2026 kingdol (kingdol666)
---

<div class="aw-ruler" aria-hidden="true"></div>

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
<p class="aw-cap">设备 9 台 · 数采节点 51 · 数采通道 51 —— 与 Agent 消费同一事件流</p>

<figure class="aw-console">
  <figcaption class="aw-console-bar">
    <span class="aw-console-tag">FIG.02</span>
    <span class="aw-console-title">LINE OPERATIONS · 产线运营</span>
    <span class="aw-console-meta">MODBUS TCP / OPC UA</span>
  </figcaption>
  <div class="aw-console-body">

![产线运营 —— 产线/产品/配方/批次隔离,联锁写控入口](/line-ops.png)

  </div>
</figure>
<p class="aw-cap">产线/配方/批次隔离 · 联锁写控 · 逐样本批次打标</p>

```bash
npm i -g agentworkshop
aw start        # 任意目录启动 → http://localhost:3000
```

<div class="aw-statusbar">

<span>WS / MCP / A2A / REST</span>
<span>Nuxt 4 · node:sqlite</span>
<span>PolyForm NC 1.0</span>

</div>
