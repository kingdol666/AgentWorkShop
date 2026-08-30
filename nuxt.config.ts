import { readFileSync, writeFileSync, cpSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
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
      link: [
        { rel: 'icon', type: 'image/svg+xml', href: '/favicon.svg' },
      ],
    },
  },

  css: [
    '~/assets/css/main.css',
    // warm-editorial 设计系统字体:Geist 正文 + EB Garamond 衬线 display + 等宽数据字体(全部本地打包,离线可用)
    // Geist 替换 Inter(design-taste 规范:技术 UI 用高辨识 sans,禁用 Inter)
    '@fontsource-variable/geist',
    '@fontsource-variable/geist-mono',
    '@fontsource/eb-garamond/400.css',
    '@fontsource/eb-garamond/400-italic.css',
    '@fontsource/ibm-plex-mono/400.css',
    '@fontsource/ibm-plex-mono/500.css',
    '@fontsource/ibm-plex-mono/600.css',
    // harness 终端(/monitor)xterm 渲染样式(组件内动态加载 xterm,样式全局注入)
    '@xterm/xterm/css/xterm.css',
  ],

  // 配置驱动注入：app 运行时通过 useRuntimeConfig().public 读取，无需在运行时读 fs
  runtimeConfig: {
    // 服务端专用配置（仅 Nitro 可见，与前端同源于 config.yml -> api）
    apiPageSize: config.api.pageSize,
    apiMaxPageSize: config.api.maxPageSize,
    // nuxt-auth-utils session 加密密钥（config.yml -> security）
    session: {
      password: config.security.sessionPassword,
    },
    // 数采基础设施(config.yml -> daq;服务端启动插件消费)
    daq: config.daq,
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

  // 路径别名:@ → 项目根目录(server/api 等深路径代码免算相对层数;
  // 覆盖 Nuxt 默认 @ → srcDir(app/) 的指向,仓库现有代码无 @/ 引用,切换安全)
  alias: {
    '@': fileURLToPath(new URL('.', import.meta.url)),
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
    // 原生/重型服务端依赖外置(不参与 bundle,运行期 require 解析):
    // pg/mqtt/modbus-serial/node-opcua 被 bundle 后,Windows 下动态 import 会变成
    // 绝对盘符路径('d:\...')→ ESM loader 报 "protocol 'd:'";外置后由 Node 原生加载。
    externals: {
      external: ['pg', 'mqtt', 'modbus-serial', 'node-opcua', '@serialport/bindings-cpp'],
    },
    // 服务器侧 rollup 构建:显式外置 node:* 内建模块(如 node:sqlite)。
    // rollup 的内建模块清单不含 node:sqlite,Nitro 的 externals 插件也放行,
    // 否则每次 dev 热构建都报 UNRESOLVED_IMPORT“treated as external”告警;
    // 这里抢先从插件层标记 external,运行期仍由 Node 原生解析,语义不变。
    rollupConfig: {
      plugins: [
        {
          name: 'node-builtins-external',
          resolveId(id) {
            if (id.startsWith('node:')) return { id, external: true }
          },
        },
      ],
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
        // 外置 prompt 目录随产物分发(.AgentWorkShop/prompts → .output/.AgentWorkShop/prompts;
        // 加载器优先解析 cwd 相对路径,生产脚本从项目根启动时双保险)
        try {
          const promptsSrc = join(process.cwd(), '.AgentWorkShop', 'prompts')
          const promptsOut = join(process.cwd(), '.output', '.AgentWorkShop', 'prompts')
          cpSync(promptsSrc, promptsOut, { recursive: true })
          console.log('[build] prompts copied →', promptsOut)
        }
        catch (err) {
          console.error('[build] prompts copy failed:', err)
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
