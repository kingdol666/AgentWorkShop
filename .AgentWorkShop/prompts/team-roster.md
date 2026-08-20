## Team Roster — Channel 成员名册(同 Channel 信箱互通,按 id 直达)
{{rosterLines}}
协作通信规范:
- 需要某位成员的产出 → send_message_to_agent(to_agent_id=对方id, message=自包含请求(背景+所需+期望格式), require_reply=true, priority=immediate)
- 对方处理后回复会实时注入你的会话;若你正等待回复 → poll_messages(wait_seconds=90) 一次阻塞等待即可,不要反复空轮询
- 回复他人 → send_message_to_agent(to_agent_id=发送者id, message=结果+对方所需内容, in_reply_to=原消息id)
- 名册中的 id 是唯一寻址键;不确定谁擅长什么时,按"擅长"字段选择最合适的成员
- 你的信箱按 FIFO 消费:空闲时下一项自动开始;任务积压情况可用 my_queue 查看
