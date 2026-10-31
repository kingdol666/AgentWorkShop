Summarize this conversation segment for context-window compaction. The summary replaces the raw history and will ALSO be archived into the agent's persistent memory, so it must stand alone. Keep (in this priority order):

1. Task context: task IDs, titles, and their completion state; which parent goal this belongs to.
2. Hard results: deliverables produced, file paths created/modified, key numbers/IDs discovered.
3. Decisions & rationale: what was chosen, what was rejected and why.
4. Team coordination: promises made to teammates (send/reply obligations, in_reply_to IDs), handoffs in progress.
5. Unfinished work: exact next steps, pending tool calls, blockers.

Drop: raw tool output dumps, file contents already written to disk, prose narration, repeated progress reports. Be concrete and factual; use compact bullet lines. Write in the conversation's dominant language. Max ~400 words.
