# Cover Letter (Editor-Facing) — IEEE TII Initial Submission

> 使用说明：本信仅编辑可见（双盲下审稿人不可见），作者信息段可保留。
> 在 IEEE Author Portal（`ieee.atyponrex.com/journal/tii`）的 Cover Letter / Comments 字段粘贴正文，
> 方括号 `[...]` 处填入实际信息后删除本说明块。

---

Date: 2026-11-18

To: Prof. Gerhard P. Hancke, Editor-in-Chief
IEEE Transactions on Industrial Informatics

Re: Submission of a Regular Research Paper — "A Configuration-Driven Runtime for Integrating Industrial Agents With Online Data Acquisition and Governed Setpoint Operations"

Dear Prof. Hancke,

On behalf of all co-authors, I submit the above manuscript for consideration as a **Regular Research Paper** in IEEE Transactions on Industrial Informatics.

**Authors (editor-only information).** [Full names, affiliations, countries; Corresponding author: name, email, phone.] All authors hold ORCID iDs, registered in the portal. [Funding: grant number(s) and agency, or "No external funding."]

**Originality and exclusivity.** The manuscript is original, has not been published previously, and is not under consideration elsewhere. All authors have read and approved the submission. The manuscript and both supplementary files are anonymized for double-blind review; the supplementary archive is anonymized by construction and includes a redaction log.

**Contribution (reviewer-facing summary).** The paper presents a configuration-driven runtime that lets industrial agents acquire process observations and submit setpoint intents through one governed boundary:

- a production-scene model binding line, product, recipe, and run context to direction-specific acquisition and control mappings, registered protocol drivers, and write limits;
- a shared dispatcher admitting task-mediated and direct calls through authorization, conditional approval with post-approval route revalidation, and layered write guards, with command outcomes, readbacks, and later observations kept as separate, verification-graded evidence;
- an evidence-bounded evaluation: 55 write-capable endpoints across four simulated scenes and five protocols (220/220 expected acceptances, 219/219 collected out-of-range rejections, 216/216 matching readbacks), guard/approval-route fixtures, an injection-twin demonstration, an exploratory nine-block scripted-versus-no-write comparison, and three language-model-driven episodes.

**Scope statements we wish to make explicit.** All results are simulator or mock-driver results; the paper does not claim general control efficacy, autonomous convergence, a complete correlated agent-to-device trace, or physical-plant safety. The batch-selection rule of the exploratory comparison is reported as unresolved, and the closed-loop control mechanism is stated as future work, to be pursued through agent-architecture orchestration and process-experience memory reuse inside the same governed boundary.

**Declarations.** The authors declare no competing interests [or list them]. Generative AI was used for limited language editing and source organization; the authors reviewed the manuscript and remain responsible for its content. Supporting evidence is provided as an anonymized supplementary file (S7 narrative PDF and record-level evidence archive).

**Suggested reviewers (optional).** [Name, affiliation, email — 3–5 researchers working on industrial agents, OPC UA/MCP tool access, or governed plant-facing operations; no conflicts of interest.]

Thank you for considering this submission.

Sincerely,
[Corresponding author name, title, affiliation, email]
