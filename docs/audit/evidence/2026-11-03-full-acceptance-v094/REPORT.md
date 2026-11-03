# v0.9.5 全功能多场景验收报告(2026-11-03)

- 代码:main @ v0.9.4 验收起点 + 本报告同 PR 的验收修复(验收后版本号升至 0.9.5)
- 方法:`.agents/skills/aw-system-acceptance` T0–T5 六层矩阵 + H1–H8 专项 + 真实 Chrome UI 走查
- 环境:Windows 11 / Node 24.19 / 本机 Chrome;隔离 `AW_MODE=home` 实例(3980–3984) + 常驻 PLC 模拟器 4010;Timescale/MQTT 本机可用
- 证据:本目录(每套件 `.log` + `ui/*.png` + `ui/report.json`)

## 1. 结果矩阵

| 层 | 套件 | 结果 | 证据 |
|---|---|---|---|
| T0 | lint · typecheck · docs:check · i18n:check · readme:lint | **全绿**;docs 89/0;i18n parity 3175/3175 | `T0-static*.log` |
| T1 | test:unit | **1017 tests / 1015 pass / 0 fail**(2 skipped) | `T1-final.log` |
| T1 | test:mcp · plugin-lifecycle · sdk-surface · twin-provider · skills | 14/14 · 全绿 · 全绿 · 5/5 · 146 PASS/0 FAIL | `T1-final.log` |
| T2 | 科学探索全链 | **21/21 PASS** | `T2-scientific.log` |
| T2 | 科学探索闭环 | **20/20 PASS** | `T2-scientific.log` |
| T2 | 产线治理 E2E | **44/44 PASS** | `T2-line-governance.log` |
| T2 | 本体离线 | **57/57 PASS** | `T2-ontology-offline.log` |
| T2 | 本体真机 | **87/87 PASS** | `T2-ontology-live.log` |
| T2 | 模型闭环真机 | **53/53 PASS** | `T2-model-loop-live.log` |
| T2 | 优化器真机 | **105/105 PASS** | `T2-optimizer-live.log` |
| T2 | 异构/MES 专项(H1–H8) | **23/23 PASS** | `T2-heterogeneous-mes.log` |
| T2 | 注塑闭环 | **未跑**(演示实例无启用「工艺优化」worker;隔离实例需 PLC 场景供给,非本次变更面) | — |
| T3 | api-live | **71 PASS / ALL PASS** | `T3-api-live.log` |
| T3 | 鉴权矩阵 | **29 pass / 0 fail** | `T3-auth-matrix.log` |
| T3 | REST 鲁棒性 | **ALL PASS** | `T3-rest-robustness.log` |
| T3 | 时区设置 | **exit 0** | `T3-timezone.log` |
| T3 | HITL 真机 | **未跑**(需 omp CLI + 可用模型;本轮变更面不涉及 HITL 交互) | — |
| T4 | 插件清单 | **11 插件,enabled 全量,failures=[]** | 运行实例 `/api/workshop/plugins` |
| T4 | 工具注册表 | **129 tools(108 builtin + 21 plugin),unavailable=0**,`mes_bridge` available | 运行实例 `/api/workshop/tools` |
| T5 | build · `/` · 未鉴权 401 · 无密钥拒绝 · pack | **全通过**;pack 42.5MB/4384 files 含 `.output`/prompts | `T5-build.log` / `T5-pack.log` |
| UI | 8 页真实 Chrome 走查 | **8/8**,无 pageerror | `ui/report.json` + `ui/*.png` |

## 2. 本轮验收发现并修复的问题

1. **静态响应面被动态 G6 门误杀**(产品修复)
   - 现象:`static_response@1` 数据集的控制序列是连续扫描,G6 判「960 个水平各仅单一连续段(纯阶梯)」→ 训练失败。
   - 根因:G6 是动态动作覆盖门;静态响应面按窗口聚合稳态样本,不做时间维因果识别。
   - 修复:`aml/dataset-builder.ts` 对 `trainerRef=static_response@1` 显式 `actionCoverage=[]`;动态数据集行为不变。
   - 复验:优化器 live **101/105 → 105/105**。
2. **Twin Provider Registry 双实例**(产品修复)
   - 现象:dev/多模块图下插件宿主注册的 `injection-greybox-v1` 在工具面解析不到(`TWIN_PROVIDER_UNAVAILABLE`)。
   - 修复:`aml/twin/provider-registry.ts` 单例挂 `globalThis.__twinProviderRegistry`,注册与解析同源。
   - 复验:模型闭环 live **51/53 → 53/53**;生产冒烟 `/providers` 同时可见 injection/castfilm/thermal。
3. **HITL 审批超时 timer `unref()`**(产品修复,已在 v0.9.4 提交)
   - 空闲事件循环先清空 → 超时不触发、Promise 永久 pending(Linux CI "event loop has already resolved")。
   - 修复:timer 保持引用;decide/cancel/超时路径均 clear。
4. **CI quick-gate 缺 pnpm 引导**(工程修复,已在 v0.9.4 提交)
   - `setup-node cache:pnpm` 前无 `pnpm/action-setup` → 缓存步骤直接失败。已补 pnpm 11.9.0。
5. **实机套件夹具与新门禁对齐**(测试夹具,未放宽产品行为)
   - 本体/模型/优化器 live 的控制激励改为离散档位 ABAB(连续正弦会被 G6 判纯阶梯);
   - model-loop 增加插件宿主异步装载等待 + 重试轮登录复用;
   - 数据锁测试区分 Windows 硬杀残留 / Linux 优雅清锁;60s 桶断言锚定分钟中点;
   - Timescale 契约测试在容器缺失时 skip。

## 3. 外部依赖与未覆盖面(如实声明)

- **注塑闭环**:未跑。前置 = 启用「工艺优化」worker 的注塑频道 + 已供给 PLC 场景;共享演示实例不满足,且按治理红线不在共享实例做写入型验收。
- **HITL 真机三阶段**:未跑。前置 = omp CLI + 可用模型;本轮未改 HITL 交互路径。
- **IDD/RAG 结果库与 UI**:未跑。前置 = 外部 IDD/RAG 服务;不属于本次异构/MES 变更面。
- **Mimosa 安全扫描**:仍为 `inconclusive`(扫描器覆盖缺口);本报告仅裁决功能面,**不作为安全认证**。

## 4. 结论

- 变更面(H1–H8 异构/MES)+ 六层矩阵内可执行套件:**全部通过**。
- 未执行套件均有明确外部前置,未静默跳过。
- 生产冒烟与 UI 走查通过;受控试点可继续,无人值守仍需按既有安全/治理门单独裁决。
