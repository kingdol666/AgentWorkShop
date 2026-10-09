/**
 * MQTT 写驱动(一次性连接发布,无回读)
 * (由 server/services/workshop/dcw/drivers.ts 按职责拆出;内容逐行原文搬运)
 */
import type { DcwWriteDriver } from './shared'
import { AppError } from '../../../../utils/errors'
import { reqNative } from './shared'
import { mqttConnectOpts } from '../../daq/drivers/mqtt'

// ============================================================
// MQTT 写驱动(publish 设定值到 Broker;fire-and-forget,无回读)
// 2026-10-09 生产化:mqtts(TLS)与采侧同源 —— TLS 参数合并/CA 校验走
// daq/drivers/mqtt 的 mqttConnectOpts(节点 driverConfig.secure/caFile 优先,
// 回落全局 daq.mqtt.*),采/控不再各说各话。
// ============================================================

export const mqttDcwDriver: DcwWriteDriver = {
  kind: 'mqtt',
  async available() {
    try {
      reqNative('mqtt')
      return true
    }
    catch {
      return false
    }
  },
  async write(input) {
    try {
      const cfg = input.driverConfig
      if (!cfg.host) throw new AppError(400, 'BAD_REQUEST', '缺少 Broker 地址 host')
      if (!cfg.topic) throw new AppError(400, 'BAD_REQUEST', '缺少下发主题 topic')
      const mqtt = reqNative('mqtt') as typeof import('mqtt')
      const secure = Boolean(cfg.secure ?? cfg.tls)
      const url = `mqtt${secure ? 's' : ''}://${String(cfg.host)}:${Number(cfg.port ?? 1883)}`
      const payload = cfg.jsonKey
        ? JSON.stringify({ [String(cfg.jsonKey)]: input.eng })
        : String(input.eng)
      // 控制发布用一次性连接(低频关键动作,不复用采样的长连接;发布即断,资源可控)。
      // TLS 语义经采侧 mqttConnectOpts 同源;一次性连接绝不能让 mqtt.js 默认重连后台空转。
      const client = await new Promise<import('mqtt').MqttClient>((resolve, reject) => {
        const c = mqtt.connect(url, { ...mqttConnectOpts(cfg), reconnectPeriod: 0 })
        c.once('connect', () => resolve(c))
        c.once('error', (err) => {
          try {
            c.end(true)
          }
          catch { /* 未连上 */ }
          reject(new Error(err.message))
        })
      })
      const qos = Math.min(2, Math.max(0, Number(cfg.qos ?? 1))) as 0 | 1 | 2
      try {
        await new Promise<void>((resolve, reject) => {
          client.publish(String(cfg.topic), payload, { qos }, (err) => {
            if (err)
              reject(new Error(err.message))
            else
              resolve()
          })
          // 发布确认超时(QoS1 等 puback):8s 未确认按失败收敛,不悬挂工具调用
          const timer = setTimeout(() => reject(new Error('发布确认超时(8s)')), 8000)
          timer.unref?.()
        })
      }
      finally {
        // 失败/超时路径同样关闭连接(此前只在成功后 end,超时会泄漏 client +
        // broker session),已关闭的 client 重复 end 幂等安全
        await new Promise<void>((resolve) => {
          // mqtt 的 DoneCallback 是 Node 风格 (error?: Error) => void;直接把 Promise 的 resolve
          // 传进去会把 error 当成"完成值"兑现(错误被吞)。这里显式包一层,保持原语义:
          // 回调一触发即完成,且与原来一样**不**因该 error 而 reject。
          client.end(false, {}, () => resolve())
        })
      }
      // ACK 鉴定如实上报:QoS puback 只是 **broker 受理**(transport-ack),设备侧未证实 ——
      // 生效判定交给写后验证器(readNow/兄弟节点补验),不在此虚报 readback-verified。
      return {
        ok: true,
        ack: 'transport-ack',
        message: `已发布 ${input.eng} → ${String(cfg.topic)}(QoS ${Number(cfg.qos ?? 1)};broker 已受理,设备侧待验证)`,
        raw: input.eng,
        readback: null,
      }
    }
    catch (err) {
      if (err instanceof AppError) throw err
      return { ok: false, message: `MQTT 发布失败: ${err instanceof Error ? err.message : String(err)}`, raw: null, readback: null, ack: 'unverified' }
    }
  },
  async test(driverConfig) {
    try {
      if (!driverConfig.host) return { ok: false, message: '缺少 Broker 地址 host' }
      if (!driverConfig.topic) return { ok: false, message: '缺少下发主题 topic' }
      const mqtt = reqNative('mqtt') as typeof import('mqtt')
      const secure = Boolean(driverConfig.secure ?? driverConfig.tls)
      const url = `mqtt${secure ? 's' : ''}://${String(driverConfig.host)}:${Number(driverConfig.port ?? 1883)}`
      await new Promise<import('mqtt').MqttClient>((resolve, reject) => {
        const c = mqtt.connect(url, mqttConnectOpts(driverConfig))
        c.once('connect', () => resolve(c))
        c.once('error', err => reject(new Error(err.message)))
      }).then(c => new Promise<void>(r => c.end(false, {}, () => r())))
      return { ok: true, message: `Broker 连接成功(${String(driverConfig.host)}:${Number(driverConfig.port ?? 1883)});未执行发布,避免误触发真实设备动作` }
    }
    catch (err) {
      return { ok: false, message: `MQTT 连接失败: ${err instanceof Error ? err.message : String(err)}` }
    }
  },
}
