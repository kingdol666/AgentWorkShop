# 与本文最相关的 IEEE 文献（参考用）

本文主题：*A Configuration-Driven Runtime for Integrating Industrial Agents With Online Data Acquisition and Governed Setpoint Operations*
（工业智能体在线取数 → 目标条件分析 → 带类型的控制意图 → 受治理下发 → 回读/后续观测）

本目录中的 PDF 均为**公开获取版本**（作者 arXiv 预印本，对应 IEEE 会议/期刊录用稿）。
IEEE Xplore 上的正式排版版多为订阅内容，未在此镜像；如需正式版请用机构账号按 DOI 下载。

> 说明：6 个 PDF 仅保存在本地工作副本，不纳入 git（第三方版权，见本目录 `.gitignore`）；
> 版本库中保留本索引，按题名/DOI 可随时重新获取。

## 已下载（6 篇）

| 文件 | 题目 | 作者 | IEEE 发表处 | DOI / arXiv | 与本文的关系 |
|---|---|---|---|---|---|
| `Xia2024-etfa-llm-agent-industrial-automation.pdf` | Control Industrial Automation System with Large Language Model Agents | Y. Xia, N. Jazdi, J. Zhang, C. Shah, M. Weyrich | IEEE ETFA 2025 | 10.1109/ETFA65518.2025.11205539 · arXiv:2409.18009 | **最接近的一篇**：LLM 智能体 + 事件驱动信息建模，端到端控制自动化系统；对应本文"取数→分析→下发"链与场景信息供给 |
| `Silva2025-etfa-mcp-manufacturing.pdf` | Beyond Formal Semantics for Capabilities and Skills: Model Context Protocol in Manufacturing | L. M. Vieira da Silva, A. Köcher, F. Gehlhoff | IEEE ETFA 2025 | 10.1109/ETFA65518.2025.11205601 · arXiv:2506.11180 | 把 MCP 作为能力/技能的工具访问层；对应本文的 harness 工具目录与直连 REST/stdio-MCP 入口 |
| `Liu2024-tse-agents4plc.pdf` | Agents4PLC: Automating Closed-loop PLC Code Generation and Verification in Industrial Control Systems using LLM-based Agents | Z. Liu, R. Zeng, D. Wang, G. Peng, et al. | IEEE Trans. Software Eng. (TSE) | 10.1109/TSE.2026.3667895 · arXiv:2410.14209 | 智能体闭环生成 + 形式化验证 PLC 代码；对应本文"批准后复核 / 守卫拒绝"的验证边界 |
| `Romero2025-induscon-intent-based-automation.pdf` | Agentic AI for Intent-Based Industrial Automation | M. Lima Romero, R. Suyama | IEEE INDUSCON 2025（预印本） | arXiv:2506.04980 | 意图驱动（intent-based）自动化；对应本文"带类型的控制意图 + 调度谓词"设计 |
| `Vyas2025-agentic-industrial-control.pdf` | Autonomous Control Leveraging LLMs: An Agentic Framework for Next-Generation Industrial Automation | J. Vyas, M. Mercangöz | arXiv 预印本（30 页，含评测） | arXiv:2507.07115 | 智能体框架做自主控制与评测；与本文实验章节的"脚本策略 vs 无写"对比思路可对照 |
| `Hofmann2025-opcua-natural-language-control.pdf` | Beyond touch-based human–machine interface: Control your machines in natural language by utilizing LLMs and OPC UA | B. Hofmann, N. Piechulek, S. Kreitlein, J. Franke, et al. | arXiv 预印本（本文已引用） | arXiv:2510.11300 | 自然语言 + OPC UA 直接控制；对应本文"直连入口 + 协议驱动注册表" |

## IEEE TII 上的近邻工作（订阅全文，未随包下载）

以下为与本文最贴近、且发表在 **IEEE Transactions on Industrial Informatics (TII)** 的文章，建议用机构账号按 DOI 取正式版：

1. A. Biskupovic, A. Villalonga, F. Castaño, R. E. Haber, F. Núñez, "Agent-Based Supervision for Service-Oriented Industrial Cyber–Physical Systems," *IEEE TII*, vol. 21, no. 3, pp. 2719–2728, 2025. DOI: 10.1109/TII.2024.3514178
   - 本文参考文献 [1]；服务化 ICPS 的智能体监督，是"运行时代理 + 服务编排"最直接的对标工作。
2. Z. Li, Z. Ge, H. Tang, G. Liu, Y. Yang, "ModSolAgent: Automated Finite Element Code Generation for Abaqus via LLM-Based Agent," *IEEE TII*, 2026. DOI: 10.1109/TII.2026.3669495
   - 本文引用；展示 TII 对"LLM 智能体 + 工程软件工具链"的接受度与写法。
3. J. Zhang, H. Wang, Z. Jia, J. Dong, L. Ren, "CoMA-IKG: LLM-Driven Multiagent Framework for Automated Construction of Industrial Knowledge Graph," *IEEE TII*, 2026. DOI: 10.1109/TII.2026.3660116
   - 多智能体协作 + 工业知识工程，可对照"多智能体分工"的表述方式。
4. Y. Zhang, et al., "How Large AI Model Empowers Time-Series Forecasting for the Operation and Maintenance of Industrial Automation System?" *IEEE TII*, vol. 21, pp. 8201–8213, 2025.
   - 大模型 + 工业运维时序，可对照"模型能力 vs 运行时约束"的论证边界。

## 检索与筛选说明

- 关键词：industrial agents、LLM agents for industrial automation、governed setpoint / control intent、MCP in manufacturing、PLC code generation agents、human-in-the-loop approval、OPC UA + natural language。
- 筛选标准：① 处理"取数 → 决策 → 下发"闭环或其中关键边界；② 强调审批/复核/回读/证据分离；③ IEEE 主办或 IEEE 期刊/会议发表；④ 有合法公开全文。
- 下载版本为作者预印本，**排版与页码与 IEEE 正式版不同**；引用时请以 DOI 对应的正式版本为准。

_整理日期：2026-11-17_
