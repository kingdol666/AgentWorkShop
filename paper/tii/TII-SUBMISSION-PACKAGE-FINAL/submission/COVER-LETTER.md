# Cover Letter (Editor-Facing) — IEEE TII Initial Submission

> 使用说明：
> - TII 初投清单第 3 条把 cover letter 列为不得随稿提交的识别性材料。常规初投**只需要上传稿件 PDF，不需要这封信**。
> - 只有 IEEE Author Portal 提供“仅编辑可见”的投稿信栏位，或编辑部另行索要时才使用；不要把它并入匿名稿件。
> - 方括号 `[...]` 处必须由通讯作者按实际情况填写，填写完整后删除本说明块；发出前确认信中不再留有任何方括号。
> - 本信中的数字与稿件 2026-11-23 版一致；稿件若再改动，请同步核对第 4 段。

---

Date: [submission date]

To: Prof. Gerhard P. Hancke, Editor-in-Chief
IEEE Transactions on Industrial Informatics

Re: Submission of a Regular Research Paper — "A Configuration-Driven Runtime for Integrating Industrial Agents With Online Data Acquisition and Governed Setpoint Operations"

Dear Prof. Hancke,

On behalf of all co-authors, I submit the above manuscript for consideration as a **Regular Research Paper** in IEEE Transactions on Industrial Informatics. The manuscript is 10 pages in the IEEE double-column format and is uploaded as a PDF with all fonts embedded; it contains 6 figures, 4 tables, and 24 references. The uploaded file does not identify the authors.

**Authors (editor-only information).** [Full names, affiliations, countries; corresponding author: name, institutional email, phone.] All authors hold ORCID iDs, registered in the portal. [Funding: grant number(s) and agency, or "No external funding."]

**Originality, exclusivity, and prior circulation.** [Confirm that the manuscript is not under consideration elsewhere, has not been published elsewhere, and that all authors approved the submission.] [Disclose related work or previous public circulation privately to the editor. A version of the manuscript PDF and its LaTeX source is included in a public source-code repository: give the link, the date it was first posted, and state that no conference or preprint version of the paper exists, or describe any that does.]

**Contribution (reviewer-facing summary).** The paper presents a configuration-driven runtime that lets industrial agents acquire process observations and submit setpoint intents through one governed boundary:

- a production-scene model binding line, product, recipe, and run context to direction-specific acquisition and control mappings, registered protocol drivers, and write limits;
- a shared dispatcher admitting task-mediated and direct calls through authorization, conditional approval with post-approval route revalidation, and layered write guards, with command outcomes, readbacks, and later observations kept as separate, verification-graded evidence;
- an evidence-bounded evaluation: 55 write-capable endpoints across four simulated scenes and five protocols (220/220 expected acceptances, 219/219 collected out-of-range rejections, 216/216 matching readbacks), guard and approval-route fixtures, an injection-twin demonstration, an exploratory nine-block scripted-versus-no-write comparison, and three language-model-driven episodes that were canceled before reaching the target band.

**Scope statements we wish to make explicit.** All results are simulator or mock-driver results; the paper does not claim general control efficacy, autonomous convergence, a complete correlated agent-to-device trace, or physical-plant safety. The batch-selection rule of the exploratory comparison is reported as unresolved, and the closed-loop control mechanism is stated as future work, to be pursued through agent-architecture orchestration and process-experience memory reuse inside the same governed boundary.

**Declarations.** [Confirm competing interests and the AI assistance stated here before sending.] The authors declare no competing interests. The manuscript discloses that generative AI via Codex (GPT-6) assisted with language polishing and LaTeX typesetting, and that the cast-film machine row in Fig. 1 is a text-to-image illustration composited with vector annotations. The authors remain responsible for the manuscript. Selected simulator records and run summaries are available on reasonable request; complete service snapshots, raw twin samples, and row-level server journals were not retained. No supplementary file is submitted with the initial manuscript.

**Suggested reviewers (optional).** [Name, affiliation, institutional email — 3–5 researchers working on industrial agents, OPC UA/MCP tool access, or governed plant-facing operations; no conflicts of interest.]

Thank you for considering this submission.

Sincerely,
[Corresponding author name, title, affiliation, institutional email]
