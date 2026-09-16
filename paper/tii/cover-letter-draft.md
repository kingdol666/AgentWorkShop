% Cover letter draft — IEEE Transactions on Industrial Informatics submission
% TODO: fill corresponding author name, date; delete this comment block before sending.

Dear Editor-in-Chief,

We are pleased to submit our manuscript entitled "AgentWorkShop: A Node-Native
Integration Framework for LLM Multi-Agent Governed Closed-Loop Optimization of
Heterogeneous Industrial Production Lines" for consideration as a Regular Paper
in IEEE Transactions on Industrial Informatics.

Industrial LLM deployments today stop at the advisory boundary: they diagnose,
generate PLC code, or recommend setpoints, but no published system lets an agent
team's decision become a governed write on a protocol-heterogeneous plant. Our
manuscript closes this gap with three contributions:

1. A node-native integration framework that hosts the agent runtime (14
   interchangeable LLM harness engines, lead-supervised teams) and the
   industrial runtime (five protocol drivers with per-node edge acquisition) in
   one process and one data domain, so binding an agent to an actuator is a
   configuration act rather than an integration project (Sec. III).

2. A governed write-control pipeline---recipe-window interlock, mode-bound
   human-approval gate, readback-verified write, attributable journal, and a
   bounded-autonomy backstop---formalized with three safety invariants that are
   mapped to implementation anchors and verified by negative tests on a live
   instance (Sec. IV).

3. AW-IndustrialBench, an executable benchmark with frozen baselines and
   machine-verifiable reproduction, measuring cross-scenario portability
   (five devices recommissioned on a second scenario with zero code changes;
   100% interception, 0% false blocks), real-protocol governance (20/20 seeded
   attacks rejected across four protocols), a closed-loop optimization
   benchmark (97.0-97.2% of the offline grid optimum under a fixed controller),
   and a four-arm governance ablation attributing interception to the interlock
   (Sec. V).

We report, against our own framework, that current LLM agent teams reach only a
median 0.76 of the offline optimum on the same loop---a measured negative that
motivates our propose/dispose design and, we believe, will be of particular
interest to TII's readership: the governed path makes such deployments safe to
attempt and honest to evaluate.

The manuscript is 12 pages, has not been published elsewhere, and is not under
review by any other journal. All measurements are simulation-tier (two seeded
plant scenarios) and are labeled as such; the platform source, benchmark
harness with frozen baselines, run archives, and the PLC node simulator are
publicly versioned.

Sincerely,
The Authors
