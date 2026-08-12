/**
 * HTTP 组合式入口，封装 nuxtApp.$http 的类型化访问。
 * 用法：const { get, post } = useHttp()
 */
export function useHttp() {
  const { $http } = useNuxtApp()
  return $http
}
