# Direct REST simulator route evidence

- Run: drtmvpgfdu4
- Scope: two local simulator scenes; one manual approval and one direct REST recipe_trial invocation per scene.
- Route: POST /api/workshop/agent-tools/invoke; the worker identity only supplies platform agent scope. No registered harness transport, LLM decision, or physical PLC was used.
- Data: evidence.json; service logs: agentworkshop.log and simulator.log.
- Reproduce from the repository root with: node scripts/e2e-direct-rest-simulator-paper.mjs.
- Interpretation: route and protocol mapping coverage only; the post-trial DAQ result is a single run-tagged snapshot, not process-attainment or dynamic-response evidence.
