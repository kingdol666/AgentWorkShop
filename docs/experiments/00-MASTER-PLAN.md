# AgentWorkShop · TII 工程化总规划（开发 × 测试 × 实验）

> 版本：2026-09-09 · 配套文档：`bench/README.md`（benchmark 规范）、`02-experiment-specs.md`（E1–E6 详情）、`03-test-plan.md`（测试体系）
> 总周期 14 周。原则：**每个里程碑都产出可验收的实物**（代码/数据/图表），P0 不完成不进 P1。

---

## 0. 总路线图

```
W1-2   P0 插桩与数据面 ────────────┐
W3-4   P1 Benchmark Harness ───────┤
W5-7   P2 主实验 E1/E4 ────────────┤--------- HIL 设备采购（W5 下单，不阻塞）
W7-9   P3 算法实验 E2/E3/E5 ───────┤
W9-11  P4 数据升级 E6（回放+HIL）──┘
W10-14 P5 论文撰写与投稿
```

投稿决策门（W12 检查点）：E1–E4 全部完成 + HIL 完成 → **IEEE TII**；缺 HIL 或缺算法主线 → 先投 **Computers in Industry**，TII 二投。

---

## 1. 开发计划（P0–P5，逐项到源码锚点）

### P0 · 插桩与数据面（W1–2）

| ID | 工作项 | 源码锚点 | 验收标准 |
|---|---|---|---|
| D1 | `decision_log` 表 + lead `supervise()` 全量落库（决策、理由、各 SupervisionDecision、耗时、token、是否规则兜底） | `server/services/workshop/db/database.ts`（新表）；`runtime/scheduler-loop.ts` decide() | 跑一次闭环任务，`SELECT * FROM decision_log` 有完整记录 |
| D2 | 写控链路结构化耗时戳：t_propose / t_hitl_pending / t_approve / t_write / t_readback | `dcw/dcw-controller.ts` write()；`agents/industrial-tools.ts` | metrics.csv 能拉出 write_latency 与 hitl_overhead 分布 |
| D2b | channel_events 等实验数据保留期 ≥90 天（bench 配置）+ JSONL 导出工具 | `config.yml` retention 组；`scripts/export-logs.mjs`（新） | 导出文件可被 pandas 直读 |
| D3 | 模拟器控制端口：`dev-modbus-simulator.mjs` / `dev-opcua-simulator.mjs` 增加本地控制 API（写任意寄存器值 / 冻结刷新 / 重启），供故障注入器调用 | `scripts/dev-modbus-simulator.mjs`、`scripts/dev-opcua-simulator.mjs` | `curl :1599/set?value=...` 生效，DAQ 值随之变化 |

### P1 · Benchmark Harness（W3–4）

| ID | 工作项 | 产出 | 验收标准 |
|---|---|---|---|
| D4 | `bench/lib/client.mjs` + `fixture.mjs`：参数化产线夹具（复用 `_dbg-live-line-e2e.mjs` S0–S1 编排，N 节点 × 5 协议），含确定性 seed | bench/lib/* | `--config W1` 一键建/拆夹具，重复 20 次 ID 无冲突 |
| D5 | 任务模板 T1–T5 + 完成判据（机器可读 oracle，校验 DB/回读/事件流而非哨兵字符串） | bench/tasks/T1-T5.mjs | 5 模板在 mock harness 下 100% 稳定判定 |
| D6 | `bench/lib/fault-injector.mjs` F1–F6 + `bench/lib/metrics.mjs` + `stats.mjs` | bench/lib/* | F1–F6 各注入一次，metrics.csv 指标齐全 |
| D7 | `bench/run.mjs` 主入口（config → 场景矩阵 → 重复 → 落盘） | bench/run.mjs | `node bench/run.mjs --config configs/e1-main.yaml --seed 42` 全程无人值守 |
| D8 | 治理消融开关（仅 `AW_BENCH_MODE=1` 生效）：no-interlock / no-readback / no-hitl | `dcw-controller.ts` + `agents/industrial-tools.ts` 三处旁路点 | 生产模式开关无效；bench 模式三臂行为符合预期 |

### P2 · 主实验（W5–7）
- 运行 E1（治理消融主对比）与 E4（故障注入鲁棒性）全矩阵（夜间批跑）。
- 统计分析 + 权衡曲线图（`bench/lib/stats.mjs` 产出论文级 SVG/CSV）。
- **中期检查点**：E1 主表 + E4 鲁棒性表成稿，若 thesis（"治理开销 <15% 时延换取 100% 拦截"）不成立，回到 D8 调整叙事或补优化。

### P3 · 算法实验（W7–9）

| ID | 工作项 | 锚点 | 说明 |
|---|---|---|---|
| D9 | E2 hybrid 调度臂：LLM 提议 + 规则引擎可行性校验 | `scheduler-loop.ts` decide() 包一层 validator | rule 臂已存在（`lead.supervise=null`），只需加 hybrid |
| D10 | E3 记忆开关 `AW_MEMORY_MMR` + `AW_MEMORY_INJECT_TOTAL=0` 支持 | `runtime/memory.ts` MMR 装配段 | 四臂配置即跑 |
| D11 | **算法主线（二选一）**：<br>方案 A：DAQ 自适应异常检测（EMA 基线 + CUSUM 漂移）+ 新 agent 工具 `alarm_insights`<br>方案 B：Safe-BO 设定值优化（trust-region + 高斯代理，联锁为硬约束投影） | 方案 A：`daq/daq-node.ts` deriveState 旁路 + `agents/industrial-tools.ts`<br>方案 B：`agents/industrial-tools.ts` dcw_control 提议段 | 方案 A 工作量 2 周、TII 偏好"信号处理×Agent"；方案 B 3–4 周、档次更高。默认 A，人力充足升 B |

### P4 · 数据升级（W9–11）

| ID | 工作项 | 说明 | 验收 |
|---|---|---|---|
| D12 | TEP / SWaT 公开数据集回放 driver（`ctx.daq.registerDriver` 插件）：把数据集时间序列按节拍回放进 DAQ 管线 | E5 的公开基准轨 | 回放数据入 Timescale，标签与样本对齐 |
| D13 | HIL：真 OPC UA/Modbus 设备接入 + E6 案例实验 | node-opcua 栈直连，W5 下单 | 论文出现 "hardware-in-the-loop" 字样的实测小节 |

### P5 · 论文撰写（W10–14）
- 形式化一节：写控管线 = 受监督状态机；不变式（任意写 ∈ SafeRange∩RecipeWindow；回读失败必回退/告警；HITL 超时默认拒绝）——把 98 项负向 E2E 断言改写为性质验证证据。
- 8 节双栏 12–14 页；图 1–4（架构/管线/权衡曲线/时间线）、表 1–3（E1 主表/E4 鲁棒性/E5 检测）。
- 复现包：bench configs + seed 协议 + prompt 哈希记录；PolyForm NC 与学术发表兼容声明。

---

## 2. 测试计划（工程可信度层）

详见 `03-test-plan.md`。要点：

1. **单元测试引入 vitest**（当前全仓零单测）：覆盖全部"论文声称的算法"——滞回去抖 deriveState、RRF 融合、MMR 装配、联锁校验、线性标定互逆、回读死区、自适应检测器（P3 后）。含性质测试（如"联锁校验对任意输入不产生窗口外写"）。
2. **集成测试**：API 级套件（现有 `_dbg-perms-e2e` 等收编为可重复集成测试）。
3. **E2E 回归**：226 个 `_dbg-*` 脚本收编为**精选 CI 集（约 15 个）+ 夜间全量集**，全部脚本加 seed 与确定性判定。
4. **Benchmark 回归**：每夜 E1-W1 子集（N=3）冒烟，指标漂移 >10% 告警——防止"论文实验做完，后续提交把系统改坏了"。
5. **CI**：GitHub Actions = typecheck + lint + vitest + mock-E2E 精选集（PR 门禁），bench 冒烟（夜间）。
6. **混沌/故障测试**：E4 的 F1–F6 同时是工程混沌测试集，双重复用。

---

## 3. 实验→论文图表映射（写作时的账本）

| 实验 | 论文位置 | 图表 | 状态依赖 |
|---|---|---|---|
| E1 主对比 | §6.1 | Table 1 主表 + Fig 3 权衡曲线 | D8 消融开关 |
| E2 调度 | §6.2 | Table 2 + Fig 4 扩展性 | D9 |
| E3 记忆 | §6.3 | Table 3 消融柱状 | D10 |
| E4 故障 | §6.4 | Table 4 鲁棒性 + Fig 5 恢复时间线 | D3 注入器 |
| E5 检测 | §5.3 + §6.5 | 方法小节 + Table 5 + Fig 6 ROC | D11-A + D12 |
| E6 HIL | §6.6 案例研究 | Fig 7 HIL 时间线 | D13 |
| 形式化 | §4.3 | 性质列表 + 验证证据表 | 现有负向断言改写 |

---

## 4. 风险与对策

| 风险 | 对策 |
|---|---|
| mock harness 实验被审稿人质疑不够真实 | mock 只跑大规模调度/记忆实验；E1 安全主对比与 E5 检测必须有真实 LLM 补充组（N=10, temperature=0, prompt 哈希留档） |
| thesis 不成立（治理开销 >15% 或拦截不满分） | F5 场景设计保证拦截率上界明确；开销主要在 HITL 等待（人为因素），报告中把"自动段时延"与"HITL 等待"分开呈现 |
| Safe-BO 超支 | 预设降级线 trust-region+简单代理；再不行切方案 A |
| HIL 设备到货延迟 | W5 下单；E6 独立于 E1–E5，不阻塞主线 |
| 真实 LLM 供应商接口变动 | decision_log 记录模型版本+prompt 哈希，实验期冻结依赖 |
| 数据保留不足导致返工 | D1/D2b 是 P0 第一优先级——历史轨迹 7 天就丢，每周拖延都是损失 |
