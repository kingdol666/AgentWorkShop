## Verification Report

### Verdict
**Status**: PASS
**Confidence**: high
**Blockers**: 0 for the revised manuscript's technical delivery and evidence-consistency gate.

This is an independent reviewer pass after prose, evidence and figure authoring. It approves the internally revised artifact. It does **not** certify IEEE TII acceptance or that every desirable research-strength condition has been established. Scholarly submission readiness remains **PARTIAL** for the research and policy-placement reasons below.

Verified on 2026-10-24. Main manuscript SHA-256:
`51118c0e71c486665117cd2ceb2e6622c57995a443b3c8a59cab5d60dc659028`.

### Evidence
| Check | Result | Command/Source | Output |
|-------|--------|----------------|--------|
| Isolated software regressions | pass | Independently executed `node node_modules/tsx/dist/cli.mjs --tsconfig .nuxt/tsconfig.server.json --test --test-force-exit --test-concurrency=1` with the eight declared suites | 65 tests, 65 pass, 0 fail; `qa/independent-software-tests.log` |
| Types | not applicable | Change scope is manuscript, figure authoring and QA; no product TypeScript authored by this revision | No claim of a repository-wide product typecheck |
| Independent build | pass | `latex-paper-en/scripts/compile.py main.tex --outdir .../qa/independent-build` | Exit 0; 10 pages; shell escape disabled; `qa/independent-build.log` |
| Technical preflight | pass | `python paper/tii/revision-2026-10-24/qa/verify_revision.py` | All 26 checks passed; `qa/independent-preflight.json` |
| Main/rebuild comparison | pass | Extracted all pages of the main and independent-rebuild PDFs using PyMuPDF | Identical page text and MediaBoxes; rebuild has 10 pages. Byte hashes differ because build metadata differs. |
| Template and fonts | pass | Main source, compiled PDF, font extraction | IEEEtran journal; US Letter; default body geometry retained; 28 font resources embedded; body regular text approximately 9.963 PDF bp = 10 TeX pt |
| Abstract and citations | pass | Source/PDF/BibTeX/BBL comparison | One paragraph, 213 words; 30 cited references printed; no missing citation or reference anchors |
| Build diagnostics | pass with nonblocking warnings | Fresh independent `main.log` | No Overfull, undefined reference, duplicate label, missing glyph or LaTeX error; 24 Underfull hbox warnings remain in narrow justified text/tables/bibliography |
| Final-size figure type | pass | Six source PDF figures plus placed Arial text in main PDF | Source floor 9.0 PDF bp; lowest placed figure type 8.96661 PDF bp, approximately 9 TeX pt |
| Vector artwork and geometry | pass | Six active PDFs; independent collision-audit executions | Zero embedded raster objects; all six collision audits have 0 fail / 0 warn; Fig. 1 is 7.16 × 3.15 in, Fig. 2 is 3.5 × 3.55 in |
| Experimental integrity | pass | Archived hash manifest, three active experimental PDFs, three raw JSON/JSONL sources | All three experimental PDFs and all three raw source hashes unchanged |
| Visual review | pass | Personally inspected `qa/independent-page-01.png` through `independent-page-10.png` and final-size Fig. 1–2 previews | No clipping, overlap, missing text, broken table, incorrect figure order or unreadable panel identified |
| Delivered package identity | pass | Independently recalculated archive SHA-256 values, all 46 source-entry hashes and ZIP path safety | Source archive 46 entries / evidence archive 213 entries; declared archive hashes match; no source-entry mismatch or unsafe path; `qa/independent-package-hashes.json` |
| Clean source-package rebuild | pass, separate coordinator execution inspected | Read `qa/source-package-verification.json` and checked its original hash against the active PDF | Extracted source compile exit 0; 10 pages; every page has matching text, MediaBox and rendered pixels |

### Acceptance Criteria
| # | Criterion | Status | Evidence |
|---|-----------|--------|----------|
| 1 | Entire compiled manuscript no longer than 10 pages | VERIFIED | Main and independently rebuilt PDFs both contain 10 pages including all 30 references |
| 2 | IEEE journal format without shrinking body geometry or type | VERIFIED | IEEEtran journal class, US Letter, no geometry/leading overrides; default body and bibliography type retained |
| 3 | Pre-experiment argument explains the industrial need and architecture | VERIFIED | Introduction:19–27 states tool/production authority, transport/endpoint evidence and trial/retained recipe distinctions; Introduction:39–51 maps three contributions; Related Work:84–88 states the remaining integration problem; System Architecture:15–20 separates state objects |
| 4 | Mechanisms and experiments follow the same contract | VERIFIED | Architecture and mechanisms distinguish node and recipe lifecycles; Q1 admission/readback ablation, Q5 confirmation challenge and Q6 recipe observations answer the corresponding questions; Engineering Interpretation and Conclusion close that argument |
| 5 | Figure 1 communicates a simple accurate component architecture | VERIFIED | Three responsibility groups with shared production context/evidence; separate control and DAQ observation; feedback originates at DAQ; equipment/local protection remains outside platform boundary. Appears on p. 3 near Section III |
| 6 | Figure 2 accurately separates execution/record lifecycles | VERIFIED | Node journal opens inside the successful changed-value write card; observation precedes separate exploration summary; recipe batch receipt precedes caller observation; accepted recipe saving is an explicitly separate caller update. Appears on p. 4 near its first callout |
| 7 | Figures and tables have readable typography, source evidence and correct placement | VERIFIED | Six native vector figures; 9 pt source floor; independent collision checks clean; captions below figures and above three booktabs tables; figure positions p. 3/4/5/8/8/9 and ordered callouts are coherent |
| 8 | Experimental claims accurately describe the available evidence | VERIFIED | Evaluation:24 dates the 65-check rerun; :65 names the upper median; :315 declares the n=1 simulator case; :325–329 retains missing-temperature/freshness limits; :336–344 discloses October 23 failures; three data figures/raw sources remain unchanged |
| 9 | Present positive observations as legitimate bounded evidence | VERIFIED | Q1's ablation isolates the exercised admission role; Q5 preserves unverified transport acceptance; Q4/Q6 show control and response together with scope and targets. Near-boundary results, reverted candidates, `converged=false` and failed recent checks are preserved |
| 10 | Anonymous artifact with accurate AI-use disclosure | VERIFIED for internal review artifact | Identity scan and PDF author metadata are anonymous; Discussion:59–69 names OpenAI language/image assistance, affected Fig. 1–2, vector redrawing and responsibility. Official final placement still needs portal confirmation |
| 11 | Current end-to-end, comparative and physical evidence sufficient to establish broader industrial benefit | PARTIAL | These are not claimed as demonstrated; Discussion:31–46 explicitly states the missing current full exploration trial, matched comparator/independent repetitions and physical transfer. Rendering and copyediting cannot supply them |

The visual check used freshly rendered `independent-page-*` files, not the obsolete first-build page 11. Figure-specific independent collision records are named `qa/independent-fig-*.collision.json`.

The fresh build has no observed layout defect requiring a source change. Underfull hbox warnings were assessed visually at their rendered locations; none produced clipping or misordering. They remain visible in the logs rather than being represented as a completely warning-free build.

### Gaps
- **Research strength remains bounded** — Risk: high for a claim of guaranteed TII publication, moderate for the paper's explicit systems-contract claim. Q4/Q6 have one trajectory per process/case; software checks are not independent plant samples. There is no complete current exploration control-response archive, matched SCADA/fixed-policy comparator, independent physical process study or human-subject approval study. Suggestion: frame any submission around the exercised execution/evidence contract; further efficacy or transfer claims require new, separately recorded studies.
- **AI-disclosure placement** — Risk: medium before external submission. IEEE's general policy requests Acknowledgments disclosure, while TII's anonymous review instructions exclude ordinary acknowledgments. The present identity-free disclosure preserves transparency but is not a verified TII exception. Suggestion: confirm the Author Portal's current disclosure field/placement instructions before submitting, and transfer disclosure to final identified acknowledgments when required.
- **Canonical quick-audit result is not a journal verdict** — Risk: medium if misrepresented. The parent-executed `qa/quick-audit-en.log` genuinely exits 1 with a 1.9/6 “Reject” heuristic result; that result is retained. Its single Critical is a failure to locate a section literally named `methods`, although Sections III–IV contain the architecture, admission equation, policies and operational methods. The claimed missing research gap contradicts Related Work:84–88; its anonymous-author warning matches the deliberate `Anonymous Authors` placeholder. Its 278 count also counts checker explanatory/rewrite metadata as findings. The unexpanded result-macro warnings at Q1 are not missing values in the compiled PDF. The missing comparative baseline is a real evidence limit, accurately retained above; the absence of population confidence intervals for n=1 trajectories is not a justification to invent them. Do not present the raw score either as official peer review or as proof that all scholarly concerns disappeared.
- **Reference verification scope** — Risk: low for this revision. All 30 citation keys and printed entries resolve and no bibliography edits were introduced. This verification did not independently repeat full-text/DOI verification for every cited paper; prior reference audits and the official-requirements research are separate evidence sources.
- **Package check scope** — Risk: low. This reviewer independently verified the final two archive hashes and all 46 declared source-entry hashes. The clean extracted-source rebuild and pixel-equality run were executed by the coordinator; its complete 10-page report was inspected here and agrees with the active PDF hash. The separate evidence-package anonymization/identity scan remains the package author's evidence, rather than a claim that this reviewer reread every historical archived source file.

### Recommendation
APPROVE
Approve the internal revised manuscript and figure deliverables as technically verified and consistent with their stated evidence; keep broader IEEE TII scholarly readiness qualified and resolve the portal disclosure placement before external submission.
