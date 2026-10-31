# Proposed experiment: multi-scene, governed agent operation

**Status:** protocol proposal only. This study has not been executed; it has no
results and must not be cited as completed evidence or written into the
manuscript as an experiment already performed.

## What the study should establish

The paper's central claim is that one integration architecture can bind
replaceable agent runtimes to heterogeneous industrial scenes and route
bounded, approved parameter changes through a shared execution path. The next
study should test that claim at the complete task level rather than infer it
from separate protocol, harness, and mission tests.

The study has three questions:

1. Can new scenes be connected by changing documented scene configuration and
   bindings while retaining the same operation catalog and agent workflow?
2. Can a role-separated agent team complete the context--approval--write--
   readback--observation chain across those scenes?
3. Does the team preserve chain completion relative to a single-agent workflow
   under matched initial conditions and identical permissions?

The objective is an integration and governance evaluation. It is not a contest
between language models or a claim that an agent improves process quality.

## Study structure

Use four resettable simulator scenes corresponding to the existing injection,
film, annealing, and wastewater missions, provided each has a validated DAQ
measurement, DCW setpoint, engineering limits, and named bounded operation.
If one scene cannot meet those criteria, select a replacement from the
protocol-integration matrix before preregistration and state the reason. Freeze
each scene's process image, line/product/recipe/run context, mappings, ranges,
step limits, target band, tool definitions, prompts, model, and approval policy.
Compute and retain a canonical configuration hash and simulator snapshot hash
for each scene.

### A. Scene portability check

Start from the same application build and operation catalog. Have an engineer
who did not implement the platform connect the four scenes using the documented
configuration interface. Record elapsed engineering time, each changed
configuration field, validation errors, and any application-code, prompt, or
tool-definition changes. A scene counts as configured only when its semantic
DAQ/DCW bindings, active context, limits, and one legal read/write validation
are independently checked. Report per-scene effort and all required code or
prompt changes; do not describe onboarding as configuration-only if any such
change is needed. This measures setup effort without claiming a reduction
unless a predeclared comparison baseline is also run.

### B. Matched single-agent and role-separated workflows

Compare these workflows in each scene using the same model, task, operation
catalog, tool permissions, approval policy, candidate rule, and initial
snapshot:

1. **Role-separated team:** a coordinator delegates context and DAQ retrieval
   to a read-only analyst and a bounded proposal to a write-limited operator.
   The operator requests explicit human approval before dispatch. The
   coordinator checks approval, receipt, device readback, and run-associated
   post-command observation before closing the parent task.
2. **Single-agent reference:** one agent performs the same sequence with the
   same operation permissions and approval requirements. This is a workflow
   reference, not a different control algorithm.

Use matched initial-condition blocks. For each block, restore the same
simulator snapshot before each workflow, randomize workflow order, and apply
the same predeclared disturbance and candidate-selection schedule. Run a
separate 10-block-per-scene pilot to estimate paired discordance and refine
runner reliability; exclude pilot episodes from confirmatory analysis. Before
confirmatory collection, specify the smallest meaningful difference with a
process engineer and calculate sample size for the paired binary endpoint
using the pilot discordance rate. Use at least 30 confirmatory blocks per
scene; increase this number if the power calculation requires it. If the
available sample is underpowered, label the comparison a feasibility study
and do not claim superiority or noninferiority.

For each episode, require the workflow to retrieve the active scene and
line--product--recipe--run tuple, read the mapped process signal, propose one
candidate, request approval, revalidate the context, dispatch one named
operation, independently read the device register, acquire a timestamped
post-command DAQ sample, and reconcile that sample with the platform record.
Stop after this single operation and a fixed observation horizon; do not keep
retuning until the target is reached.

### C. Entry-path parity control

The route-level comparison should not apply two writes sequentially to the
same live recipe. Instead, for each scene and matched block, create two
isolated simulator instances from the same snapshot and canonical
configuration hash. Apply the same candidate once through the registered task
route and once through direct REST; randomize route order across blocks. Keep
approval, context tuple, tool arguments, protocol mappings, and limits
identical. This avoids the simulator's same-recipe dispatch interval while
preserving a controlled route comparison. Report this arm separately from the
agent-workflow comparison; it tests route integration, not agent behavior or
process response.

### D. Guard and rejection controls

Run separate negative controls for an out-of-range candidate, a stale context
introduced after approval but before dispatch, and a declined approval. Repeat
each control at least 10 times per scene and workflow, restoring the initial
snapshot before every attempt. Acceptance requires a recorded rejection and
unchanged device registers. Report each control's numerator and denominator;
do not pool these cases with valid-operation completion.

## Outcomes and analysis

The primary endpoint is **complete governed-chain success**, a binary episode
outcome. Success requires correct context and units, a candidate within all
configured limits, approval recorded before dispatch, successful context
revalidation, one verified platform receipt, matching independent register
readback, and a timestamped post-command observation associated with the same
run and retrieved by the workflow. Report counts and exact confidence
intervals by scene and workflow, every failure category, and the paired risk
difference. Use an exact McNemar test for the matched workflow comparison;
interpret it against the preregistered meaningful-difference margin.

Secondary outcomes are scene-setup time and changes, task duration, model and
tool calls, retries, approval and context errors, and evidence-record
completeness. Report distributions and all timeouts/model/tool errors. For the
route-parity control, report matched success counts and readback mismatches.
Capture a fixed-horizon process trajectory as a descriptive response only.
Any claim of process improvement requires a separate randomized controller
or baseline study with repeated initial conditions; a single post-write
sample is not causal evidence.

## Required evidence package

For every setup and episode, retain the scene and snapshot hashes; operator
setup log; model, prompt, and role identifiers; parent/child task IDs; task
messages and tool calls; context before proposal and dispatch; candidate and
limits; approval; operation and acknowledgement trace IDs; independent
register readback; timestamped DAQ samples and run IDs; simulator events;
elapsed time; call counts; runner and fixture source hashes; and the full list
of failed, timed-out, and excluded episodes. Remove credentials and personal
identifiers from the public copy, retain unmodified originals internally, and
publish a checksum manifest.

## Interpretation boundary

If successful, this study would support configuration reuse and completion of
the tested governed workflow in the selected simulator scenes. It would not
establish universal multi-agent capability, operator-review effectiveness,
production benefit, safety certification, or physical-plant performance.
Only measured counts, uncertainty intervals, setup effort, and observed
failures may be inserted into the paper after the complete evidence package
has been checked independently.
