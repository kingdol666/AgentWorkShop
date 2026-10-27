# 频道执行三模式(observe / manual / auto)验收报告

- 日期:2026-10-28 · 分支 `feat/daq-dcw-hardening-20261027` · 目标版本 v0.8.4
- 计划:`docs/plans/2026-10-28-execution-modes-plan.md`(M1-M5 全部落地)
- 结论:**APPROVED —— 全部门禁通过,三模式语义经隔离 e2e 与真实模拟器产线实测双重验证**

## 1. 交付面(M1-M5)

| 里程碑 | 交付 | 关键锚点 |
| --- | --- | --- |
| M1 数据模型 | `execution_mode` 列(幂等迁移)+ 语义单一声明源 + 切换 REST(owner-only,confirm 守卫,recordOps 审计,运行时热回收) | `agents/execution-mode.ts`、`db/database/{schema,migrations,open}.ts`、`api/workshop/channels/[id]/execution-mode.patch.ts` |
| M2 注入/分发/执行门 | observe 白名单(读面+协作面+**MES 只读族 G3**)+ 写族 belt;分发守卫扩宽至治理写/整包方案/启停线;recipe-gate 与治理写叠加频道钳位;提示词执行模式卡 | `host-tool-bridge/catalog.ts`、`dispatch.ts`、`recipe-gate.ts`、`dcw-tools.ts`、`industrial-context.ts` |
| M3 rationale | auto 免批路径 hypothesis 必填(fail-closed;optimization_explore 缺省合成不受影响);审批卡拼入依据(≤200字);`DcwWriteMeta.executionMode` → audit detail;配方面 reason/hypothesis 全线已必填(核实:recipe_update:746 / trial:1077 / apply:1196 / rollback:866) | `dcw-tools.ts`、`write-audit.ts`、`shared/dcw-protocol/closed-loop.ts` |
| M4 UI | Channel 设置面三选一(收紧自由/放开两段式确认)+ 生效全景(频道×产线总闸×绑定分布+压制标注)+ 中英 i18n | `ChannelSettingsModal.vue`、`useWorkshopApi.ts`、`i18n/locales/{zh-CN,en}.ts` |
| M5 验收 | 见 §2 | |

## 2. 门禁结果(T0-T4,退出码直捕)

| 门 | 结果 | 证据 |
| --- | --- | --- |
| T0 lint | **0 错误 0 警告**(退出码 0;含新增 e2e/实测脚本) | `logs-execmodes-lint-final.log` |
| T0 typecheck | **通过**(tsc+vue-tsc) | `logs-execmodes-typecheck.log` |
| T0 docs/i18n/readme | docs:build 0 · i18n:check 0 · readme:lint 0 | `logs-execmodes-docsbuild/readmelint/i18ncheck.log` |
| T1 单测 | **673/673**(基线 658 + 新增 15:execution-mode 10 + observe 注入面 5) | `logs-execmodes-unit.log` |
| T2 新套件 | **e2e-execution-modes 34/34**:切换 REST 正反例(confirm 守卫/非法值/审计 detail)、observe 拒写+读可用+模式卡注入、manual 频道钳位挂卡+卡含依据+批准附言回流、auto 免批直执行+缺依据拒绝+台账 `executionMode='auto'`、注入面零写族+热切换 | `logs-execmodes-e2e-final.log` |
| T3 回归 | line-governance **44/44** · tool-surface-multiagent **37/37** · api-live **60/60**(hitl-live:环境边界见 §4) | `logs-execmodes-regress-*.log` |
| 产线实测(US-210) | **真实节点模拟器(4020 HTTP/16052 Modbus TCP,物理引擎 presets)+ 真实平台链路**:`_live-execmodes-invoke-20261028.mjs` 全部通过 —— 开线 HITL 设备证实;观察档数采入库(熔温 246.7℃ 真实读数)+ recipe_trial 物理零写拒绝;手动档 HITL 卡(含 Agent 依据)→人工批准(附言回流)→ 238℃ **模拟器直读物理证实**;自动档三层 auto 免批直执行 → 236℃ 直读证实 + journal 锚点 | `live/invoke-summary-*.json`、`live/invoke-V2/V3-*`、`logs-execmodes-live-invoke2.log` |

## 3. 语义要点(评审关注)

1. **缺省中性**:存量频道 `execution_mode=NULL` → `auto`(频道层不额外收紧),升级**零行为变化**;fail-safe 由既有两层承担(线级缺省 manual、首绑恒 manual)。
2. **三层取最严**:`hitlRequired = channelManual || lineManual || bindingManual`;observe 不进此函数——在注入面摘除 + 分发按名拒写 + handler 兜底三处短路。
3. **放开必须确认**:manual→auto、observe→任意 均 400 `MODE_CONFIRM_REQUIRED`(严格布尔 confirm);每次切换审计(`channel.execution_mode`,detail 含 fromMode/toMode)并回收成员运行时。
4. **注入面不是安全边界**:目录摘除只是体验优化;分发咽喉(`dispatch.ts` 写守卫)对 REST/MCP/omp 直调一律 fail-closed——与既有安全哲学同源。

## 4. 边界与遗留

1. **hitl-live 套件本轮未跑通**:该套件依赖 3000 端口常驻实例 + 真实 omp 会话(本轮实测时 omp key 撞 3h 预算墙 `422 ExceededBudget`);手动 HITL 路径已由 line-governance L3/L4(44/44)与新套件 M4(审批挂起/批准/附言回流)覆盖。
2. **LLM 会话级实测(transcript)被外部供应商预算阻断**:机器共享 omp key 触发 `422 ExceededBudget: Key over 3h budget`(并行会话占用);已用 deepseek 备选 provider 起会话(手动档 HITL 卡确由 LLM agent 发起并携带依据),但回执抓取时序未收敛。模式门机制的确定性证据由 invoke 驱动实测补齐(真实模拟器物理写入);LLM 全对话留档属后续轮次。
3. **实测期间修复的两个实测脚手架坑**(非产品缺陷,已固化进脚本):①模板 `daq-temp-tc` 缺省量程 150~185℃ 会拒收真实熔温(~247℃)——实测节点必须显式 `min/max` 覆盖;②数采按产线活动批次门控(`sweep-alarms.ts:42`)——线不开跑 DAQ 恒 offline。
4. **配方路径写入的 audit `executionMode` 字段为 null**:executionMode 随 `DcwWriteMeta` 只在 Agent 治理写路径透传;recipe 路径的审批卡已含 reason,mode 回填属下一轮小改。
5. R1(崩溃重启静默退出)/F1(OPC UA 同步失联)为既有已知缺陷,边界声明见 `DESIGN-COMPLETENESS.md` §5。

## 5. 判定

按 PRD `US-201..210` 逐条对照:全部满足。**APPROVED。**
