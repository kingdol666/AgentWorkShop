# Offline evidence tools

These files are a minimal, dependency-free snapshot of the evidence collector,
E6 trajectory validator, synthetic paired-protocol fixture, and E7
schedule/inventory tools used by the paper workflow. They use Node.js built-ins
only.

Run the offline tests from this directory:

```text
node --test bench/tools/collect-paper-evidence.test.mjs bench/paper-study/study.test.mjs bench/experiment/paper-agent-comparison.test.mjs
node --test bench/paper-runner/paired.test.mjs
```

The E6 validator currently checks paired `no_write`/`scripted` offline traces,
fixed sampling, reset identifiers, and per-scene IAE. It does not acquire data
or verify an actual reset or DAQ source. E7 registers Harness/model
configurations and inventories episode records; it does not call a model,
Harness, simulator, or plant. PID/Agent multiarm acquisition and controlled cross-Harness E7 execution remain
`NOT_IMPLEMENTED / NOT_RUN`; the separate archived E6 exploratory subset and
three-episode E7 pilot are described in the paper and S7 archive.

The canonical experiment protocol, detailed design, and evidence limitations
are in the sibling `documentation/` directory. Tests validate tooling only;
they are not paper outcomes.
