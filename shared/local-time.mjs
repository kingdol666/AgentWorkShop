/**
 * 本地时间呈现(单点收口):全项目 ISO 时间输出统一为本地系统时区(如北京时间 +08:00)。
 *
 * 背景:Node `Date.toISOString()` 恒输出 UTC(`Z` 后缀)。本项目所有时间字段
 * (日志 t / DB createdAt / WS 帧 at / Agent 记录)此前均为 UTC 字符串,用户要求
 * 全部以本地系统时间呈现。
 *
 * 机制:installLocalIso() 把 Date.prototype.toISOString 改写为输出
 * `YYYY-MM-DDTHH:mm:ss.sss±HH:MM`(本地偏移)。性质:
 *  - 同一绝对时刻(仅表示形式变化),Date.parse/new Date(str) 完全兼容;
 *  - 偏移后缀恒定(无 DST 时区如 +08:00),字符串字典序排序与时间序一致;
 *  - 覆盖显式调用与 JSON.stringify(Date)(toJSON 默认走 toISOString)。
 *  - 时区动态取自系统(getTimezoneOffset),跟随宿主,不硬编码。
 *
 * 幂等:重复安装跳过;原始实现保留在 __origToISOString 供诊断。
 */
export function installLocalIso() {
  const proto = Date.prototype
  if (proto.__origToISOString) return
  const orig = proto.toISOString
  proto.__origToISOString = orig
  const pad = (n, w) => String(n).padStart(w, '0')
  proto.toISOString = function () {
    const t = this.getTime()
    if (Number.isNaN(t)) throw new RangeError('Invalid time value')
    // getTimezoneOffset:UTC 比本地慢的分钟数(UTC+8 → -480);取负得本地相对 UTC 偏移
    const offMin = -this.getTimezoneOffset()
    const sign = offMin >= 0 ? '+' : '-'
    const abs = Math.abs(offMin)
    // 平移后用 UTC getter 读出本地分量(整分偏移,毫秒不变)
    const shifted = new Date(t + offMin * 60_000)
    return `${pad(shifted.getUTCFullYear(), 4)}-${pad(shifted.getUTCMonth() + 1, 2)}-${pad(shifted.getUTCDate(), 2)}`
      + `T${pad(shifted.getUTCHours(), 2)}:${pad(shifted.getUTCMinutes(), 2)}:${pad(shifted.getUTCSeconds(), 2)}`
      + `.${pad(this.getMilliseconds(), 3)}${sign}${pad(Math.floor(abs / 60), 2)}:${pad(abs % 60, 2)}`
  }
}
