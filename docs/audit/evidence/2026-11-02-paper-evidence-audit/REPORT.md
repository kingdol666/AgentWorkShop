# 论文—实验证据一致性审计(2026-11-02)

**对象**:`paper/tii/SUBMISSION-IEEE-TII`(main.pdf 2026-11-02 16:55,10 页)+ `Supplementary-File-S7-data-2026-11-01.zip` + `bench/reports-archive/2026-11-01-perfect/`
**方法**:抽取论文每个数字/主张 → 对账原始 CSV/run.json → 检查摘要/正文/讨论/结论一致性 → 构建与打包检查

---

## 0. 结论

**论文可以按当前口径写入,且属于"真实、可审计"的实验证据:未发现编造数字、未发现正文超出实验边界的成功性主张。**
但"成功"是**有边界的成功**:论文主张的是"配置驱动运行时的受测路径 + 治理写 + 拦截",不是"活体 Agent 自主优化"或"优于工业控制器"。论文自己已用 abstract/discussion/conclusion 三重声明把边界划清,这一点做得正确。

**可写入**;若目标是 TII 少挨 Major Revision,需补"活体 Agent 多轮 + 基线控制器"两类实验(见 §5),而不是改现有数字。

---

## 1. 逐数对账(论文 → 原始产物)

| 论文位置/主张 | 论文数字 | 原始产物 | 核对 |
| --- | --- | --- | --- |
| 集成流水线双跑 | 77 pass / 0 warn / 0 fail ×2;commit `da627d21`;`agentHarness=(none)` | `20261101103641-9j8-run.json`、`20261101104849-xu0-run.json`:checks=77,pass=77,warn=0,fail=0;env.gitCommit=da627d21;env.agentHarness=(none) | ✅ 逐项一致 |
| 场景×协议准入(4 场景子集) | 220/220 受理;219/219 结构拒绝;216/216 回读 | `scenario-protocol-probes-20261101121221.csv`:admissible 220/220;structural 219/219;readback 216/216 | ✅ |
| 分场景表 | injection 44/44/44;wwtp 28/28/28;anneal 28/28/28;biax 120/120、119/119、116/116 | 同 CSV 按 scene 分组逐项一致 | ✅ |
| 五 seed 对照 | C0 0/15 vs C1 15/15;injection 31.206–31.272 vs 32.173–32.340;wwtp 0.198–0.268 vs 3.576–3.864;anneal 134.36–134.90 vs 97.44–99.90 | 10 份 `optcontrol-c0/c1-*.csv` 重算:0/15、15/15;各区间逐位一致 | ✅ |
| C1 工作负载 | 12 写/17 轮、56/59、41/50 | 同 10 份 CSV 求和:完全一致 | ✅ |
| C1 时长 | 150.41–172.90 s/seed | 同 CSV wallS 去重:{150.41,153.14,164.97,166.74,172.90} | ✅ |
| 消融 | full 18/18 拒绝、0/6 越窗;no-interlock 12/18、6/6;no-readback 18/18;legal 9/9、boundary 9/9 | `process-window-ablation.csv`:每臂 attack 18、legit 9、boundary 9;full 18/18、win 0/6;no-interlock 12/18、win 6/6;boundary 9/9 | ✅ |
| 审批 pilot | manual 202→204.8 / 216→216;auto 202→204.8 / 216→218.8 | `approval-gate.csv` 四行逐值一致 | ✅ |
| 授权三用例 | 未绑定拒、绑定放行、跨节点拒 | `authorization.csv` 三行逐项一致 | ✅ |
| 论文数字可追溯 | 每个数字指到 S7 | `Supplementary-File-S7.tex` 表 + 数据包 `file-manifest.json` + 38 个文件 | ✅ |

**结论:论文正文没有"无产物支撑"的数字。**

## 2. 跨章节一致性

- 摘要:"15/15 vs 0/15;0/6 vs 6/6;220/220、219/219、216/216;150.41–172.90 s"——与正文/讨论/结论一致;
- 正文:"C1 is a deterministic policy; not an Agent-generated policy"——与 run.json 的 `agentHarness=(none)`、`toolHarness=opencode` 一致(注:toolHarness=opencode 是直调工具链,不是 LLM Agent);
- 讨论:"C0 不是竞品控制器;审批 pilot 不是人工判断质量证据;无 live Agent/harness 对照"——与产物和台账一致;
- 结论:未出现"优越性/安全性/自主性"表述。

## 3. 构建与打包

| 项 | 状态 |
| --- | --- |
| main.pdf | 2026-11-02 16:55,10 页,`undefined` 0,`Overfull` 0,`??` 0 |
| S7.pdf / S7.tex | 2026-11-02 00:46 / 00:45,S7 引用 `Supplementary-File-S7-data-2026-11-01.zip` |
| S7 数据包 | 38 文件:两跑 run/report/summary、10 份 C0/C1 CSV、探测 CSV、消融/审批/授权/生产态 CSV、图、HTML、manifest |
| **打包隐患** | 目录里同时存在旧包 `Supplementary-File-S7-data.zip`(仅 4 文件)与目录 `Supplementary-File-S7-data/`(同 4 文件);若误传旧包,正文"source CSVs preserved in S7"将落空。**建议删除旧包/旧目录或改名归档** |
| 编译日志 | `main-check.txt` 仍是 2026-11-01 19:56 的旧日志,与 11-02 16:55 的 PDF 不同步;若作为投稿附件,应重生成 |

## 4. 不影响结论、但建议修的口径

1. **cast-film 24/24 未进正文**:S7 明确说明该 run 的 manifest 声明 4 场景却只记录 cast-film、端点不匹配,故排除;正文只写"4 场景子集 220/220"是诚实的。但主文未说明"为什么不是 5 场景",建议在 evaluation 的 E1 段加一句"S7 记录了被排除的 cast-film run 及原因"。
2. **审批段措辞**:"auto-mode calls ... starting values do not match the manual cases named in the runner's pairing labels"——实际 auto 起始值 202/216 与 manual 相同,不匹配的是**标签配对**(auto 行标"manual rejected"却从 202 起)。建议改为"auto rows are not matched to the stimuli named by their labels",避免审稿人误解为数值不一致。
3. **内部结果文档漂移**:`PAPER-READY-RESULTS.md` 写 J_end/J* 0.961–0.983(均值 0.975)、4 写/45.6 s;run.json 的 closedloop 是 0.959–0.985(均值 0.976)、3 写/38.2 s。**论文未引用这组数字**,不影响稿件;但内部文档应回写 run.json,防止下次误抄。
4. **"Each scene uses four families"**:四场景的可写协议各为 4 类(biax 用 HTTP 替代 MQTT),全文合计 5 类,表述成立;若审稿人按"5 类"理解会疑惑,可加"four writable families per scene; five families across the subset"。

## 5. TII 就绪度(证据强度,而非诚信)

**可以作为"系统集成 + 受测路径"论文的证据写入**,因为:
- 每个数字有 runId+CSV/JSON;双跑可复现;分母/对照/边界声明完整;
- 消融是可归因的(移除窗口联锁→6/6 越窗到达驱动,结构限仍拦);
- 论文主动声明"不是 live Agent / 不是控制器对比 / 不是物理安全"。

**但按 TII 审稿强度,当前证据仍偏"软件路径验证"**:
1. 无活体 Agent/真实 harness(主题是工业 Agent);
2. 无基线控制器(PID/规则/MPC),C0 只是不写;
3. 审批消融只有配置级 pilot,无单机制 OFF 臂;
4. simulator-only,无 HIL/实体;
5. N=5、确定性对照,无区间/显著性;跨场景仅 4 场景子集。

**建议补(按投入产出)**:
| 优先 | 实验 | 目的 |
| --- | --- | --- |
| P0 | E2-C3:omp+固定模型,3 场景×5 run,同写预算 | 把"Agent 多轮"从 0 变成有对照的证据 |
| P0 | 基线控制器(PID/规则)同场景/seed | 把"C0 不写"升级为"与工业控制器对比" |
| P1 | E3 单机制审批 OFF(M1 vs M2) | 支撑"审批门有效"而非仅路径 |
| P1 | E1 补 biax 入矩阵/cast-film 合法语料 | 6 场景×5 协议完整矩阵 |
| P2 | E5 harness×model 资格 | 支撑"可替换"架构主张 |
| P2 | HIL/实体单点 | TII 工业可信度 |

## 6. 判定

- **诚信/一致性:通过**。论文数字与最终批次产物逐项一致,没有编造或超范围的成功性主张。
- **可写入:是**——按论文当前的克制口径(配置驱动运行时 + 受测路径 + 治理写 + 窗口联锁消融)可作为真实实验证据。
- **TII 成功概率:可投,但大概率 Major Revision**;瓶颈是证据范围(活体 Agent、基线、HIL),不是数据造假。补 P0 两项后,论文的实验故事会从"路径可行"升级为"机制有效且有对照"。

*审计证据:本报告 §1 的 8 组对账全部来自 `Supplementary-File-S7-data-2026-11-01.zip`(已解包核对)+ `main.pdf`(10 页,0 undefined/overfull)。*
