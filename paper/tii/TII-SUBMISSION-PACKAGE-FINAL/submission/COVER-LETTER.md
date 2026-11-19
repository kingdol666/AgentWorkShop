# Cover Letter (Editor-Facing) — IEEE TII Initial Submission

> 使用说明：这是可选投稿信模板，不是初投必传文件。只有在 IEEE Author Portal 或编辑部确认渠道仅编辑可见后才发送，不要插入匿名稿件。
> 方括号 `[...]` 处按实际情况填写；所有声明核实后删除本说明块。

---

Date: [submission date]

To: Prof. Gerhard P. Hancke, Editor-in-Chief
IEEE Transactions on Industrial Informatics

Re: Submission of a Regular Research Paper — "A Configuration-Driven Runtime for Integrating Industrial Agents With Online Data Acquisition and Governed Setpoint Operations"

Dear Prof. Hancke,

On behalf of all co-authors, I submit the above manuscript for consideration as a **Regular Research Paper** in IEEE Transactions on Industrial Informatics.

**Authors (editor-only information).** [Full names, affiliations, countries; Corresponding author: name, email, phone.] All authors hold ORCID iDs, registered in the portal. [Funding: grant number(s) and agency, or "No external funding."]

**Originality, exclusivity, and prior circulation.** [Confirm the manuscript is not under consideration elsewhere and all authors approved the submission. Disclose related work or previous public circulation privately to the editor, providing dates, links, and the relationship to this submission where applicable.] The submitted manuscript PDF does not identify the authors.

**Contribution (reviewer-facing summary).** The paper presents a configuration-driven runtime that lets industrial agents acquire process observations and submit setpoint intents through one governed boundary:

- a production-scene model binding line, product, recipe, and run context to direction-specific acquisition and control mappings, registered protocol drivers, and write limits;
- a shared dispatcher admitting task-mediated and direct calls through authorization, conditional approval with post-approval route revalidation, and layered write guards, with command outcomes, readbacks, and later observations kept as separate, verification-graded evidence;
- an evidence-bounded evaluation: 55 write-capable endpoints across four simulated scenes and five protocols (220/220 expected acceptances, 219/219 collected out-of-range rejections, 216/216 matching readbacks), guard/approval-route fixtures, an injection-twin demonstration, an exploratory nine-block scripted-versus-no-write comparison, and three language-model-driven episodes.

**Scope statements we wish to make explicit.** All results are simulator or mock-driver results; the paper does not claim general control efficacy, autonomous convergence, a complete correlated agent-to-device trace, or physical-plant safety. The batch-selection rule of the exploratory comparison is reported as unresolved, and the closed-loop control mechanism is stated as future work, to be pursued through agent-architecture orchestration and process-experience memory reuse inside the same governed boundary.

**Declarations.** [Confirm competing interests and the actual AI assistance before sending.] The manuscript discloses the use of generative AI via ZCode for language editing, abstract drafting, LaTeX source organization, and the layout of Fig. 4. The authors remain responsible for the manuscript. Underlying simulator records are available on reasonable request; no narrative supplement is submitted with the initial manuscript.

**Suggested reviewers (optional).** [Name, affiliation, email — 3–5 researchers working on industrial agents, OPC UA/MCP tool access, or governed plant-facing operations; no conflicts of interest.]

Thank you for considering this submission.

Sincerely,
[Corresponding author name, title, affiliation, email]
