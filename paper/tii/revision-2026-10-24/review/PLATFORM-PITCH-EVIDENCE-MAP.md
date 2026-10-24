# Platform Story and Evidence Map for the Writer

[OBJECTIVE] Recenter the manuscript on AgentWorkShop as an extensible industrial-agent framework whose architecture connects collaboration, production context, analysis/strategy, and heterogeneous industrial I/O across configured scenarios. Treat governance as the execution boundary within that architecture, not as the whole system.

## Evidence-backed system model

The current architecture text in paper/tii/SUBMISSION-IEEE-TII/sections/system.tex (System Architecture; Semantic Nodes and Production Context; Capabilities and Channel Profiles; Analysis, Models, and Candidate Proposals; Two Execution Lifecycles) supports this functional story:

1. **Collaboration and replaceable strategy.** Channels organize member agents, tasks, shared memory, and engine adapters. Strategies consume observations and produce candidate tasks/actions; the framework is not tied to one model. See system.tex opening paragraphs and evaluation.tex Q2–Q3.
2. **Production and equipment context.** Line–product–recipe–run objects scope the operational context. Onboarding blueprints declare devices, signal maps, units, roles, and initial setpoints; a differential ensure pass provisions or reconciles configuration. This gives a concrete reuse mechanism: change a scene’s map/objective/guards while retaining common services. See system.tex, Semantic Nodes and Production Context.
3. **Semantic industrial integration.** DAQ/DCW nodes represent engineering quantities and map them to drivers/protocols; timestamped DAQ observations, receipts, and production identifiers can be linked. The paper lists Modbus TCP, Modbus RTU-over-TCP, OPC UA, MQTT, and HTTP/REST/MES mappings. Q1 has five acquisition families and four writable routes; RTU-over-TCP is acquisition-only in that experiment.
4. **Analysis and decision support.** DAQ exports and diagnostics, RAG/process knowledge, AML dataset/model workflows, bounded exploration, and a separately bound optimizer can inform a strategy. Model/optimizer recommendations remain candidates; they do not themselves grant actuation authority. Current system.tex already gives AML pipeline detail and the optimizer recommendation caveat.
5. **Operational execution and evidence.** The platform applies profiles/capabilities/limits/approval and records route-specific receipts, observations, and verdicts. Preserve the two lifecycles: bounded node exploration opens a node record and later stores an exploration summary; recipe work returns batch/per-parameter receipts, then the caller observes and may issue a separate recipe update. Do not merge these into one generic “agent loop.” The SDK, REST, MCP, agent-to-agent, CLI, and console are extension/access surfaces, not separate process evidence.

Useful code anchors corroborating the prose include server/services/workshop/optimization/binding.service.ts, dispatch.service.ts, access.ts, server/services/workshop/daq/bus/queue-port.ts, mqtt.adapter.ts, and the route-specific tool implementations cited in the manuscript/reproducibility bundle. The existing EVIDENCE-AUDIT.md also inspected optimizer-tools.ts and host-tool-bridge/optimizer-gate.ts: optimizer recommendations are not direct write authority.

## Recommended narrative and contribution framing

**Central question:** how can one extensible industrial-agent platform connect replaceable collaboration/strategy components to production-scoped context and heterogeneous plant interfaces, so that the same operational services can be configured for different process scenes while preserving inspectable action/observation records?

**Story arc:** industrial tasks differ in agent strategy, signal schema, protocol, and production context → ad hoc per-agent integrations do not make those changes composable → AgentWorkShop separates collaboration/strategy, production context, semantic I/O, and route-specific operational services → experiments exercise those reuse dimensions in protocol, strategy, configuration, software-composition, and recipe workflows → evidence supports configuration-based reuse on the tested simulator routes, with explicit interface-era and sample-size limits.

Position three contributions around: (i) a modular framework architecture and extension surface joining agent collaboration, production objects, analysis/model services, and industrial adapters; (ii) reusable commissioning and semantic DAQ/DCW plus distinct node/recipe workflows that link requests, execution receipts, process observations, and retained production state; (iii) implementation evidence that exercises multiple protocol mappings, replaceable proposal strategies, four configured simulator scenes, deployment/regression composition, and one recipe-path trajectory. Keep capabilities, admission, approval, and graded confirmation as a key cross-cutting design feature supporting the operational contract rather than making them the sole novelty.

For the experimental section, organize the evidence as adaptation coverage: Q1 protocol/semantic integration; Q2–Q3 strategy-slot replacement and controller handling; Q4 four process configurations; Q5 multi-line/software composition and regression; Q6 a recipe lifecycle case. Describe what each test establishes, then state that these archives are separate evidence units rather than one joint current-version end-to-end test.

## Experiment-to-claim map and allowed scope

| Evidence | What it supports | Important scope |
|---|---|---|
| Q1 protocol closure | DAQ acquisition across five protocol families; governed writes over four routes; legal/out-of-window handling across different signal maps | RTU-over-TCP acquisition only; 6 writes per writable route for latency; separate mock-driver ablation, not physical plant data |
| Q2 strategy slot | Two archived live-engine tasks traversed the same proposal/execution workflow | Two tasks; no model or engine benchmark |
| Q3 controller | A deterministic strategy used the same command path on three seeds; objective improved relative to its finite admissible-grid reference | One software process and restricted grid; not a global optimum or comparative strategy benefit |
| Q4 scene reuse | Four differently configured simulator processes completed their declared terminal checks; evidence shows configuration-based reuse | One seed-42 trajectory per process; two endpoints near target boundaries; WWTP rollback/pH drift and annealing failed/compensated steps must remain visible |
| Q5 composition/reliability | Nine deterministic deployment-suite executions passed 782 software assertions; current isolated rerun covers 65 channel/profile/composition checks | These are software checks, not independent process runs; scripted confirmations do not measure operator performance |
| Q6 operational recipe | One October 18 injection recipe trajectory linked four approved 45-to-65-bar trials, observations, and saved recipe version | n=1 simulator trajectory; pacing override used; not the current default cadence path or a repeated result |

Latest boundary evidence must remain explicit. As EVIDENCE-AUDIT.md reports: on October 23 the old direct-node replay was refused on all 8 attempts (zero writes) by the current public interface. A separate current recipe-route check verified 45→50 bar, then later requests were cadence-refused at 66 s and 132 s; no recipe update was saved, final target was not attained, and restoration assertion failed. These do not invalidate the earlier archived runs, but those runs cannot be represented as a successful replay of the current interface. Keep them in the scope/boundary discussion adjacent to Q6 or reproducibility description.

## Claims and phrasing to avoid

Avoid: universal or plug-and-play industrial generality; validated transfer to physical plants; all five protocol families completed write/readback control; one unified current-version end-to-end experiment; statistically replicated cross-process performance; superior optimization/control quality; proven human oversight benefit; hard real-time or safety assurance; current success of the October 18 trajectory; restored baseline in the October 23 check.

Prefer qualified claims: “exercised configuration-based reuse across four simulator scenes”; “protocol acquisition was exercised across five families, with governed writes on four”; “the archives provide route-specific implementation evidence”; “one accelerated simulator recipe trajectory reached its declared quality band and saved the accepted version”; “the results demonstrate the tested integration and evidence paths, not physical transfer or comparative process improvement.”

## Suggested balance changes

- Retitle and recast the abstract/Introduction so the subject is AgentWorkShop’s extensible architecture and cross-scene integration problem. Lead with variation across agents, signals, protocols, and production context; mention governance as a designed execution boundary.
- In Related Work, end on the broader integration/adaptation gap across agent frameworks, industrial semantic interfaces, production context, and operational workflows; avoid making all nearest-work comparison criteria authority and write confirmation.
- Keep the architecture section’s feature inventory and two lifecycles, but ensure each architecture group answers what system function it supplies. Avoid letting the mechanisms section occupy more conceptual weight than the platform architecture.
- In Evaluation and Conclusion, distinguish positive exercised coverage from what remains untested. Never combine the historical Q1–Q4 direct-node interface, current software tests, and October 18 recipe archive into a single claimed present-day integrated demonstration.

## Source anchors

- Manuscript: paper/tii/SUBMISSION-IEEE-TII/main.tex and sections/introduction.tex, related.tex, system.tex, mechanisms.tex, evaluation.tex, discussion.tex.
- Audit and detailed numerical/limitation map: paper/tii/revision-2026-10-24/review/EVIDENCE-AUDIT.md.
- Q1–Q6 details are in sections/evaluation.tex and resources/REPRODUCIBILITY.md; preserve their labels, macros, citations, archived values, and evidence-unit distinctions.
