/**
 * dev 守卫包装:nuxt dev 的 CLI 父进程(Vite HMR WS 所在)与 nitro worker 都可能被
 * 审计浏览器频繁开/关触发的陈旧 socket `read ECONNRESET` unhandledRejection 击穿
 * (nuxt CLI 自带的 pretty 处理器会 log 后退出;worker 默认 throw)。
 *
 * 策略:以 `--unhandled-rejections=warn` 重入自身 —— Node 对未处理拒绝只发进程警告,
 * 不派发 unhandledRejection 事件(任何注册处理器都不会触发 exit),nitro fork 的
 * worker 继承 execArgv 同享保护。生产构建为单进程 nitro,由 workshop 插件守卫覆盖。
 */
if (!process.env.__AW_DEV_GUARD) {
  const { spawnSync } = await import('node:child_process')
  const { fileURLToPath } = await import('node:url')
  const r = spawnSync(
    process.execPath,
    ['--unhandled-rejections=warn', ...process.execArgv, fileURLToPath(import.meta.url), ...process.argv.slice(2)],
    { stdio: 'inherit', env: { ...process.env, __AW_DEV_GUARD: '1' } },
  )
  process.exit(r.status ?? 0)
}

console.log('[dev-guard] unhandled-rejections=warn 已启用(dev server 对断连 rejection 免疫)')

// nuxt 包 exports 不暴露 ./bin 子路径 → 用文件 URL 直连磁盘 CLI 入口(等效 `nuxt dev`)
const { pathToFileURL } = await import('node:url')
const { createRequire } = await import('node:module')
const binPath = createRequire(import.meta.url).resolve('nuxt/package.json').replace(/package\.json$/, 'bin/nuxt.mjs')
await import(pathToFileURL(binPath).href)
