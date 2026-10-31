/**
 * MQTT 写载荷渲染(纯函数,零 IO)—— jsonTemplate / jsonKey / 裸数值 三档。
 *
 * jsonTemplate:支持 `{{value}}` 插值(可多处、可嵌套、可带静态字段),例如
 *   {"cmd":"set","params":{"temp":{{value}},"hold":8}}
 * 渲染后必须是**合法 JSON**(解析一次再序列化,等价于规范化),避免把坏报文发给设备。
 *
 * 安全边界:
 *  - 不做任何表达式/函数求值,只有字面替换;
 *  - 下发值必须是有限数字(NaN/Infinity 拒绝);
 *  - 模板长度 ≤ 4096 字符,渲染结果 ≤ 64KB;
 *  - jsonTemplate 与 jsonKey 互斥(避免"看起来都配了、实际只生效一个")。
 */
import { AppError, ErrorCodes } from '../../../utils/errors'

export const MQTT_TEMPLATE_MAX_CHARS = 4096
export const MQTT_PAYLOAD_MAX_CHARS = 64 * 1024

function bad(message: string): AppError {
  return new AppError(400, ErrorCodes.VALIDATION_ERROR, message)
}

/**
 * 渲染一条 MQTT 写载荷。
 * @param cfg 节点 driverConfig(读取 jsonTemplate / jsonKey)
 * @param value 工程量纲设定值(有限数字)
 * @returns 待 publish 的字符串(JSON 模板会被规范化;裸数值为 String(value))
 */
export function renderMqttWritePayload(cfg: Record<string, unknown>, value: number): string {
  const tplRaw = cfg.jsonTemplate
  const keyRaw = cfg.jsonKey
  const tpl = tplRaw == null ? '' : String(tplRaw).trim()
  const key = keyRaw == null ? '' : String(keyRaw).trim()

  if (tpl) {
    if (key) throw bad('jsonTemplate 与 jsonKey 互斥:嵌套/多字段报文用 jsonTemplate,单键报文用 jsonKey')
    if (!Number.isFinite(value)) throw bad('下发值必须是有限数字(NaN/Infinity 已拒绝)')
    if (tpl.length > MQTT_TEMPLATE_MAX_CHARS) {
      throw bad(`jsonTemplate 过长(${tpl.length} 字符,上限 ${MQTT_TEMPLATE_MAX_CHARS})`)
    }
    if (!tpl.includes('{{value}}')) throw bad('jsonTemplate 缺少 {{value}} 占位符(模板必须把下发值插入报文)')
    const rendered = tpl.replaceAll('{{value}}', String(value))
    let parsed: unknown
    try {
      parsed = JSON.parse(rendered)
    }
    catch (err) {
      throw bad(`jsonTemplate 渲染后不是合法 JSON:${err instanceof Error ? err.message : String(err)}(渲染结果:${rendered.slice(0, 200)})`)
    }
    const out = JSON.stringify(parsed)
    if (out.length > MQTT_PAYLOAD_MAX_CHARS) {
      throw bad(`jsonTemplate 渲染结果过大(${out.length} 字节,上限 ${MQTT_PAYLOAD_MAX_CHARS})`)
    }
    return out
  }

  if (key) return JSON.stringify({ [key]: value })
  return String(value)
}

/** 配置期校验(创建/PATCH 时调用):模板可渲染、JSON 合法、占位符存在、与 jsonKey 不冲突。 */
export function validateMqttWriteConfig(driverConfig: Record<string, unknown>): void {
  renderMqttWritePayload(driverConfig, 0)
}
