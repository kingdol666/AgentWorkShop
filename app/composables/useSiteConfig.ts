/**
 * 统一读取运行时配置（来自 config.yml -> runtimeConfig.public）
 * 全应用通过 useSiteConfig() 消费，避免散落 useRuntimeConfig()。
 */
export function useSiteConfig() {
  const c = useRuntimeConfig().public
  return {
    name: c.appName as string,
    title: c.appTitle as string,
    version: c.version as string,
    description: c.description as string,
    mode: c.mode as string,
    apiBase: c.apiBase as string,
    apiTimeout: c.apiTimeout as number,
    primaryColor: c.primaryColor as string,
    themeMode: c.themeMode as 'light' | 'dark',
    serverHost: c.serverHost as string,
    devPort: c.devPort as number,
    prodPort: c.prodPort as number,
  }
}
