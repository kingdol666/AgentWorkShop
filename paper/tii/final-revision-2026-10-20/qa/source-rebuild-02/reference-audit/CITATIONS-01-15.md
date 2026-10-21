# Citation audit: original bibliography entries 1–15

Audit date: **2026-10-20 (Asia/Shanghai)**. Numbering is the `main.bbl` order read at the start of this pass; stable citation keys are authoritative after recompilation.

Scope: local `main.bbl`, `resources/refs.bib`, `sections/introduction.tex` and `sections/related.tex`, followed by primary publisher/author/standards-maintainer sources. No manuscript was uploaded and no new third-party bibliography API was called. `web.run` was attempted but returned blank responses in this worker; all live source reads reported here used real browser CDP from the loaded web-access skill. No synthetic web citation IDs are used.

Metadata verification and support of a manuscript claim are separate. Full-text flags below mean the relevant original sections were inspected; they do not mean every paragraph of a source was exhaustively audited. Abstract/catalog-only support is explicitly labelled. Waseem journal issue metadata is carried from the earlier same-day publisher-deposit record with its provenance disclosed.

## Changes that should be made before final delivery

- MADE: replace the asserted multimodal input with the actually described operator-reviewed OPC UA sequence generation; include HITL and virtual/physical demonstrations fairly in the comparison.
- Biskupovic: describe supervision and dynamic service reconfiguration, rather than citing this work for generic organizational-role mapping.
- AgentSpec: update the preprint-only record to the published ICSE 2026 paper, pages 2938–2950, DOI `10.1145/3744916.3764546`.
- MCP: use a versioned specification reference (official current page explicitly says **2026-07-28 latest**); no implication that the protocol lacks authorization or human-approval guidance.
- ISA: split two standards into separate references. ISA-95 Part 1 now has a 2025 edition; retaining 2010 requires identifying it as a historical edition.
- R2R book: the three named people are **editors**, not coauthors. Year 2000 is valid publication metadata despite copyright 2001.
- Fill complete authors in the underlying metadata for Zhao and Agents4PLC, rather than treating `and others` as a verified author list. IEEE may still abbreviate the rendered list.

No invented paper was identified among items 1–15. This statement does not upgrade catalog/abstract-only checks to full-text verification.

## [1] `huang2026made`

**Canonical metadata:** Large Language Model Integration in Industrial Cyber-Physical Systems: A Multi-Modal Architecture for Automated Control Generation. Kuan-Chun Huang; Hsiao-Tse Lin; Chia-Hsuan Lin; Meng-Tien Huang — 2026 International Conference on Control, Automation and Diagnosis (ICCAD), 2026, pp. 1–6. DOI: `10.1109/ICCAD69956.2026.11643124`.

**Verification:** metadata = true; relevant full text = true.

**Manuscript anchors:** sections/introduction.tex:3–4; sections/related.tex:13–14; sections/related.tex:45–46.

**Claim assessment:** Partly supported: control generation, safety layer, human review and evaluation are supported. Specific multimodal-input claim is not demonstrated by the accessed implementation/evaluation sections.

**Primary evidence (paraphrase):** Sections III–IV describe HMI strategy descriptions serialized as JSON, LM Studio, operator authorization, and sequential OPC UA writes. Evaluation covers ten scenarios × four task dimensions and virtual/physical demonstrations.

**Action:** Replace 'generate control updates from multimodal input' with 'generate operator-reviewed OPC UA control sequences'. Table evidence should say '40 control tasks; virtual and physical demonstrations' and reflect HITL authorization. Keep published title unchanged.

**Boundary:** No image/multimodal input evaluation was found in the inspected full text; do not infer it from the title.

**Sources accessed 2026-10-20:**

- https://ieeexplore.ieee.org/document/11643124
- https://doi.org/10.1109/ICCAD69956.2026.11643124

## [2] `koehle2026llmdriven`

**Canonical metadata:** LLM-Driven Multi-Agent Control for Skill-Based Smart Manufacturing. Kay Köhle; Darko Anicic; Thomas A. Runkler; René Graf — 2026 IEEE 31st International Conference on Emerging Technologies and Factory Automation (ETFA), 2026, pp. 1–8. DOI: `10.1109/ETFA68377.2026.11725257`.

**Verification:** metadata = true; relevant full text = true.

**Manuscript anchors:** sections/introduction.tex:4–5; sections/related.tex:14–15,25–30,47–49.

**Claim assessment:** Supported: module-scoped agents and MCP servers expose OPC UA skills; MQTT coordination and state-dependent tool availability are explicit; silent-fault challenges require cross-verification.

**Primary evidence (paraphrase):** Sections IV–VI specify the state tracker, ToolAvailabilityManager and three architectures. Nine simulated challenges run ten times each include a false-success assembly skill and a conveyor command that leaves the plate unmoved. The inspector/factory state enables diagnosis.

**Action:** Keep overlap/state-aware availability and silent-fault discussion. Prefer 'simulated modular factory' or 'six peripheral modules plus conveyor backbone' because the abstract says six modules while implementation counts seven including the belt.

**Boundary:** The paper itself already contains state-conditioned tool admission and observation-based fault diagnosis; do not claim these individually as new or absent from prior art.

**Sources accessed 2026-10-20:**

- https://ieeexplore.ieee.org/document/11725257
- https://doi.org/10.1109/ETFA68377.2026.11725257

## [3] `lim2025llmenabled`

**Canonical metadata:** A Large Language Model-Enabled Control Architecture for Dynamic Resource Capability Exploration in Multi-Agent Manufacturing Systems. Jonghan Lim; Ilya Kovalenko — 2025 IEEE 21st International Conference on Automation Science and Engineering (CASE), 2025, pp. 2088–2095. DOI: `10.1109/CASE58245.2025.11163802`.

**Verification:** metadata = true; relevant full text = true.

**Manuscript anchors:** sections/introduction.tex:5–6; sections/related.tex:17–18.

**Claim assessment:** Supported for dynamic resource capability exploration, resource matching and shop-floor coordination. Avoid reducing the entire contribution to task allocation alone.

**Primary evidence (paraphrase):** Sections I–III describe product agents, resource agents, a central controller agent, resource capability FSM models, bid requests, and adaptation beyond initial resource configurations; the case study is simulation-based.

**Action:** Use 'resource capability exploration and coordination' in synthesis; existing joint citation is appropriate.

**Boundary:** No comparative statement about the present platform's optimization superiority follows from this source.

**Sources accessed 2026-10-20:**

- https://ieeexplore.ieee.org/document/11163802
- https://doi.org/10.1109/CASE58245.2025.11163802

## [4] `zhao2026shopfloor`

**Canonical metadata:** A Large language model-based multi-agent manufacturing system for intelligent shopfloors. Zhen Zhao; Dunbing Tang; Changchun Liu; Liping Wang; Zequn Zhang; Haihua Zhu; Kai Chen; Qingwei Nie; Yuchen Ji — Advanced Engineering Informatics, 2026, vol. 69, article 103888. DOI: `10.1016/j.aei.2025.103888`.

**Verification:** metadata = true; relevant full text = false; author abstract supports the narrow claim.

**Manuscript anchors:** sections/introduction.tex:5–6; sections/related.tex:17–18.

**Claim assessment:** The narrow coordination/resource-matching statement is supported by the original authors' abstract. Full-text claim support beyond that level remains unverified in this pass.

**Primary evidence (paraphrase):** Author-maintained arXiv v2 names the five modules (Machine Server, Bid Inviter, Bidder, Thinking, Decision), dynamic selection of processing machines, and physical shop-floor experiments. It explicitly supplies the published journal title, volume, article number and DOI.

**Action:** Retain the narrow coordination citation. Replace 'and others' in source metadata with all nine known authors if desired. Do not describe this source's experiments as simulation-only.

**Boundary:** Publisher landing presented a robot challenge. Its journal metadata is confirmed by the author's arXiv journal-reference field and the earlier same-day deposit record, not a newly read publisher full text.

**Sources accessed 2026-10-20:**

- https://arxiv.org/abs/2405.16887v2
- https://doi.org/10.1016/j.aei.2025.103888

## [5] `waseem2026pretrained`

**Canonical metadata:** Pretrained LLMs as real-time controllers for robot operated serial production line. Muhammad Waseem; Kshitij Bhatta; Chen Li; Qing Chang — Machine Learning: Engineering, 2026, vol. 2, no. 1, article 015006. DOI: `10.1088/3049-4761/ae4ee8`.

**Verification:** metadata = verified_previous_same_day_publisher_deposit; direct IOP re-read blocked; relevant full text = true.

**Manuscript anchors:** sections/introduction.tex:6–7; sections/related.tex:15–16,50–51.

**Claim assessment:** Supported for LLM robot assignment, prompt constraints, simulated serial line and throughput. Simulation is explicit in primary author full text.

**Primary evidence (paraphrase):** Section 4 presents 2-machine/1-robot and 4-machine/2-robot numerical configurations, 480-step episodes replicated 25 times, and synthetic inputs derived from automotive data. Prompt components include possible actions, feasibility criteria, output format and task objective.

**Action:** Keep the published IOP bibliographic entry and present LLM robot-assignment/throughput as the comparison axis.

**Boundary:** IOP landing redirected to a blocked PerfDrive connection in this pass. The exact 2(1):015006 metadata is carried from the same-date prior publisher-deposit audit; the claim-level read uses the primary author preprint, not a separately verified journal revision.

**Sources accessed 2026-10-20:**

- https://arxiv.org/abs/2503.03889
- https://arxiv.org/html/2503.03889v1
- https://doi.org/10.1088/3049-4761/ae4ee8
- Same-day local provenance: `paper/tii/revision-2026-10-20/IEEE-TII-REQUIREMENTS.md §6/R4`.

## [6] `biskupovic2025supervision`

**Canonical metadata:** Agent-Based Supervision for Service-Oriented Industrial Cyber–Physical Systems. Angel Biskupovic; Alberto Villalonga; Fernando Castaño; Rodolfo E. Haber; Felipe Núñez — IEEE Transactions on Industrial Informatics, 2025, vol. 21, no. 3, pp. 2719–2728. DOI: `10.1109/TII.2024.3514178`.

**Verification:** metadata = true; relevant full text = true.

**Manuscript anchors:** sections/related.tex:4–5.

**Claim assessment:** Current phrasing about organizational roles is too broad for this particular source. Its supported contribution is agent supervision, dynamic service selection and reconfiguration.

**Primary evidence (paraphrase):** The publisher abstract and introduction specify selecting services from a component library according to performance/computational load and monitoring them online to trigger reselection.

**Action:** Rewrite the sentence as 'Industrial agents supervise and reconfigure service-oriented cyber-physical systems'. Keep the 2025 issue year; the DOI's 2024 fragment is not an error.

**Boundary:** This source is not primarily evidence for a taxonomy of organizational roles.

**Sources accessed 2026-10-20:**

- https://ieeexplore.ieee.org/document/10812581
- https://www.ing.uc.cl/publicaciones/agent-based-supervision-for-service-oriented-industrial-cyber-physical-systems/
- https://doi.org/10.1109/TII.2024.3514178

## [7] `liu2026agents4plc`

**Canonical metadata:** Agents4PLC: Automating Closed-Loop PLC Code Generation and Verification in Industrial Control Systems Using LLM-Based Agents. Zihan Liu; Ruinan Zeng; Dongxia Wang; Gengyun Peng; Xiaoxia Liu; Qiang Liu; Peiyu Liu; Wenhai Wang; Jingyi Wang — IEEE Transactions on Software Engineering, 2026, vol. 52, no. 5, pp. 1672–1687. DOI: `10.1109/TSE.2026.3667895`.

**Verification:** metadata = true; relevant full text = true.

**Manuscript anchors:** sections/related.tex:6.

**Claim assessment:** Supported for code generation and code-level formal verification/repair; do not interpret 'closed-loop' in its title as online physical process control.

**Primary evidence (paraphrase):** Publisher full-text introduction explains planning, generation, syntax checking, functional verification and debugging, with direct verification of ST code against formal properties.

**Action:** Retain 'PLC generation and verification'. Add all authors in source metadata if desired; preserve distinction from run-time plant execution.

**Boundary:** This is code synthesis/verification evidence, not evidence of continuously controlling a physical process.

**Sources accessed 2026-10-20:**

- https://ieeexplore.ieee.org/document/11410524
- https://doi.org/10.1109/TSE.2026.3667895

## [8] `wu2025instructmpc`

**Canonical metadata:** InstructMPC: A Human-LLM-in-the-Loop Framework for Context-Aware Control. Ruixiang Wu; Jiahao Ai; Tongxin Li — 2025 IEEE 64th Conference on Decision and Control (CDC), 2025, pp. 172–179. DOI: `10.1109/CDC57313.2025.11312156`.

**Verification:** metadata = true; relevant full text = true.

**Manuscript anchors:** sections/related.tex:7.

**Claim assessment:** Supported for instruction-guided/context-aware control. More precise: LLM translates human context into predicted disturbance trajectories supplied to MPC.

**Primary evidence (paraphrase):** Publisher abstract and introduction explain the Language-to-Distribution module, human instructions and closed-loop fine-tuning from MPC loss; the paper includes a linear-dynamics performance guarantee.

**Action:** Keep the current broad phrase; avoid portraying the LLM itself as a replacement for the downstream numerical MPC.

**Boundary:** Its theoretical result belongs to its particular model and cannot be transferred to the current platform.

**Sources accessed 2026-10-20:**

- https://ieeexplore.ieee.org/document/11312156
- https://doi.org/10.1109/CDC57313.2025.11312156

## [9] `gill2025llmdt`

**Canonical metadata:** Leveraging LLM Agents and Digital Twins for Fault Handling in Process Plants. Milapji Singh Gill; Javal Vyas; Artan Markaj; Felix Gehlhoff; Mehmet Mercangöz — 2025 IEEE 30th International Conference on Emerging Technologies and Factory Automation (ETFA), 2025, pp. 1–8. DOI: `10.1109/ETFA65518.2025.11205597`.

**Verification:** metadata = true; relevant full text = true.

**Manuscript anchors:** sections/related.tex:8.

**Claim assessment:** Supported for digital-twin fault handling.

**Primary evidence (paraphrase):** The publisher abstract and introduction describe plant-specific engineering knowledge for prompting, a digital-twin simulation for validation/verification of corrective actions, and a mixing-module pipe-clogging case.

**Action:** Keep citation. Expand the conference metadata from generic 'Proc. IEEE ETFA' to the official 2025 30th ETFA name if desired.

**Boundary:** No assertion that this work lacks corrective-action validation is warranted.

**Sources accessed 2026-10-20:**

- https://ieeexplore.ieee.org/document/11205597
- https://doi.org/10.1109/ETFA65518.2025.11205597

## [10] `hofmann2025nlc`

**Canonical metadata:** Beyond touch-based human-machine interface: Control your machines in natural language by utilizing large language models and OPC UA. Bernd Hofmann; Niklas Piechulek; Sven Kreitlein; Joerg Franke; Patrick Bruendl — arXiv, 2025. DOI: `10.48550/arXiv.2510.11300`.

**Verification:** metadata = true; relevant full text = false; author abstract supports the narrow claim.

**Manuscript anchors:** sections/related.tex:8–9.

**Claim assessment:** The narrow natural-language OPC UA machine-control claim is supported by the primary author abstract.

**Primary evidence (paraphrase):** The author record describes three tools that read/change OPC UA nodes, an S7-1500 demonstrator with four parameters, fifty synthetic commands per tested model, and transfer to a deployed spray-coating machine.

**Action:** Retain preprint status and original 2025 submission year; pin v2 or indicate revision date if discussing latest experiments. Do not promote to a peer-reviewed publication.

**Boundary:** Full PDF was not inspected in this pass; no stronger claim is certified.

**Sources accessed 2026-10-20:**

- https://arxiv.org/abs/2510.11300v2
- https://doi.org/10.48550/arXiv.2510.11300

## [11] `jiang2026agentic`

**Canonical metadata:** Agentic AI for Safety-Aware Process Monitoring and Fault Diagnosis: A Review. Xiaoyu Jiang; Haotao Xie; Jiayu Wang; Zeyu Yang; Yuanqiang Zhou; Le Yao; Zheren Zhu — Processes, 2026, vol. 14, no. 13, article 2112. DOI: `10.3390/pr14132112`.

**Verification:** metadata = true; relevant full text = true.

**Manuscript anchors:** sections/related.tex:22–23.

**Claim assessment:** Supported for safety-aware, explainable, human-in-the-loop decision-support positioning.

**Primary evidence (paraphrase):** The publisher's original review explains agentic FDD as an orchestration layer grounded in process evidence, engineering knowledge and operator support, and distinguishes this near-term role from unrestricted autonomous plant control.

**Action:** Keep citation and add issue 13 to bibliography. Frame the present design as an implementation consistent with the review's direction, not validation of all its safety recommendations.

**Boundary:** A narrative review is contextual support; it is not empirical validation of this platform.

**Sources accessed 2026-10-20:**

- https://www.mdpi.com/2227-9717/14/13/2112
- https://doi.org/10.3390/pr14132112

## [12] `mcp2024`

**Canonical metadata:** Model Context Protocol — Tools. Model Context Protocol contributors — official specification, 2026.

**Verification:** metadata = true; relevant full text = true.

**Manuscript anchors:** sections/related.tex:61.

**Claim assessment:** Supported for standardized tool discovery, schemas, invocation and results. The protocol also includes human-approval guidance and authorization-dependent tool availability.

**Primary evidence (paraphrase):** The current Tools specification provides tools/list and tools/call, JSON input/output schema and structured results. Its current capability text allows tools to vary with request authorization, while prohibiting connection-state-dependent variation; it recommends human ability to deny invocations.

**Action:** Replace the unversioned 2024 homepage entry by a versioned official specification citation with access date 2026-10-20, while retaining key if desired. Keep the narrow phrase 'standardizes tool interfaces'.

**Boundary:** A version citation identifies documentation, not the version implemented by the repository. Do not claim protocol conformance or absence of authorization unless separately established.

**Sources accessed 2026-10-20:**

- https://modelcontextprotocol.io/specification/2026-07-28/server/tools
- https://modelcontextprotocol.io/specification/2025-11-25/server/tools

## [13] `isa88isa95`

**Canonical metadata:** Two separate standards currently merged in one bibliography entry. International Society of Automation.

**Verification:** metadata = true; relevant full text = false; official catalog supports general scope.

**Manuscript anchors:** sections/related.tex:61–63.

**Claim assessment:** The general recipe and operations-model concepts are supported by the official catalog/series descriptions. Full normative text and compliance have not been verified.

**Primary evidence (paraphrase):** ISA-88 catalog describes hierarchical equipment/procedure models, recipe management and separation of product recipes from equipment control. ISA-95 series page describes the enterprise/manufacturing operations interface and Part 1 models/terminology. The official training page's DOM preserves the exact 2010 ISA-95 designation.

**Action:** Split into one entry per standard. For current general concepts, cite ISA-88.00.01-2010 and ANSI/ISA-95.00.01-2025; alternatively retain the historic 2010 ISA-95 edition explicitly and use its historic official-training record. Do not call 2010 ISA-95 the latest edition.

**Boundary:** No full standard was accessed or reproduced. Catalog descriptions establish scope only, not implementation compliance. The old ISA-95 product URL redirects to the 2025 edition, so it cannot establish the detailed contents of the 2010 edition.

- Separate standard: **ISA-88.00.01-2010**, *Batch Control — Part 1: Models and Terminology*, 2010; ISBN 978-1-936007-75-2.
- Separate standard: **ANSI/ISA-95.00.01-2010 (IEC 62264-1 Mod)**, *Enterprise-Control System Integration — Part 1: Models and Terminology*, 2010; historical edition; official current catalog points to ANSI/ISA-95.00.01-2025.

**Sources accessed 2026-10-20:**

- https://www.isa.org/products/isa-88-00-01-2010-batch-control-part-1-models
- https://www.isa.org/training/training-courses-by-topic/standards-based-courses
- https://www.isa.org/products/ansi-isa-95-00-01-2025-iec-62264-1-mod-enterprise
- https://www.isa.org/standards-and-publications/isa-standards/isa-95-standard

## [14] `moyne2000r2r`

**Canonical metadata:** Run-to-Run Control in Semiconductor Manufacturing. James Moyne; Enrique del Castillo; Arnon M. Hurwitz (editors) — CRC Press, 2000, pp. 366.

**Verification:** metadata = true; relevant full text = false; official publisher synopsis supports broad lineage.

**Manuscript anchors:** sections/related.tex:63–64.

**Claim assessment:** The broad run-to-run recipe-adjustment lineage is supported by the publisher synopsis. Treat the platform's adaptation as the authors' design, not a theorem of the book.

**Primary evidence (paraphrase):** The official publisher explicitly presents an edited volume and describes modification of the product recipe between machine runs to reduce drift, shifts and variability.

**Action:** Change BibTeX author to editor for these three names; retain publication year 2000 (not an error despite copyright 2001). Add ISBN or official publisher URL.

**Boundary:** Full book chapters were not accessed. Avoid claiming a specific algorithm or formal guarantee is derived from this book without a chapter/page anchor. This is intentionally foundational older literature.

**Sources accessed 2026-10-20:**

- https://www.routledge.com/Run-to-Run-Control-in-Semiconductor-Manufacturing/Moyne-delCastillo-Hurwitz/p/book/9780849311789

## [15] `wang2025agentspec`

**Canonical metadata:** AgentSpec: Customizable Runtime Enforcement for Safe and Reliable LLM Agents. Haoyu Wang; Christopher M. Poskitt; Jun Sun — Proceedings of the 2026 IEEE/ACM 48th International Conference on Software Engineering (ICSE '26), 2026, pp. 2938–2950. DOI: `10.1145/3744916.3764546`.

**Verification:** metadata = true; relevant full text = true.

**Manuscript anchors:** sections/related.tex:64–66.

**Claim assessment:** Supported for customizable runtime constraints on agent actions. Its human inspection mechanism directly overlaps the general concept of approval.

**Primary evidence (paraphrase):** The original paper defines a DSL with triggers, predicates and enforcement; implementation intercepts proposed actions and supports termination, user inspection, corrective invocation and reflection.

**Action:** Update the 2025 preprint-only entry to the published 2026 ICSE proceedings metadata and DOI, retaining key if desired. Preserve conceptual overlap instead of implying approval/runtime enforcement is unique.

**Boundary:** No source claim establishes the current platform's effectiveness or industrial protocol guarantees.

**Sources accessed 2026-10-20:**

- https://dl.acm.org/doi/10.1145/3744916.3764546
- https://arxiv.org/abs/2503.18666
- https://arxiv.org/html/2503.18666v3

## Suggested source-aware LaTeX comments

```latex
% BIBLIOGRAPHY (related.tex:45) [Major] [P1]: MADE has HITL authorization and virtual/physical demonstrations; state these fairly in the comparison.
% BIBLIOGRAPHY (introduction.tex:3) [Major] [P1]: Multimodal-input evaluation was not established; cite operator-reviewed OPC UA control-sequence generation.
% BIBLIOGRAPHY (related.tex:4) [Minor] [P2]: This source supports dynamic service supervision/reconfiguration, not a general organizational-role taxonomy.
% BIBLIOGRAPHY (related.tex:61) [Minor] [P2]: Pin current MCP documentation version and access date; no protocol-conformance claim follows.
% BIBLIOGRAPHY (related.tex:62) [Minor] [P2]: Split ISA-88 and ISA-95; distinguish current 2025 and historic 2010 editions.
% BIBLIOGRAPHY (refs.bib:moyne2000r2r) [Minor] [P2]: Use editor rather than author for the edited volume.
% BIBLIOGRAPHY (refs.bib:wang2025agentspec) [Minor] [P1]: Replace preprint-only metadata by the verified ICSE 2026 publication record.
```

