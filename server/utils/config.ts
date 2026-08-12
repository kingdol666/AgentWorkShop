import { useRuntimeConfig } from '#imports'

/**
 * 服务端配置读取 —— 与前端同源（config.yml -> nuxt.config runtimeConfig -> useRuntimeConfig）
 * 前端对应 useSiteConfig()，两侧看到的配置完全一致，保证「配置一致性」。
 */
export function useServerConfig() {
  const c = useRuntimeConfig()

  return {
    app: {
      name: c.public.appName as string,
      title: c.public.appTitle as string,
      version: c.public.version as string,
      description: c.public.description as string,
      mode: c.public.mode as string,
    },
    server: {
      host: c.public.serverHost as string,
      devPort: c.public.devPort as number,
      prodPort: c.public.prodPort as number,
    },
    api: {
      baseURL: c.public.apiBase as string,
      timeout: c.public.apiTimeout as number,
      // 服务端专用键（仅 Nitro 可见，同样来自 config.yml -> api）
      pageSize: c.apiPageSize as number,
      maxPageSize: c.apiMaxPageSize as number,
    },
    theme: {
      primaryColor: c.public.primaryColor as string,
      themeMode: c.public.themeMode as 'light' | 'dark',
    },
    i18n: {
      defaultLocale: c.public.defaultLocale as string,
    },
  }
}

export type ServerConfig = ReturnType<typeof useServerConfig>
