# IEEE TII Writing Experience and Manuscript Argument Map

Prepared 2026-10-31 from the installed Supervisor-Skills repository and three
downloaded IEEE Transactions on Industrial Informatics (TII) architecture
papers. These notes are a working aid for this manuscript, not official IEEE
or TII policy. The paper itself uses only the current integrated simulator
run as its experimental evidence.

## Sources studied

1. Christian Gehrmann and Martin Gunnarsson, “A Digital Twin Based Industrial
   Automation and Control System Security Architecture,” *IEEE Transactions
   on Industrial Informatics*, 16(1), 669–680, 2020.
   DOI: [10.1109/TII.2019.2938885](https://doi.org/10.1109/TII.2019.2938885).
   The paper moves from industrial-control assumptions and security
   requirements to trust boundaries, synchronization design, and a bounded
   protected-update proof of concept. Its figures distinguish architecture
   functions, protected paths, and execution sequence.
2. Nurul Huda Mahmood et al., “A Functional Architecture for 6G Special-Purpose
   Industrial IoT Networks,” *IEEE Transactions on Industrial Informatics*,
   19(3), 2530–2540, 2023.
   DOI: [10.1109/TII.2022.3182988](https://doi.org/10.1109/TII.2022.3182988).
   It derives functional blocks from industrial-network requirements, then
   explains their interaction through a use case. Its architecture figure
   maps functions to layers; tables and plots report use-case-specific KPIs.
3. Jayasree Sengupta, Sushmita Ruj, and Sipra Das Bit, “A Secure Fog-Based
   Architecture for Industrial Internet of Things and Industry 4.0,”
   *IEEE Transactions on Industrial Informatics*, 17(4), 2316–2324, 2021.
   DOI: [10.1109/TII.2020.2998105](https://doi.org/10.1109/TII.2020.2998105).
   The downloaded copy is the arXiv preprint, not a confirmed version of
   record. It separates the architecture, security mechanisms, cost analysis,
   simulation, and testbed evidence; tables distinguish testbed conditions
   from outcomes.

The PDFs, rendered pages, DOI metadata, download sources, and checksums are in
[`reference-papers-2026-10-31`](reference-papers-2026-10-31/REFERENCE-STUDY.md).

## Reusable writing practices

1. **Start from the industrial constraint.** Name the process condition that
   makes integration difficult, then state the capability the system must
   provide. Avoid leading with a list of software components.
2. **Derive the architecture from requirements.** Make each block answer a
   stated need: scene configuration preserves signal meaning; adapters isolate
   harness variation; dispatch checks bound operations; owning services keep
   evidence records distinct.
3. **Follow one operation through the system.** Show how process context,
   semantic nodes, protocol drivers, checks, and receipts connect. Use an
   architecture figure for layers and ownership, and a separate sequence view
   for execution and approval revalidation.
4. **Use related work to locate the interface.** Organize prior work by the
   layer it addresses (agent reasoning, industrial communication, asset
   grounding, or governed execution), then state the narrower integration
   boundary of this paper. Do not claim that prior work lacks a capability
   unless the cited comparison establishes that absence.
5. **Match each result block to one question.** Workflow checks show stage
   coverage; protocol samples show acquisition; negative probes show the tested
   guard path; fixed-seed cases report simulator objective observations; the
   BOPET task is a separate scripted integration trace. The latter two are
   not one continuous process trajectory.
6. **Keep plots conventional and self-contained.** Use vector PDFs, restrained
   color, labeled axes and units, meaningful markers, and captions that state
   what the data show. Do not add uncertainty bars when the evidence contains
   only one trace or three non-independent subcases.
7. **Report evidence limits where they affect interpretation.** A deterministic
   adapter with the language-model loop disabled validates configured software
   paths, not autonomous reasoning. An open task record supports an integration
   observation, not a completed optimization claim.

## Supervisor-Skills method applied

The installed `tech-paper-template` and `intro-drafter` informed the argument
map; `paper-writer` supplied the evidence gate; `paper-polish` guided the
language pass; and `pre-submission-reviewer` supplied the final structural,
language, layout, and figure audit. The main chain used here is:

| Logic stage | Manuscript content |
|---|---|
| Industrial setting | Production scenes combine changing context, semantic signals, and heterogeneous device protocols. |
| Specific integration problem | Task-level agents need a common operation boundary that preserves the active scene context and constrains device writes. |
| Design idea | Keep scene mappings and harness adapters configurable; converge task and direct operation calls on shared dispatch and write admission. |
| Challenges | Preserve signal meaning across drivers; isolate harness-specific execution; enforce live authority and process limits while retaining distinct records. |
| Modules | Scene/configuration model; task and harness adapters; shared dispatcher; route-specific admission, approval revalidation, and evidence ownership. |
| Current evidence | One deterministic integrated run (`20261031034253-1dbo`): stage checks, five-protocol acquisition, negative-write probes, a second-scene check, fixed-seed objective cases, and a separate BOPET integration trace. |
| Evidence boundary | No active language-model loop, physical equipment, matched controller, independent system repetitions, or runtime-frozen manifest. |

## Claim-to-evidence map used in the revision

| Claim retained | Evidence in the current run | Wording boundary |
|---|---|---|
| The configured simulator path exercised five protocols. | Five acquisition nodes returned 54 samples across Modbus TCP, Modbus RTU, OPC UA, MQTT, and HTTP. | This is configured simulator integration, not field interoperability. |
| Tested negative write requests were blocked before driver execution. | 24/24 probes across four writable paths and 9/9 probes in the in-run second-scene check were rejected. | No approval-on/off ablation or complete false-block denominator is available. |
| The simulator objective cases were close to the offline reference. | Ratios were 96.3%–98.8%; mean 97.8% across three fixed seeds. | Seed 43 was a zero-update case; these cases are not independent system repetitions or a controller comparison. |
| The configured BOPET path produced an in-band observation. | Three scripted writes; terminal thickness 24.84 µm within 25.0 ± 0.7 µm. | The task record remained open and unjudged; no causal optimization claim is made. |

## Structural choices in the revised manuscript

- The Introduction follows the path from industrial context, related system
  layers, integration boundary, implementation challenges, architecture, and
  contributions.
- System Design presents the architecture and execution contract. Module
  Functions then explains context assembly, shared dispatch, and route-specific
  write admission without retelling the whole architecture.
- The experimental section is divided into separate coverage, protocol/guard,
  objective, and BOPET blocks. The fixed-seed objective plot and BOPET trace
  are separate figures to prevent a visual suggestion that they are one
  experiment or one causal trajectory.
- The composite workflow score and protocol latency summaries are not used as
  main-text performance claims. Latency summaries remain in S6 with their
  denominator limitation.
- The manuscript uses IEEEtran two-column composition and restrained,
  conventional diagrams and plots. The sampled TII papers are stylistic
  references, not formal publication rules.

## Independent pre-submission review outcome

The separate reviewer pass found no critical source or evidence-integrity
issue. The 10-page Letter main PDF and one-page S6 PDF compile, citations and
figure targets resolve, and both active-figure and source-package audits pass.
The evaluation remains a single deterministic simulator integration run;
the available evidence does not establish LLM-agent effectiveness, physical
plant performance, comparative benefit, or independent repeatability. The
final reference page is sparse because the bibliography ends there; no
unsupported text was added to fill it.

## Installation and attribution

Supervisor-Skills was installed from
[HKUSTDial/Supervisor-Skills](https://github.com/HKUSTDial/Supervisor-Skills)
at commit `a20d76ef3979b804d7dbf599d577826957e0a8a9`. The repository is
licensed CC BY-NC-SA 4.0; see the installed license and attribution record.
The handbook recommends author-written prose. The user explicitly requested
AI-assisted restructuring, so the skills were applied as evidence, structure,
polishing, and review guidance; the authors should verify scientific meaning
and follow IEEE's applicable AI-use disclosure policy before submission.
