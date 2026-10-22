# Figure 1–2 redesign and rendered quality checks

Date: 2026-10-20. Backend: Python / Matplotlib exclusively. The figures are implementation schematics: no measured result, new process trial, statistical aggregate, or uncertainty interval is encoded.

## Figure contract

Figure 1 answers how replaceable task reasoning connects to production-scoped execution without conflating commands, command confirmation, and process observation. Its component architecture has an interface/extension band, a shared production-context band, three service columns, linked records, and an external equipment/local-protection block. The stepped dashed platform boundary includes interface and evidence services but excludes the equipment. The left feedback route has at least 2.6 pt clearance from the MediaBox after accounting for stroke width.

Figure 2 answers how bounded exploration and recipe dispatch differ in persistence and observation responsibility. Two aligned lanes intentionally retain different endpoints: exploration saves a later summary after its wait/query; recipe dispatch returns graded per-parameter evidence and leaves waiting, process interpretation, and a separate recipe-update request to its caller. A node journal and an exploration summary are separate records. The journal is opened after a successful value-changing governed node write, subject to the existing anchor deduplication; an unchanged value is not represented as a new intervention.

## Implementation anchors

All paths below are relative to the repository root; these are audit pointers, not experimental evidence.

- `server/services/workshop/agents/host-tool-bridge/dispatch.ts`, lines 105–165: server-enforced channel profiles. Read-only observation/training and the optimization entry have different tool surfaces.
- `server/services/workshop/agents/industrial/optimization-tools.ts`, lines 46–104: profile/control/target-scope checks, starting control snapshot at line 78, target-window baseline at line 96, then delegation to the internal governed node executor.
- `server/services/workshop/agents/industrial/dcw-tools.ts`, lines 114–219: capability resolution, conditionally required approval, post-approval grant checks, and internal node write. This is not a public direct-write Agent entry.
- `server/services/workshop/dcw/recipe-rollback-manager/lock.ts`, lines 48–105: the post-write hook deduplicates anchors, skips unchanged values, and opens a journal for Agent/rollback sources after the successful write path. The journal is not created by the later exploration-summary insert.
- `server/services/workshop/agents/industrial/optimization-tools.ts`, lines 107–133: successful writes lead to platform waiting, a second target query, and a separate insert into `optimization_explorations`.
- `server/services/workshop/agents/industrial/recipe-gate.ts` and `ops-tools.ts`, lines 1036–1143 and 1148–1248: recipe-specific scopes, trial/apply approval and revalidation, dispatch, graded receipt, and caller follow-up guidance. No universal check order shared by every route is asserted.
- `server/services/workshop/dcw/dcw-controller/recipes.ts`, lines 114–159 and 211–212: create the batch run before sequential per-parameter write and verification; persist results and ACK summary.
- `server/services/workshop/agents/industrial/ops-tools.ts`, line 738 onward: `recipe_update` is a separate caller-invoked definition operation, not an automatic quality verdict or an implicit part of trial dispatch.
- `server/services/workshop/dcw/param-limits.ts`, lines 32–80: operation-specific source limits. The component figure uses a gate bundle rather than a false common four-layer sequence.
- `server/services/workshop/daq/daq-controller/state.ts`, line 93 onward, and `sweep-alarms.ts`, lines 19–47: timestamped acquisition is separate from DCW command confirmation.

## Fresh validation

Generation command:

```powershell
python paper/tii/SUBMISSION-IEEE-TII/figures/make-system-2026.py --only architecture runtime
```

The script defaults to these two figures; the admission/HITL asset is opt-in and was not regenerated. All QA is redirected to this directory by default; `--qa-dir` supports an explicit alternate audit location.

- Source validator: 19 PASS, 2 WARN, 0 FAIL; exit 0. Reviewed WARNs: PNG is a preview while the manuscript uses vector PDF, so no TIFF is needed for this schematic delivery; the source validator cannot infer a width from the canvas helper, while the exported MediaBoxes verify exact dimensions.
- Figure 1: 7.16 × 3.15 in; Arial regular/bold embedded as TrueType; 9 pt minimum; 0.5 pt minimum stroke; 0 raster objects; 26 editable SVG text objects; collision audit 0 FAIL / 0 WARN.
- Figure 2: 3.50 × 3.55 in; Arial regular/bold plus embedded DejaVu Sans glyph fallback for full-size Unicode subscripts; 9 pt minimum; 0.6 pt minimum stroke; 0 raster objects; 29 editable SVG text objects; collision audit 0 FAIL / 0 WARN.
- Figure 2 panel alignment: PASS, 0 FAIL / 0 WARN, no exemptions. Both lanes are 116 × 195 pt with exactly shared top/bottom boundaries and matching panel-label anchors; tolerance remains 1.5 pt.
- Figure 1 alignment: NOT APPLICABLE because it is one connected component diagram, not comparable subplots.
- Exports: exact-size PDF and editable SVG, 600 dpi PNG (Figure 1: 4296 × 1890 px; Figure 2: 2100 × 2130 px), 300 dpi final-size preview and grayscale preview. Both PDFs have empty author/keyword metadata.
- Automated text audit checks actual rendered PDF sizes at a 9 pt floor. Unicode subscripts use full-size glyphs rather than scaled mathtext, so no smaller hidden glyphs are introduced.

## Final-size and grayscale inspection

The complete architecture and each of its three columns were inspected in the final-size preview, followed by grayscale inspection. Titles, context, gate bundle, distinct DCW/DAQ contracts, external equipment boundary, and linked evidence remain legible. Commands and responses are distinguished by direction, line style, and direct labels as well as color. No text is clipped, no path crosses a label, and the left feedback arrow stays inside the figure.

Both execution lanes were inspected separately and together in final-size color and grayscale. The five event rows align exactly, arrow gaps are consistent, all labels fit at 9 pt, baseline precedes execution, node journaling precedes platform observation, batch creation precedes parameter verification, and the separate recipe save has a dashed caller-action connection. The muted navy/teal palette is supplementary to the explicit lane headings; grayscale preserves the argument.

These checks validate figure artifacts and their implementation mapping. The manuscript must retain the journal-opening qualification in Figure 2's caption and continue to distinguish implementation capability from simulator experiment coverage. They do not constitute journal acceptance or a claim of validated industrial process performance.

## Final PDF SHA-256

- Figure 1: `1ad40d2764cdad1cee610581c25f6adcf8796758aaf1da631d102e525794c8d5`.
- Figure 2: `7aca692d19cdd133c7e2471c6db1111ba3f5843d84b39cf61748473e7eac5db6`.
- Unchanged admission/HITL PDF: `3be2c9e2f400769f67b86c864c1299ab8338499bf51fc6788fa9b0bb7a65e63c`.
