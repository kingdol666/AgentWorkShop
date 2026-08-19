<script setup lang="ts">
/**
 * A2A JSON-RPC/SSE 调试器(P2):对 channel 内 agent 实例直发 JSON-RPC 2.0。
 * - 普通方法(tasks/send 等):POST /a2a/:agentId/rpc → 结果 JSON
 * - tasks/sendSubscribe:消费 SSE 流,事件逐条实时渲染(task/status-update/artifact-update/message/error)
 * - message/send 需 Bearer token(可选填)
 */
import { message } from 'ant-design-vue'
import { useEntitiesStore } from '@/app/stores/workshop/entities'

const props = defineProps<{ channelId: string }>()
const open = defineModel<boolean>('open', { default: false })

const entities = useEntitiesStore()
const agents = computed(() => entities.agents[props.channelId] ?? [])
const agentId = ref('')
watch(agents, (list) => {
  if (!agentId.value && list.length > 0) agentId.value = list[0]?.agentId ?? ''
}, { immediate: true })

type Method = 'tasks/send' | 'tasks/sendSubscribe' | 'tasks/get' | 'tasks/list' | 'message/send' | 'agent/getCard'
const method = ref<Method>('tasks/list')
const methodOptions: Array<{ value: Method, label: string, sse?: boolean }> = [
  { value: 'tasks/list', label: 'tasks/list' },
  { value: 'tasks/get', label: 'tasks/get' },
  { value: 'tasks/send', label: 'tasks/send' },
  { value: 'tasks/sendSubscribe', label: 'tasks/sendSubscribe(SSE 流)', sse: true },
  { value: 'message/send', label: 'message/send(需 token)' },
  { value: 'agent/getCard', label: 'agent/getCard' },
]

const paramsJson = ref('{}')
const token = ref('')
const running = ref(false)
const output = ref('')

/** 按方法生成参数模板 */
const template = (): Record<string, unknown> => {
  switch (method.value) {
    case 'tasks/send':
    case 'tasks/sendSubscribe':
      return { message: { role: 'ROLE_USER', parts: [{ text: '调试:请回显这条消息' }] } }
    case 'tasks/get':
      return { taskId: '<taskId>' }
    case 'message/send':
      return { message: { role: 'ROLE_USER', parts: [{ text: '调试消息' }] } }
    default:
      return {}
  }
}

const append = (line: string): void => {
  output.value += `${line}\n`
}

/** SSE 消费:sendSubscribe 流式渲染 */
const runSse = async (body: Record<string, unknown>): Promise<void> => {
  const res = await fetch(`/api/workshop/a2a/${agentId.value}/rpc`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'accept': 'text/event-stream',
      ...(token.value ? { authorization: `Bearer ${token.value}` } : {}),
    },
    body: JSON.stringify(body),
  })
  append(`▶ HTTP ${res.status} ${res.headers.get('content-type') ?? ''}`)
  if (!res.body) {
    append(await res.text())
    return
  }
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    const frames = buf.split('\n\n')
    buf = frames.pop() ?? ''
    for (const frame of frames) {
      const dataLine = frame.split('\n').find(l => l.startsWith('data:'))
      if (dataLine) append(`◀ ${dataLine.slice(5).trim().slice(0, 400)}`)
    }
  }
  append('▶ 流结束')
}

const run = async (): Promise<void> => {
  if (!agentId.value) {
    message.warning('选择目标 agent')
    return
  }
  let params: Record<string, unknown>
  try {
    params = JSON.parse(paramsJson.value || '{}')
  }
  catch {
    message.error('params 不是合法 JSON')
    return
  }
  running.value = true
  output.value = ''
  const body = { jsonrpc: '2.0', id: Date.now(), method: method.value, params }
  try {
    if (method.value === 'tasks/sendSubscribe') {
      await runSse(body)
    }
    else {
      const res = await fetch(`/api/workshop/a2a/${agentId.value}/rpc`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(token.value ? { authorization: `Bearer ${token.value}` } : {}),
        },
        body: JSON.stringify(body),
      })
      const text = await res.text()
      append(`▶ POST /a2a/${agentId.value.slice(0, 8)}/rpc ${method.value} → HTTP ${res.status}`)
      append(text.slice(0, 4000))
    }
  }
  catch (e) {
    append(`✖ ${e instanceof Error ? e.message : String(e)}`)
  }
  finally {
    running.value = false
  }
}
</script>

<template>
  <a-drawer
    v-model:open="open"
    placement="right"
    :width="600"
    title="A2A RPC / SSE 调试器"
  >
    <div class="dbg">
      <div class="row">
        <a-select
          v-model:value="agentId"
          class="agent"
          placeholder="目标 agent 实例"
          :options="agents.map(a => ({ value: a.agentId, label: `${a.name}(${a.role})` }))"
        />
        <a-select
          v-model:value="method"
          class="method"
          :options="methodOptions"
        />
      </div>
      <a-input-password
        v-model:value="token"
        size="small"
        placeholder="Bearer token(message/send 需要;留空匿名)"
        class="token"
      />
      <div class="row">
        <a-textarea
          v-model:value="paramsJson"
          :rows="6"
          class="params"
        />
      </div>
      <div class="row ops">
        <a-button
          size="small"
          @click="paramsJson = JSON.stringify(template(), null, 2)"
        >
          参数模板
        </a-button>
        <a-button
          type="primary"
          size="small"
          :loading="running"
          @click="run"
        >
          执行
        </a-button>
      </div>
      <pre class="output">{{ output || '(输出;sendSubscribe 将逐条渲染 SSE 事件)' }}</pre>
    </div>
  </a-drawer>
</template>

<style scoped>
.dbg {
  display: flex;
  flex-direction: column;
  gap: 8px;
  font-size: 12px;
}
.row {
  display: flex;
  gap: 8px;
}
.agent { flex: 1 1 55%; }
.method { flex: 1 1 45%; }
.params { font-family: ui-monospace, Consolas, monospace; }
.ops { justify-content: flex-end; }
.output {
  min-height: 240px;
  padding: 10px;
  overflow: auto;
  font-size: 11px;
  font-family: ui-monospace, Consolas, monospace;
  white-space: pre-wrap;
  word-break: break-all;
  background: color-mix(in srgb, currentColor 5%, transparent);
  border-radius: 8px;
}
</style>
