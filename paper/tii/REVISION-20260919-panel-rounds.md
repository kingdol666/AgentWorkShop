# 五席盲审 + 二轮验证：修订记录（2026-09-18/19）

成品：`paper/tii/main.pdf`，**11 页**，无 LaTeX error / undefined reference / citation，
`reviews/verify_evaluation_numbers.py` 219 条断言全部通过。

---

## ⚠️ 最重要的一条：TII 投稿页数上限是 10 页，不是 11 页

已从 IEEE IES 官方页核实（[TII 期刊页](https://www.ieee-ies.org/pubs/transactions-on-industrial-informatics)）：

> Regular Research Papers — Only new submissions since 01 January 2025 are allowed
> **10 pages maximum (strictly enforced)**. Final versions are allowed 12 pages maximum
> (strictly enforced). Overlength page charges apply from page 11 onwards at $250/page.

因此**当前 11 页的稿件作为新投稿会被系统直接退回**。10 页是投稿门槛，12 页是录用后的终稿上限。
本记录中所有"保持在 11 页内"的工作因此仍差一页；详见文末"下一步"。

---

## 一、盲审panel构成与结论

| 席位 | 一轮 | 二轮（验证） |
|---|---|---|
| 主编/期刊契合度 | Major revision before review | — |
| R1 方法学与实验设计 | Major Revision | **Minor Revision**（6 项一轮意见全部实质解决） |
| R2 工业领域（BOPET/APC/OT） | Major Revision（borderline Reject） | Major Revision（第二次），但明确表示新实验类意见**不应阻塞**本轮 |
| R3 系统集成/人因/功能安全 | Major Revision | Major Revision（Fig.6 闸门与 HITL 两轮未解决） |
| Devil's Advocate | Major Revision（borderline Reject） | **Major Revision（范围很窄）**：所有"撤稿级"意见已解除，仅剩 6 处句子级修正 |

二轮共同的判断：**修订方向正确、数字全部可复现**；剩下的问题集中在"摘要/图表层级比正文更宽松"
与若干句子级事实错误。

---

## 二、已核实并修正的问题

### 一轮修正（已验证）
1. 缺陷率区间 `0.50–0.53 %` → **`0.38–0.53 %`**（seed 44 = 0.383 % 被漏掉）
2. Fig. 5(b) 图注因果错误（说末点是 J_end 均值；实际画的是逐次实测值）→ 已改写
3. `9/9 hard-range probes` 与档案自带标签不符 → 改称 out-of-constraint，并写明该组**不含配方窗探针**
4. 摘要补上"其中 3 项检查跳过写入子检查"，并写明 LLM 路径关闭
5. J 分解 ≈1.8/4.4/3.2 点 → 限定为 seed 42 末点
6. "shrinking gains" 误称 → 改为预设增益 0.5/0.35/0.3 + 观测到的响应递减
7. "energy-for-throughput trade" → 改为控制器的**受限动作集合**（线速度被固定）
8. 复现性第五条例外：披露同 hash 同 seed 的两次运行分别落在 25.68 µm 与 −0.02 µm
9. 迁移 `Town` 等未定义专有名词、修正误引 IEC 62541、去掉"Four properties"却只列三条
10. 标题改为 *AgentWorkShop: Node-Native Binding and Governed Write Paths for Agent Teams in Industrial Supervision*（原句在摘要里就要自我否认）

### 二轮修正（本轮新增）
11. **我自己上一轮引入的一句是假的**：写了"film-break guard 在 archive B 之后才加入"。
    实测 `20260918040908-1f4o`（B 之前 26 分钟、同一 recorded commit `7d4bfc0`）**已经触发该分支**
    且恢复失败。已改正为：guard 在工作树中已存在、B 未进入该分支、**另有三个 archive 进入且全部恢复失败**
    （终值 0.04 / −0.02 / −0.02 µm），并指出**负厚度说明是植物模型而非治理层在限制该结果**。
12. 失败 archive 的判定是 **warn 而非 fail**（73 pass / 2 warn / 0 fail，hard gate green）→ 已改正并点名两个 archive
13. 新增"本次达标是**一次**归档观测，后续同命令复跑未复现"（写在达标结论处，不再只藏在 §V-F）
14. **消融段探针分类写错且推论反了**：六个探针中只有 2 个是窗类，4 个是量程类；
    "batch-window interlock 才是承重检查"是反的 → 改为"量程结构性强制、窗检查是增量保护"
15. 补报**已存在但未报的边界数据**（窗沿 ±0.1 单位探针全部拒绝、各臂 0 误拦）——这是 R2 最大的证据诉求，属报告遗漏而非缺实验
16. `Seed 44 degrades most in relative terms` 限定为"缺陷率相对升幅最大"
17. "Two failures" 段落实含三条 → 改为 three 并补 First/Second/Third 标记
18. "the latest archive" → "reference archive B"（B 已非最新）
19. §V-A 的"本节的每一个测量结果都来自同一个归档"因消融属另一归档而失效 → 已限定
20. **Fig. 6 闸门图**：删掉"every request clears all four"，四行由 `pass` 改为 `cleared`，
    回读行加星号，图内补注 `* recipe and heartbeat paths bypass this gate`，图注指向 §IV-C 的旁路说明
    （R3 两轮要求、并以此作为"再不修就 Reject"的信号）
21. 贡献 3 的"independent film-line scenario" → "second film-line scenario"（与正文自相矛盾）

---

## 三、评审意见的取舍判断（哪些接受、哪些不接受）

**接受并已改**：所有可核对的事实错误、所有"摘要比正文宽松"的层级不一致、所有图注-正文冲突、
消融段的分类与推论、边界数据的补报、达标频次披露、Fig. 6 闸门范围限定。

**接受为"边界声明"但不改结论**：不宣称物理安全、不宣称 agent 性能、不宣称 J* 是全局最优、
不宣称可复现整机行为。

**不接受/不在本轮范围**（需新实验或换定位，二轮评审亦明确同意不阻塞本轮）：
- 真实 LLM 在环的对照实验（当前归档 LLM 全关）
- 常规 APC/RTO 写路径作为 baseline
- ownership / cooldown / pause / disable / 审批拒绝·超时 / K=2 的负向探针
- TOCTOU 竞态注入、审计 fail-open 量化
- 与植物模型无关的第三方 oracle
- 物理装置 / TEP·SWaT 回放 / 操作员负荷研究
- R2 要求的"以吞吐/熔体泵/模口间隙/CD 轮廓为执行器的物料锚定模型"

---

## 四、下一步（需要你决定）

1. **压到 10 页**。差一页。可选路径：
   (a) 继续压缩正文（约需再删 1000–1200 词，会明显伤及细节）；
   (b) 把 Algorithm 1 + 机制细表移入 TII 允许的 supplementary material（官方页面明确支持），
       正文保留一句指针 —— 这是最省内容代价的做法；
   (c) 合并 Fig. 3 与 Fig. 4。注意：你要求的前四张图必须留在正文，故 (b) 更合适。
2. **补跑最小实验包**（R3 称"数小时、确定性、应当阻塞下一轮"）：
   审批拒绝/超时/绑定撤销、ownership·cooldown 负向、K=2 升级、归档复跑 ≥3 次并给出判定稳定性表。
   这些证据已在 harness 里有现成接口。
3. **把 §IV 的"六机制"与 Table I 的七个表面统一**（把过程参数层写成第七个机制，或删去其权重）。

---

## 五、复现命令

```
cd paper/tii
latexmk -g -pdf -interaction=nonstopmode main.tex
python reviews/page_fill.py                 # 页数与各页填充度
python reviews/check_citations.py           # 引用完整性
python reviews/verify_evaluation_numbers.py # 219 条数值断言 vs 归档 20260918043504-bdo
python reviews/apply_panel_corrections.py   # 一轮修正（幂等性：已应用会断言失败）
python reviews/apply_round2_fixes.py        # 二轮修正
python figures/publication/build_scenario_figure.py && node figures/publication/export_scenario_figure.mjs
```
