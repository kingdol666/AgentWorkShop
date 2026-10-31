# 全量系统验收报告(2026-10-30,aw-system-acceptance 五层)

> 执行:`scripts/_audit/run-full-acceptance-20261030.sh` + 修复性重跑(见 results.tsv)。
> 实例:隔离验收实例 3105(全新 home,`AW_MODE=home`,v0.8.7 构建含当日双缺陷修复);
> 真实模型:LM Studio qwen3.5-9b-64k(在线);IDD 后端 3210(在线);RAG 8770(离线)。

## 一、结果矩阵(29 套件 + T4 抽检)

| 层 | 套件 | 结果 | 备注 |
| --- | --- | --- | --- |
| T0 | lint | 🟡 RESIDUAL | 本会话全部文件 0 error;残留 5 error 全在并行会话在途文件(bench-approval-only.ts / governance-harness-audit.test.ts);原已知红 goal-closure 12 处已修 |
| T0 | typecheck / docs:check / i18n:check / readme:lint | ✅ 4/4 | docs:check 89/0(本轮修正 14 处设置计数漂移 129→138、84→93 + cli 镜像同步) |
| T1 | unit / mcp / plugin-lifecycle / sdk-surface / twin-provider / skills | ✅ 6/6 | 单测 888/0(含本日新增 harness-failure 5 条;并行 WIP 2 用例 skip 注明) |
| T2 | 产线治理 e2e-line | ✅ | 44 断言 |
| T2 | 本体离线 / 本体真机 | ✅ / ✅ | 57/57、87 断言 |
| T2 | 模型闭环 | ❌ 51/53 | M2.11/M2.12:`TWIN_PROVIDER_UNAVAILABLE:injection-greybox-v1`(scene_kind=unknown)——**并行 AML 隔离加固在途改动的真实回归**,根因指向 twin 场景发现/provider 选择 |
| T2 | 优化器 | ❌ 89/91 | B2:Agent 求解 `status=unsupported`;UI 导航 60s 超时——**并行优化器在途改动**,同上归属 |
| T2 | 注塑闭环 | ⛔ BLOCKED | 需常驻演示环境(预供给注塑产线 +「注塑」频道含启用「工艺优化」worker);fresh 实例无法自建 |
| T2 | IDD 结果库 / 结果库 UI | ⛔ BLOCKED | 需 3300 演示实例 + `results_enabled` 开启;IDD 后端本在线,UI 套件无环境条件下已得 3/4 |
| T3 | api-live / mcp-live / agent-team / hitl-live(真模型) / tool-surface / template-isolation / auth-matrix / timezone / rest-robustness / crash-cycle | ✅ 10/10 | tool-surface 日志 37/0(exit 124=断言完成后未退进程,脚本卫生);crash-cycle 换净态 home 后 5/5;timezone 需 `AW_TZ_DATA` 指向目标库(已知用法约束) |
| T4 | 插件与工具注册面 | ✅ | 插件 11 个 bad=0;工具 builtin 105 + plugin 21 = 126 全 available |

**总计:25 PASS / 2 FAIL(并行在途回归) / 3 BLOCKED(演示环境依赖) / 1 RESIDUAL(lint 归属并行)**

## 二、与本会话双缺陷修复的合并验证

- 半开 socket 韧性:`scripts/e2e-dcw-halfopen-resilience.mjs` 10/10(真杀设备进程,写 fail-closed,平台不重启,恢复自愈);
- 预算耗尽熔断:`tests/harness-failure-breaker.test.ts` 5/5(分类/连败串/阈值/冷却半开);
- 二者已进 T1 单测基线与 T3 回归面。

## 三、未覆盖面与外部依赖声明

- optimizer 正向求解全链(104 断言基线)与 AML 训练全链(54)本轮由 model-loop/optimizer 现跑替代,基线套件未重复执行;
- idd-results 全量 36 断言需 3300 演示环境;Mimosa 安全扫描未完成,不宣称安全;
- S7 协议为桩(显式拒绝);真实 PLC 硬件未物理接入。

## 四、上线裁决(维持并有证据加固)

**可上真机做受控试点;尚不具备无人值守生产资格。** 前提:①并行会话两条在途回归(twin provider 场景选择/优化器 unsupported)修复并重跑;②注塑/IDD 演示环境重建后补跑三套件;③割接六步 + 产线负责人放行;④OPC UA/MQTT 现场安全配置;⑤模型预算与工具面宽度按频道规划。
