# RSI：经验演化闭环

> RSI（Runtime Self-Improvement）回答一个问题：**Agent 团队的经验，凭什么从"一次任务里的感觉"变成"下一次会真正注入的系统行为"？**
> 答案不是更长的提示词，而是一条可审计的链路：沉淀 → 门禁 → 共享 → 演化 → 证实。

## 一句话理解

```
任务完成 / 评审终态 / 治理写入
        │
        ▼
   经验行（candidate）+ 证据（task / artifact / 干预台账）
        │  fail-closed 门（单任务不够）
        ▼
   validated（可按产线共享）
        │                      ┌── 配对评测（p<0.05，成本非劣）
        ├──▶ Harness Profile ──┤
        │    pin / shadow / active / rollback
        ▼
   prompt 注入（经验 + advisory + 隔离声明）
        │
        ▼
   独立回读验证（match / mismatch / inconclusive）──▶ L1 门
```

## 五个对象

| 对象 | 作用 | 存放 |
|---|---|---|
| **Experience** | 一条带作用域与证据的经验；状态 `candidate → validated`（也可被否定/归档） | 记忆库（按 channel / line 作用域） |
| **Evidence** | 产生这条经验的任务、成果或干预台账行；没有证据的经验不能晋级 | `taskIds` / `resultId` / 干预台账 |
| **Harness Profile** | 注入 prompt 的版本化覆盖层（pins + overlay + advisory） | `harness_profiles` |
| **Verification** | 独立回读结论：`match` / `mismatch` / `inconclusive` | 验证台账 |
| **Meta stats** | 按 action_kind 聚合的成功率，回答"这套机制自己有没有用" | `improvement-stats` |

## 链路细节

### 1. 沉淀（capture）

- 任务终态：root task 完成会触发反射器，把结果写成 `candidate` 经验，带 `taskIds` 证据；
- 评审终态：L1 复核通过/驳回同样沉淀经验，并生成 `kb_ingest` 候选；
- 治理写入：`line_start` / `recipe_trial` 等写入在 DCW 写咽喉落一行**干预台账**，供判决与回读使用。

### 2. 门禁（gate，fail-closed）

晋级 `validated` 的默认门槛是**独立证据数量**（实机口径：两个独立任务）。只有一个任务时门直接拒绝，理由写回审计：

```
独立任务样本不足：1/2
```

这条拒绝是正确行为，不是故障。演示环境想要单任务通过，必须显式调整策略并承担"证据不充分"的语义。

### 3. 共享（share）

`validated` 经验按作用域读取：

- 同一产线（`scope=line`）的其他 Channel 成员**可以**读回；
- 另一条产线**零命中** —— 这是隔离负样本，必须保持；
- 读取动作有审计，不产生写。

### 4. 演化（evolve）

Harness Profile 是"经验如何进入 prompt"的唯一通道：

```bash
# 列出 profile 版本 + 当前注入预览
GET /api/workshop/channels/:id/harness-profiles

# 晋级（shadow → active 必须带配对评测结果）
POST /api/workshop/channels/:id/harness-profiles/promote
{ "profileId": "…", "to": "active", "bench": { "p": 0.02, "delta": 10, "costDelta": 0.01 } }

# 回滚（恢复上一个 active）
POST /api/workshop/channels/:id/harness-profiles/promote
{ "rollback": true }
```

规则：

- `shadow` 可以放行观察；**无配对结果的 `active` 直接 409**；
- 配对结果需显著改善（p<0.05）且成本非劣；
- 同一 Channel 任意时刻**只有一个 active**，回滚也走同一入口；
- 注入预览（preview）会展示实际进入 prompt 的文本：active overlay + pins + advisory + 指令隔离声明。

### 5. 证实（verify）

独立回读验证器把"平台以为写成功了"变成"设备值同意了吗"：

| 结论 | L1 语义 |
|---|---|
| `match` | 可放行 |
| `mismatch` | **409 阻断**复核（False-Done 被拦） |
| `inconclusive` | 等同"未证实"，不得当通过 |

这也是 RSI 与产线治理的接缝：经验可以告诉你"上次这样做有效"，但**这一次设备回读说了算**。

## API 速查

| 方法 | 路径 | 作用 |
|---|---|---|
| `GET` | `/api/workshop/channels/:id/memories/experience-stats` | 经验看板（生命周期 / 作用域 / 极性 + 最近条目） |
| `GET` | `/api/workshop/channels/:id/memories?scope=line` | 读回经验（含跨 Channel，按产线隔离） |
| `POST` | `/api/workshop/channels/:id/memories/:memoryId/promote` | 经验晋级（gate 在此生效） |
| `GET` | `/api/workshop/channels/:id/harness-profiles` | Profile 版本 + 注入预览 |
| `POST` | `/api/workshop/channels/:id/harness-profiles` | 创建 pin/shadow 版本 |
| `POST` | `/api/workshop/channels/:id/harness-profiles/promote` | 晋级 / 回滚 |
| `GET` | `/api/workshop/channels/:id/verifications` | 独立回读台账（match / mismatch / inconclusive） |
| `GET` | `/api/workshop/channels/:id/improvement-stats` | 元层成功率（按 action_kind） |

> RSI 当前是 **API / Agent 工具面**能力，没有独立的可视化页面；运维用上述只读端点核对，写操作仅 owner/admin 可做。

## 验收口径（2026-11-09，main 构建）

`scripts/acceptance-rsi-live-e2e.mjs`：**32/32 PASS**，覆盖：

- 两个独立任务自动沉淀 `candidate` 经验；
- 单任务证据被门拒绝（fail-closed）；
- 项目任务实例 + `write_intent` + HITL 双批准后 `line_start` / `recipe_trial` 下发，设备值证实；
- C1 回读 `mismatch` 使 L1 review 409，`match` 放行；
- 评审终态沉淀经验 + `kb_ingest` 候选；
- 证据合并（2 任务）后晋级 `validated`；
- 同产线跨 Channel 可读、异产线零命中；
- B2 配对评测 → B3 `shadow → active` 门 → B4 回滚；
- C3 元层成功率、C1 台账、DB 审计事实；
- 学习环静态红线：0 处设备写调用。

证据：[`docs/audit/evidence/2026-11-09-rsi-live-e2e/report.md`](https://github.com/kingdol666/AgentWorkShop/blob/main/docs/audit/evidence/2026-11-09-rsi-live-e2e/report.md)。

## 边界

- **经验不是事实**：它只在同样治理与回读约束下成立；设备回读永远有最终否决权。
- **门禁不是越多越好**：单任务拒晋级会让"刚学到的东西"在下一次任务里不可用，这是有意的代价。
- **Profile 需要真实评测**：没有配对结果就不给 active，避免"凭感觉调提示词"。
- **作用域必须诚实**：跨产线共享经验会制造错误因果，当前实现按 line 隔离。
