# IEEE TII manuscript package

Current revision: 2026-10-25, framework-focused narrative refinement. The
final checked anonymous manuscript is **10 pages**,
including four active vector drawings, four tables, one pseudocode figure, and
**30 references**, within the at-most-ten-page requirement.
The delivery manifest records the actual page count. IEEEtran journal
body/bibliography type and margins are unchanged.

The paper presents AgentWorkShop as a configurable industrial-agent framework
that connects collaborative tasks and agent-harness adapters to production
context, analysis and modeling services, semantic acquisition and control, and
protocol drivers. Scene blueprints, channel profiles, tool policies, and
per-agent bindings express scene and task variation around shared services.
Section III links five integration requirements and six design rules to the
layered architecture, configuration chain, modules, and evidence groups. The
experiments cover four historical simulator scenes, protocol integration, two
live-engine tasks using the same harness and model, one deterministic
controller across three seeds, deployment-suite behavior, and a recipe-path
case. A current registered-harness run completes six model-selected tasks
(three sequential executions per scene) with synthetic approval and verified
command receipts. Each has one run-tagged sample after a 20-s wait initiated
after task completion and evidence queries, but all six
samples remain outside their target bands; the tests do not establish process
convergence. The DAQ query used an isolated SQLite fallback. The
782-assertion deployment suite is from archived v0.7.57; the current v0.8.0
rerun covers 65 isolated software checks with mock I/O. Current
profile/binding adaptation across scenes, cross-harness portability,
default-paced recipe recovery, and physical transfer remain unvalidated. No
paired strategy comparison was run.

## Files

- `main.tex` / `main.pdf`: source and compiled anonymous manuscript.
- `sections/`: seven section sources, including the separately described module functions.
- `resources/`: five active manuscript figures and editable SVG/PNG companions,
  the bibliography, and result macros. The earlier governance-timing asset is
  not part of the active figure set or this source archive; its S4/S5 values
  remain summarized in the evaluation text.
- `figures/make-system-2026.py`: the six-band software architecture (Fig. 1),
  cross-module task-execution flow (Fig. 2), and admission/approval boundary
  (Fig. 3).
- `figures/make-evaluation-2026.py`: data-driven experimental plots; the paper
  uses the multi-process and recipe-path figures, while the earlier governance
  timeline remains an audit artifact.
- `REPRODUCIBILITY.md`: R1-R20 evidence units, objective definitions, protocol
  and interpretation of the archived process measurements.
- `FILE-MANIFEST.json`: hashes of the active manuscript and resources.

The manuscript-source ZIP and `IEEE-TII-anonymous-evidence-2026-10-25.zip` are separate
deliverables. The latter contains available raw/derived archives, original
engine logs, replay source snapshots, redaction/hash manifests, and a
claim-to-artifact map. Available scripts are labelled by interface era; the
supplement does not claim a standalone runtime or an exact historical source
snapshot when only an archived commit marker is available. The October 25
evidence package extends the historical anonymous bundle with the October 23
failed boundary checks, the v0.8.0 software rerun, the blocked simulator-
harness record, the R16 fixture diagnostic, and the R20 registered-harness
model execution with original/delivered hashes. Neither R16 nor R20 is
represented as a process-response replicate.

## Compile

From this folder, with TeX Live and IEEEtran installed:

```text
latexmk -pdf -interaction=nonstopmode -halt-on-error main.tex
```

The agent's checks use the latex-paper-en `compile.py` wrapper with shell
escape disabled. Use a Python environment with PyMuPDF for PDF preflight.
Current figure and page-layout checks for this revision are in
`revision-2026-10-25/qa/`. The source and evidence packages, delivery
manifest, and final verification are in `../revision-2026-10-25/`. Official
requirements and earlier evidence/prose audits remain in
`../revision-2026-10-24/`; the October 20 checks and earlier five-seat review
are historical records.
Unchanged primary-source citation audits
remain in `../revision-2026-10-20-tenpage/`; original experimental figure
source-data mappings remain in `../revision-2026-10-20/`.

The current `../revision-2026-10-24/requirements/IEEE-TII-REQUIREMENTS.md`
distinguishes official rules from project choices. TII sets a ten-page
ceiling; exactly ten pages is unnecessary. Thirty references results from separating two standards,
not a journal reference ceiling. Earlier review/build records are historical
artifacts and do not describe the current PDF.

## Editorial and citation scope

The current bibliography contains the actually cited works; the previous
background library and nine-page draft are preserved separately. AgentSpec
uses its ICSE 2026 publication; the R2R book lists editors; MCP is versioned;
ISA-88 and ISA-95 have distinct references. DOI links are printed where available.
The primary-source reports distinguish full-text, author-abstract, catalog and
same-day prior-metadata checks rather than claiming every source was read fully.

Formatting and citation verification are distinct from journal peer review.
The paper reports the mechanisms and process observations its archives support,
and states the simulator/sample scope. The prior five-seat review is preserved
as a historical editorial input; this pass has its own read-only verification.
AI assistance is disclosed for manuscript organization, prose revision, and
plotting-code preparation. Earlier image-generation concepts were exploratory;
the final Figures 1 and 2 were independently redrawn as editable Python
vectors from implementation and evidence. The
official requirements record the AI-disclosure placement issue for anonymous
review; the final portal instructions still govern submission placement.
No external journal submission is performed.
