IEEEtran
amsmath,amssymb,amsfonts
algpseudocode
iftex

 TUptm
 TUptmmn<->ptmr8t
 TUptmbn<->ptmb8t
 TUptmmit<->ptmri8t
 TUptmbit<->ptmbi8t
 TUptmmsl<->ptmro8t
 TUptmmsc<->ptmr8t

graphicx
booktabs
tabularx
array
xcolor
stfloats
placeins
url
same
cite
hyperref
bookmarksnumbered=true,
 pdftitle=A Configurable Framework for Multi-Scenario Industrial Agent Integration,
 pdfauthor=Anonymous Authors,
 pdfsubject=IEEE Transactions on Industrial Informatics,
 pdfkeywords=industrial informatics, industrial agents, multi-agent systems, production system integration, semantic data integration

topnumber4
bottomnumber3
totalnumber7
dbltopnumber1
0.95
0.80
0.03
0.72
0.95
0.72

8pt plus 2pt minus 3pt
8pt plus 2pt minus 3pt
7pt plus 2pt minus 3pt
3pt plus 1pt minus 1pt
2pt plus 1pt minus 1pt

resources/results-macros

the platform

document
IEEEbstctl

AgentWorkShop: A Configurable Framework for Multi-Scenario Industrial Agent Integration

Anonymous Authors
IEEE Transactions on Industrial Informatics, Submitted ManuscriptAgentWorkShop: Industrial Agent Integration



abstract
Integrating industrial agents with production context and heterogeneous
equipment while preserving process-specific constraints remains challenging.
We present AgentWorkShop, a modular framework that combines agent
collaboration and configurable execution harnesses with line--product--recipe--run
context, analysis and modeling services, semantic data-acquisition and
write-control nodes, and protocol drivers. Scene blueprints define signal
maps, objectives, and guards; channel profiles, tool policies, and per-agent
bindings scope available operations. Agents or callers invoke named
node-exploration or recipe workflows, whose route-specific checks and records
distinguish command confirmation from process observation. Evaluation found
that a historical seed-42 campaign met terminal checks in four configured
simulator scenes. Separate protocol tests covered five acquisition
families and four
writable mappings, and nine deployment-suite runs passed 782 deterministic
assertions. A profile and composition suite passed 65 checks using temporary
storage and mock I/O, rather than process-level cross-scene trials. Live-engine
and controller archives and one cadence-overridden recipe trajectory exercise
complementary workflows; the recipe case saved but did not apply its accepted
version. These findings provide evidence that AgentWorkShop offers a
configurable integration path for the tested simulator and software-test
workflows.
Matched current-version cross-scene trials are still needed to validate
profile and binding adaptation; the evidence also does not establish
multi-harness portability, physical transfer, or comparative control benefit.
abstract

IEEEkeywords
Industrial agents, industrial communication, industrial informatics,
production systems, semantic data integration.
IEEEkeywords



sections/introduction
sections/related
figure*[!t]

resources/fig-architecture-2026.pdf
AgentWorkShop software architecture. Access, collaboration,
governance, production context, services, and field I/O form six connected
bands. Registered harness and driver interfaces expose extension points;
the evidence ledger retains route-specific records across the bands.
fig:arch
figure*
sections/system
sections/modules

sections/evaluation
sections/discussion

IEEEtran
resources/refs

document

## Included TeX source files (appended for exact-quote verification)



### Source: sections/discussion.tex

\section{Discussion}
\label{sec:limits}
R1 contains four seed-42 process trajectories under a shared scripted
scaffold; these historical scene configurations reached their declared
terminal checks. Q1 covers acquisition over five protocol families and writes
over four mappings, while Q5 checks deployment behavior in nine sequential
suite runs. Together, these archives support integration of the tested
interfaces and workflows. They do not show that current channel profiles and
per-agent bindings preserve tool availability and task outcomes across scenes:
Q4 used a historical direct-node path, and the independent profile checks used
temporary storage and mock I/O.

Q6 is one inspectable recipe trajectory: its harness disabled the line cadence
and used emergency trials to bypass the separate recipe-operation interval.
The accepted definition was saved but not applied. A default-paced attempt
missed its target. Separately, an October 23 direct-node replay refused all
eight historical writes, and a default-paced recipe check failed restoration,
leaving pressure at 50\,bar rather than the requested 45\,bar (four of eight
assertions passed). These records do not establish default-paced recipe
completion or recovery readiness.

AgentWorkShop composes agent collaboration, scene configuration, production
analysis, semantic device access, and route-specific execution records. Its
interfaces let an operator inspect a proposal, endpoint evidence, and process
observation separately. The evaluation does not establish operator
effectiveness: approval records do not measure comprehension or complacency
\cite{parasuramanmanzey2010complacency,parasuraman2000model,bainbridge1983ironies}.
Likewise, a restricted tool surface does not remove deployment security
requirements \cite{greshake2023injection,liu2024pinjection,iec62443-3-3}, and
the framework does not replace independently engineered PLC or
safety-instrumented protection under the IEC~61511 process-safety lifecycle
\cite{iec61511}.

Next, a versioned build should vary profiles and bindings across matched
scenes, measure tool availability and task outcomes, and test recipe recovery
at default pacing against declared baselines. Physical-plant evaluation is
needed before claiming transfer beyond repository simulators; Tennessee
Eastman is one additional setting \cite{downs1993tep}. Model-assisted control
response remains unevaluated.

\section{Conclusion}
\label{sec:conclusion}
AgentWorkShop provides a modular integration path linking collaborative
harnesses, production context, analysis and modeling services, semantic
industrial I/O, and node and recipe workflows. It keeps task and context
resolution, dispatch, command confirmation, process observation, and
route-specific evidence within explicit module interfaces. Historical
records show terminal-check success in four simulator
scenes; separate archives exercise protocol, deployment, live-engine,
controller, and recipe functions. The evidence supports the tested interfaces
and routes, but not current cross-scene profile/binding adaptation,
cross-harness portability, default-paced recipe recovery, physical transfer,
or comparative control benefit. Matched cross-scene evaluation is the next
step; plant-level effectiveness remains unestablished.



### Source: sections/evaluation.tex

\section{Experimental Evaluation}
\label{sec:eval}
The evaluation is organized into six evidence groups, not six research
questions. Q4 first presents the historical four-scene campaign to establish
the process settings; Q1 then tests acquisition and policy-checked writes over
multiple protocol mappings. Q2 records two live-engine tasks under one
harness, provider, and model setup, while Q3 follows one deterministic
controller over three seeds. Q5 assesses deployment-suite behavior, and Q6
examines a recipe-path lifecycle. All process experiments use repository
simulators. These groups are complementary archives, not one joint
current-version trial or a paired strategy comparison; their source mappings
are given in the reproducibility notes.

\subsection{Evidence Units and Experimental Procedure}
\label{sec:testbed}
\label{sec:procedure}
Q1--Q4 use the seed-\resSeed{} integrated archive (R1) and its raw scenario
records; the admission ablation uses a separate companion run (R2). R1 can
be audited, but its historical runtime worktree is not archived, so the
recorded source commit does not guarantee exact replay. These historical
missions use the direct-node interface and scripted proposal policies,
apart from the two Q2 live-engine tasks. Q3 additionally uses seeds 43--44;
Q5 uses nine deployment-suite executions, and Q6 uses the October 18 recipe
archive. The cast-film reference preset uses an author-defined objective $J$
combining thickness conformance, defects, energy, and throughput.

Separately, 65 channel/profile and composition checks passed in an October
20 archive and an October 24 rerun with temporary storage and mock I/O. They
cover approval outcomes, starting-control capture, and approved-recipe
snapshot consistency; they are not process-level cross-scene trials. For
each Q4 mission, the archive retains the configured scene, initial controls,
proposed writes, available command evidence, post-wait DAQ observations, and
terminal guard result. Each process contributes one seed-42 trajectory;
writes within a trajectory are sequential
observations, not independent trials.

The deployment regression spans 20 phases, from commissioning and protocol
I/O to agent missions, controller reuse, and concurrent processes. Its
author-defined checks report rejected probes, per-parameter confirmation,
recipe/readback/mirror agreement, process-target margins, and event spans.
Across nine sequential runs, 782 deterministic assertions passed; they are
software checks, not plant samples. Because each protocol line has six
writes, latency is reported as the archived upper median and observed
maximum, not as a tail percentile.

\subsection{Historical Four-Process Simulator Missions (Q4)}
\label{sec:scenarios}
The concurrent campaign provides one seed-42 trajectory per process.
Figure~\ref{fig:missions} pairs archived manipulated controls $u$ with the
corresponding response $y$ rather than showing response alone. All four
terminal attainment checks passed; two lay near a target boundary.

Injection molding used two changes: hold pressure
$45\rightarrow58.2$\,bar and hold time $6\rightarrow10.64$\,s. Part weight
rose from \resInjStart{} to \resInjFinal{}\,g for a
$32.5\pm0.35$\,g window, only $0.02$\,g above its lower limit.
Biaxially oriented polyethylene terephthalate (BOPET) changed casting speed
$32\rightarrow33.8$\,m/min, fast-roll speed
$118\rightarrow120.3$\,m/min, and rail width $3000\rightarrow3035$\,mm.
Thickness fell from \resBiaxStart{} to \resBiaxFinal{}\,$\mu$m for a
$25.0\pm0.7$\,$\mu$m target, $0.04$\,$\mu$m inside the upper limit.
Its three changes each have a recorded keep verdict and journal identifier.

Wastewater treatment required 15 writes across several nodes. Dissolved
oxygen rose from \resWwtpStart{} to \resWwtpFinal{}\,mg/L, within
$3.4\pm0.6$\,mg/L. Some admissible blower proposals reduced compliance
margin and were reverted. Terminal guards remained within their declared
limits, although pH moved toward its lower bound (6.59 to 6.38; limit 6.0).
Dissolved oxygen, total phosphorus (TP), and pH are different quantities
and are not concatenated into one output trajectory.

Annealing combined furnace-temperature changes with line-speed increases
from 140 to 164\,m/min. The recorded Vickers hardness (HV) trajectory moved from
\resAnnealStart{} to 99.84\,HV; the separate terminal measurement was
\resAnnealFinal{}\,HV, within $95\pm6$\,HV. A 176\,m/min attempt produced
101.3\,HV and was reverted. The first temperature step has no optimization
record identifier in the archive, which bounds record-level traceability.
These historical missions document process behavior under a shared scripted
task scaffold and retain the distinction between a candidate command, a
reverted candidate, and a terminal observation. They do not evaluate
current profile or per-agent binding variation across scenes.

\begin{figure*}[!t]
\centering
\includegraphics[width=\textwidth]{resources/fig-missions-controls.pdf}
\caption{Historical scripted missions (seed 42, one trajectory per process).
(a--d) Weight, dissolved oxygen (DO), hardness, and film thickness with their
target windows. (e--h) Requested controls as percentage change from native
baselines: injection pressure 45\,bar/time 6\,s; wastewater blower
26\,Hz/NaOH 12\,L/h/PAC 30\,L/h; annealing zone 3
730$^{\circ}$C/zone 2 710$^{\circ}$C/speed 140\,m/min; BOPET casting
32\,m/min/fast roll 118\,m/min/rail 3000\,mm. Lines connect event indices,
not physical time; unchanged requested values carry forward. Crosses mark
reverted candidates and squares distinct terminal observations. DO excludes
pH/TP events; annealing's first step lacks an optimization record.}
\label{fig:missions}
\end{figure*}

\subsection{Heterogeneous Protocol Integration and Route Checks (Q1)}
\label{sec:protocol}
The suite acquired \resDaqSamples{} samples over five protocol families and
issued policy-checked writes over four; the RTU-over-TCP line was
acquisition-only.
Archived upper-median write latencies ranged from \resPfiftyRange{}, with observed maxima
\resPninetyfiveRange{}. The four writable lines accepted legal writes and
rejected 24/24 out-of-window probes. A configuration-only second preset
added 9/9 rejected probes on three further writable lines. These results
exercise the same resolver against different signal maps.

In a mock-driver API fixture, three deterministic repetitions of six attack
classes per arm isolated admission from endpoint confirmation. With the
soft-window interlock enabled, both the full and no-readback arms refused
all 18 attacks. Disabling the interlock allowed the six soft-window probes
to execute, while the 12 hard-range probes remained refused. Removing
readback did not change admission, showing that confirmation cannot replace
a pre-write gate. A frozen-measurement drill further separated command and
process evidence: the setpoint and readback agreed, yet the monitoring
quantity remained outside its window and triggered backstop rollback after
\resBackstop{}. A manual-binding drill suspended execution until
harness-issued approval (\resHitlLatency{} mediation span).

\subsection{Live-Engine Tasks and Deterministic Controller (Q2--Q3)}
\label{sec:agentteam}
The archived team workflow linked a parent task, a bound worker, a command,
a verdict, and its journal. On the single-node cast-film mission, the policy
changed the heater from \resMissionFrom{} to
\resMissionTo\,$^{\circ}$C; the observation settled at
\resMissionPv\,$^{\circ}$C within the declared target. The task reached
\texttt{COMPLETED}. The BOPET mission expanded this workflow to nine devices
and 49 signals, with three manipulated nodes
(Section~\ref{sec:scenarios}).

Two live-engine tasks used the same \texttt{omp} harness, Zhipu Coding Plan
provider, and GLM-5.3-Flash model on a scratch line; they are execution
traces, not a strategy comparison or a cross-harness portability test. The archive
records a bounded write, a goal-driven
descent to \resGoalFinal\,$\mu$m for a $52.0\pm0.8$\,$\mu$m target, and a
recipe save. The original contemporaneous omp logs and checked run outcomes
trace proposal, policy-checked action, observations, and retained recipe.
The reported \resGoalFinal\,$\mu$m is the run-summary terminal value;
the log's 52.02\,$\mu$m window mean is a different aggregation.

\label{sec:controller}
A deterministic controller used the dimensionless cast-film objective
\begin{equation}
\begin{aligned}
J={}&55J_{\mathrm{thick}}+25J_{\mathrm{quality}}\\
&+8J_{\mathrm{energy}}+7J_{\mathrm{throughput}},
\end{aligned}
\label{eq:objective}
\end{equation}
whose components score thickness conformance, product quality, and
control-based energy and throughput proxies. The latter two terms use
screw speed and line speed, rather than independently metered energy and
production output. This deterministic-controller experiment is not an
evaluation of AgentWorkShop's optional model service. Table~\ref{tab:q3search}
summarizes its finite candidate grid and selection rule; component formulas
and replay details are provided in \path{REPRODUCIBILITY.md}.

\begin{table*}[!t]
\centering
\caption{Finite-grid search protocol for the deterministic cast-film
controller in Q3. The reference score is restricted to this grid and is not
a global continuous optimum.}
\label{tab:q3search}
\footnotesize
\setlength{\tabcolsep}{4pt}
\begin{tabularx}{\textwidth}{@{}p{2.15cm}Xp{2.4cm}@{}}
\toprule
Search element & Candidate set or rule & Role in the search \\
\midrule
Objective & Eq.~(\ref{eq:objective}); weights 55/25/8/7 for thickness,
quality, energy proxy, and throughput proxy & Rank eligible steady states \\
Eligibility & Melt temperature 195--225~$^{\circ}$C; melt pressure
$\leq 22$~MPa & Discard ineligible states \\
Equal zone setpoint & 195--225~$^{\circ}$C in 2.5~$^{\circ}$C steps & Search variable \\
Screw speed & 50--200~rpm in 5-rpm steps & Search variable \\
Line speed & 20--120~m/min in 2.5-m/min steps & Search variable \\
Die gap & Fixed at 1~mm & Held constant \\
Selection & Evaluate modeled steady state and retain the highest eligible
score; $J^{*}=89.894$ & Finite-grid reference \\
\bottomrule
\end{tabularx}
\end{table*}

Across seeds 42--44, this single controller made two policy-checked writes per
seed, without rejection. It raised $J$ from approximately
\resJzero{} to $J/J^*=\resControllerMin$--\resControllerMax{}, with
$J^*=\resJstar$ from the admissible setpoint grid. This reference
normalization is restricted to the finite search space.
The result links the controller's native objective to admissible commands
and endpoint evidence, exercising a conventional strategy through the
same execution services.

\subsection{Deployment Composition and Confirmation Semantics (Q5)}
\label{sec:hardening}
The deployment instance contained \resLinesLive{} provisioned lines,
\resChannelsLive{} channels, \resDaqOnline{} online DAQ nodes,
\resWriteNodesLive{} write nodes, \resRecipesLive{} recipes, and
\resBindingsLive{} bindings, with \resLinesRunning{} lines running.
These objects coexisted on one simulator-backed host.

The injection benchmark followed observation, proposal, pacing gate,
approval, batch dispatch, and recipe/readback/mirror comparison.
The three sources agreed at the endpoint's recording resolution
(maximum deviation \resConsistencyErr{}; tolerances 0.05\,bar for device
readback and 0.51\,bar for the bucketed mirror). This verifies setpoint
consistency rather than process convergence. In S4, the initial proposal was
cadence-refused; the reproposal followed 69.014\,s later, and
observation-to-verification at 65\,bar took 96.105\,s. The archived verdict
remained \texttt{converged=false}. S5 began 96.129\,s after the S4
observation, applied a 40-to-40.5$^{\circ}$C setpoint, refused a further
write, waited 66.046\,s, and restored 40$^{\circ}$C. These are
server/harness event spans, not process-convergence evidence. Across the
campaign, approval-to-dispatch spans were \resHitlDispatchMs{}.

Seven fault tests exercised receipt grading. A mock acceptance required a
reread; a broker outage failed one parameter while its healthy sibling
verified; and a publish-only endpoint remained unverified after three
attempts despite returning a broker receipt. The suite also tested
readback-based promotion, confirmation of manual-to-automatic mode changes,
and approval before manual-mode recipe dispatch. MES application-receipt
semantics were covered by route tests; the campaign itself used MES only in
read mode. These checks show that receipt grades followed the available
endpoint evidence under the injected conditions.

\subsection{Operational Recipe Workflow Case Study (Q6)}
\label{sec:recipeexperiment}
The October 18 recipe archive (R6 in the accompanying reproducibility notes)
pairs recipe-path controls, receipts, and process observations. The replay
entry is \path{scripts/e2e-injection-recipe-closedloop.mjs}. R6 lacks an exact
source commit, seed, and per-sensor timestamp series, so it is reported as an
archived trajectory rather than a fully specified replay.
The setup used OPC UA setpoints and HTTP quality acquisition against the
injection simulator. A live agent separately diagnosed insufficient packing,
but the archived intervention sequence and approvals were scripted.

Starting from 45\,bar with a fixed 6-s hold time, the script proposed
5-bar pressure increments and stopped when weight was in $[32.15,32.85]$\,g,
flash was at most 0.4\%, and sink mark was at most 1.5\%, or after six
proposals. Each \texttt{recipe\_trial} was approved by the harness, followed
by a 65-s wait, and checked against the platform control node and DAQ. The
successful run used four proposals; its overshoot compensation and hold-time
fallback were not needed. Table~\ref{tab:q6actions} records the archived
parameter and action sequence.

\begin{table*}[!t]
\centering
\caption{Recorded Q6 injection-recipe actions and post-wait observations
($n=1$ simulator trajectory). Hold time remained 6\,s; each trial used
harness approval, a 65-s wait, and a 1/1 parameter-verification receipt.}
\label{tab:q6actions}
\footnotesize
\setlength{\tabcolsep}{3.5pt}
\begin{tabularx}{\textwidth}{@{}l c c c c X@{}}
\toprule
Stage & Pressure (bar) & Weight (g) & Flash (\%) & Sink (\%) & Recorded action and outcome \\
\midrule
Baseline & 45 & 31.28 & 0 & 1.977 & No command; initial observation \\
Trial 1 & 45$\rightarrow$50 & 31.49 & 0.014 & 1.956 & Approved; 1/1 verified; continue \\
Trial 2 & 50$\rightarrow$55 & 31.74 & 0.031 & 1.760 & Approved; 1/1 verified; continue \\
Trial 3 & 55$\rightarrow$60 & 32.05 & 0 & 1.534 & Weight below 32.15-g minimum and sink above 1.50\%; continue \\
Trial 4 & 60$\rightarrow$65 & 32.30 & 0.019 & 1.277 & Three observed guards pass; stop \\
Save & 65 & --- & --- & --- & \texttt{recipe\_update} saved version 2; no \texttt{recipe\_apply} is archived \\
\bottomrule
\end{tabularx}
\end{table*}

The successful harness set \texttt{AW\_TRIAL\_INTERVAL\_MS=0}, disabling
per-line trial cadence, and used \texttt{emergency=true} to bypass the
separate recipe-operation interval; approval, admission, and command
confirmation remained active. These snapshots are platform-node values, not
a physical PLC trace. Melt temperature was missing, so the pass covers only
the three observed quality quantities. The update rationale contains
different quality figures without a linked raw sample; the table uses the
archived final snapshot.

The freshness check used the newest timestamp among available sensors, not
each sensor's individual timestamp.
The additional archive is not an independent replication.
A separate later check started at 65\,bar,
32.29\,g, and 1.385\% sink mark; one 70-bar trial ended at 32.55\,g and
0.976\%. It is a new initial state and is not appended to the plotted trace.

October 23 boundary checks distinguish historical replay from current
operation. The public interface refused all eight direct-node attempts
(zero writes). A separate recipe check verified one 45-to-50-bar trial, then
refused requests at 66 and 132\,s under the default 300-s cadence.
Restoration failed: pressure remained at 50\,bar rather than the requested
45-bar baseline, and only 4/8 harness assertions passed. Final weight was
31.46\,g; no recipe update was saved. These failed checks are not repetitions
of the accelerated October 18 trajectory; their full outcomes are retained
in the reproducibility notes.



### Source: sections/introduction.tex

\section{Introduction}
\IEEEPARstart{L}{arge} language-model agents are being explored for
plant-facing tasks. MADE generates control sequences for operator review
\cite{huang2026made}; K{\"o}hle et al. organize agents around modular factory
skills \cite{koehle2026llmdriven}; and Waseem et al. study agent-based
production scheduling \cite{waseem2026pretrained}. These studies demonstrate
useful agent capabilities under different task and integration assumptions.
Across plants, however, agent roles, signals, protocols, objectives, and
production context vary. The selected studies do not jointly evaluate a
configurable framework that connects agent collaboration, scene-specific
production context, and heterogeneous process I/O across these differences.

Consider injection molding. An agent team may use recent measurements and
process knowledge to diagnose insufficient packing and propose a holding-
pressure change. To carry that proposal into an auditable production task, a
system must resolve the active line, product, recipe, and run; map the
quantity to the correct device interface; check that the requested operation
is available for that context; and retain the command evidence alongside
subsequent quality observations. Another process may use different signals,
protocols, or objectives while reusing the same collaboration and runtime
services. The design problem is therefore to make scene-specific variation
configurable while keeping each operation tied to its production context.

This paper presents AgentWorkShop, a configurable industrial-agent framework
that connects collaborative tasks and registered harnesses to production
context, manufacturing execution system (MES) data, analysis and modeling
services, data-acquisition (DAQ) and write-control (DCW) nodes, and
protocol-specific drivers. Its access surfaces include a command-line
interface (CLI), web, software development kit (SDK), representational state
transfer (REST), Model Context Protocol (MCP), and Agent-to-Agent (A2A)
interfaces.
Scene blueprints define signal maps, objectives, and guards; channel profiles,
tool policies, and agent bindings scope operations. Agents and callers invoke
named operations through shared runtime checks; the framework does not choose
routes autonomously and retains proposals, command confirmation, and process
observations as distinct records. Figure~\ref{fig:arch} presents the system
architecture, and Fig.~\ref{fig:runtime} shows the cross-module task flow.
Section~IV details the node-exploration and recipe lifecycles.

The paper makes three contributions:
\begin{enumerate}
\item It derives five integration requirements and six design principles for
  connecting agent collaboration, production context, process I/O, and
  route-specific evidence, and uses them to organize the system design.
\item It specifies AgentWorkShop's cross-module execution flow and software
  modules, including task and harness integration, production-context
  configuration, analysis and modeling services, semantic device access, and
  route-specific evidence handling.
\item It reports complementary evidence from a historical four-scene
  simulator campaign, protocol tests, current profile/composition checks with
  mock I/O, live-engine and controller runs, a deployment suite, and a
  recipe-path case. These archives exercise different components and
  workflows; they do not establish current-version
  cross-scene profile/binding adaptation, multi-harness portability, or a
  paired strategy comparison.
\end{enumerate}

Section~II reviews related industrial-agent and integration work.
Section~III presents the design rationale, architecture, and cross-module
execution flow; Section~IV explains module responsibilities and their
integrated operation. Section~V describes the experiments and results, and
Sections~VI and~VII discuss the evidence limits and conclude the paper.



### Source: sections/mechanisms.tex

\subsection{Route-Specific Lifecycles and Evidence}
\label{sec:routes}
\label{sec:mech}
\label{sec:objective}
\label{sec:nodeexec}
\label{sec:ack}

\paragraph{Timing and approval}
Timing guards are route-specific. Online node writes enforce an effective
minimum spacing of 60\,s. Recipe dispatch uses a per-recipe interval anchored
to approval, while trials also use a configurable per-line cadence (default
300\,s). The recipe interval can refuse a proposal before an approval request
is created. Checks occur at proposal or execution according to the operation,
and experiment-specific pacing overrides are reported with the corresponding
results.

Manual bindings create an approval request containing the actor, node or
recipe, candidate values, applicable limits, expiry, and parameter bases.
The default wait expires after 180\,s and refuses execution. After approval,
the executor rechecks authorization and active limits to account for context
changes during the wait. For \texttt{recipe\_apply}, a changed definition
requires a new proposal; an unchanged approval dispatches a copy of the
approved parameter snapshot. A line-level recipe mode defaults to manual;
changing it to automatic requires administrator confirmation. The approval
record authorizes a workflow action and does not replace process protection.

\begin{figure*}[!t]
\centering
\includegraphics[width=\textwidth]{resources/fig-admission-hitl-2026.pdf}
\caption{Admission and approval boundaries. (a) Online node interventions
use the four-layer value interval of Eq.~(1); recipe dispatch omits the prior
recipe window. (b) Human approval binds a proposed action and authority
fields; execution checks run again after approval, which does not reserve
equipment state.}
\label{fig:hitl}
\end{figure*}

\paragraph{Node probe}
The bounded node probe is exposed as \texttt{optimization\_explore} to the
Auto Modeling Lab (AML) optimization profile (\texttt{aml\_optimization}).
The profile validates a bound control and target DAQ scope,
captures a starting control and target baseline, invokes the internal DCW
write path, then waits 10--300\,s (default 45\,s) and queries a trailing 45-s
target window before saving an exploration summary. Since each window is
relative to its query time, approval can separate baseline sampling from
actuation; a 10-s wait can leave about 35\,s of pre-write samples in the later
window. The command receipt and target summary are therefore returned
separately. A successful changed-value write opens a node-optimization
record; refusal or expired approval creates a rejected summary without a
post-write sample.

\paragraph{Recipe operations}
\texttt{recipe\_trial} checks the bound recipe and active run, then dispatches
candidate overrides as a batch with per-parameter verification. The caller
subsequently queries DAQ and decides whether to save a new definition with
\texttt{recipe\_update}, restore one with \texttt{recipe\_rollback}, or
dispatch a version with \texttt{recipe\_apply}. These steps are separate: a
trial does not save or apply a version, and endpoint verification is not a
process-response measurement. Public direct-node control is closed; the
bounded probe and recipe operations are the configured operation surfaces.
The historical four-scene results use an earlier direct-node path and do not
test current profile or binding adaptation across scenes.

\paragraph{Command verification}
Command confirmation and process response answer different questions. A
driver ACK is graded as \texttt{readback-verified}, \texttt{transport-ack},
or \texttt{unverified}. A matching endpoint read supports the first grade; a
transport or MES application receipt supports the second. Recipe batch
verification assigns \texttt{verified}, \texttt{unverified}, or
\texttt{failed}; if no matching readback is available, it attempts up to
three independent reads, 2\,s apart. A matching retry upgrades the final ACK,
while exhausted retries remain unverified. The initial ACK remains in write
history and the final ACK and verdict are retained with the batch.
Per-parameter receipts preserve successful outcomes when another parameter
fails. A readback-verified setpoint does not establish target attainment.

\paragraph{Observation, verdict, and compensation}
The caller performs recipe-path observation after batch dispatch. The October
recipe case therefore compares a recipe definition, endpoint readback, and
DAQ sample as separate representations. Saving a definition, applying it to
equipment, and observing its process response are separately evidenced
operations. The evaluation does not combine these route-specific records into
one universal end-to-end record.

An open node record provides a monitoring backstop. After 120\,s it polls
every 30\,s; three cumulative samples outside the recipe monitoring window
trigger a system-attributed rollback request toward the preceding value.
Missing samples do not count as breaches. A caller's \texttt{keep},
\texttt{rollback}, or \texttt{uncertain} verdict records its interpretation;
compensation is a new command subject to its applicable admission policy.
The write audit deduplicates the same value on the same node within 10\,s,
while batch receipts, exploration summaries, DAQ history, and recipe versions
retain their distinct lifecycles. Linking these records by actor and
production context allows the command, endpoint evidence, and process
observation to be inspected without treating them as interchangeable.
\label{sec:agentloop}



### Source: sections/modules.tex

\section{Module Functions and Integration}
\label{sec:modules}
The architecture in Fig.~\ref{fig:arch} is implemented as cooperating
modules rather than a single monolithic agent. Shared interfaces connect
task execution to configuration, industrial services, protocol drivers, and
route-specific evidence. This section describes those responsibilities and
the checks that preserve their boundaries.

\subsection{Task Runtime and Harness Adapters}
An access surface creates or joins a workspace channel, where the task
engine manages members, task queues, shared memory, and execution templates.
The harness registry instantiates an adapter behind a common agent interface;
the prompt builder combines the task with the active scene brief, industrial
context, channel profile, agent binding, and retrieved memory. Tool calls
return to the shared dispatcher regardless of which registered harness
produced them. The registry is an extension point; the experiments do not
establish portability across harnesses.

\subsection{Production Context and Configuration}
Scene blueprints describe devices, signal maps, objectives, and process
guards. A task resolves these definitions against its active
line--product--recipe--run context. The channel profile selects the available
capability family, the tool policy narrows the operation catalog, and the
agent binding scopes the nodes, controls, and recipe operations available to
that member. These filters can restrict one another but cannot broaden the
underlying device range. The dispatcher re-reads policy at execution, so a
cached catalog does not retain authority after a grant or policy change.

\subsection{Acquisition, Analysis, and Modeling Services}
Semantic DAQ nodes expose typed values, engineering units, ranges, and
sampling settings while hiding protocol-specific reads. A per-node DAQ
runtime schedules acquisition and stores timestamped observations; the
gateway aggregates node pipelines. MES-facing operations provide the
configured production-data path. Analysis and retrieval services consume
these records, while optional model, training, optimization, and digital-twin
services are invoked through their registered operation handlers. These
services complement the agent workflow; AgentWorkShop does not prescribe a
single optimization strategy.

\subsection{Semantic I/O and Actuation}
The driver registry resolves a semantic node to a built-in or plugin driver.
DAQ handlers use the node's acquisition interface; DCW handlers route a
write or readback through the controller and the configured protocol driver.
This separation lets recipes and agents refer to semantic controls without
embedding Modbus, OPC UA, MQTT, HTTP, or MES transport details in their
operation arguments. The supported driver mappings are implementation
interfaces; only the mappings and workflows enumerated in Section~\ref{sec:eval}
are experimentally exercised.

\subsection{Shared Dispatch and Write Admission}
\label{sec:governed}
Every named operation passes the dispatcher. Its ordered checks validate
invocation scope, channel tool selection, profile, duty separation, the
agent's binding and runtime grant, and ownership of referenced resources.
A refusal returns the excluding condition and is recorded. A catalog entry
therefore describes availability but does not authorize execution. Handlers
for operations that require manual approval suspend for a decision, then
revalidate authority and active limits before dispatch.

All actuator writes converge on the DCW admission point. For an online node
write, the admissible interval is
\begin{equation}
\mathcal{I}^{\mathrm{online}}_n(t)=\mathcal{H}_n\cap\mathcal{B}_n
\cap\mathcal{P}_n(t)\cap\mathcal{R}_n(t),
\label{eq:admission}
\end{equation}
where $\mathcal{H}_n$ is the hard engineering range and $\mathcal{B}_n$,
$\mathcal{P}_n$, and $\mathcal{R}_n$ are the baseline, active-product, and
active-recipe limits. Missing optional limits impose no restriction, whereas
an empty intersection rejects the request and identifies the excluding
layer. Recipe dispatch applies the hard, baseline, and product limits to the
replacement recipe rather than intersecting with the previous recipe window.
The actuator path also enforces step, interval, and hold-window checks.
These admission rules constrain commands; process objectives and coupled
variable guards are assessed from later observations. The framework does
not replace independent PLC or safety-instrumented protection.

\subsection{Integrated Operation and Route-Specific Evidence}
\label{sec:tasklifecycle}
A recipe trial illustrates how the modules cooperate. The task runtime
delivers a named \texttt{recipe\_trial} call from the agent harness; the
dispatcher checks the agent's recipe binding and execution scope; the recipe
handler checks the active run, candidate parameters, and route timing; and a
manual binding requests approval before the DCW controller sends the batch
through its driver. The handler returns a per-parameter receipt. The caller
then obtains DAQ observations and can request a separate update, apply, or
rollback operation. A trial receipt confirms command handling; it does not
by itself establish process attainment or persist a new recipe version.

The routes retain different records because they answer different
questions. A driver acknowledgment reports command evidence; DAQ reports a
process observation; an exploration summary records a bounded probe; and a
recipe version records a saved definition. Their relation through actor and
production context allows an execution to be inspected without treating
these outcomes as interchangeable.

\input{sections/mechanisms}



### Source: sections/related.tex

\section{Related Work}
\label{sec:related}
This section connects AgentWorkShop to two complementary bodies of work:
plant-facing industrial agents, and the production and automation abstractions
that define context, tool access, and operational constraints. Table~\ref{tab:nearest}
compares selected agent systems; the research gap is limited to these
comparators rather than attributed to the wider literature.

\subsection{Industrial Agents and Plant Integration}
Industrial-agent systems span supervisory services, programmable logic
controller (PLC) interfaces, manufacturing coordination, and operator-facing
machine access. Biskupovic et al. study agent-based supervision for
service-oriented industrial systems \cite{biskupovic2025supervision};
Agents4PLC and InstructMPC address PLC code generation and human--LLM
context-aware control, respectively
\cite{liu2026agents4plc,wu2025instructmpc}. Manufacturing studies consider
dynamic resource-capability exploration \cite{lim2025llmenabled}, multi-agent
shop-floor coordination \cite{zhao2026shopfloor}, and digital-twin-supported
fault handling \cite{gill2025llmdt}. Natural-language machine access
\cite{hofmann2025nlc} and real-time LLM control of a robot-operated serial
line \cite{waseem2026pretrained} extend this work to operator interfaces and
robotic-line control. Together, these studies address different operational
contexts, interfaces, and allocations of responsibility between agents,
operators, and controllers.
Accordingly, the table compares three representative integration settings:
reviewed control-sequence generation, module-level manufacturing skills, and
line scheduling. It reports each source's evidence within its own scope and is
not a direct performance comparison.

\begin{table*}[!t]
\centering
\caption{Selected plant-facing agent systems and their integration settings.
Evaluation evidence is reported within each source's scope and is not a direct
performance comparison.}
\label{tab:nearest}
\footnotesize
\setlength{\tabcolsep}{3pt}
\begin{tabularx}{\textwidth}{@{}p{2.7cm}XXX@{}}
\toprule
System & Application scope & Industrial integration & Source-reported evaluation \\
\midrule
MADE \cite{huang2026made} & Operator-reviewed control-sequence generation &
Structured OPC Unified Architecture (OPC UA) commands and authorization & 40 control tasks; virtual and physical demonstrations \\
K{\"o}hle et al. \cite{koehle2026llmdriven} & Module agents and factory skills &
OPC UA and Message Queuing Telemetry Transport (MQTT) with component-state tool availability & Three agent architectures across nine production challenges, including silent-fault recovery \\
Waseem et al. \cite{waseem2026pretrained} & LLM-based robot-assignment scheduling &
Prompt-constrained controller for a simulated line & Scheduling throughput \\
\midrule
AgentWorkShop (this work) & Collaborative tasks, configurable agent harnesses, and analysis/model services &
Production context and semantic process nodes over multiple protocol mappings & Historical four-scene simulator archive; separately archived protocol, software-suite, and recipe-route evidence \\
\bottomrule
\end{tabularx}
\end{table*}

The comparison highlights distinct design emphases rather than a ranking.
AgentWorkShop treats authority and command confirmation as operational
services, consistent with safety-aware decision support \cite{jiang2026agentic};
it does not replace process protection or establish operator effectiveness.

\subsection{Production Context, Agent Interfaces, and Automation}
Industrial integration also depends on abstractions that are not specific to
agent architectures. MCP standardizes tool discovery and calls with
request-scoped authorization \cite{mcp2024}, whereas
ISA-88 and ISA-95 describe recipes and production operations
\cite{isa88_2010,isa95_2025}. Run-to-run methods connect process observations
to successive production runs \cite{moyne2000r2r}. At the agent level,
AgentSpec and CaMeL address tool behavior and capability-based information
flow \cite{wang2025agentspec,debenedetti2025camel}. Together, these works
provide complementary abstractions for production context, tool interaction,
and information flow. They do not, by themselves, specify the shared
integration architecture presented here.

Industrial security and record requirements further constrain that
architecture: FDA guidance discusses trustworthy records and audit trails
\cite{part11}, IEC~62443-3-3 specifies system-security requirements
\cite{iec62443-3-3}, and DNP3 includes select-before-operate
\cite{ieee1815dnp3}. Control-assurance methods address state evolution through
shielding, control-barrier functions, or Simplex architectures
\cite{alshiekh2018shielding,ames2017cbf,sha2001simplex}. These standards and
methods inform the boundaries within which an industrial-agent framework must
operate; they are not contributions claimed by AgentWorkShop.

Within the three representative systems in Table~\ref{tab:nearest}, the
evaluated settings do not assess one configurable composition of agent
harnesses, production context, semantic process I/O, and distinct node and
recipe workflows across scenes. This bounded gap motivates AgentWorkShop as an
integration architecture and implementation. The experiments evaluate
complementary parts of that implementation, while current profile and
per-agent-binding adaptation across scenes remains unvalidated.



### Source: sections/system.tex

\section{System Design}
\label{sec:design}
AgentWorkShop is designed for industrial tasks whose agents, production
contexts, interfaces, and process signals vary between deployments. A useful
framework must let these differences be configured without changing the
shared task runtime, while ensuring that a proposed operation is checked
against the active production context before it reaches a device. It must also
retain enough route-specific evidence to distinguish a returned command
receipt from a measured process response.

\subsection{Design Rationale and Requirements}
\label{sec:principles}
Five requirements follow from this integration problem. Scene variability
requires signal maps, objectives, and guards to be represented as
configuration. Harness variability calls for registered adapters behind a
shared runtime interface. Authority requires a fresh execution-time check,
with explicit approval for manual bindings. Observability requires command
confirmation and process response to remain separate records. Extensibility
requires new engines, tools, and protocol drivers to be registered without
changing the common task path.

These requirements lead to six design rules: represent scene-specific
differences as versioned data; extend the runtime through registered
interfaces; keep an agent's proposal separate from execution; treat the tool
catalog as a view rather than an authorization boundary; route actuator
writes through a common admission point; and retain evidence according to
the operation that produced it. The framework does not choose an agent's
strategy or replace controller and safety functions. It supplies the
integration path through which a named operation is contextualized,
authorized, dispatched, and recorded.

\subsection{Layered Architecture}
\label{sec:layers}
\label{sec:arch}
Fig.~\ref{fig:arch} maps the reference implementation onto six bands and a
shared evidence ledger. The access band exposes command-line, web, SDK, REST,
MCP, and A2A entry surfaces. The collaboration band contains workspaces,
channels, task queues, shared memory, mailboxes, task templates, and
harness adapters. The governance band projects an operation catalog and
checks each invocation. The context band binds a scene blueprint to the
active line--product--recipe--run tuple and its semantic DAQ/DCW nodes. The
service band provides acquisition, write control, analysis, retrieval, and
optional model services. The field-I/O band resolves semantic nodes to
built-in or plugin drivers for a plant or simulator.

Each band has a distinct responsibility. Entry surfaces converge on the
same task runtime; a harness adapter supplies the agent-specific interaction;
semantic nodes hide protocol details from the task; and the driver registry
provides the device-facing extension point. The evidence ledger records
task, command, observation, and version events against their actor and
production context. It does not collapse them into a single success flag.

\subsection{Cross-Module Execution Flow}
\label{sec:executionflow}
Fig.~\ref{fig:runtime} summarizes a task turn from entry to returned
evidence. The runtime resolves the production context and assembles the
prompt and scoped tool catalog before invoking a registered harness. For
each returned tool call, the shared dispatcher rechecks invocation scope
and channel policy; industrial operations also receive current grant and
binding checks before handler selection. The selected handler applies its
own route-specific guards, approval, revalidation, and device-I/O steps.
Command receipts and any later process observations remain distinct records.

Fig.~\ref{fig:execution} gives pseudocode for these cross-module contracts;
it is a reference flow rather than one literal orchestrator function.
Route-specific timing, approval, and evidence rules are detailed in
Section~\ref{sec:modules}.

\begin{figure*}[!t]
\centering
\includegraphics[width=\textwidth]{resources/fig-runtime-2026.pdf}
\caption{Cross-module task execution in AgentWorkShop. Entry and task
services assemble the channel-scoped tool catalog before the agent turn;
each returned call is rechecked for scope and policy, with grant and binding
checks for industrial operations. Dispatch-gate refusals stop before handler
execution, whereas route-specific handlers may read state before refusing a
write. Receipts and later observations remain distinct.}
\label{fig:runtime}
\end{figure*}

\begin{figure}[!t]
\centering
\begin{algorithmic}[1]
\Require task $q$, channel $c$, bound agent $a$
\Ensure task result and route-linked evidence
\State $x \gets \Call{ResolveContext}{c,q}$
\State $T \gets \Call{FilterToolCatalog}{a,c}$
\State $m \gets \Call{RetrieveMemory}{q}$
\State $p \gets \Call{AssemblePrompt}{q,x,m}$
\State $h \gets \Call{InvokeRegisteredHarness}{a,p,T}$
\ForAll{tool request $u$ returned by $h$}
  \State $g \gets \Call{CheckScopeAndChannelPolicy}{a,c,u}$
  \If{\textbf{not} $g$}
    \State \Call{RecordDispatchRefusal}{u,x}; \textbf{continue}
  \EndIf
  \If{$u$ is an industrial operation}
    \State $v \gets \Call{CheckGrantAndBinding}{a,u}$
    \If{\textbf{not} $v$}
      \State \Call{RecordDispatchRefusal}{u,x}; \textbf{continue}
    \EndIf
  \EndIf
  \State $k \gets \Call{SelectHandler}{u}$
  \State $r \gets \Call{ExecuteRouteHandler}{k,u,x}$
  \State \Call{RecordAvailableEvidence}{u,r,x}
  \State \Call{ReturnToolResult}{h,r}
\EndFor
\State \Return task state and retained evidence
\end{algorithmic}
\caption{Reference pseudocode for cross-module execution in AgentWorkShop.}
\label{fig:execution}
\end{figure}

