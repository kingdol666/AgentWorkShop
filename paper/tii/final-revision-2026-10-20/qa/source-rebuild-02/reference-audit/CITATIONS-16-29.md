# Citation audit: references 16–29

Audit date: **2026-10-20 (Asia/Shanghai)**. Scope: the `main.bbl` numbering at the start of this revision; stable BibTeX keys below remain authoritative after reordering. Local bibliography and citation-bearing paragraphs in `related.tex` and `discussion.tex` were read first. The complete field-level record is in [citations-16-29.json](citations-16-29.json).

All 14 reference identities were confirmed from publisher, author, regulator, standards-body, or protocol-owner originals. **One citation-bearing sentence needs narrowing**: the original Part 11 reference was asked to support too many generic automation practices. Several metadata completions are recommended. No manuscript/source/BibTeX file was modified by this auditor.

`web.run` was called as required but returned blank tool output in this agent. Public pages were then read through the web-access skill using newly created background browser tabs; ordinary publisher/protocol-owner PDFs were also read. No Crossref/Semantic Scholar/other third-party metadata API was called, and no manuscript was uploaded. Search snippets were discovery aids only. Paid standards full texts were not accessed; catalog verification is not a compliance audit.

## Actionable corrections

- **Part 11 scope and identity:** cite the 2003 FDA **guidance** by its exact title/type; the regulation itself was issued in 1997. The guidance directly supports defined electronic-record/signature controls, authority checks, accountability, and risk-based audit trails. It does not substantiate all generic DCS/SCADA range checks or versioned recipes. Suggested split: “Versioned recipes organize executable production intent [ISA-88]. Electronic-record and signature practice provides precedents for authority checks, accountability, and risk-based audit trails [FDA guidance].” Keep this as a precedent, without a compliance claim.
- **Shielding pages:** the publisher's original AAAI PDF prints **2669–2678**. Add `pages={2669--2678}`.
- **DNP3 edition:** IEEE Std 1815-2012 is real, but the IEEE SA catalog labels it **Inactive-Reserved** from **2023-03-30**. It remains a valid historical telecontrol precedent. The DNP Users Group primer, p. 7, directly confirms select-before-operate/direct-operate sequencing; neither sequence establishes physical process attainment.
- **IEC 61511:** complete the Part 1 title. The revised discussion inspected during this audit correctly separates PLC interlocks from safety instrumented systems (SIS) and assigns IEC 61511 to the latter. The original broader “protection remains in the PLC/DCS” attribution was too broad.
- **Historical literature:** references older than two years below serve foundational or historical functions. Their age is disclosed; replacing established safety/control/human-factors origins with newer secondary summaries would not improve source fidelity.

## Per-reference findings

### [16] `debenedetti2025camel`

**Identity:** Edoardo Debenedetti; Ilia Shumailov; Tianqi Fan; Jamie Hayes; Nicholas Carlini; Daniel Fabian; Christoph Kern; Chongyang Shi; Andreas Terzis; Florian Tramèr. *Defeating Prompt Injections by Design*. arXiv, 2025. DOI: `10.48550/arXiv.2503.18813`. Identifier: arXiv:2503.18813.

**Status:** VERIFIED. Cited as an arXiv preprint; v1 2025-03-24, v2 2025-06-24. The inspected arXiv page does not assign a journal/conference publication. Current/recent relative to the 2026-10-20 audit.

**Use in manuscript:** CaMeL uses capability-based information-flow control to govern data/tool behavior. **Support:** SUPPORTED.

**Original-source synthesis:** CaMeL separates trusted-query control/data flows and applies capabilities/security policies at tool invocation to constrain unauthorized data flows. This directly supports the narrow related-work description; it supplies no evidence of this manuscript's implementation or physical safety. **Read scope:** Author-submitted arXiv metadata and abstract.

**Primary sources (accessed 2026-10-20):**
- https://arxiv.org/abs/2503.18813

### [17] `part11`

**Identity:** U.S. Food and Drug Administration. *Part 11, Electronic Records; Electronic Signatures — Scope and Application*. Guidance for Industry, 2003. Identifier: FDA-2003-D-0143; guidance about 21 CFR Part 11.

**Status:** EXISTS_BUT_ENTRY_CONFLATES_GUIDANCE_AND_REGULATION. Final FDA guidance, September 2003; public page content-current date 2018-08-24. Guidance is nonbinding and is distinct from the regulation originally issued in 1997. Older than two years; used as a foundational/historical reference.

**Use in manuscript:** Original related-work sentence groups range checks, approvals, versioned recipes, and audit trails in DCS/SCADA and electronic batch-record practice under this one citation. **Support:** NEEDS_NARROWING.

**Original-source synthesis:** The guidance covers defined FDA-regulated electronic records/signatures, authority/operational/device checks, and risk-based audit/record controls. It does not establish generic DCS/SCADA range-check practice or recipe-version control. It expressly discusses narrow applicability and enforcement discretion. **Read scope:** FDA guidance HTML, including scope, authority checks, electronic signatures, audit trails, and nonbinding-status sections.

**Recommended edit:** Use exact guidance title without prefixing it as the regulation itself; set howpublished to Guidance for Industry and include official FDA URL. Narrow the citation-bearing sentence to electronic-record/signature accountability, authority checks, and risk-based audit trails; support range/recipe practices with ISA-88 or implementation evidence separately. Do not describe this system as Part 11 compliant or certified.

**Primary sources (accessed 2026-10-20):**
- https://www.fda.gov/regulatory-information/search-fda-guidance-documents/part-11-electronic-records-electronic-signatures-scope-and-application
- https://www.fda.gov/media/75414/download

### [18] `iec62443-3-3`

**Identity:** International Electrotechnical Commission. *IEC 62443-3-3:2013: Industrial communication networks — Network and system security — Part 3-3: System security requirements and security levels*. International Standard, 2013, 80 pages (catalog extent). Identifier: IEC 62443-3-3:2013, edition 1.0.

**Status:** VERIFIED. Published 2013-08-07; catalog stability date 2027; 2014 corrigendum included. Older than two years; used as a foundational/historical reference.

**Use in manuscript:** Industrial control-system security environment / deployment credentials, endpoint security, and IT/OT separation. **Support:** SCOPE_SUPPORTED_CLAUSE_LEVEL_NOT_ASSESSED.

**Original-source synthesis:** The public scope identifies technical control-system security requirements and capability security levels, applied using zones and conduits. It supports broad IACS security context; individual clauses, implementation compliance, and certification were not assessed. **Read scope:** Public IEC catalog metadata and scope only; paid standard full text not read.

**Recommended edit:** Retain as security-context reference; avoid asserting formal IEC 62443 compliance or implying catalog access proves every detailed deployment clause.

**Primary sources (accessed 2026-10-20):**
- https://webstore.iec.ch/en/publication/7033

### [19] `ieee1815dnp3`

**Identity:** IEEE. *IEEE Standard for Electric Power Systems Communications—Distributed Network Protocol (DNP3)*. IEEE Standard, 2012. Identifier: IEEE Std 1815-2012.

**Status:** VERIFIED_HISTORICAL_INACTIVE_EDITION. IEEE SA catalog: published 2012-10-10; Inactive-Reserved since 2023-03-30. Historical reference, not an active-current-standard claim. Older than two years; used as a foundational/historical reference.

**Use in manuscript:** DNP3 select-before-operate is a telecontrol precedent for staged command handling. **Support:** SUPPORTED_AS_HISTORICAL_PRECEDENT.

**Original-source synthesis:** IEEE's catalog verifies the designation/title and protocol scope. The DNP Users Group primer explicitly describes control and analog-output requests using select-before-operate or direct-operate sequences on page 7. This does not equate command staging with observing physical process attainment. **Read scope:** IEEE SA public standard catalog; DNP Users Group original 8-page Primer, Revision A, 2005-03-20, p.7.

**Recommended edit:** Add historical wording if needed; do not label IEEE1815-2012 active/current. No full paid IEEE standard was accessed; SBO claim was checked using the protocol owner's public primer.

**Primary sources (accessed 2026-10-20):**
- https://standards.ieee.org/ieee/1815/5414/
- https://www.dnp.org/Portals/0/AboutUs/DNP3%20Primer%20Rev%20A.pdf

### [20] `alshiekh2018shielding`

**Identity:** Mohammed Alshiekh; Roderick Bloem; Rüdiger Ehlers; Bettina Könighofer; Scott Niekum; Ufuk Topcu. *Safe Reinforcement Learning via Shielding*. Proceedings of the AAAI Conference on Artificial Intelligence, 32(1), 2018, 2669–2678. DOI: `10.1609/aaai.v32i1.11797`.

**Status:** VERIFIED_CURRENT_ENTRY_OMITS_PAGES. Published AAAI-18 conference paper; publisher landing page lists 2018-04-29. Older than two years; used as a foundational/historical reference.

**Use in manuscript:** Formal shielding is a distinct safety-enforcement approach that complements supervisory governance. **Support:** SUPPORTED.

**Original-source synthesis:** The work synthesizes a shield from temporal-logic specifications, monitors learner actions, and corrects actions that would violate the specification. Its formal-property setting supports distinguishing shielding from this manuscript's supervisory checks. **Read scope:** AAAI publisher metadata/abstract plus original PDF first page and page-number footers.

**Recommended edit:** Add pages={2669--2678}; the original publisher PDF has 10 pages with these printed page numbers.

**Primary sources (accessed 2026-10-20):**
- https://ojs.aaai.org/index.php/AAAI/article/view/11797
- https://ojs.aaai.org/index.php/AAAI/article/download/11797/11656

### [21] `ames2017cbf`

**Identity:** Aaron D. Ames; Xiangru Xu; Jessy W. Grizzle; Paulo Tabuada. *Control Barrier Function Based Quadratic Programs for Safety Critical Systems*. IEEE Transactions on Automatic Control, 62(8), 2017, 3861–3876. DOI: `10.1109/TAC.2016.2638961`.

**Status:** VERIFIED. Published in August 2017 issue; online date 2016-12-13 is not a conflicting publication year. Older than two years; used as a foundational/historical reference.

**Use in manuscript:** Control-barrier-function safety certification differs from ordinary range/admission checks. **Support:** SUPPORTED.

**Original-source synthesis:** The paper formalizes forward invariance via barrier functions and combines safety constraints with Lyapunov performance objectives in quadratic programs. It supports the manuscript's methodological distinction; no CBF proof is supplied for this system. **Read scope:** IEEE publisher metadata/abstract and introduction; author arXiv abstract/related DOI.

**Primary sources (accessed 2026-10-20):**
- https://ieeexplore.ieee.org/document/7782377
- https://arxiv.org/abs/1609.06408

### [22] `sha2001simplex`

**Identity:** Lui Sha. *Using simplicity to control complexity*. IEEE Software, 18(4), 2001, 20–28. DOI: `10.1109/MS.2001.936213`.

**Status:** VERIFIED. Published July–August 2001 issue; IEEE date of publication 2001-08-31. Older than two years; used as a foundational/historical reference.

**Use in manuscript:** Simplex assurance is a distinct mechanism with a reliable safety/core controller and switching logic. **Support:** SUPPORTED.

**Original-source synthesis:** The Simplex section separates high-assurance and high-performance subsystems and uses decision logic to retain the plant within an established stability envelope or hand control to the assurance controller. It supports differentiation from a software supervisory record/admission layer. **Read scope:** IEEE publisher metadata, article introduction, and The Simplex Architecture section.

**Recommended edit:** Capitalize Simplex when naming the architecture.

**Primary sources (accessed 2026-10-20):**
- https://ieeexplore.ieee.org/document/936213

### [23] `parasuramanmanzey2010complacency`

**Identity:** Raja Parasuraman; Dietrich H. Manzey. *Complacency and Bias in Human Use of Automation: An Attentional Integration*. Human Factors, 52(3), 2010, 381–410. DOI: `10.1177/0018720810376055`.

**Status:** VERIFIED. Published research review; publisher first-online date 2010-10-20. Older than two years; used as a foundational/historical reference.

**Use in manuscript:** Approval workflow structure is distinguishable from measured operator comprehension, complacency, and automation bias. **Support:** SUPPORTED_AS_HUMAN_FACTORS_CONTEXT.

**Original-source synthesis:** The review integrates evidence on automation-related complacency and bias, highlighting attention, multitask load, and omission/commission errors. It motivates human evaluation, but it does not diagnose this system or show its operators experience those effects. **Read scope:** SAGE publisher metadata/abstract; page extent also checked in publisher's rights-link metadata (startPage=381,endPage=410).

**Primary sources (accessed 2026-10-20):**
- https://journals.sagepub.com/doi/10.1177/0018720810376055

### [24] `parasuraman2000model`

**Identity:** Raja Parasuraman; Thomas B. Sheridan; Christopher D. Wickens. *A model for types and levels of human interaction with automation*. IEEE Transactions on Systems, Man, and Cybernetics—Part A: Systems and Humans, 30(3), 2000, 286–297. DOI: `10.1109/3468.844354`.

**Status:** VERIFIED. Published May 2000; IEEE publication date 2000-05-31. Older than two years; used as a foundational/historical reference.

**Use in manuscript:** Human responsibility and automation allocation require explicit design beyond adding a confirmation click. **Support:** SUPPORTED_AS_DESIGN_CONTEXT.

**Original-source synthesis:** The model distinguishes acquisition, analysis, decision/action selection, and action implementation and their levels of automation. Human performance consequences are primary design-evaluation criteria. It supports the workflow-versus-human-outcome distinction. **Read scope:** IEEE publisher metadata/abstract.

**Primary sources (accessed 2026-10-20):**
- https://ieeexplore.ieee.org/document/844354

### [25] `bainbridge1983ironies`

**Identity:** Lisanne Bainbridge. *Ironies of automation*. Automatica, 19(6), 1983, 775–779. DOI: `10.1016/0005-1098(83)90046-8`.

**Status:** VERIFIED. Published November 1983; 2021 author-site posting is a reproduction, not the paper's publication year. Older than two years; used as a foundational/historical reference.

**Use in manuscript:** Automation changes residual operator tasks and responsibility; human collaboration is a separate evaluation concern. **Support:** SUPPORTED_AS_FOUNDATIONAL_CONTEXT.

**Original-source synthesis:** The original discusses monitoring and manual takeover, maintenance of manual/cognitive skills, and human-computer collaboration in industrial process control. It supports discussing the human role without asserting a demonstrated defect in this system. **Read scope:** Elsevier publisher issue/article metadata and abstract; author's reproduced original paper, including monitoring/manual-takeover/human-computer collaboration sections.

**Primary sources (accessed 2026-10-20):**
- https://www.sciencedirect.com/science/article/pii/0005109883900468?via%3Dihub
- https://www.sciencedirect.com/journal/automatica/vol/19/issue/6
- https://www.complexcognition.co.uk/2021/06/ironies-of-automation.html

### [26] `greshake2023injection`

**Identity:** Kai Greshake; Sahar Abdelnabi; Shailesh Mishra; Christoph Endres; Thorsten Holz; Mario Fritz. *Not What You've Signed Up For: Compromising Real-World LLM-Integrated Applications with Indirect Prompt Injection*. Proceedings of the 16th ACM Workshop on Artificial Intelligence and Security (AISec '23), 2023, 79–90. DOI: `10.1145/3605764.3623985`.

**Status:** VERIFIED. Published 2023-11-26; publisher notes corrected version of record on 2024-01-10 with minor nonsubstantive changes, same work/DOI. Older than two years; used as a foundational/historical reference.

**Use in manuscript:** Retrieved documents/prompts are treated as untrusted inputs at the execution boundary. **Support:** SUPPORTED_AS_THREAT_MODEL_CONTEXT.

**Original-source synthesis:** The paper demonstrates indirect injection through retrieved data that can redirect application behavior and API invocation. It supports separating retrieved content from authority; it is not evidence of an exploit or a completed attack evaluation in the submitted system. **Read scope:** ACM publisher metadata, editorial note, and author-supplied abstract; arXiv author record/abstract. Publisher AI-generated summary was not used..

**Primary sources (accessed 2026-10-20):**
- https://dl.acm.org/doi/10.1145/3605764.3623985
- https://arxiv.org/abs/2302.12173

### [27] `liu2024pinjection`

**Identity:** Yupei Liu; Yuqi Jia; Runpeng Geng; Jinyuan Jia; Neil Zhenqiang Gong. *Formalizing and Benchmarking Prompt Injection Attacks and Defenses*. 33rd USENIX Security Symposium (USENIX Security 24), 2024, 1831–1847. Identifier: ISBN 978-1-939133-44-1.

**Status:** VERIFIED. Published USENIX Security 2024 proceedings paper; official open-access record. Current/recent relative to the 2026-10-20 audit.

**Use in manuscript:** Prompt injection warrants an explicit untrusted-input boundary and separately measured attack evaluation. **Support:** SUPPORTED_AS_THREAT_MODEL_CONTEXT.

**Original-source synthesis:** The authors formalize prompt injection and evaluate attacks/defenses across multiple models/tasks. The narrow contextual citation is appropriate. It does not establish this system's defense effectiveness or lack of vulnerabilities. **Read scope:** USENIX publisher metadata and abstract.

**Primary sources (accessed 2026-10-20):**
- https://www.usenix.org/conference/usenixsecurity24/presentation/liu-yupei
- https://www.usenix.org/system/files/usenixsecurity24-liu-yupei.pdf

### [28] `iec61511`

**Identity:** International Electrotechnical Commission. *IEC 61511-1:2016: Functional safety — Safety instrumented systems for the process industry sector — Part 1: Framework, definitions, system, hardware and application programming requirements*. International Standard, 2016, 175 pages (catalog extent). Identifier: IEC 61511-1:2016, edition 2.0.

**Status:** VERIFIED_ENTRY_TITLE_CAN_BE_COMPLETED. Published 2016-02-24; September 2016 corrigendum included; catalog links AMD1:2017 and consolidated edition, so do not call base edition the entire latest series. Older than two years; used as a foundational/historical reference.

**Use in manuscript:** Updated discussion states IEC 61511 concerns independently engineered safety instrumented systems and their process-safety lifecycle. **Support:** SUPPORTED_AFTER_SCOPE_CORRECTION.

**Original-source synthesis:** The public scope covers specification, design, installation, operation, and maintenance of safety instrumented systems intended to achieve/maintain a safe process state. This supports the corrected SIS-specific sentence, not equating every PLC/DCS with an SIS. **Read scope:** Public IEC catalog metadata/scope only; paid standard full text not read.

**Recommended edit:** Use the full Part 1 title and identify as an International Standard. Original broader PLC/DCS attribution was flagged to root; revised discussion inspected during this audit now separates PLC interlocks from SIS and assigns IEC61511 to the latter.

**Primary sources (accessed 2026-10-20):**
- https://webstore.iec.ch/en/publication/24241

### [29] `downs1993tep`

**Identity:** J. J. Downs; E. F. Vogel. *A plant-wide industrial process control problem*. Computers & Chemical Engineering, 17(3), 1993, 245–255. DOI: `10.1016/0098-1354(93)80018-I`.

**Status:** VERIFIED. Published March 1993; later online digitization date 2001-07-27 is not the paper's year. Older than two years; used as a foundational/historical reference.

**Use in manuscript:** Tennessee Eastman is an established additional process-control benchmark for further evaluation. **Support:** SUPPORTED.

**Original-source synthesis:** The original introduces an industrial chemical-process model for studying plant-wide/multivariable control and describes manipulated valves, measurements, objectives, and disturbances. Current wording names it as a potential additional setting, not an experiment already performed. **Read scope:** Elsevier publisher article/issue metadata and original abstract; N. L. Ricker's University of Washington TE archive as supplementary primary simulator-maintainer context.

**Recommended edit:** Do not infer that the repository experiments used the Tennessee Eastman benchmark.

**Primary sources (accessed 2026-10-20):**
- https://www.sciencedirect.com/science/article/pii/009813549380018I?via%3Dihub
- https://www.sciencedirect.com/journal/computers-and-chemical-engineering/vol/17/issue/3
- https://depts.washington.edu/control/LARRY/TE/download.html

## Boundary of the conclusion

This audit verifies identities and the narrow claims described above. It does not certify the system against FDA/IEC/IEEE standards, infer implementation behavior from citations, or convert a literature precedent into experimental evidence. After the Part 11 sentence is narrowed and bibliography metadata is completed, root should rerun the local citation/key check and inspect the final paragraph contexts because prose is being revised concurrently.

