/**
 * 客户端 IP 解析(限流/登录锁定/审计的唯一取数点)。
 *
 * X-Forwarded-For 是**客户端可伪造**的请求头。只有部署在可信反向代理之后、
 * 且反代已改写该头时才可信;直连部署若采信它,限流桶 / 404 封锁 / 登录失败锁定
 * 全部可按伪造 IP 绕过(密码可无限暴破,也可反过来伪造受害者 IP 做锁定 DoS)。
 *
 * 因此:仅当 AW_TRUST_PROXY=1 时才采信 XFF,否则一律取 socket 地址。
 * 不在本函数内自行解析 XFF 链——交给反代正确配置(h3 的 xForwardedFor 选项取首跳)。
 */
import { getRequestIP, type H3Event } from 'h3'

const TRUST_PROXY_ENV = 'AW_TRUST_PROXY'

/** 是否采信 X-Forwarded-For(每次调用读取,便于测试与热配置) */
export function trustProxyEnabled(): boolean {
  return process.env[TRUST_PROXY_ENV] === '1'
}

/** 真实客户端 IP;无法确定时返回 'local'。 */
export function clientIp(event: H3Event): string {
  try {
    return (trustProxyEnabled() ? getRequestIP(event, { xForwardedFor: true }) : getRequestIP(event)) ?? 'local'
  }
  catch {
    // event 形状不完整(单测/内部调用):退化为 local,不阻塞请求
    return 'local'
  }
}
