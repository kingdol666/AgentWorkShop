# Editorial Decision — Round 1 (盲审编辑裁决书)

**Manuscript:** AgentWorkShop: A Node-Native Integration Framework for LLM Multi-Agent Closed-Loop Control of Heterogeneous Industrial Production Lines
**Panel (blind, independent seats):** EIC Journal-Fit · R1 Methodology · R2 Domain · R3 Perspective/Human-Factors · DA Devil's Advocate
**Seat recommendations:** EIC Minor · R1 **Major** · R2 Minor · R3 **Major** · DA: 2 CRITICAL + 6 MAJOR

## Decision: **MAJOR REVISION**(多数票:R1+R3 两席 Major,DA 2 条 CRITICAL 未消解;核心贡献五席一致认可为真)

## 共识(多席独立印证)
| # | 发现 | 印证席位 |
|---|---|---|
| C-1 | 标题/摘要 "LLM Closed-Loop Control" 超出证据:97% 基准无 LLM(deterministic controller),LLM 实测是 0.76 负结果 | R2-M1, DA-M3, R1-M1, EIC-B5 |
| C-2 | "Enforceable" 措辞超出被测范围:harness 引擎可绕过管线(论文自认),compensating 部署断言未测量 | DA-C1, R2-M5, R3(坦诚加分) |
| C-3 | 证据层级表述:全部实测为仿真层,"live system" 有硬件误导;29/29 为自建攻击集的结构性结果 | DA-C2, EIC-M2, R1-M6 |
| C-4 | 0.76 vs 0.97 对比受混杂因子(6× 加速、脚本操作员、无温度-0、单种子),却在摘要/引言/结论无对冲复述 | R1-M1, DA-M2, R3-m1, EIC-M3 |
| C-5 | 心智模型测试:五席均通过(论文可独立读懂)✅,但各有 3-7 个断裂点需补句 | 全体 |

## DA CRITICAL 裁决(逐条可见裁决)
- **C1(trust boundary vs enforceability)→ 裁决:成立(claim retreat 路径)。** 测量一条注入/越权钻取超出本轮范围(需新实验),故采纳 DA 的 resolve(i)+ 文字降级:摘要/引言改 "enforceable on the platform-exposed path";IV-G 明示 harness 引擎在边界外、compensating 控制为部署属性未测量;插件隔离机制如实描述;引用 IEC 62443-3-3。拒绝路径(不做任何降级)不可接受。
- **C2(closed self-authored evidence)→ 裁决:成立(表述修正 + 覆盖表路径)。** L2/L3 实测超出本轮范围;采纳:摘要改 "on a live software instance over real protocol transports against seeded plant simulators";明确攻击集来源为作者自建;在 V-A 增加 T/F 覆盖表述(measured/drill/acceptance-level/unmeasured);V-I 的 "live" 与 "L1–L3–L4" 矛盾句修正。L3/L2 的实际测量列为遗留工作。

## 修订路线图(执行清单)
**A. 声明降级与重表述(不改数据,只改措辞)**
1. 标题改 "…Governed Closed-Loop Optimization of…"(去掉以 LLM 领衔 control 的过度声明);摘要首句补 supervisory/optimization 定位
2. 摘要:97% 基准注明 "a fixed deterministic controller (no LLM in the loop)";0.76 补 "in four uncontrolled same-seed campaigns (0.35–0.76)";"live system"→"a live software instance over real protocol transports against seeded plant simulators";Wilson 区间移出摘要(改 set-coverage 表述,区间留 Fig.4 并注明 n=6 structural)
3. Sec.I "enforceable rather than merely declared"→"enforceable on the platform-exposed write path";引言区分 supervisory optimization loop vs regulatory control 一句
4. "oscillatory overwrites are impossible"→改证所得:"same-direction ratcheting is prevented; alternating corrections remain allowed, bounded only by the window, step rule, and backstop; cross-agent in-window oscillation is out of scope"(VI 遗留)
5. IV-G 补:引擎边界外=部署属性未测量;插件隔离如实("error isolation, not privilege containment");引 IEC 62443-3-3
6. ISA-88 声明收窄为 formula/parameter 子集(程序控制 out of scope);ISA-95 引用降为层级映射;批间采集停采给出诚实理由(P2 PLC 侧保护持续;降频监控为遗留)
7. 集成成本声明收窄:16s 是 scenario 定义存在后的重commissioning;scenario 编写工时未计价(VI 承认)
8. Eq.(2) 维度修正:τ(n)=max(0.5·10^(−d(n))/|t_scale|, 0.005·span)(最少有效位在原始刻度);Alg.1 补 v_prev 赋值行;unbound 检查命名 stage
9. I3 "third response"→"the third rollback attempt";"optimization record" 在 IV-C 首现处加 2 行 schema/lifecycle 定义;V-B 声明驱动层级=真实五协议传输;MCP 25-tool 子集选择准则一句
10. 摘要 29 推导:V-B/V-D 处注明 29 = 9(film-line) + 20(five-protocol),V-C 6 次为独立 mock 层

**B. 一致性修复(矛盾/算术)**
11. "39 acceptance checks per campaign" 句:改为可核查表述或删除(采纳 R1:denominator 不成立 → 改为逐 campaign 验收结果存于发布档案,正文给 4 campaign 通过区间 "33–35 of 39 across the four campaigns" 若可证实,否则删除)
12. V-I 内部效度段重写:temperature-0 句与 V-H 矛盾 → 描述实况;删未兑现的 nonparametric/spot-check 承诺或如实标注为遗留;声明未报告的指标族(readback-failure capture、spurious rollback、token/cost)为遗留
13. "no transfer beyond L1–L3–L4"→"beyond the measured layers (L1, L4)"
14. Fig.4 [30,90]→[30,90.3];V-F/V-I 同区间两处表述统一为 "across the same campaign repetitions";补测量主机环境(Ryzen 7 9700X, 31 GB, Windows)进 V

**C. 领域正确性(R2)**
15. 告警 warn 带定义补全(参照实现:span 的 ±8%,双侧)+ 批间停采时告警机行为说明
16. "hard interlock"→"driver-enforced hard limit" 措辞 + 与 VI "非安全功能" 句挂钩
17. ISA-88.01:2010/IEC 61512-1 版本更新;ISA-18.2 声明收窄为 detection mechanics 子集;补 EEMUA 191/IEC 62682 引用
18. backstop 最坏时序一句(120–150s 检测窗 + 回退写时延);τ 可按节点覆写一句;"gateway" 术语消歧一句

**D. HITL/R3 规范缺口(如实规范实现现状,未实现项入 VI 遗留)**
19. IV-G 补:审批卡面向内容(提案值 vs PV、窗口位置、步长、基线统计、理由);lapse 计时如实;K 无重置策略=lifetime 语义明示;绑定变更治理、多操作员/交接班、uncertain 判定消费者 → 未实现项入 VI-A 遗留段
20. 人因失效模式 → 设计特征 → 残余风险对照(automation bias/complacency/out-of-the-loop → lapse/dedup/decoupled re-run/ack);引 Bainbridge 1983、Lee & See 2004、Parasuraman & Manzey 2010

**E. 格式/文献(EIC)**
21. 作者块/DOI 占位:保留占位但收敛为单一 TODO 注释;正文删除内部仓库路径引用
22. arXiv 格式统一、"Ren et al."→全作者、"Chatgpt"→"ChatGPT"+venue、[24][25][27][30] 补 "[Online]. Available"
23. Fig.3 caption "Eq. 3"→"Eq. (3)";红星 overplot → 星形偏移;Fig.3 J_end 定义句保持
24. 补引用:IEC 62443-3-3、EEMUA 191(或 IEC 62682 详注)、NIST SP 800-82、ISO 23247、Bainbridge/Lee&See/Parasuraman&Manzey;启用 refs.bib 中已存未被引的 liu2026embodied、ren2025agentic、xu2024company(放入 II 相关工作)
25. "omp" 首用展开;"gel counter" 首用注释;"the rig is restored" 措辞替换

**F. 明确不采纳/降级为遗留(记录理由)**
- DA 建议的 L3 实测、TEP/SWaT 回放、外部攻击集、经典控制器基线、跨种子受控 LLM campaign:均为新实验,超出本轮修订(修订仅重表述+已归档数据的如实呈现);全部列入 VI 遗留与 released protocol
- DA-M5 对抗/多智能体 campaign:同样列入遗留;正文以 scope 声明处理(见 A4)
- DA-m9 median 0.76 四舍五入:R1 独立复算 0.7564→0.76 正确,不采纳
- EIC 建议实测一条外部基线臂:认可价值,列为遗留

## 剩余页数约束
正文保持 ≤11 页:新增引用与规范句(约 +30 行)以 V-B/V-D/VI 冗余压缩与 II 尾部收紧对冲。

---

## Round 2 Verification Outcome(re-review,2026-09-17)

- **R1:** SATISFIED —— M1/M3/M4/M5/M6 = ADDRESSED;M2/M7 = PARTLY(遗留:token/cost 明细、55/55 枚举、release 计数、artifact URL——均为 camera-ready 项);数字全扫无新矛盾;建议上调推荐等级。
- **R2:** SATISFIED —— M1–M5 与 6 项 minor 全部核销(标题改优化口径、无回读策略、振荡声明收回、ISA-88 收窄、containment 降级 + 62443-3-3/NIST 引用)。
- **R3:** SATISFIED —— M1–M5 全部核销(审批卡诚实 scoping、失效模式→机制映射 + Bainbridge/Lee&See/Parasuraman&Manzey、lapse 如实、K=lifetime、16s 范围收窄)。
- **DA:** CRITICALS-CLOSED —— C1/C2 均RESOLVED-BY-RETREAT 且全文一致;M1/M2/M3/M5/M6 RESOLVED-BY-RETREAT;M4 PARTLY(覆盖表已给,F6 措辞与 T3–T5 已补);消解的怀疑未被"误修"。
- 第二轮残留 copy-edit(悬空 VI-A 引用×3、V-A 成本指针、Fig.1 caption、结论限定词、索引词)已在本轮全部落地并经 PDF 验证。
- **编辑结论:五席全部 SATISFIED / CRITICALS-CLOSED,无新增 barrier。** 提交前用户侧遗留:作者块与 artifact DOI(相机就绪项)。
- 篇幅:12 页(TII ≤14 合规)。评审强制新增内容(规范句+7 条文献)使篇幅较上轮 +1 页;若须压回 11 页,可裁 VI-A 部署治理段与 walkthrough 指针句(约 0.5 页),由作者定夺。
