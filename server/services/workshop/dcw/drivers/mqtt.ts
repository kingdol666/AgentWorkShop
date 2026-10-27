/**
 * MQTT 写驱动(publish 设定值到 Broker;可选状态主题回读)
 * (由 server/services/workshop/dcw/drivers.ts 按职责拆出;内容逐行原文搬运)
 */
import type { DcwWriteDriver } from './shared'
import { AppError } from '../../../../utils/errors'
import { reqNative } from './shared'
import { mqttConnectOpts, readMqttValue, invalidateMqttTopic } from '../../daq/drivers/mqtt'

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
      // 回读准备(必须在发布**之前**):先把状态主题订阅就绪并把 broker 的 retained 旧值读进缓存,
      // 再清空缓存 —— 这样发布后的回读只可能拿到写后报文;冷连接直接订阅也不会把 retained
      // 旧值误当成本次写入的回读(配方重复下发同值时的假 verified)。
      if (cfg.readTopic) {
        const readTopic = String(cfg.readTopic)
        const readJsonPath = cfg.readJsonPath != null ? String(cfg.readJsonPath) : (cfg.jsonPath != null ? String(cfg.jsonPath) : undefined)
        try {
          await readMqttValue(cfg, readTopic, readJsonPath, 300, { allowCachedMs: 5000 })
        }
        catch { /* 预热失败不阻断发布;验证阶段会如实判 unverified */ }
        invalidateMqttTopic(cfg, readTopic)
      }
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
    let c: import('mqtt').MqttClient | null = null
    try {
      if (!driverConfig.host) return { ok: false, message: '缺少 Broker 地址 host' }
      if (!driverConfig.topic) return { ok: false, message: '缺少下发主题 topic' }
      const mqtt = reqNative('mqtt') as typeof import('mqtt')
      const secure = Boolean(driverConfig.secure ?? driverConfig.tls)
      const url = `mqtt${secure ? 's' : ''}://${String(driverConfig.host)}:${Number(driverConfig.port ?? 1883)}`
      c = await new Promise<import('mqtt').MqttClient>((resolve, reject) => {
        const cli = mqtt.connect(url, { ...mqttConnectOpts(driverConfig), reconnectPeriod: 0 })
        // 立即登记到外层变量:connect 失败时 catch 里能销毁该 client(reconnectPeriod=0 虽不重连,
        // 但失败的 socket/句柄仍要显式释放,避免"测试连接"把池撑大)
        c = cli
        cli.once('connect', () => resolve(cli))
        cli.once('error', err => reject(new Error(err.message)))
      })
      await new Promise<void>(r => c!.end(false, {}, () => r()))
      return { ok: true, message: `Broker 连接成功(${String(driverConfig.host)}:${Number(driverConfig.port ?? 1883)});未执行发布,避免误触发真实设备动作` }
    }
    catch (err) {
      // 失败路径必须销毁 client(否则 mqtt.js 后台重连泄漏)
      try {
        c?.end(true)
      }
      catch { /* 未连上 */ }
      return { ok: false, message: `MQTT 连接失败: ${err instanceof Error ? err.message : String(err)}` }
    }
  },

  /**
   * 可选回读:设备若在状态主题回显设定值,driverConfig.readTopic + readJsonPath
   * (缺省沿用 jsonPath)即可把写后验证从 transport-ack 提升到 readback-verified。
   * 未配置 readTopic 时明确返回「不支持读取」——网关立即收敛为 unverified,不空转重试。
   */
  canRead(driverConfig) {
    return Boolean(driverConfig.readTopic)
  },
  async read(input) {
    const cfg = input.driverConfig
    const readTopic = cfg.readTopic ? String(cfg.readTopic) : ''
    if (!readTopic) {
      return { ok: false, eng: null, raw: null, message: 'MQTT 节点未配置 readTopic:仅下行,不支持读取回读(写结果按 transport-ack 如实记账)' }
    }
    try {
      const jsonPath = cfg.readJsonPath != null ? String(cfg.readJsonPath) : (cfg.jsonPath != null ? String(cfg.jsonPath) : undefined)
      // 周期读/手动读:缓存 4s 内可直接复用(状态主题按设备周期刷新),避免长时间占住读锁;
      // 写后验证前 write() 已 invalidate,因此这里拿到的一定是写后报文或缓存过期后的新报文。
      const hit = await readMqttValue(cfg, readTopic, jsonPath, 1200, { allowCachedMs: 4000 })
      if (!hit) {
        return { ok: false, eng: null, raw: null, message: `MQTT 回读超时:${readTopic} 在 1.2s 内无新报文且无 4s 内缓存(状态主题未发布) ` }
      }
      return { ok: true, eng: hit.value, raw: hit.value, message: `MQTT 回读 ${readTopic} = ${hit.value}` }
    }
    catch (err) {
      return { ok: false, eng: null, raw: null, message: `MQTT 回读失败: ${err instanceof Error ? err.message : String(err)}` }
    }
  },
}
