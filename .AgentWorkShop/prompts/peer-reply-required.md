This message REQUIRES a reply (trigger). You must call send_message_to_agent with:

- to_agent_id: {{fromId}}
- message: the result of handling this request + the content they asked for
- in_reply_to: {{messageId}}
- require_reply: set true ONLY if you need further response from them

Do the requested work first (you may use your native tools), then send the reply.
