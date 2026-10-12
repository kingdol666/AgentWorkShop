# Language + positioning pass — 2026-10-12 (round 3)

## qinyan检查结果：无需大改

按沁言的五个维度逐项扫描全文，**没有找到该改的东西**——这本身是结论：

| 维度 | 扫描方式 | 结果 |
|---|---|---|
| 语言表达（冗余套话） | 16 个典型冗词模式（`in order to` / `the fact that` / `it is important to note` / `a number of` / `with respect to` …） | **0 命中** — 前六轮润色已清干净 |
| 学术用语（绝对化表述） | `proves` / `guarantee` / `always` / `never` / `cannot` / `ensures` / `fully` | 11 处 `never`/`guarantee` **全部是精确用法**，不是过度断言：`never as authority`、`never queues behind human attention`、`not a protection guarantee`。唯一的 `always`（`the interval is always defined`）是设计事实，正文已解释空交集情形 |
| 术语一致性 | 核心概念变体计数 | `governed write` 13 / `governed path` 5 / `governed intervention` 2 / `governed iteration` 1 —— 各自指称不同对象（写操作 / 通路 / 事务 / 循环周期），非混用 |
| 逻辑衔接 | 段落过渡 | 前几轮已加 `\looseness` 与过渡句，未发现断裂 |
| 格式规范 | — | 无 |

按沁言"不改变文章的整体结构"的约束，此处**不做重写**：在已经无冗余的文本上做同义替换是churn，不产生价值。

## 文献定位：补最高价值的两条（零字数成本）

领域席（R2）判为 CRITICAL 的那条——空白主张只对着 5 篇同期 LLM 论文——本轮用**零新增字数**的方式部分修复：把已有但未引用的 `refs.bib` 条目**并入现存 `\cite` 组**，只付参考文献表行的成本，不付正文字数。

1. **`biskupovic2025supervision`** — *"Agent-Based Supervision for Service-Oriented Industrial…"*，**IEEE Trans. Ind. Inform.**，2025。
   这是**目标期刊自己**发表的、主题几乎完全重合的论文（工业系统 agent 监督）。投 TII 而不引它，是定位上最刺眼的一处缺失。
   并入：`Agent-based manufacturing and supervision have long linked organizational roles to plant capabilities \cite{leitao2009agentbased,biskupovic2025supervision}`

2. **`parasuraman2000model`** — *"A Model for Types and Levels of Human Interaction with Automation"*，IEEE Trans. SMC，2000。
   人机自动化交互的奠基文献；论文在 §VI-C 讨论 approval fatigue 与 automation bias 时只引了 Bainbridge。
   并入：`\cite{bainbridge1983ironies,parasuraman2000model}`

已实测：**两条吸收后仍是 10 页**。第三条（`iec62541` OPC UA）实测会把页数顶到 11，已撤回——三条引用的边际价值低于一页。

## 当前状态

**10 页 · audit 6/6 · check-refs 25/25**（引用数 23 → 25）。

## 结构性问题（需要作者决策）

不改内容的排版杠杆已全部用尽且不可再用：

- 参考文献 `\linespread{0.79}\scriptsize` —— **低于 IEEE 的 8pt 参考表规格**，再压是拿可读性换页数
- `\looseness=-1` 已施加于 10 个段落
- 五张图均已缩放（Fig.1 0.64 / Fig.2 0.38 `\textwidth`；Fig.3b 0.78；Fig.4、Fig.5 0.95 `\columnwidth`）

**结论：任何进一步的正文增补，都必须以删除等量正文为代价。** 领域席要求的那段"工业 agent 架构谱系 + 安全优化理论 + 生产写授权实践"定位文字约需 2–3 行，必须先指定牺牲哪个段落。
