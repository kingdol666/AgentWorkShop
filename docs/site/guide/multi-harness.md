# 多 Harness Agent 团队

一个 `AgentInterface` 契约之下,六个执行引擎可互换 —— 平台不关心 Agent 由谁驱动:
`mock`(进程内,联调/CI)、`omp`、`codex`、`dsh`、`opencode`(真实引擎子进程,
RPC/ACP/JSON-RPC 多协议)、`claude`(SDK 适配)。

## 每频道选择引擎与模型

- 频道级设定 **harness → provider → model(+effort)** 三元组,从引擎官方目录实时选择
  (如 omp 上 `zhipu-coding-plan/glm-5.3-flash`、dsh 上 `ustc/glm-5.3-flash`);
- 成员默认继承,也可逐成员覆盖 —— **一个团队混用多种引擎是一等公民配置**;
- 每个 harness 有独立能力面(steer / lead 调度 / HITL / 终端镜像 / 上下文统计 / 压缩),
  前端徽标如实展示。

## 环境可用性检查

- `GET /api/workshop/harnesses` 返回每引擎 `available`(PATH 探测外部 CLI,
  进程内引擎恒可用)、`command`、`resolvedPath`、`error`;
- 前端下拉**禁用未安装引擎**并标注「未安装」;仪表盘「执行引擎」面板显示就绪度;
- 执行前强校验:模板/实例/任务七处入口统一 `assertHarnessUsable` ——
  未知引擎 400 `UNKNOWN_HARNESS`,未安装 409 `HARNESS_UNAVAILABLE`(人话报错)。

## 已验证的多引擎并行

`scripts/_dbg-multiharness-live-e2e.mjs`(对生产实例)四引擎并行,各自独立 Channel
在真实 Modbus 产线上完成专属场景:

| 引擎 | 场景 | 交付标记 |
|---|---|---|
| omp | 闭环控制(下发→采样→判定 keep) | `OMP-CLOSEDLOOP-OK` |
| codex | 数据控制(真实寄存器写入+账本) | `CODEX-WRITE-OK` |
| dsh | 数据采集(line_context + daq_query) | `DSH-DAQ-OK` |
| opencode | Recipe 写入回退(recipe_update → recipe_rollback) | `OC-RECIPE-OK` |

## LLM 供应商配置

频道级 `llm`(provider/model/effort)在频道设置页选择;各引擎的供应商目录
`GET /api/workshop/harnesses/:harness/providers`。成员未显式指定时继承频道默认。
