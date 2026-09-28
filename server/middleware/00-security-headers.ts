/**
 * 安全响应头(公网部署基线)—— 全站统一附加:
 * - X-Content-Type-Options / X-Frame-Options / Referrer-Policy / Permissions-Policy
 * - CSP:自托管 SPA 语义('self' + inline 样式/脚本;Nuxt 水合与 antd cssinjs 需要 inline)
 * - HSTS:security.hstsEnabled 设置开启才下发(前提=已上 TLS,反代/隧道终结亦可)
 * 纯 setHeader,不读 body、不阻塞;设置读取走 3s TTL 缓存(settingOf)。
 */
import { defineEventHandler, getRequestURL, setResponseHeader } from 'h3'
import { settingOf } from '../services/workshop/settings'

const CSP = [
  'default-src \'self\'',
  'script-src \'self\' \'unsafe-inline\' \'unsafe-eval\'',
  'style-src \'self\' \'unsafe-inline\'',
  'img-src \'self\' data: blob: https:',
  'font-src \'self\' data:',
  'connect-src \'self\' ws: wss:',
  'media-src \'self\' blob:',
  'object-src \'none\'',
  'base-uri \'self\'',
  'frame-ancestors \'none\'',
  'form-action \'self\'',
].join('; ')

export default defineEventHandler((event) => {
  if (!event.node?.res) return
  setResponseHeader(event, 'X-Content-Type-Options', 'nosniff')
  setResponseHeader(event, 'X-Frame-Options', 'DENY')
  setResponseHeader(event, 'Referrer-Policy', 'strict-origin-when-cross-origin')
  setResponseHeader(event, 'Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()')
  setResponseHeader(event, 'Content-Security-Policy', CSP)
  const url = getRequestURL(event)
  if (url.pathname.startsWith('/api/')) setResponseHeader(event, 'Cache-Control', 'no-store')
  // HSTS 只在设置开启时下发(未上 TLS 时下发会锁死 http 访问)
  if (settingOf('security.hstsEnabled') === true) {
    setResponseHeader(event, 'Strict-Transport-Security', 'max-age=31536000; includeSubDomains')
  }
})
