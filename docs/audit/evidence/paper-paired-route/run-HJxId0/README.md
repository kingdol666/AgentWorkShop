# Paired route integration evidence

- Run: pprmvszh1z0
- Scope: two simulator scenes; one registered deterministic OMP-RPC fixture route and one direct REST route per scene.
- The fixture supplies a predeclared test vector. No LLM inference, autonomous Agent decision, multi-Agent coordination, or physical PLC was involved.
- Each route used separate line, recipe, control node, and approval. Both used the same normalized scene/signal/protocol/range/step/target configuration and admissible candidate set; each route applied its own distinct predeclared candidate. The configuration fingerprint, candidate-set hash, and route values are recorded in evidence.json.
- Both route results are checked against platform trial/ACK records and a separate DCW device readback.
- Service logs: agentworkshop.log and simulator.log. Reproduce with `node scripts/e2e-paper-paired-route.mjs`.
- Interpretation: validates software route integration and simulated bounded writes only; it is not evidence of Agent decision quality, multi-Agent capability, physical deployment, process attainment, or dynamic response.
