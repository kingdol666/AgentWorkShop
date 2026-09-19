# 五席盲审 · 五轮迭代最终记录（2026-09-19）

**成品**：`paper/tii/main.pdf` —— **11 页**，无 LaTeX error / undefined reference / citation orphan，
`verify_evaluation_numbers.py` **219 条**数值断言对归档 `20260918043504-bdo` 全部通过。

---

## 一、迭代轨迹

| 轮次 | 席位 | 结论 |
|---|---|---|
| 1 | 主编 / R1 方法学 / R2 领域 / R3 系统安全 / DA 对抗 | 五席均 Major Revision；指出多处可核验的事实错误 |
| 2 | R1 / R2 / R3 / DA（验证） | R1 → **Minor**（一轮意见全部实质解决）；DA → Major（收窄到 6 处句子级）；R2/R3 → Major（给文本清单） |
| 3 | R3 / DA（验证） | R3 → Major（给出"若不做 i–v 就 Reject"的信号）；DA → Major（收窄，给出 6 句清单） |
| 4 | DA（最终确认） | **Minor Revision**："Not a block, and no new experiment or fourth adversarial round. Four text edits (~15 min) stand between this and production." |
| 5 | 本轮 | 该 4 处文本修改已全部落地 |

**终止条件已满足**：panel 不再提出需要文本修改的阻塞项；剩余意见全部属于"需要新实验/新数据"一类。

---

## 二、经核实并修正的事实错误（累计）

1. 缺陷率 `0.50–0.53 %` → **`0.38–0.53 %`**（漏 seed 44 = 0.383 %）
2. Fig. 5(b) 图注因果错误（称末点为 J_end 均值，实为逐次实测）
3. `9/9 hard-range` 与档案标签冲突 → 改称 out-of-constraint，并写明该组不含配方窗探针
4. 摘要补"其中 3 项检查跳过了写入子检查"
5. J 分解限定为 seed 42 末点；"gains" 改为预设增益 0.5/0.35/0.3 + 观测响应
6. "energy-for-throughput trade" → 受限动作集合
7. **我自己上一轮引入的假陈述**：film-break guard "在 B 之后才加入"。实测 `1f4o`（B 之前、
   同一 recorded commit `7d4bfc0`）已触发该分支 → 已改为"harness 中存在但 B 未进入；
   另外三个 archive 进入且全部恢复失败（0.04 / −0.02 / −0.02 µm）；第四个 archive 未进分支即崩塌"
8. 失败 archive 判定是 **warn 而非 fail**（73/2/0，hard gate green）→ 已改正
9. 消融段探针分类写错且推论反了（6 个中只有 2 个是窗类）→ 已改正，并补报**已有但未报**的
   边界探针数据（±0.1 单位；窗检查启用时拒绝、禁用时接受、各臂 0 误拦）
10. 达标频次未报 → 现写明"seed 42 参考命令的 10 次归档中 7 次达标、3 次未达标，
    其中 2 次带有其他阶段的不相关失败检查"（本人独立复核一致）
11. "latest archive" → "reference archive B"（B 已非最新）
12. 机制计数 6/7 不一致 → 全文统一为 **seven**
13. §V-C "过程参数层不在 §IV 中" 与新增 §IV-G 自相矛盾 → 改为交叉引用
14. **Fig. 6 图注交叉引用在 PDF 中渲染为 "refsec:writepath"**（源码双反斜杠）→ 已修复
15. Fig. 6 闸门：四行 `pass` → `cleared`；"driver write · readback*" → "driver write accepted"；
    图注与脚注限定为 governed agent write，并注明 recipe/heartbeat 旁路
16. 标题改为 *AgentWorkShop: Node-Native Binding and Governed Write Paths for Agent Teams
    in Industrial Supervision*（原句在摘要里就要自我否认）
17. 第五节由 "Benchmark Evaluation" 改称 **"Integrated Evaluation"**，Table I 同步，
    layer 6 "benchmark" → "evaluation"（与正文"not a benchmark with an external oracle"一致）
18. 复现指纹措辞 "nine checker sources" → **"nine harness modules"**；消融档案以
    seed 42 / 3 次重复 / commit `d6c824d` 标识
19. 补上 §IV 的 **Process-Parameter Mapping Layer** 子节（第七机制）与审批对象字段说明
20. 补上三条循环性残余披露：J 的 throughput/energy 项取自下发设定值、控制律是模型
    `h ∝ N/v` 的代数反解、pass 门限为 `J/J* ≥ 0.8`

---

## 三、评审明确接受为"新实验范围、不阻塞本文"的残余

- HITL 负向分支（拒绝 / 超时 / 绑定撤销 / 重复抑制 / K=2 无人值守）
- ownership · cooldown · pause · disable · 回读不匹配的负向探针
- 固定初始条件的 ≥3 次复跑与判定稳定性表
- 常规 APC/RTO 写路径 baseline、独立于模拟器的 J* oracle
- 物理装置 / TEP·SWaT 回放 / 操作员负荷研究 / 真实 LLM 在环对照
- 模拟器版本入指纹

DA 原话：*"None of it justifies rejecting a paper that now discloses all of it."*
R3 原话（给出替代路径）：*"WITHDRAW/SCOPE the unevidenced assertions instead of evidencing
them — then no new runs are needed."* 本文已采用该替代路径（缩限 Fig. 6 与 §IV-H 的断言）。

---

## 四、仍未解决 —— 需要你决定（唯一阻塞投稿的事项）

**TII 新投稿页数上限是 10 页**（已从 IEEE IES 官方页核实，2025-01-01 起严格执行；
终稿 12 页，第 11 页起收 overlength 费）。当前 11 页作为新投稿会被系统退回。

三条可选路径：
1. 把 Algorithm 1 + 机制细表移入 TII 明确支持的 supplementary material，正文留指针
   （省约 165 pt，且不动你要求留在正文的前四张图）—— 代价最小；
2. 继续压缩正文（约需再删 1000–1200 词，会明显伤及细节）；
3. 合并 Fig. 3 与 Fig. 4。

---

## 五、复现命令

```
cd paper/tii
latexmk -g -pdf -interaction=nonstopmode main.tex
python reviews/page_fill.py                  # 11 页
python reviews/check_citations.py            # 37 引用、零孤儿
python reviews/verify_evaluation_numbers.py  # 219 条断言 vs 归档
python reviews/verify_task11_trim.py         # 受保护内容存在性
python figures/publication/build_scenario_figure.py && node figures/publication/export_scenario_figure.mjs
```
