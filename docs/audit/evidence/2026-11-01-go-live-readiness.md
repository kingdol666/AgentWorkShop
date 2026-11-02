# 系统设计与功能终检 + 上线路径书(go-live-readiness)

**时间**:2026-11-01 18:2x · v0.8.8 · 全栈复活后八项复检

---

## 0. 一句话回答

**设计已收敛、功能全测试基本通过验收:受控试点可以上线真实场景。** 上线动作本身已被三轮真机演练固化为确定性路径——拿着产线协议文档走 `aw-protocol-onboarding` skill 的八步(预检→蓝图→**澄清门**→能力匹配→连通预检→供给配置→镜像跑通→割接六步),节点的 daq/dcw 配置、Channel 创建、镜像实测、无缝衔接全部有已验证的命令级路径,**换一份文档即换一条产线**。

## 1. 八项运行面复检(本轮 fresh)

| # | 检查项 | 结果 |
| --- | --- | --- |
| 1 | 平台健康 | ok · v0.8.8 · activeChannels=3 · wiredAgents=4 |
| 2 | 插件面 | **11/11 enabled, failures=0**(diag-bridge 2.3.0 / rag-bridge 2.2.0 / idd-closedloop / serial 全新版本在位) |
| 3 | 工具注册表 | **126/126 available** |
| 4 | 双桥连通 | diag-bridge remote **ok**(IDD 17 runs 可见) |
| 5 | 采集活性 | PROTO3 熔体压力新鲜样本(9.7s 龄) |
| 6 | DCW 写通道 | 吹气 SP=2.6 在位;journal 锚链完整(manual/recipe/agent 三源) |
| 7 | 分析/诊断台账 | **diag_results 113 条**按 id 即查 |
| 8 | 频道(真实 harness) | PROTO3 频道 llm=ustc/deepseek-flash 绑定 ln-5402968a;另一优化频道同模型在位 |

## 2. 设计与功能总评(基于本 session 十轮实测)

**设计质量 8.5/10**(架构评审结论维持):调度循环/任务引擎 A 级;五层验收 T0-T4 全绿(除 model-loop 51/53 的 twin 工具面回归 E-3 已立案);治理面(授权门/负向拒绝/账本为准/回执认领)是系统最强项。

**功能面实测全景**:
- 多协议采集:同线 http+mqtt+modbus-tcp 三驱动同跑,运行中动态加协议即插即采
- 下发控制:readback-verified 链 + 步限/频控/量程三闸(步限按实时现值算)
- recipe:版本化/历史锚链/一键回退(三方一致)/UI 版本与下发历史
- Channel×Agent:wait=true 挂起等待语义(2.3.0/2.2.0 新增)、异步回执自动送达、HITL 带推理全文、工具按 Channel/Agent 启停、按 AgentId 动态注入、无权限结构化 feedback
- IDD/RAG 集成:异步后台+进度可查+结果台账 113 条;deepseek-flash 真机作业三层能力实证(治理纪律/环境自证/数据素养)

## 3. 上线路径(产线文档 → 无缝衔接真实场景)

**已固化的确定性路径**(三轮真机演练:PROTO2 割接演练 / PROTO3 澄清门轮 / 本轮):

```
① 预检        node scripts/onboarding/preflight.mjs --json(生产附加模式纪律)
② 蓝图        逐点提取 {方向/协议/地址/取值路径/单位/量程/周期/期望值}
③ 澄清门      A 文档缺口/B 系统必需/C 意图确认 三类必问用户(clarifications[] + mapsTo)
④ 能力匹配    内置 9 驱动对照;不支持→插件适配(最小扩展面)
⑤ 连通预检    node scripts/onboarding/test-connection.mjs(全绿才进供给)
⑥ 供给配置    provision-line 一键:产线+daq/dcw 节点+产品+配方+开批次
⑦ 镜像实测    verify-mirror 逐节点确定性断言 + 导出五项核对 + 写穿 readback
⑧ 割接六步    真实端点预检→只读浸泡30min→单点最小步写(三方一致)→PATCH driverConfig
              (零重建)→verify-line V1-V6→交付割接清单
```

**Channel 侧**(数据源验证通过后):forge-channel 模板实例化→Agent 绑定(权限模型 v2)→执行模式+llm 配置→种子任务→HITL 观察作业。

**配图 skill**:aw-protocol-onboarding / aw-line-onboarding / aw-plc-sim-twin 三 skill 覆盖从文档到孪生到频道的全流程;文档格式前提=Markdown/CSV/JSON(PDF/Word 需先转文本)。

## 4. 上线判定与硬门

- **受控试点:GO**(三轮真机演练 PROVEN;八项复检全绿;Agent 中枢 HITL+异步插件作业真机验证)
- **无人值守:NO-GO**,四个待办:E-1 资源独占(本轮反复复现的内存挤压)/ E-3 twin 工具面回归修复 / 注册表 description 刷新缺陷 / D-1 kb 引擎侧资源
- **真实上线硬门清单**(每条都有已验证的检查方法):
  1. 协议匹配核对(protocol-matrix;S7 仅桩)
  2. S11 未知驱动 fail-loud / S15 Modbus 字节序与范围
  3. `AW_BENCH_MODE` 未设(生产纪律)
  4. MQTT broker 认证(非匿名)/ OPC UA securityMode
  5. 启动 env 四件套(AW_MODE/AW_HOME/AW_ALLOW_PRIVATE_OUTBOUND/AW_MCP_ENABLED)+ runbook(docs/runbook-production-instance.md)
  6. 凭据只进 secretRef;数据类型超 scalar/vector/image 需核心扩展评估

**结论:拿上产线协议文档,按 ①→⑧ 走,实测跑通即无缝上线;系统侧已无阻断项。**

*证据链:docs/audit/evidence/2026-10-31-proto-accept/(割接演练 PROVEN)、2026-10-31-proto-onboard-clarify/(澄清门轮)、2026-11-01-{toolface-verify,final-acceptance,iddrag-async}/(工具面/五层终验/IDD-RAG 异步);runbook=docs/runbook-production-instance.md。*
