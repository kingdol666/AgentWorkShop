# Cover letter (draft)

Dear Editor-in-Chief,

We submit our manuscript **"From agent goals to plant setpoints:
configuration-driven governance of LLM-agent writes on production lines"**
for consideration as a regular paper in *Computers in Industry*.

LLM agent teams are moving from advisory roles into supervisory setpoint
writes on production lines. Existing agent frameworks govern actions at
session granularity; they do not encode plant semantics such as safe
ranges, recipe windows, batch context, or the difference between a device
confirmation and a transport acknowledgment. The manuscript treats the
agent-to-plant write path itself as the unit of governance and makes the
following contributions:

1. **Configuration-driven binding.** Agent authority is bound to lines,
   products, recipes, runs, and nodes, so write scope is a configuration
   fact rather than a prompt convention.
2. **Layer-attributable write path.** A four-layer admission interval,
   bound human approval with dispatch-time tuple recheck, and
   readback-graded receipts produce a path in which every blocked or
   executed write names its deciding layer and evidence class.
3. **Industrial testbed evidence.** A five-protocol matrix on real
   protocol stacks (Modbus TCP/RTU, OPC UA, MQTT, HTTP) passes 21/21
   checks; a four-arm ablation attributes interception to the batch-window
   interlock with zero false blocks on the injected legitimate workload;
   a simulator-backed OPC UA case study exercises the complete governed
   correction; an adversarial episode bounds a weak model to zero
   unapproved writes; and the open implementation passes 913/915 unit
   tests with bit-exact frozen-baseline reproduction.

The work is application-oriented and protocol-grounded: real industrial
stacks, a MES mirror, and a deployable single-runtime implementation. We
are explicit that process physics is simulator-backed; the manuscript
frames this as an industrial testbed and identifies the plant pilot as the
next empirical step. We believe this transparency, together with the
layer-attribution evidence, fits the journal's emphasis on
application-oriented research with a generalized message.

The manuscript is prepared for double-anonymous review: the main PDF
contains no author-identifying information, and a separate title page
provides author details, CRediT contributions, competing interests,
funding, and acknowledgements. Highlights and a graphical abstract are
provided as separate files. The manuscript is not under consideration
elsewhere [author to confirm before submission].

Thank you for considering our work.

Sincerely,

[Corresponding author name]
[Affiliation]
[Email]
