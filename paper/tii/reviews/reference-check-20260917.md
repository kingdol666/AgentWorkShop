# Bounded reference verification — 2026-09-17

## Scope and method

Checked **only eight requested keys** against `paper/tii/refs.bib` and their uses in `paper/tii/sections/introduction.tex:2` and `paper/tii/sections/related.tex:3`. This is not an audit of the entire bibliography, a full-text systematic review, or verification of experimental reproducibility. No manuscript or bibliography edits were made. Primary evidence is arXiv abstract/metadata pages, publisher-deposited Crossref records, and the Scientific Reports publisher page. A batched `web.run` search returned no usable results; direct fetch and the official Crossref API worked. Abstract-level support is explicitly distinguished from metadata-only support below. Publisher blocks were not interpreted as evidence of nonexistence.

## Priority handoff

1. **Correct Agents4PLC journal authors.** The current entry combines 2026 journal metadata with the eight-author 2024 preprint list. The journal has **nine authors**, adding Xiaoxia Liu in fifth position and placing Jingyi Wang last. Add DOI, issue, and pages listed below.
2. **Expand Raza's complete author list.** `Raza, M. and others` is not fabricated, but is incomplete when five exact names are available.
3. **Resolve LLM4PLC author-version spelling deliberately.** arXiv lists Gustavo Quiros Araya; the ACM-deposited proceedings record lists Gustavo Quiros. Prefer the latter for the proceedings citation, while recording that the preprint differs. Add the proceedings DOI and pages.
4. **Keep Sabetta entry year 2024.** Its key says 2025, but its existing bibliographic year is correct. Renaming the key is optional and would require updating citations; do not change the publication year to match the key.
5. Preserve the manuscript's distinction between **real OPC UA machine interaction**, **simulated fault-tolerant control**, and **PLC code generation/verification**. Sharpen InstructMPC's wording to disturbance prediction for MPC. CoMA-IKG's precise verified topic is graph construction, not demonstrated operator assistance.

## 1. `hofmann2025nlc` — verified; version qualification recommended

- Exact title: **Beyond touch-based human-machine interface: Control your machines in natural language by utilizing large language models and OPC UA**.
- Authors, in order: **Bernd Hofmann; Niklas Piechulek; Sven Kreitlein; Joerg Franke; Patrick Bruendl**.
- Identifier: **arXiv:2510.11300**; DOI **10.48550/arXiv.2510.11300**.
- Dates: first submitted **2025-10-13**; latest displayed version **v2, 2026-02-05**.
- Existing title, authors, identifier, and first-submission year match (capitalization differences immaterial).
- Claim support: **yes, abstract-level**. Tools read/change OPC UA node values; evaluation uses a Siemens S7-1500 PLC demonstrator, and the approach is subsequently transferred to a deployed spray-coating machine. This supports the limited manuscript statement that natural-language interfaces have controlled machines over OPC UA. It does not establish certified safety, generic production readiness, or long-horizon autonomous optimization.
- Proposed correction: no mandatory identity correction. Add `doi = {10.48550/arXiv.2510.11300}` and/or an explicit v2 URL; if retaining `year = {2025}`, note `revised February 2026` to make the evidence version clear. This check does not establish whether every v2 deployment detail was already present in v1.
- Primary source: https://arxiv.org/abs/2510.11300 (v2 inspected).

## 2. `vyas2026ftc` — verified; simulation qualifier essential

- Exact title: **From Detection to Action: Using LLM Agents for Fault-Tolerant Control**.
- Authors, in order: **Javal Vyas; Milapji Singh Gill; Artan Markaj; Felix Gehlhoff; Mehmet Mercangöz**.
- Identifier: **arXiv:2606.28011**; DOI **10.48550/arXiv.2606.28011**.
- Date/version: **2026-06-26, v1**. This is in the past relative to this check, not a future citation.
- Existing identity fields match.
- Claim support: **yes, abstract-level**. A multi-agent workflow combines plant knowledge, Graph RAG, simulation, and deterministic validation. Evaluation is explicitly **in simulation** on a discrete Mixing Module and a PID-regulated CSTR. The abstract also describes interlocks, envelopes, dynamic-feasibility checks, bounded planning, and safety fallback.
- Proposed correction: none mandatory; optionally add the arXiv DOI. Keep “simulated fault-tolerant control”; do not recast this as demonstrated live-plant actuation or imply prior work lacks execution validation.
- Primary source: https://arxiv.org/abs/2606.28011.

## 3. `wu2025instructmpc` — verified; refine mechanism description

- Exact title: **InstructMPC: A Human-LLM-in-the-Loop Framework for Context-Aware Control**.
- Authors, in order: **Ruixiang Wu; Jiahao Ai; Tongxin Li**.
- Identifier: **arXiv:2504.05946**; DOI **10.48550/arXiv.2504.05946**.
- Dates: submitted **2025-04-08**; **v3, 2025-09-05** inspected.
- Existing identity fields match.
- Claim support: **yes, with more precise wording available**. Human contextual instructions are translated by a Language-to-Distribution module into predicted disturbance trajectories that inform MPC optimization. The method is not simply direct LLM-issued actuator commands.
- Suggested manuscript replacement: “InstructMPC translates human contextual instructions into disturbance predictions used by model predictive control.” No physical-deployment conclusion is established by the inspected abstract.
- Primary source: https://arxiv.org/abs/2504.05946.

## 4. `liu2026agents4plc` — exists; substantive journal/preprint author mismatch

- Exact journal title: **Agents4PLC: Automating Closed-Loop PLC Code Generation and Verification in Industrial Control Systems Using LLM-Based Agents**.
- **Journal authors, in order:** **Zihan Liu; Ruinan Zeng; Dongxia Wang; Gengyun Peng; Xiaoxia Liu; Qiang Liu; Peiyu Liu; Wenhai Wang; Jingyi Wang**.
- Journal: **IEEE Transactions on Software Engineering, 52(5), 1672–1687, May 2026**.
- Journal DOI: **10.1109/TSE.2026.3667895**.
- Related preprint: **arXiv:2410.14209**, submitted **2024-10-18**, revised **2024-12-25 (v2)**. Its eight-author list matches the current bib entry, but not the published journal record.
- Claim support: **yes for PLC code generation and code-level verification**, based on the inspected preprint abstract and the journal title. The “closed loop” here concerns generation/verification; it is not evidence of online LLM supervisory setpoint control. The final journal full text was not inspected, so no journal-specific performance claim is verified.
- Precise proposed bibliography fields:

```bibtex
author = {Liu, Zihan and Zeng, Ruinan and Wang, Dongxia and Peng, Gengyun and Liu, Xiaoxia and Liu, Qiang and Liu, Peiyu and Wang, Wenhai and Wang, Jingyi},
volume = {52},
number = {5},
pages = {1672--1687},
year = {2026},
doi = {10.1109/TSE.2026.3667895}
```

- Keep the existing journal title and paper title. The arXiv note may be retained as a related preprint, but should not substitute for the journal DOI or authors.
- Primary sources: https://api.crossref.org/works/10.1109/TSE.2026.3667895 ; https://arxiv.org/abs/2410.14209.
- Search caution: the first Crossref title-search hit was a **supplement**, DOI ending `/mm1`; the parent journal DOI above was separately fetched and verified.

## 5. `fakih2024llm4plc` — verified; author spelling differs by version

- Exact title: **LLM4PLC: Harnessing Large Language Models for Verifiable Programming of PLCs in Industrial Control Systems**.
- **Proceedings authors, in order:** **Mohamad Fakih; Rahul Dharmaji; Yasamin Moghaddas; Gustavo Quiros; Oluwatosin Ogundare; Mohammad Abdullah Al Faruque**.
- The arXiv list instead gives **Gustavo Quiros Araya**, as currently entered in the bib. The other five names and ordering agree.
- Venue: **Proceedings of the 46th International Conference on Software Engineering: Software Engineering in Practice**, **192–203**, **2024**.
- DOI: **10.1145/3639477.3639743**; arXiv **2401.05443**, submitted **2024-01-08**. Crossref records print date **2024-04-14** and online date **2024-05-31**; both support year 2024.
- Claim support: **yes, abstract-level**. User-guided iterative PLC code generation uses grammar checkers, compilers, and SMV verification and is validated on a FischerTechnik manufacturing testbed. Do not imply this is merely textual advice or lacks hardware testing; equally, do not conflate it with online agent setpoint control.
- Proposed correction: add `doi = {10.1145/3639477.3639743}` and `pages = {192--203}`. For exact proceedings metadata use `Quiros, Gustavo`; if keeping `Quiros Araya, Gustavo`, document the preprint spelling rather than claiming exact agreement with the ACM record. ACM page retrieval returned HTTP 403, so the discrepancy was not adjudicated against the final PDF.
- Primary sources: https://arxiv.org/abs/2401.05443 ; https://api.crossref.org/works/10.1145/3639477.3639743.
- Freshness: the January/April/May 2024 records are over two years old as of this check; they remain valid historical citations, not evidence of current model capability.

## 6. `zhang2026comaikg` — metadata verified; content availability limited

- Exact title: **CoMA-IKG: LLM-Driven Multiagent Framework for Automated Construction of Industrial Knowledge Graph**.
- Authors, in order: **Jing Zhang; Haiteng Wang; Zidi Jia; Jiabao Dong; Lei Ren**.
- Venue: **IEEE Transactions on Industrial Informatics, 22(6), 5553–5564, June 2026**.
- DOI: **10.1109/TII.2026.3660116**; IEEE document **11407486**.
- All existing identity/publication fields match the publisher-deposited Crossref record.
- Claim support: **metadata/title-level only**. Automated industrial knowledge-graph construction is established by the title; the broader grouping “knowledge-based assistance” is plausible but less precise. The IEEE page returned no extractable content, and Crossref did not provide an abstract. Detailed agent design, experiments, downstream assistance, and actuation claims are **unavailable/unverified** in this bounded check.
- Suggested manuscript wording: “industrial knowledge-graph construction” for this citation, rather than implying an evaluated operator assistant. No bibliography correction required.
- Primary source: https://api.crossref.org/works/10.1109/TII.2026.3660116.
- Attempted publisher source: https://ieeexplore.ieee.org/document/11407486/ (content unavailable).

## 7. `raza2025industrial` — verified; complete the authors

- Exact title: **Industrial applications of large language models**.
- Authors, in order: **Mubashar Raza; Zarmina Jahangir; Muhammad Bilal Riaz; Muhammad Jasim Saeed; Muhammad Awais Sattar**.
- Venue: **Scientific Reports, 15, article 13755**, published **2025-04-21**.
- DOI: **10.1038/s41598-025-98483-1**.
- Existing title, year, volume, article number, and DOI match. Existing author field is incomplete, not an exact author listing.
- Claim support: **yes for broad background**, based on publisher abstract/introduction. This is a cross-industry overview, including predictive maintenance and other applications; not itself an experimental demonstration of PLC control or real-time supervisory actuation. The grouped introductory claim is defensible when the PLC-specific citations supply the program-generation evidence.
- Precise proposed field:

```bibtex
author = {Raza, Mubashar and Jahangir, Zarmina and Riaz, Muhammad Bilal and Saeed, Muhammad Jasim and Sattar, Muhammad Awais}
```

- Primary sources: https://www.nature.com/articles/s41598-025-98483-1 ; https://api.crossref.org/works/10.1038/s41598-025-98483-1.

## 8. `sabetta2025assistant` — metadata verified; 2024 is correct; content unavailable

- Exact title: **Assessment of a large language model based digital intelligent assistant in assembly manufacturing**.
- Authors, in order: **Silvia Colabianchi; Francesco Costantino; Nicolò Sabetta**.
- Venue: **Computers in Industry, 162, article 104129, November 2024**.
- DOI: **10.1016/j.compind.2024.104129**.
- Existing title, author order, year, volume, and article number match the Crossref publisher record. The citation key's `2025` does not change the publication year.
- Claim support: **title-level only** for an assessed assembly-manufacturing assistant. The current introductory use as engineering assistance is consistent with the title. Crossref supplied no abstract; DOI fetch returned only a redirect page, and ScienceDirect fetching was blocked (403 robots check). Therefore assistant behavior, experiment details, direct actuation, and any stronger control/advisory categorization remain **unverified**, not disproved.
- Proposed correction: no mandatory bibliographic correction. Optionally rename to `colabianchi2024assistant` for a less misleading internal key, updating every corresponding citation if the parent elects to do so.
- Primary source: https://api.crossref.org/works/10.1016/j.compind.2024.104129.
- Attempted publisher source: https://www.sciencedirect.com/science/article/pii/S0166361524000575 (blocked).
- Freshness: Crossref includes a July 2024 license start, but that is not treated as proof of the publication date. The confirmed November 2024 issue date is less than two years before this check.

## Coverage-limited conclusion

All **eight identities exist** in primary arXiv/publisher-deposited records. This does **not** mean all eight current entries are exact: Agents4PLC has a material author/version mismatch; Raza lacks complete authors; LLM4PLC has a source-dependent author-name discrepancy. The revised real-machine/simulation/PLC-verification distinction is supported by the inspected abstracts. CoMA-IKG and the assembly-assistant paper have verified metadata but only title-level content support in this run. Nothing outside these eight references is certified by this report.
