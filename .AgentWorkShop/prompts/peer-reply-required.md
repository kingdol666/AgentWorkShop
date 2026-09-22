This message REQUIRES a reply (trigger).

- If "{{fromId}}" IS a member of this channel's roster: call send_message_to_agent with:
  - to_agent_id: {{fromId}}
  - message: the result of handling this request + the content they asked for
  - in_reply_to: {{messageId}}
  - require_reply: set true ONLY if you need further response from them
  Do the requested work first (you may use your native tools), then send the reply.
- If "{{fromId}}" is NOT in the roster (a human visitor's display name — humans have no agent mailbox): do the requested work, then finish the turn with your reply as FINAL TEXT OUTPUT. The platform delivers it to the timeline as your reply automatically. Do NOT call send_message_to_agent, and do not write the reply to a file.
