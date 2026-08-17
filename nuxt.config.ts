import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadConfig } from './app/config'

// 构建期一次性读取 config.yml，作为整个运行时的单一事实来源
const config = loadConfig()

// https://nuxt.com/docs/api/configuration/nuxt-config
export default defineNuxtConfig({
  modules: [
    '@nuxt/eslint',
    '@pinia/nuxt',
    'pinia-plugin-persistedstate/nuxt',
    '@vueuse/nuxt',
    '@unocss/nuxt',
    '@ant-design-vue/nuxt',
    '@nuxtjs/i18n',
    'unplugin-icons/nuxt',
    'nuxt-auth-utils',
  ],

  // Pinia stores 自动导入（srcDir = app/）
  imports: {
    dirs: ['stores'],
  },
  devtools: { enabled: true },

  app: {
    head: {
      title: config.app.title,
      htmlAttrs: { lang: config.i18n.defaultLocale },
      meta: [
        { charset: 'utf-8' },
        { name: 'viewport', content: 'width=device-width, initial-scale=1' },
        { name: 'description', content: config.app.description },
      ],
    },
  },

  css: ['~/assets/css/main.css'],

  // 配置驱动注入：app 运行时通过 useRuntimeConfig().public 读取，无需在运行时读 fs
  runtimeConfig: {
    // 服务端专用配置（仅 Nitro 可见，与前端同源于 config.yml -> api）
    apiPageSize: config.api.pageSize,
    apiMaxPageSize: config.api.maxPageSize,
    // nuxt-auth-utils session 加密密钥（config.yml -> security）
    session: {
      password: config.security.sessionPassword,
    },
    public: {
      appName: config.app.name,
      appTitle: config.app.title,
      version: config.app.version,
      description: config.app.description,
      mode: config.mode,
      apiBase: config.api.baseURL,
      apiTimeout: config.api.timeout,
      primaryColor: config.theme.primaryColor,
      themeMode: config.theme.mode,
      serverHost: config.server.host,
      devPort: config.server.dev.port,
      prodPort: config.server.prod.port,
      defaultLocale: config.i18n.defaultLocale,
    },
  },

  // 由 config.yml -> server.dev 驱动开发端口（`pnpm dev` 生效）
  devServer: {
    host: config.server.host,
    port: config.server.dev.port,
  },

  future: { compatibilityVersion: 4 },

  compatibilityDate: '2025-07-15',

  // Nitro WebSocket 支持(游戏后端事件驱动 /api/game/ws)
  nitro: {
    experimental: {
      websocket: true,
    },
    hooks: {
      /**
       * 修复 nitropack 2.13.4 的 import-meta 插件缺陷:非入口 chunk 的
       * `globalThis._importMeta_` 兜底 stub 把 import.meta.url 硬编码为
       * "file:///_entry.js"(虚拟入口名,运行时不存在的路径),而 ESM 求值顺序下
       * 该 stub 先于入口执行,导致 createRequire/资产路径解析拿到错误基址,
       * 生产启动抛 ERR_INVALID_ARG_VALUE。补丁把兜底 URL 改为真正的
       * import.meta.url(仅构建产物,dev 不受影响)。
       */
      compiled: () => {
        const outputDir = join(process.cwd(), '.output', 'server', 'chunks')
        const targets = [
          join(outputDir, '_', 'nitro.mjs'),
          join(outputDir, 'virtual', 'entry.mjs'),
        ]
        for (const file of targets) {
          let src
          try {
            src = readFileSync(file, 'utf8')
          }
          catch {
            continue // 该 chunk 本次构建未生成
          }
          const fixed = src.replaceAll(
            'globalThis._importMeta_||{url:"file:///_entry.js",env:process.env}',
            'globalThis._importMeta_||{url:import.meta.url,env:process.env}',
          )
          if (fixed !== src) writeFileSync(file, fixed)
        }
      },
    },
  },

  typescript: {
    strict: true,
    typeCheck: false,
  },

  antd: {
    extractStyle: true,
  },

  eslint: {
    config: { stylistic: true },
  },

  i18n: {
    defaultLocale: config.i18n.defaultLocale,
    strategy: 'no_prefix',
    langDir: 'locales',
    detectBrowserLanguage: false,
    bundle: { optimizeTranslationDirective: false },
    locales: config.i18n.locales.map(l => ({
      code: l.code,
      name: l.name,
      file: `${l.code}.ts`,
    })),
  },
})
