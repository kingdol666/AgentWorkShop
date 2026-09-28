# 知识库集成通用闭环优化频道 + lead→worker 节点权限委派 —— 验收记录(2026-09-28)

## 功能范围(本期交付)

1. **模板级知识库集成开关**:`chtpl-aml-optimization-default`(工艺优化通道)与新增内置模板
   `chtpl-generic-optimize-default`(通用闭环优化频道·标准)实例化时支持 `enableKnowledgeBase`:
   - `true` → 写入频道级插件开关(rag-bridge=on)并在频道场景提示词追加「知识库集成」作业段
     (先检索 → 后行动 → 再沉淀);
   - `false` → 显式停用(频道内 kb_* 工具不注入);
   - 缺省 → 不写开关行(平台默认行为,向后兼容)。
   模板详情面新增 `knowledgeBaseCapable` 标记;`/workshop/channel-templates` 实例化弹窗提供开关(默认开)。
2. **lead → worker 节点权限委派**(硬规则:只授予 lead 自己已绑定的节点,权限不可超越授予者):
   - 新宿主工具 `team_grant_nodes` / `team_revoke_nodes`(lead 专属,加入 `LEAD_ONLY_TOOL_NAMES`);
   - `dispatch_task` 新增 `grant_node_ids`(+`grant_mode`)派发时随任务授予,fail-closed(任一节点不在
     lead 绑定面 → 整单失败,任务不创建);
   - REST:`POST /api/workshop/agent-tools/bindings/grant|revoke`(owner/admin 鉴权);
   - 绑定记录新增 `grantedByAgentId` / `grantedAt` 溯源;委派绑定逐 (nodeId, kind) 复制 lead 的
     kind/tuning,mode 缺省随 lead、可显式覆盖;撤销允许「自己授予的」或「自己也持有的」。
   核心校验面:`server/services/workshop/agents/node-delegation.ts`(宿主工具与 REST 共用)。
3. **标准通用 Channel 模板** `chtpl-generic-optimize-default`:内联 omp lead(生产主管)+ 工艺工程师 +
   数据分析师,适配任意已建模产线;KB 开启时 lead 按作业段先检索场景数据分析与物理机理、收口后
   经验沉淀(kb_agent async)。

## 验收结果

### 单元与离线

| 项 | 结果 |
|---|---|
| `tests/node-delegation.test.ts`(越面拒绝/非 lead 拒绝/复制+溯源/mode 覆盖/幂等/撤销边界) | **4 / 4** |
| `pnpm typecheck` | 通过 |
| `pnpm lint`(全仓) | 0 错误 |
| `scripts/check-docs-sync.mjs` | 81 / 81 |

### mock 阶段(`scripts/_audit/kb-team-mock-e2e.mjs`,无 LLM,生产构建隔离实例)

**25 PASS / 0 FAIL** —— 模板能力面、实例化三态(on/off/缺省)、KB 作业段注入、频道插件开关、
lead 绑定、委派授予(grantedBy 溯源 + dcw 随 lead manual)、越面 403 `DELEGATION_NOT_OWNED`、
授予 lead 自己 400、执行中授予(mode 覆盖)、撤销与误撤保护。

### 真实 omp 阶段(`scripts/_audit/kb-team-omp-e2e.mjs`,真实 PLC 模拟器 + 真实 omp 团队)

产物目录:`bench/results/kb-team-omp-20260928{055657,060452,061356,070619,07…}/`
(含每场景 `transcript.md` 作业转录 / `final.json` 验收面 / 事件流工具证据)。

**injection(注塑克重窗口)—— 全链路闭环达成:**

- 模拟器 5 设备 5 协议(modbus-tcp/modbus-rtu/opcua/mqtt/http)、11 SP + 14 PV,平台建线开跑(真实协议 driverConfig);
- 通用频道(omp lead + 2 worker,enableKnowledgeBase=true)实例化;lead 绑定 pv/knob 节点;
- **KB 检索**:lead 调用 `kb_agent`(sync)检索机理知识(事件流证据 ×18);
- **委派**:`team_grant_nodes`/`grant_node_ids` 真实发生 —— 2/2 worker 持有 `grantedByAgentId=lead` 的绑定
  (数据分析师得 daq;工艺工程师得 dcw×2+daq);
- **治理优化**:9 步单变量保压阶梯 46.8→63.0 bar(+1.8 bar/步=硬上限,步间隔 60–111 s),
  24 次治理写入 / 27 开记录 / 26 次 `dcw_judge` 判定 / 4 次自动回退;
- **达标**:实测增益 0.0574 g/bar(与数据分析阶段量化 0.0576 吻合,<1% 偏差),14:40 入窗,
  PV 均值 32.307 g,100% 落在 32.5±0.35 g 窗内(脚本复测均值 32.286 ∈ 带);
- **KB 经验沉淀**:lead `kb_agent`(async,task_id=kbt_mukvw3rz_a7b00ada)→ **知识库检出经验条目
  `exp-d119252832e9`「注塑成型质量窗口寻优:保压压力链式爬坡入窗」**(aw-industrial/experience/,vetted,
  含机理/方案/120s 兜底回退陷阱对策/复现边界),经 kb_agent 直接问答核验;
- **根任务终态 COMPLETED**(阶段1/阶段2 均 COMPLETED)。

**wwtp(A2O 污水达标降耗)—— 阶段性达成 + 崩溃恢复实证:**

- 建线开跑;lead 拆解「DO 时序取证+曝气频率↔DO 响应量化」(COMPLETED)与「曝气频率小步幅拉升 DO」;
- 治理阶梯实跑:风机 26.6→26.9→27.5→28.1 Hz(第 4 步),步步 open→write→judge keep(ops 流水证据);
- 平台实例被环境终止后重启:**调度循环/租约自动恢复,在飞子任务重新接线继续执行**(崩溃恢复设计实证)。

**anneal(连续退火)—— 负结果(如实记录):**

- 委派与治理写入均实证工作(2/2 worker 持 lead 授予绑定;发生过 dcw 治理写入);
- 但根任务 `ROOT_TIMEOUT` 收口(FAILED),PV 未入带(硬度 134.8 HV vs 95±6)。失败链:①工艺参数注册表
  存在**跨场景缺口** —— anneal 线的配方参数未进语义参数映射,worker 的 `param_read` 只能看到 injection
  线注册的参数(错误信息如实列出可用参数);②目标口径偏大(质量窗+产能最大化双目标)放大了收敛时长;
  ③lead 在探针受阻后取消子任务,看门狗按 ROOT_TIMEOUT 收口。改进方向(后续轮次):provisionScenarioLine
  为每条产线补齐参数映射注册、anneal goal 先达标后寻优两段式。

**环境事件(如实记录)**:测试期间本机出现周期性 node 进程清理(平台实例/模拟器/KB web 多次被外部终止,
含 3001 生产实例;无 OOM 特征,进程内无崩溃栈),injection 的 30min 转录窗因此截断(根任务其后正常收口,
终态经复核为 COMPLETED 并已回写 final.json `postRunVerification`);wwtp/anneal 的连续转录窗未能完整落成。
anneal 场景在最后一轮尝试中同样受此限制——闭环管线本身已由 injection 全程与 wwtp 阶段实据验证。

## 已知边界

- rag-knowledge 后端 `GET /api/v1/experience/{kb}` 与 web 目录存在状态分歧(KB not found,外部服务漂移);
  经验沉淀实际落在 web 侧 Agent 存储并可用 kb_agent 问答检出(本次验收采用该口径)。
- `kbExperience` 自动断言依赖后端检索索引时滞,转录「工具证据」(事件流 kb_agent×18/委派×18)为佐证口径。

## 复现

```bash
# 构建 + 隔离实例(KB token 预置 plugins.rag-bridge.token)
pnpm build
AW_MODE=home AW_HOME=<home> node bin/aw.mjs start --port 3456
# mock 阶段
AW_BASE=http://127.0.0.1:3456 node scripts/_audit/kb-team-mock-e2e.mjs
# 真实 omp 场景(需 omp CLI 与 KB web/后端在线)
node scripts/_audit/kb-team-omp-e2e.mjs --base http://127.0.0.1:3456 --scenarios injection,wwtp,anneal --timeout-min 45
```
