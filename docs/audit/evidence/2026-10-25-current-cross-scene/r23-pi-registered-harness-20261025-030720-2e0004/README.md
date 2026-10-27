# R23 registered Pi CLI simulator evidence

Run status: **passed**.

This archive was produced by a bounded local integration run of the registered Pi CLI adapter, its AgentWorkShop host-tool extension, the protected synthetic approval endpoint, and the loopback process simulator. The model endpoint is a deterministic OpenAI-compatible fixture bound to IPv4 loopback; no external model, provider, or service was called.

The fixture is scripted to issue one bounded `recipe_trial`, pass its returned host-tool result back into Pi, issue one explicit `complete_task`, and pass that result back into Pi. Device acknowledgement, direct readback, run-tagged DAQ sample persistence, task/approval/receipt/sample linkage, and process/port cleanup are recorded in `evidence.json` when observed.

The archived application and simulator logs contain runtime diagnostics with workspace and temporary-home paths and the synthetic admin email scrubbed. The Pi API trace contains request metadata and bounded tool-result text only; it omits prompts, credentials, session files, and the temporary isolated home.

No run blocker was recorded.

