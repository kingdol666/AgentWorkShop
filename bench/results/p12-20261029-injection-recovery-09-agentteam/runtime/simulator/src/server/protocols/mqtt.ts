/**
 * MQTT 设备侧 —— 主动向 broker 发布信号值(主项目 mqtt 驱动只订阅不发布)。
 *   - 每 tick 发布全部 topic 映射:payload 模板 '${value}' 纯数字或 JSON 占位符
 *   - commandTopic(可选):订阅主项目 DCW publish 的写({"setpoint":v} 或纯数字)→ 回灌信号
 * broker 可为外部(如主项目 docker mosquitto 1883)或本模拟器内置 mini-broker(18830)。
 */
import type { DeviceNode } from '../../shared/types'
import type { ProtocolHandle } from './registry'
import { applyWriteback } from '../engine/signals'
import { saveConfig } from '../store'

function renderPayload(template: string | undefined, value: number): string {
  if (!template || template === '${value}') return String(value)
  return template.replace(/\$\{value\}/g, String(value)).replace(/\$\{name\}/g, String(value))
}

export async function startMqtt(node: DeviceNode): Promise<ProtocolHandle> {
  const mqtt = await import('mqtt')
  const brokerUrl = node.config.brokerUrl ?? 'mqtt://127.0.0.1:29830'
  const topics = node.config.topics ?? []
  const commandTopic = node.config.commandTopic
  const commandSignalId = (node.config as Record<string, unknown>).commandSignalId as string | undefined
  // 状态回显主题(可选):发布命令信号的当前值,供上位机/平台写后回读验证。
  // retain=true → 上位机晚订阅也能立刻拿到当前设定值。
  const stateTopic = (node.config as Record<string, unknown>).stateTopic as string | undefined

  const client = await mqtt.connectAsync(brokerUrl, {
    clientId: `plcsim-${node.id}-${Math.random().toString(16).slice(2, 6)}`,
    ...(node.config.username ? { username: node.config.username, password: node.config.password } : {}),
    reconnectPeriod: 2000,
    connectTimeout: 4000,
  })

  if (commandTopic) {
    await client.subscribeAsync(commandTopic, { qos: 1 })
  }

  let lastError: string | undefined
  client.on('error', (err: Error) => { lastError = err.message })
  node.runtime = { ...node.runtime, lastError: undefined }

  const publish = (): void => {
    for (const t of topics) {
      const sig = (node.signals ?? []).find(s => s.id === t.signalId)
      if (!sig?.runtime) continue
      const payload = renderPayload(t.payloadTemplate, sig.runtime.value)
      client.publish(t.topic, payload, { qos: t.qos ?? 0, retain: t.retain ?? false })
    }
    if (stateTopic) {
      const targetId = commandSignalId ?? topics[0]?.signalId
      const sig = (node.signals ?? []).find(s => s.id === targetId)
      if (sig?.runtime) {
        const state = JSON.stringify({
          setpoint: sig.runtime.value,
          value: sig.runtime.value,
          signalId: sig.id,
          at: Date.now(),
        })
        client.publish(stateTopic, state, { qos: 0, retain: true })
      }
    }
  }

  // 发布周期 = 设备 tickMs(下限 500ms,避免打爆 broker)
  const timer = setInterval(publish, Math.max(node.tickMs, 500))
  // 首拍立即发布一次:retained 值在设备启动后无需等一个 tick 即可被订阅者拿到
  publish()

  // 命令回灌
  if (commandTopic) {
    client.on('message', (topic: string, payload: Buffer) => {
      if (topic !== commandTopic) return
      const text = payload.toString()
      let value: number | undefined
      try {
        const parsed = JSON.parse(text) as Record<string, unknown>
        value = typeof parsed.setpoint === 'number' ? parsed.setpoint
          : typeof parsed.value === 'number' ? parsed.value : Number(parsed.setpoint ?? parsed.value)
      }
      catch { value = Number(text) }
      if (!Number.isFinite(value)) return
      const targetId = commandSignalId ?? topics[0]?.signalId
      const sig = (node.signals ?? []).find(s => s.id === targetId)
      if (!sig) return
      applyWriteback(sig, value)
      // Persist commandTopic writes so the next simulator process starts from
      // the last PLC setpoint instead of the stale preset value.
      saveConfig()
      node.runtime = { ...node.runtime, lastCommand: { at: Date.now(), value } } as never
      // 命令生效立即回显状态主题(不等下一个 tick):平台写后回读可在毫秒级拿到设定值
      publish()
    })
  }

  const handle: ProtocolHandle = {
    close: async () => {
      clearInterval(timer)
      try { await client.endAsync(true) } catch { /* 已断 */ }
    },
    summary: () => ({
      protocol: 'mqtt', brokerUrl, topics: topics.map(t => t.topic), commandTopic: commandTopic ?? null,
      stateTopic: stateTopic ?? null,
      connected: client.connected, ...(lastError ? { lastError } : {}),
    }),
  }
  return handle
}
