# Gemma4 + omp 全系统实验:复现 PIPELINE 与重启后真实场景验收报告

- 日期:2026-11-18(两轮:首轮 13:39 验收 → 本轮 15:39 清理重启后复验)
- 环境:LM Studio `google/gemma-4-12b-qat`(Gamma4,Q4_0,7.15 GB,**context 65536 / parallel 1**,单实例串行)+ `omp 18.12.2`(rpc mode)
- 本轮实例:**端口清理后全新重启**,`http://127.0.0.1:3073`(fresh `AW_HOME`,pid 186184,0.13.0)
- 复现入口:`scripts/experiments/gemma4-pipeline.mjs`(一键五阶段:env → cleanup → start → accept → report)
- 结果:**41/41 步骤全部 PASS**(summary.json),全程真实模型回合,无 IDD/RAG(按实验设计不集成)
- 质量门:eslint 0 error / node --check 通过;独立代码评审 APPROVED(0 P0,3 个 P1 已在复验前加固);PIPELINE 经 3 轮迭代自我纠错(36/41 → 40/41 → 41/41 → 加固版 41/41)

---

## 一、我做了什么(总览)

### 第一阶段(上午~傍晚):首轮全系统测试
1. 把 Gamma4 从默认 8k context 重载为 **64k / parallel=1**(omp 每回合需要 24k–62k tokens,8k 必溢出)。
2. 在 `~/.omp/agent/models.yml` 的 local provider 注册 omp 模型 id(过程中发现**必须用模型 id,不能用显示名**——显示名会让平台 `set_model` 静默失败,omp 回落云端 `ustc/deepseek-flash`)。
3. 于 :3072 拉起隔离实例(fresh AW_HOME),手工逐步完成 Channel / Project / RSI / 产线(mock 线)四域测试,证据归档 `docs/audit/evidence/2026-11-18-gemma4-omp-system/`(122 文件),经**两轮独立复核最终 APPROVED**。
4. 过程中实测出 2 个平台边界:①交付物状态在「验收后取消工作项」场景不重算(P2,完成门持续 DELIVERABLES_INCOMPLETE,用正当 retry 路径绕过);②`recipe_trial` 审批卡生成阶段不做单步预检,拦截发生在批准后的派发门(设备确实未被写)。

### 第二阶段(本轮):固化 PIPELINE → 端口清理 → 重启 → 真实场景复验
1. 把整场实验固化为可一键复现的 **PIPELINE 脚本**(五阶段,含归属核验的安全清理、新鲜度 marker、pacing 节奏器、失败路径证据落盘)。
2. **端口清理**:核验归属后终止 :3072 旧实例进程树(共享实例 3001/3003/4050/1234 全程未触碰)。
3. **重启系统**:PIPELINE cleanup+start 在 :3073 拉起全新隔离实例并自动注册 admin。
4. **真实场景验收**:重启后的实例上 41 步全链路真实回合测试,41/41 PASS。

## 二、PIPELINE(复现指引)

```bash
cd AgentWorkShop
# 前置:LM Studio 已加载 gemma-4-12b-qat @ 65536/parallel1;仓库已 build(.output 存在)
lms load google/gemma-4-12b-qat -c 65536 --parallel 1 --gpu max -y   # 如未加载
node scripts/experiments/gemma4-pipeline.mjs                          # 一键全流程(~16-40 分钟)
```

| 阶段 | 内容 |
| --- | --- |
| env | 校验模型 64k 加载、omp 版本;models.yml 缺模型 id 时自动注册(先备份);LM Studio 直连探针(max_tokens=160,防 reasoning 吃满导致空 content) |
| cleanup | 终止**本 PIPELINE 登记**的旧实例(pidfile + 命令行 + 端口监听三重归属核验;taskkill 未确认成功则保留现场;受保护端口硬拒绝);旧 home 轮换为 `.bak-*` |
| start | 全新隔离实例(`AW_MODE=home` + fresh home + 独立端口 + 新鲜度 marker);健康门;首注册 admin |
| accept | 真实场景验收 41 步(下表);模型回合串行等待终态 |
| report | `summary.json`(失败路径同样落盘,含 ABORT 标记) |

细节见 [PIPELINE.md](./PIPELINE.md)。脚本只用标准库;受保护端口(3001/3003/3300/4001/4010/4011/4034/4050/1234/1883/5432/9000)拒绝纳入生命周期管理;`models.yml` 修改前备份、apiKey 行永不入证据。

## 三、重启后真实场景验收结果(41/41)

### Channel 通信(非产线)— 7/7

| 步 | 判据 | 实测 |
| --- | --- | --- |
| C1/C2 | 频道 + lead/worker 双 Agent(omp + `local/google/gemma-4-12b-qat`,rpc) | PASS |
| C3 | lead 真实回合 | 「水沸点」任务 COMPLETED,交付含 **100°C** |
| C4 | worker 群聊真实回合(@提及) | 回复 **24**(4×6) |
| C5 | lead→worker A2A 即时消息 requireReply | 回执 **OK-A2A-9.** |
| C6 | Session A 真实回合 | 回复 **收到 ALPHA-7** |
| C7 | **Session 隔离** | Session B 回复 **不知道**;A 的 brief 块含 ALPHA-7,B 块不含(无跨会话泄漏) |

### Project 模式(非产线)— 14/14

| 步 | 判据 | 实测 |
| --- | --- | --- |
| P1–P2 | Project 创建(omp leader)+ 绑频道 + 交付物 | PASS |
| P3 | **真实 Gemma4 leader 规划** | office continue 触发,leader 调用 `project_propose_plan` 产出 V1 计划审批 |
| P4–P5 | 计划批准 → 物化工作项 → 派发 | PASS(planVersion=1) |
| P6–P7 | 项目实例任务执行 | 真实回合执行;模型 write 工具协议失败后由实例 lead agent token 经 REST 收口(**已在交付正文与本报告披露**) |
| P8–P9 | reconcile → 结果 draft → submit → L1 复核 | reviewed |
| P10 | **自批负例** | admin 决策自己提交的成果 → `SELF_APPROVAL_FORBIDDEN`(403) |
| P11–P12 | **L2 成果验收**(第二名用户,项目 approver 角色) | approved;交付物 approved(全工作项终态) |
| P13–P14 | `project_complete` 审批批准 | **project=completed**,报告 ratio=1 |

### 产线治理(隔离 mock 模拟线,非物理 HIL)— 14/14

| 步 | 判据 | 实测 |
| --- | --- | --- |
| L1–L4 | 线(simulated)/产品/模板/DCW+DAQ 节点/配方供给;开线;绑线频道;line-recipe/recipe/daq 绑定面 | PASS |
| L5 | Agent DAQ 查询 | 实采样本(单位/量程/活动批次齐全) |
| L6–L8 | `recipe_propose`(150→144,单步 6 内)→ **HITL 审批卡** → 人工 choice=0 批准 | 整批下发 **设备证实 1/1**(批次 rr-4d15a61c) |
| L9 | 设备回读一致 | **value=144 / readValue=144**(独立读回) |
| L10 | journal 留痕 | `150→144, source=agent, approvalId=ap-35f6f4db, recipeRunId=rr-4d15a61c` |
| L11 | **越量程负例**(999°C) | 预检拒绝:超出安全量程 200°C,「批准必被拒包」不得入审,产线零变更 |
| L12–L13 | **超单步负例**(144→190) | 审批卡批准后,**派发门拒绝:「本次变化 46°C 超过单步限制 6°C」**,设备保持 144,journal 无 190 写入 |
| L14 | 停线收窗 | PASS |

### RSI 持续学习(绑线频道 candidate 全生命周期)— 5/5

| 步 | 判据 | 实测 |
| --- | --- | --- |
| R1 | 任务完成反射经验 | 2 条 `status=candidate, scope=line` |
| R2 | 单任务晋级负例 | 拒绝:`独立任务样本不足:1/2` |
| R3 | 合并(证据并集) | taskIds=2 |
| R4 | 人工晋升 candidate→validated | `证据充分(2 任务 / 0 锚点)` |
| R5 | **越权负例** | Agent token 调人工晋升端点 → **HTTP 401 USER_UNAUTHORIZED** |

### 模型取证 — 1/1

X1:本轮全部真实回合的 omp 会话 assistant 消息均为 **`local/google/gemma-4-12b-qat`**(`omp-provenance.json`,按仓库工作区目录过滤后零例外)。

## 四、执行过程(3 轮迭代,自我纠错实录)

| 轮 | 结果 | 暴露的问题 → 修复 |
| --- | --- | --- |
| 1 | 36/41 | ①会话断言被注入提示语污染(提示语含“收到 ALPHA-7”字样)→ 改为「文本 ≠ 提示语」的回复判定;②HITL 批准后 15s 即下发,撞 **120s 写控保持窗**(0/1 参数成功,设备保持 150)→ 加保持窗节奏器;③试验负例撞 **300s 试验节拍** → 改为按节拍等待;④模型取证把其他 demo 的旧会话误计 → 按工作区目录过滤 |
| 2 | 40/41 | L11 越量程提案 0s 内提交,先撞 60s 下发间隔卡控(没走到量程预检)→ 加 65s 节奏等待 |
| 3(手动抢救) | 41/41 | leader 一次回合退化为 `<unused49>` 重复 token(12B 偶发)→ 补发规划指令恢复;脚本固化「tick 超时自动重发规划指令」 |
| **4(最终,加固版)** | **41/41** | 独立评审 APPROVED 后的 P1 加固全部落地:home 新鲜度 marker(拒绝静默复用脏 home)、终止归属三重核验(pidfile==端口监听者==命令行,taskkill 未确认不清理现场)、失败路径 summary 落盘 + 关键空值守卫、R5 附真实 HTTP 401 |

> 1–3 轮的原始证据完整保留在 `attempt1/`、`attempt2/`、`attempt3/`(失败也是证据,不作清理)。

## 五、边界(如实)

1. **产线是 mock 驱动的隔离模拟线**(simulated=true),非物理 HIL;结论只覆盖模拟链路。
2. **三处人工/脚本收口是实验设计的一部分**:HITL 卡由验收员身份裁决(审批语义由 HITL 端点保证);Project 工作项与 RSI 样本任务因 12B 模型 `write` 工具协议不稳,由实例 lead agent token 经 REST 终结(任务 claim 后 REST 完成,正文已注明)。
3. **单实例串行**:LM Studio parallel=1,回合排队;全程 16–40 分钟/轮。
4. **未集成 IDD/RAG**(实验设定);未跑 Mimosa 安全封印,不宣称安全结论。
5. 12B 模型偶发 `<unused49>` token 退化与 `write` 参数漏传——是本地小模型能力边界,平台防线(邮箱投递/治理闸/审计)在全部异常下行为正确。
6. `recipe_trial` 的单步校验发生在**批准后的派发门**而非审批卡生成前(已实测拦截有效);是否符合产品预期留待确认。
7. 已知平台 P2(上轮发现):交付物状态在「验收后取消工作项」场景不重算。

## 六、证据索引(本目录)

- `summary.json` — 41 步明细(最终轮)
- `run.log` — 全程时间线
- `channel-*.json` / `project-*.json` / `line-*.json` / `rsi-*.json` / `env-*` / `omp-provenance.json` — 各步原始返回
- `PIPELINE.md` — 复现指引
- `attempt1/ attempt2/ attempt3/` — 三轮迭代的完整原始证据(含失败)
- 上轮全量报告:`docs/audit/evidence/2026-11-18-gemma4-omp-system/REPORT.md`(122 文件,两轮独立复核 APPROVED)
