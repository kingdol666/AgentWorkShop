# Registered Pi CLI simulator evidence

Run status: **failed**.

This archive was produced by a bounded local integration run of the registered Pi CLI adapter, its AgentWorkShop host-tool extension, the protected synthetic approval endpoint, and the loopback process simulator. The model endpoint is a deterministic OpenAI-compatible fixture bound to IPv4 loopback; no external model, provider, or service was called.

The fixture is scripted to issue one bounded `recipe_trial`, pass its returned host-tool result back into Pi, issue one explicit `complete_task`, and pass that result back into Pi. Device acknowledgement, direct readback, run-tagged DAQ sample persistence, task/approval/receipt/sample linkage, and process/port cleanup are recorded in `evidence.json` when observed.

The application and simulator logs contain runtime diagnostics for this isolated run. The Pi API trace contains request metadata and bounded tool-result text only; it omits prompts, credentials, session files, and the temporary isolated home.

Recorded blocker/failure: cast-film Pi task did not complete within the bounded window (state=WORKING) (stage: cast-film:collect-result-and-observations).
