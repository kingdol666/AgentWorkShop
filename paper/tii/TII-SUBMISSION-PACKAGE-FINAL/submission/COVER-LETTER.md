# Cover Letter — IEEE Transactions on Industrial Informatics

**Editor-only document — do not include in the anonymous manuscript PDF**

**Date:** [YYYY-MM-DD]

**To:** The Editor-in-Chief

*IEEE Transactions on Industrial Informatics*

**Re:** Regular Research Paper — “A Configuration-Driven Runtime for Integrating Industrial Agents With Online Data Acquisition and Governed Setpoint Operations”

Dear Editor-in-Chief,

On behalf of all authors, we submit the manuscript entitled “A Configuration-Driven Runtime for Integrating Industrial Agents With Online Data Acquisition and Governed Setpoint Operations” for consideration as a **Regular Research Paper** in *IEEE Transactions on Industrial Informatics*.

The manuscript addresses an industrial-informatics integration problem: an industrial agent may use online process observations to propose a setpoint change, but observation access and a plausible proposal must not by themselves authorize a plant-facing write. We present a configuration-driven runtime operation boundary that binds line, product, recipe, and run context to direction-specific acquisition and control mappings, registered protocol drivers, and configured limits. Task-mediated and direct calls are designed to enter a common dispatch boundary; route handlers then apply authorization, value admission, conditional approval, and route-specific revalidation. Command outcomes, optional setpoint readbacks, and later process observations are retained as distinct evidence types.

The contribution is a runtime contract for integrating industrial-agent proposals with governed writes, not a new control law or reasoning algorithm. The main evaluation uses direct probes at 55 writable endpoints in four simulated scenes spanning five protocol families. The service returned the expected response to all 220 admissible requests and all 219 collected structural violations; all 216 available simulator readbacks matched the requested values. Mock-driver fixtures tested selected guard branches. A separate scripted comparison and a simulated-twin write are exploratory; none of the three language-model episodes reached the target band. These tests characterize the exercised write paths. They do not establish task/direct parity, autonomous control, controller efficacy, or physical-plant performance.

The manuscript is within the scope of TII because it concerns the integration of industrial agents with production context, heterogeneous industrial communication mappings, online data acquisition, governed setpoint operations, and evidence-aware plant-facing execution. We believe the distinction between a proposed action, an authorized operation, a dispatched command, a readback, and a subsequent process observation is relevant to readers developing industrial-agent runtimes and supervisory automation systems.

**Statements to be completed and verified by the authors before submission**

- **Authors and affiliations:** [Insert the complete author list, affiliations, countries, and corresponding-author contact details.]
- **ORCID and institutional email:** [Confirm that every author has an ORCID iD and an institutional email address in the IEEE Author Portal.]
- **Originality and exclusive consideration:** [Confirm that the manuscript is original, has not been published previously in substantially the same form, is not under consideration elsewhere, and has been approved by all authors.]
- **Prior circulation or related public material:** [If applicable, disclose to the editor any conference paper, preprint, public repository, or earlier public circulation, including the URL, date, overlap, and relationship to this manuscript. The anonymous PDF intentionally contains no such identifying link.]
- **Funding:** [Insert the funding statement, grant number(s), or “This research received no external funding.”]
- **Competing interests:** [Confirm the manuscript statement “The authors declare no competing interests,” or replace it with the accurate disclosure.]
- **Suggested reviewers:** [Optional; provide only eligible researchers with institutional contact details and no conflicts of interest, if the portal requests them.]

The manuscript discloses the authors’ use of generative AI via ZCode for language editing, abstract drafting, LaTeX-source organization, and the layout of Fig. 4. The authors remain responsible for the accuracy, originality, and final approval of all submitted material. The study used simulated scenes, mock-driver fixtures, and a PLC-based simulated twin; it involved no human participants, personal data, or physical-plant operation. Selected simulator records and run summaries are available on reasonable request, while complete service snapshots, raw twin samples, and row-level server journals were not retained. No narrative supplementary file is being submitted as a routine initial-submission attachment; any supplementary or data material will be supplied only if permitted and requested by the journal or editor.

Thank you for considering this manuscript. We would be grateful for the opportunity to have it evaluated by the TII editorial and peer-review process.

Sincerely,

[Corresponding author full name]\
[Department, Institution]\
[City, Country]\
[Institutional email]\
[Telephone, if required]
