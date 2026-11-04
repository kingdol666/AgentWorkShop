# Manuscript review and revision — 4 November 2026

## Editorial assessment

**Major revision before submission.** This is an internal assessment, not an
IEEE editorial decision. The manuscript now states a coherent, bounded
integration question, but the present results do not establish a control
efficacy advantage, a successful autonomous-Agent write, or physical-plant
safety. The originality and practical significance of the integration remain
for TII reviewers to judge. Scientific readiness and formatting are separate.

## Findings and actions

1. **Process comparison — major.** The no-write endpoint is a fixed 60-second
   mean, while the scripted policy reports final values after scenario-specific
   steps under a different horizon. Two no-write seed-42 runs also start from residual states.
   The abstract, Section VI and Fig. 5 state these limitations. A causal
   efficacy claim requires matched initial states, a common horizon,
   prespecified trajectory metrics, and an appropriate controller baseline.
2. **Agent and approval evidence — major.** Neither recorded live-Agent episode
   issued a governed write; approvals were scripted. Positive process
   observations therefore do not demonstrate Agent or operator performance.
   These limitations remain explicit in Sections VI–VIII.
3. **Pilot provenance — major.** The injection pilot is one simulated-twin
   execution with missing raw sample series, verdict rule and version snapshot.
   Its structured record gives a baseline of 31.503 g rounded, but the
   accompanying report says 31.508 g. The discrepancy is now disclosed in the
   manuscript, S7 and reproducibility note; the source records were not altered.
4. **Governance description — corrected.** The former Fig. 4 caption applied
   the same recipe limits to both write routes. The revised flowchart and
   caption distinguish an online write from a replacement recipe and identify
   route-dependent checks. This is a clarification of the described design,
   not a new experiment.
5. **Evidence traceability — improved.** The main text now maps each evaluation
   block to its unit and limitations, lists the 30 endpoint values, and reports
   the guard and route fixtures. An independent check compared the values and
   counts to the archived CSVs. Repeated deterministic stimuli are not
   represented as independent trials.
6. **Positioning and venue — outstanding.** Related-work comparisons are
   qualitative and use different tasks and evaluation units. The new main-text
   table agrees with the existing S7 descriptions; it is not a new independent
   verification of every cited article. Confirm the current TII submission
   instructions and the double-blind AI-disclosure channel before submission.

## Verification and limits

The main IEEEtran manuscript builds to 10 US Letter pages with balanced final
reference columns; S7 builds to six pages. The local audit resolves 25 cited
keys and finds all active figures. New Figures 4 and 5 are vector PDFs with
embedded fonts; their generator checks the frozen endpoint and ablation data.
Figure 3 is the supplied raster (about 363 dpi at its placed width).

The bibliography script reports a missing author for `graul2026aas`; the
source entry does contain an author field and the compiled bibliography renders
it. This is a parser issue associated with the nested accented-name markup,
not proof that the citation itself has been externally verified. No online
bibliography API checks were performed. Other local formatting warnings require
contextual review, rather than automatic edits.

## Review provenance

Two separate read-only reviewers examined methodology/evidence and
venue/logic respectively; the figure designer worked separately and the
methodology reviewer rechecked the final figures. The primary editor integrated
and checked the manuscript. These role-separated passes are not the five-seat,
contract-validated panel described by the reviewer skill, and no claim of
independent error processes or calibrated editorial decision is made.

## Submission checks

The current journal page should be checked at upload time; it could not be
retrieved directly during this session. IEEE's AI guidance requires disclosure
of AI-generated article content, including the system, affected portions and
extent; the author must verify the draft disclosure and submission channel.
See [IEEE AI guidance](https://open.ieee.org/author-guidelines-for-artificial-intelligence-ai-generated-text/)
and [TII author information](https://www.ieee-ies.org/pubs/transactions-on-industrial-informatics).
