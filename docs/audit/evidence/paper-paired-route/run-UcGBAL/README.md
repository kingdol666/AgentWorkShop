# Paired route integration evidence

- Run: pprmvszkd4y
- Scope: two simulator scenes; one registered deterministic OMP-RPC fixture route and one direct REST route per scene.
- The fixture supplies a predeclared test vector. No LLM inference, autonomous Agent decision, multi-Agent coordination, or physical PLC was involved.
- Both routes reused one line, product, recipe, control/DAQ nodes, channel, agent, and active run per scene, with separate manual approvals. They used one normalized scene/signal/protocol/range/step/target configuration and candidate set, then applied distinct predeclared candidates sequentially. Evidence records pre/post reads and invocation-local trial/ACK run IDs.
- Both route results are checked against platform trial/ACK records and a separate DCW device readback.
- Service logs: agentworkshop.log and simulator.log. Reproduce with `node scripts/e2e-paper-paired-route.mjs`.
- Interpretation: validates software route integration and simulated bounded writes only; it is not evidence of Agent decision quality, multi-Agent capability, physical deployment, process attainment, or dynamic response.
