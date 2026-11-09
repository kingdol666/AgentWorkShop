/**
 * 登录态工具(axios `$http` 与 `apiFetch` 共用)。
 *
 * 背景:两条传输层各写了一套 401 收尾 —— axios 有「重读 token 重放一次 → 清登录态
 * → 去重 toast → 打开登录框」,apiFetch 只抛 ApiError。同一份凭据过期,走 apiFetch
 * 的 65 处调用点不会自愈(登录框不弹、cookie 残留、后续请求继续 401)。
 * 这里把三通道读 token 与 401 收尾抽成单一实现,两条路径共用。
 */
import { message } from 'ant-design-vue'
import { useUserStore } from '~/stores/workshop/user'
import { useAuthUiStore } from '~/stores/workshop/auth-ui'

const g = globalThis as typeof globalThis & { __awShown401?: boolean }

/**
 * token 多通道读取:useCookie → document.cookie → localStorage。
 * 背景:cookie 罐在部分环境(嵌入式浏览器/宿主隔离策略)会被异步驱逐,而 Nuxt 上下文
 * 未就绪时 useCookie 也拿不到值 —— 单通道会让首批请求裸奔 → 401 级联。
 */
export function readAuthToken(): string | null {
  try {
    const v = useCookie<string | null>('token').value
    if (v) return v
  }
  catch { /* Nuxt 上下文未就绪 */ }
  if (typeof document !== 'undefined') {
    const m = document.cookie.match(/(?:^|;\s*)token=([^;]*)/)
    if (m?.[1]) {
      try {
        return decodeURIComponent(m[1])
      }
      catch {
        return m[1]
      }
    }
  }
  try {
    const ls = typeof localStorage !== 'undefined' ? localStorage.getItem('aw.token') : null
    if (ls) return ls
  }
  catch { /* 隐私模式等 localStorage 不可用 */ }
  return null
}

/**
 * 401 统一收尾:清登录态(cookie/pinia/localStorage)+ 3s 去重 toast + 打开登录框。
 * 调用方判定"凭据真的失效"(axios 侧已先做过一次重读 token 重放)后再调用。
 */
export function handleAuthExpired(): void {
  // 清登录态(cookie+pinia+localStorage),防 401 toast 风暴
  try {
    useCookie<string | null>('token').value = null
    try {
      localStorage.removeItem('aw.token')
    }
    catch { /* localStorage 不可用 */ }
    useUserStore(useNuxtApp().$pinia).$reset()
  }
  catch { /* 无 pinia 上下文(极端时序) */ }
  if (!g.__awShown401) {
    g.__awShown401 = true
    // SSR 安全:ant-design message 依赖 DOM,服务端调用会炸掉渲染进程
    if (import.meta.client) message.error('登录已过期,请重新登录')
    setTimeout(() => {
      g.__awShown401 = false
    }, 3000)
  }
  // F2:401 不再只弹 toast —— 弹出全局登录对话框给出进门通道
  try {
    if (import.meta.client) useAuthUiStore(useNuxtApp().$pinia).openLogin('expired')
  }
  catch { /* 无 pinia 上下文(极端时序) */ }
}
