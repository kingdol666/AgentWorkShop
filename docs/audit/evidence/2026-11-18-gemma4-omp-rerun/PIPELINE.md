# Gemma4 实验 PIPELINE(一键复现)

复现 2026-11-18「本地 Gamma4(gemma-4-12b-qat @ LM Studio)+ omp harness」全系统真实场景验收。
脚本:`scripts/experiments/gemma4-pipeline.mjs`(单文件,零第三方依赖,Node ≥23)。

## 前置条件

| 项 | 要求 | 说明 |
| --- | --- | --- |
| LM Studio | `google/gemma-4-12b-qat` 已加载,context **65536**,parallel **1** | `lms load google/gemma-4-12b-qat -c 65536 --parallel 1 --gpu max -y` |
| omp | `omp --version` 可用(实验基线 18.12.2) | `~/.omp/agent/models.yml` 缺少模型 id 时脚本自动注册(先备份 `.bak-pipeline`) |
| AgentWorkShop | 仓库已 `pnpm build`(`.output/server/index.mjs` 存在) | 实例从仓库 `.output` 启动 |
| 端口 | 默认 `3073`(可用 `--port` 覆盖) | 3001/3003/3300/4001/4010/4011/4034/4050/1234 等受保护端口脚本拒绝使用 |

## 一键运行

```bash
cd AgentWorkShop
node scripts/experiments/gemma4-pipeline.mjs                 # 全流程(env→cleanup→start→accept→report)
```

分阶段运行(调试用):

```bash
node scripts/experiments/gemma4-pipeline.mjs --phase env      # 只做环境检查与自愈
node scripts/experiments/gemma4-pipeline.mjs --phase cleanup  # 只清理本 PIPELINE 登记过的实例
node scripts/experiments/gemma4-pipeline.mjs --phase start    # 只启动隔离实例
node scripts/experiments/gemma4-pipeline.mjs --phase accept   # 只跑验收(需实例已在跑)
```

常用参数:`--port 3075`、`--model-id google/gemma-4-12b-qat`、`--root <运行目录>`(默认 `%TEMP%/aw-gemma4-pipeline`)、`--evidence <证据目录>`(默认 `docs/audit/evidence/2026-11-18-gemma4-omp-rerun`)。

## PIPELINE 五阶段

| 阶段 | 做什么 | 关键产物(evidence 目录内) |
| --- | --- | --- |
| `env` | 校验模型 64k 加载、omp 版本;models.yml 自动注册模型 id;LM Studio 直连探针(max_tokens=160,防 reasoning 吃满导致空 content) | `env-lms-ps.txt`、`env-direct-probe.json`、`env-models-yml-redacted.yml` |
| `cleanup` | 终止**本 PIPELINE 自己登记**的旧实例(pidfile + 命令行双重核验;受保护端口拒绝触碰) | run.log |
| `start` | 全新隔离实例:`AW_MODE=home` + fresh `AW_HOME`(默认 `%TEMP%/aw-gemma4-pipeline/home`)+ 独立端口;健康门;首注册即 admin | `env-health.json`、`env-register.json` |
| `accept` | 真实场景验收(串行,模型回合逐个等待终态):**C**hannel(lead 真实回合/worker 群聊/A2A 回执/双 Session 隔离)→ **P**roject(真实 leader `project_propose_plan`→批准→物化→派发→REST 收口→reconcile→L1→自批负例→L2(approver)→completed)→ **L**ine(mock 隔离线:DAQ/recipe_propose+HITL/回读 144/journal/越量程负例/超单步派发门负例)→ **R**SI(绑线频道 candidate 反射→单任务晋级拒→合并→人工晋升 validated→Agent 越权 401)→ **X**模型来源取证 | `channel-*.json`、`project-*.json`、`line-*.json`、`rsi-*.json`、`omp-provenance.json`、`run.log` |
| `report` | 汇总每步 PASS/FAIL + 元数据 | `summary.json` |

## 时长与纪律

- 12B 本地推理单回合 2–5 分钟(24k–62k tokens);全流程约 **25–40 分钟**,全程串行(parallel=1)。
- 验收里三处「人工收口」是**实验设计的一部分**,报告中如实披露:
  1. Project 工作项:模型 write 工具协议失败后由实例 lead agent token 经 `POST /tasks/:id/complete` 收口(交付正文为算术说明);
  2. RSI 样本任务:同上(claim 后 REST 完成,再停运行时释放模型);
  3. HITL 卡由脚本(验收员身份)裁决——真实人类审批语义由 HITL 端点保证。
- 负例(越量程提案被预检拒、超单步被派发门拒、自批被拒、Agent 越权 401)是 PASS 判据的一部分。

## 安全边界

- 脚本只管理**自己拉起并写入 pidfile** 的实例;清理前必须通过「命令行含 `.output/server/index.mjs`」核验,否则拒绝终止。
- 受保护端口(共享实例/基础设施)硬编码拒绝。
- `models.yml` 修改前先备份;apiKey 不进证据文件(写证据前按行剔除)。
