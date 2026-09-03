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
  - icon: '<span class="aw-tag">CLI</span>'
    title: aw CLI · 指令注册系统
    details: config / dev / start / build / doctor / update 内置;
      三层指令注册(项目级 > 用户级 > 内建),放入目录即生效。
  - icon: '<span class="aw-tag">SDK</span>'
    title: SDK · 平台 REST 客户端
    details: createPlatformClient 类型化消费产线/数采/写控/孪生 REST 面;
      鉴权、信封解包、超时与协议守卫开箱即用。
  - icon: '<span class="aw-tag">PLG</span>'
    title: 插件 · 前后端双面增强
    details: 服务端钩子(daq:sample / daq:frame / dcw:write / line 生命周期 / scene 全事件)
      + 浏览器增强脚本 + 插件自有 API 路由,放入目录即装载。
      v0.6 起可注册自定义数采驱动/下沉处理器/节点模板与 omp 工具(运行时热注入)。
  - icon: '<span class="aw-tag">IND</span>'
    title: 真实工业栈 · 多形态数采
    details: Modbus TCP / OPC UA 数采,安全量程 ∩ 配方窗口联锁,
      HITL 人工审批 → PLC 写入 → 回读校验,逐样本批次打标。
      v0.6 支持多点轮廓(vector)与 CCD 图像帧:sink 管线加工后入 Timescale,像素入 MinIO。
  - icon: '<span class="aw-tag">R/W</span>'
    title: 数控读写一体(v0.7)
    details: 每个控制节点沿写链路同一套标定读回 PLC 当前值 —— 周期读/手动读取/Agent
      dcw_read 三通道,SET 与 ACT 在数控页与孪生面板并排呈现(读为被动观测,免审批)。
  - icon: '<span class="aw-tag">CFG</span>'
    title: 全量配置驱动(v0.7)
    details: 运行语义旋钮全部收编设置描述符(14 组 62 键):config.yml < runtime-settings <
      env(历史变量名别名兼容),项目级 .AgentWorkShop 优先、~/.AgentWorkShop 用户兜底。
      通信故障按类给出诊断与处理提示(连接/超时/量程越规/PLC 拒绝)。
  - icon: '<span class="aw-tag">TWN</span>'
    title: 3D 数字孪生
    details: Three.js 小镇实时呈现产线设备、节点健康、告警与趋势 —— 与 Agent 消费同一事件流。

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
