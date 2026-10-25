# IEEE TII requirements and figure-design reference

Checked: 2026-10-24 (Asia/Shanghai). Scope: regular research initial submission, anonymous review, Figures 1–2, and experimental-figure presentation. This file records requirements and design guidance; it does not certify the manuscript's scientific acceptance.

## 1. Authoritative publication requirements

| Item | Verified rule and practical implication | Official source |
|---|---|---|
| Page ceiling | Regular research papers newly submitted since 2025-01-01 are limited to **10 pages**. Accepted final versions have a separate 12-page ceiling. For this task, count the entire compiled PDF, including figures and references, against 10 pages. Exactly 10 pages is unnecessary. | [TII home / March 2025 announcement](https://www.ieee-ies.org/pubs/transactions-on-industrial-informatics) |
| Review format | IEEE double-column manuscript, with readable figures. Use the journal template without shrinking the body text or changing margins to manufacture compliance. | [Current TII submission checklist](https://www.ieee-ies.org/pubs/transactions-on-industrial-informatics/new-submission?view=article&id=423:tii-checklist-for-manuscript-submissions&catid=17), [official TII template selector](https://template-selector.ieee.org/secure/templateSelector/format?publicationTypeId=1&titleId=188&articleId=1) |
| Anonymous review | Remove names, biographies, affiliations, identifying footnotes and ordinary acknowledgments from the review manuscript. The journal describes double-blind review. Also inspect PDF metadata and supplementary material for identity. | [TII home](https://www.ieee-ies.org/pubs/transactions-on-industrial-informatics), [submission checklist](https://www.ieee-ies.org/pubs/transactions-on-industrial-informatics/new-submission?view=article&id=423:tii-checklist-for-manuscript-submissions&catid=17) |
| Submission PDF | The checklist accepts a manuscript PDF and specifies a maximum file size of 40 MB; fonts must be portable or embedded. New submissions use the IEEE Author Portal. | [New-submission page](https://www.ieee-ies.org/pubs/transactions-on-industrial-informatics/new-submission), [checklist](https://www.ieee-ies.org/pubs/transactions-on-industrial-informatics/new-submission?view=article&id=423:tii-checklist-for-manuscript-submissions&catid=17) |
| Scope and contribution | TII requires industrial application and a clear, original technical contribution. A generic informatics framework alone is insufficient. A systems paper should connect its mechanisms to concrete industrial operating requirements and evidence. | [TII scope](https://www.ieee-ies.org/pubs/transactions-on-industrial-informatics) |
| Abstract | IEEE Author Center currently requires one self-contained paragraph, at most 250 words, without abbreviations, footnotes, references or mathematical equations. Include purpose, approach, results and implications. The general live page does **not** specify a 150-word minimum; 150–250 words is a conservative template-based working target, not a minimum verified from that page. | [Structure Your Article](https://journals.ieeeauthorcenter.ieee.org/create-your-ieee-journal-article/create-the-text-of-your-article/structure-your-article/) |
| Citations and clarity | Cite and discuss relevant work, include recent relevant research, explain the original accomplishment, and avoid unnecessary information. No universal 30-reference ceiling was found. | [TII submission checklist](https://www.ieee-ies.org/pubs/transactions-on-industrial-informatics/new-submission?view=article&id=423:tii-checklist-for-manuscript-submissions&catid=17) |

The TII checklist still states that EPS figure files are required at the final stage. IEEE Author Center's general artwork guidance accepts PDF and several other formats. These statements concern different stages: **vector PDF is appropriate for the current embedded review figures; preserve editable sources and plan EPS export if required by the eventual TII production checklist**. Do not claim that a PDF-only archive satisfies every future production upload requirement.

## 2. Official graphics requirements

| Property | Verified guidance | Implementation contract for this manuscript |
|---|---|---|
| File type | IEEE accepts PS, EPS, PDF, PNG and TIFF. Office formats are acceptable when the artwork was originally created there. SVG is useful source material but is not in the listed submission-artwork formats. | Deliver embedded PDF artwork and keep SVG/source scripts separately. |
| Vector preference | PS/EPS/PDF provide scalable graphics; vector artwork is preferable for diagrams. | Keep labels, boxes and arrows as vectors in final Figures 1–2 when feasible. A bitmap inside a PDF remains a bitmap. |
| Width | Standard single-column width: 3.5 in / 88.9 mm. Standard double-column width: 7.16 in / 182 mm. | Fig. 1 at 7.16 × 3.15 in and Fig. 2 at 3.5 × 3.55 in fit the standard widths. Verify their **actual included sizes**, not merely source sizes. |
| Typography | Recommended fonts include Helvetica, Times New Roman, Arial, Cambria and Symbol. At full size, type should be approximately 9–10 pt. Embed fonts or convert text to outlines. | Use one type family and a restrained hierarchy; audit the smallest label after LaTeX scaling. |
| Raster resolution | Color/grayscale artwork: >300 dpi. Black-and-white line art: >600 dpi. Upsampling after creation does not restore original detail. | Measure effective pixels per included inch. A 2,048-pixel-wide image across 7.16 in is only about 286 dpi; changing the PNG dpi tag does not fix this. |
| Grayscale/accessibility | Figures should remain interpretable in grayscale. Use shape, line style, brightness and direct labeling alongside color. | Use solid versus dashed arrows and explicit labels. Never encode admitted/blocked or command/observation solely by red versus green. |

Sources: [Resolution and Size](https://journals.ieeeauthorcenter.ieee.org/create-your-ieee-journal-article/create-graphics-for-your-article/resolution-and-size/), [File Formatting](https://journals.ieeeauthorcenter.ieee.org/create-your-ieee-journal-article/create-graphics-for-your-article/file-formatting/), [Create Graphics for Your Article](https://journals.ieeeauthorcenter.ieee.org/create-your-ieee-journal-article/create-graphics-for-your-article/).

IEEE does not prescribe a unique TII palette, box count, border thickness, arrow grammar or architecture layout on these pages. White backgrounds, restrained color, aligned groups, short labels, ample whitespace and limited arrow crossings are **editorial design choices**, not journal mandates.

For experimental charts, captions should identify what is measured, units, sample sizes, uncertainty/aggregation and the comparison being made. The plotting source must retain the actual recorded values. Positive results are legitimate evidence only when their denominator, baseline, scope and uncertainty are clear; figure styling cannot establish causation, plant safety or physical deployment. These are research-integrity and review criteria, rather than a TII-specific plotting recipe.

## 3. AI-generated schematic policy

IEEE's current author policy explicitly covers AI-generated text, figures, images and code. Such assistance is **not categorically prohibited**, but must be disclosed with the AI system, the affected parts of the article and the extent of generation. Authors remain responsible for checking the result. Editing and grammar assistance alone is treated differently: disclosure is recommended rather than required.

Source: [IEEE Submission and Peer Review Policies — Guidelines for AI-Generated Content / Use by Authors](https://journals.ieeeauthorcenter.ieee.org/become-an-ieee-journal-author/publishing-ethics/guidelines-and-policies/submission-and-peer-review-policies/).

Practical disclosure text, to be adjusted to the actual workflow:

> OpenAI image generation was used to draft the compositions of Figs. 1 and 2. Their scientific content and labels were checked against the implementation, and the final artwork was redrawn as editable vector graphics.

Only state vector redrawing if it actually occurred. Record the actual system name returned by the tool or platform; do not invent a model version. If the generated raster is the final included asset, say that instead. Retain prompts and provenance. Never use generative imagery to synthesize experimental outcomes.

### Anonymous-review disclosure placement: unresolved rule interaction

IEEE's general policy places the disclosure in Acknowledgments, while the TII review checklist excludes acknowledgments to preserve anonymity. No TII-specific public exception resolving that placement was located during this check. An identity-free **AI Assistance Disclosure** paragraph is a reasonable review-stage implementation, followed by transfer into Acknowledgments in the identified final manuscript; this is a **practical interpretation, not a verified TII exemption**. Keep the disclosure in the manuscript and, if the portal offers a relevant field, in that field as well. This placement detail should be checked against the actual portal instructions before external submission. It does not block internal figure creation or compilation.

## 4. Original TII examples and transferable diagram logic

The examples below are the authors' original papers, accessed through their full-text/figure records, rather than blog advice. They are style references, not current policy.

1. **De Benedictis et al., “Digital Twins for Anomaly Detection in the Industrial Internet of Things: Conceptual Architecture and Proof-of-Concept,” TII 19(12), 11553–11563, 2023.** [DOI](https://doi.org/10.1109/TII.2023.3246983), [author full-text and figures](https://www.researchgate.net/publication/368728148_Digital_Twins_for_Anomaly_Detection_in_the_Industrial_Internet_of_Things_Conceptual_Architecture_and_Proof-of-Concept), [layered architecture figure](https://www.researchgate.net/figure/Layered-conceptual-DT-architecture-supporting-anomaly-detection-through-CC-and-its_fig1_368728148). The paper separates a layered conceptual architecture from offline/online activity processes. Figure captions and surrounding text explain layer roles and map functions to the governing feedback loop. Activity flows distinguish data artifacts through a stated line convention. Transferable lesson: give architecture and mechanism different jobs, and explain arrow semantics in the caption instead of filling every box with prose. This paper is older than two years; use it as an architectural communication example, not a source for current rules.

2. **Vitale et al., “Process Mining for Digital Twin Development of Industrial Cyber-Physical Systems,” TII 21(1), 866–875, 2025.** [DOI](https://doi.org/10.1109/TII.2024.3465600), [author full text](https://www.researchgate.net/publication/384917493_Process_Mining_for_Digital_Twin_Development_of_Industrial_Cyber-Physical_Systems), [university record](https://www.iris.unina.it/handle/11588/993601). Its high-level view precedes a more detailed framework, with offline and online responsibilities explicitly separated. Transferable lesson: introduce the overall responsibility boundary first and then refine a small number of meaningful lifecycle transitions; do not duplicate the same component inventory in both figures.

Access boundary: search-indexed original full text, captions and figure records were read. Direct university PDF retrieval returned access/timeout errors, and the full-resolution ResearchGate image endpoint returned HTTP 403. Therefore this research establishes the examples' **diagram structure and caption logic**, but does not claim a fresh pixel-level visual audit of those published images or a measured survey of the journal's colors/fonts. The official graphics rules above were checked independently.

## 5. Figure 1 and Figure 2 design brief

### Fig. 1: responsibility architecture

Scientific message: the supervisory framework joins task reasoning, governed execution and industrial I/O while keeping physical protection outside its boundary.

- Three clear groups: Team and strategy; Governance; Industrial integration.
- One proposal path to the admission/dispatch boundary, one explicit observation return path, and linked production context/evidence.
- Distinguish DCW commands from DAQ observations with labels and arrow styles.
- Show the plant/PLC safety boundary once; avoid protocol logos, decorative machines, gradients, repeated database cylinders and exhaustive API inventories.
- Short labels at final 9–10 pt; caption carries the longer explanation.

### Fig. 2: evidence lifecycle

Scientific message: dispatch admission and downstream confirmation/observation are distinct events, and the two execution routes retain their own semantics.

- Use two aligned lanes or two compact panels, with consistent left-to-right ordering.
- Put the shared admission/approval gate in a clear common location; separate protocol acceptance, driver readback and process observation.
- Use one visual treatment for retained records and another for actions, with the meanings explained in the caption.
- Do not imply a physical response from an ACK, a data-change receipt or a returned tool call.
- Keep failures/holds visible only where they are part of the actual contract, without expanding the figure into an exhaustive exception chart.

These briefs follow the manuscript's current system contract and should be reconciled with the code/evidence audit before final inclusion.

## 6. Final verification checklist

- Compiled PDF has no more than 10 pages, including references.
- Standard IEEEtran double-column template, readable body/bibliography and unchanged margins.
- Abstract is one paragraph and at most 250 words; all numerical claims agree with evidence.
- Fig. 1–2 references appear before or near the figures; labels, captions and prose describe the same mechanism.
- Final-size artwork remains readable; fonts embedded/outlined; no clipped labels, overlapping arrows or ambiguous crossings.
- Raster assets satisfy effective original resolution at the included size; vector sources are available.
- Experimental figures show real data, measurement units, scope, denominator and honest comparison/uncertainty where applicable.
- PDF metadata and supplements preserve anonymity.
- AI assistance is accurately disclosed; final external-submission placement is checked against the portal.
- No prediction of TII acceptance is presented as a formatting verification result.

## Retrieval notes

The live TII home and current checklist were successfully read directly over HTTPS on 2026-10-24 using PowerShell `Invoke-WebRequest`; the web extraction tool returned HTTP 418 for those same URLs. The current official pages, rather than stale search snippets or the local `http[local-path]` placeholders, are the basis for the rules above. IEEE Author Center pages were read with the web extraction tool. No private manuscript was uploaded to an external literature service as part of this research.
