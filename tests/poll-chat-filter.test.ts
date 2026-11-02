/**
 * F-3(2026-11-02):人类群聊投递不得被 poll_messages 读即取。
 *
 * 群聊提问必须走消息回合(processMessage)收尾的 platformReply 才能回写群聊;
 * poll 的「读即取」认领后,文本只留在 Agent 会话里,用户永远收不到答复
 * (实测:15:15 提问被 lead 的 poll 取走,15:50 群聊仍无回复)。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

const { isHumanChatDelivery } = await import('../server/services/workshop/types/a2a')

test('F-3: 人类群聊投递识别(有 source-chat 且无 from-agent)', () => {
  assert.equal(
    isHumanChatDelivery({ metadata: { 'x-aw-source-chat-message-id': 'cm-1', 'x-aw-from-label': '用户', 'x-aw-require-reply': 'true' } }),
    true,
    '人类群聊投递 → true',
  )
  assert.equal(
    isHumanChatDelivery({ metadata: { 'x-aw-source-chat-message-id': 'cm-1', 'x-aw-from-agent': 'ag-1' } }),
    false,
    'Agent 间消息即使带 source-chat 也不排除',
  )
  assert.equal(isHumanChatDelivery({ metadata: { 'x-aw-from-label': '用户' } }), false, '非群聊投递不排除')
  assert.equal(isHumanChatDelivery({}), false, '无 metadata 不排除')
})

test('F-3: poll 过滤后人类群聊投递仍留 pending,任务/协作消息照常可读', () => {
  const list = [
    { messageId: 'a', metadata: { 'x-aw-source-chat-message-id': 'cm-1', 'x-aw-from-label': '用户' } },
    { messageId: 'b', metadata: { 'x-aw-task-kind': 'assign' } },
    { messageId: 'c', metadata: { 'x-aw-from-agent': 'ag-2' } },
  ]
  const kept = list.filter(m => !isHumanChatDelivery(m)).map(m => m.messageId)
  assert.deepEqual(kept, ['b', 'c'], '只有人类群聊投递被留下')
})
