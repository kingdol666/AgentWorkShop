# 工程测试体系规划（从"功能验收"到"可发表工程"）

> 现状：226 个 `_dbg-*` 功能脚本、零单元测试、无 test runner、无 CI。本计划把测试体系升级为 TII 审稿人眼中"工程可信"的形态：**论文声称的每一条算法行为都有自动化测试兜底**。

---

## 1. 测试金字塔

```
        ┌─────────────┐
        │ E2E 回归(夜) │  精选 15 脚本(PR 门禁) + 226 全量(夜间)
        ├─────────────┤
        │ 集成测试(API) │  收编 perms/audit-neg/recipe 等套件 → vitest
        ├─────────────┤
        │ 单元测试     │  vitest —— 算法核心全覆盖 + 性质测试
        ├─────────────┤
        │ bench 回归   │  每夜 E1-W1 子集 N=3，指标漂移告警
        └─────────────┘
```

## 2. 单元测试（最高优先，P1 前完成骨架）

**引入 vitest**（`pnpm add -D vitest`，`package.json` 加 `"test": "vitest run"`）。首批覆盖"论文声称的算法"清单：

| 模块 | 测试点 | 文件锚点 |
|---|---|---|
| DAQ 报警 | 2% 滞回边界、3 拍去抖、alarm/offline 即时切换、边界值扫描 | `daq/daq-node.ts` deriveState/applyReading |
| 记忆融合 | RRF 排序正确性(k=60)、向量榜失败退化 FTS、MMR 多样性单调性、时近衰减、token 预算裁剪 | `runtime/memory.ts` |
| DCW 联锁 | 量程∩配方窗交集为空的拒绝、窗边缘值、BENCH 开关旁路语义 | `dcw/dcw-controller.ts` write |
| 标定 | linear 正反变换互逆、死区容差计算、量程外值 | `dcw/dcw-node.ts` transform |
| 任务机 | 7 态迁移合法性枚举、retry≤3、停滞看门狗 | `runtime/task-engine.ts` |
| 配置引擎 | 优先级合并、schema 校验、live/restart 分类 | `shared/config/` |

**性质测试（property-based，用 fast-check）**——直接为论文形式化一节提供证据：
- 对任意 value/量程/配方窗组合，`DcwController.write` 在治理开时**从不**产生窗外写入（对应论文不变式 I1）；
- 回读失败必然产生 ACK≠ok 且落写历史（不变式 I2）；
- HITL 超时后写必不执行（不变式 I3）。

## 3. 集成与 E2E 收编

- 现有权威套件（live-line 37 断言、multiharness 21、perms 20、audit-neg 9、recipe 24 等）保持，但：
  1. 全部加 `SEED` 环境变量与固定 TAG，产物落盘可追溯；
  2. 哨兵字符串断言逐步升级为**数值/状态断言**（复用 bench 的 oracle 思路）；
  3. 挑 15 个进 PR 门禁集（跑 mock harness，<10 分钟），其余夜间跑。
- `package.json` 增加：`"test": "vitest run"`、`"test:e2e": "node scripts/e2e-suite.mjs ci"`、`"bench:smoke": "node bench/run.mjs --config configs/e1-main.yaml --smoke"`。

## 4. CI 流水线（GitHub Actions，P1 交付）

```
PR:   typecheck → lint → vitest → e2e 精选集(mock)     # <15 min
夜:   e2e 全量 → bench 冒烟(E1-W1 × N=3) → 指标漂移报告
```

## 5. Bench 回归（防"论文做完系统改坏"）

每夜 E1-W1-full 臂 × N=3 的固定 seed 冒烟；与历史基线比较 `write_latency_p95` / `goal_success_rate` / `intercept_rate`，漂移 >10% 在 CI 报警并钉到引入提交。**这一条是长期维护实验可信度的机制**。

## 6. 里程碑对齐

| 阶段 | 测试交付物 |
|---|---|
| P1 | vitest 骨架 + 算法单测首批 + CI（PR 门禁） |
| P2 | E4 故障集 = 混沌测试集双重复用 |
| P3 | 自适应检测器/Safe-BO 新算法单测 + 性质测试 |
| P4 | 回放 driver 回归测试（TEP 样本数对账） |
| P5 | 复现包 = bench + 测试套件 + seed 协议，随论文开源声明 |
