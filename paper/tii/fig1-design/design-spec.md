# Fig. 1 redesign — design spec (Phase 3, single shared input for all three directions)

## What the artefact is
The opening figure of an IEEE Transactions on Industrial Informatics regular paper
(10-page limit, double-column, double-blind). It occupies a full-width float:
**7.16 in x 2.70 in** (aspect 0.377). It is the paper's hero figure: the first thing a
reviewer sees after the abstract, and the only place where the paper's thesis is
stated visually rather than in prose.

## Audience and reading situation
TII associate editors and reviewers, then readers skimming the PDF. Two very different
reading distances: (1) the *glance* — 2 seconds at page scale, where only silhouette,
colour blocking and the (a)/(b) contrast are perceived; (2) the *close read* — 30
seconds at 200% zoom, where every label must resolve. The figure must work at both.
Print reality: IEEE TII is read on paper and in greyscale print-on-demand, so **hue
must never be the sole carrier of meaning**; value steps and shape must survive a
greyscale conversion. Colour-blind safety is mandatory (no red/green opposition).

## Core message (must be legible in the glance)
"Integration is rebuilt per application, and it leaves three questions open; this work
replaces that with one governed member–node path that admits a write under shared
production context and returns evidence."

## Content inventory — every direction carries exactly this
(a) Application-specific integration — the problem
- N applications, each with its own **driver · permission · log** stack, each reaching
  its own device; the middle column is **duplicated per application**.
- Three gaps left open on the write path: **who is authorized**, **which limits apply**,
  **write ↔ outcome link**.
(b) AgentWorkShop member–node binding — this work
- Path: **Channel (lead + workers) → member–node binding → DAQ/DCW nodes
  (engineering quantities) → plant devices (5 protocols)**.
- Admission checks sitting on that path: **recipe · approval · range**.
- Shared production context resolved per request: **line · product · recipe · run**.
- Return path: **readback**, **process observation**, and a **verdict recorded** back.
- Closing artefact: **intervention record** = proposal | result | observation | verdict
  (this is what makes write ↔ outcome inspectable).
- Scope note: readback where the driver supports it; fast PLC regulation stays outside
  the agent-team loop.

## Emotional register
Precise, calm, authoritative — a figure that looks *engineered*, not decorated. The only
permitted energy is the (a) vs (b) contrast: tension on the left, resolution on the right.
No gradients, no drop shadows, no rounded-corner-card soup, no emoji, no clip-art icons,
no 3D. Ink does the work; whitespace does the grouping.

## Hard constraints
- Canvas 716 x 270 units; 1 unit = 0.72 pt at final size. **All type ≥ 9 units (6.5 pt)**;
  node titles 11–12 units; panel titles 12.5–13.5 units.
- Palette per direction, but each must (i) pass greyscale, (ii) avoid red/green pairing,
  (iii) use at most one saturated accent, (iv) reserve colour for meaning, never for
  decoration.
- Connectors are hairlines (0.9–1.2 units). Arrowheads must be small and consistent.
- Fonts must be installed system faces (Arial / Segoe UI / Tahoma / Times New Roman);
  no webfont download, no font that could silently fall back and reflow.
- Vector only, so the figure converts to a crisp PDF for LaTeX.

## Visual motif (why the form is what it is)
The paper's core object is a **governed write**: a request that must pass a gate and that
produces a return path of evidence. So the figure's motif is *path + gate + return loop*.
Direction (a) therefore must show paths **without** a gate and **without** a return; the
absence is the argument. Every direction renders the gate as a distinct, non-rectangular
mark (valve / lock / bracket) so that "governed" is recognisable by shape, not by colour.

## Output format
Three directions, each a standalone SVG at the exact final aspect, plus a gallery HTML
for side-by-side judgement at true print size and in greyscale. Winner is then converted
to vector PDF and dropped into the LaTeX float, replacing
`figures/publication/fig1-governed-binding.pdf`.
