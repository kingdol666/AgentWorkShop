/**
 * dev 守卫包装:nuxt dev 的 CLI 父进程(Vite HMR WS 所在)没有 nitro 插件里
 * 的 unhandledRejection 兜底 —— 审计浏览器频繁开/关会触发陈旧 socket 的
 * read ECONNRESET rejection 直接击穿父进程(dev server 整体退出)。
 * 此处在加载 nuxt CLI 前注册兜底:记录并继续运行,与 worker 侧策略一致。
 * (生产构建为单进程 nitro,由 server/plugins/workshop.ts 的守卫覆盖,不经此路径。)
 */
process.on('unhandledRejection', (reason) => {
  console.error('[dev-guard] 未处理 Promise rejection(已兜底,dev server 继续运行):', reason)
})
process.on('uncaughtException', (err) => {
  console.error('[dev-guard] 未捕获异常(已兜底,dev server 继续运行):', err)
})

// nuxt 包 exports 不暴露 ./bin 子路径 → 用文件 URL 直连磁盘 CLI 入口(等效 `nuxt dev`)
const { pathToFileURL } = await import('node:url')
const { createRequire } = await import('node:module')
const binPath = createRequire(import.meta.url).resolve('nuxt/package.json').replace(/package\.json$/, 'bin/nuxt.mjs')
await import(pathToFileURL(binPath).href)
