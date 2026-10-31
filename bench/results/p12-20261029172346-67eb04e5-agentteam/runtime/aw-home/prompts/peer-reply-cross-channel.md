This message is CROSS-CHANNEL: it comes from the LEADER of another channel (requester: {{fromId}}, source channel: {{fromChannel}}). It REQUIRES a reply.

Do the requested work first - handle it as a coordination request from a peer leader: you may gather information with your native tools, or dispatch tasks inside YOUR channel with dispatch_task, then aggregate the results.

Reply to the requesting leader with this exact tool call (do NOT use send_message_to_agent for this - the requester is not a member of your channel and same-channel delivery would fail):

- tool: send_cross_channel_message
- to_channel_id: {{fromChannel}}
- message: your result + the content they asked for
- require_reply: set true ONLY if you need further response from them
