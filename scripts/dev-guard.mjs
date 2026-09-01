/**
 * dev 守卫包装:nuxt dev 的 CLI 父进程(Vite HMR WS 所在)与 nitro worker 都可能被
 * 审计浏览器频繁开/关触发的陈旧 socket `read ECONNRESET` unhandledRejection 击穿
 * (nuxt CLI 自带的 pretty 处理器会 log 后退出;worker 默认 throw)。
 *
 * 策略:以 `--unhandled-rejections=warn` 重入自身 —— Node 对未处理拒绝只发进程警告,
 * 不派发 unhandledRejection 事件(任何注册处理器都不会触发 exit),nitro fork 的
 * worker 继承 execArgv 同享保护。生产构建为单进程 nitro,由 workshop 插件守卫覆盖。
 *
 * 配置驱动:开发端口取自共享配置引擎 ——
 *   config.yml 默认 < data/runtime-settings.json 运行时覆盖 < 环境变量 < CLI 显式参数
 * 生效优先级:显式 --port/--host > AW_/PORT 环境 > runtime-settings.json > config.yml。
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
  throw new Error('unreachable')
}

console.log('[dev-guard] unhandled-rejections=warn 已启用(dev server 对断连 rejection 免疫)')

const { existsSync, readFileSync } = await import('node:fs')
const { dirname, resolve } = await import('node:path')
const { fileURLToPath: u2f } = await import('node:url')

const root = resolve(dirname(u2f(import.meta.url)), '..')

// --- 预载 .env（与 start.mjs 同策略；已导出环境变量优先） ---
const envPath = new URL('../.env', import.meta.url)
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/)
    if (!m || line.trim().startsWith('#')) continue
    if (process.env[m[1]] === undefined) process.env[m[1]] = m[2]
  }
}

// --- 共享配置引擎：计算有效开发端口/主机 ---
const { loadEffective } = await import('../shared/config/engine.mjs')
const eff = loadEffective({
  configPath: resolve(root, 'config.yml'),
  settingsPath: resolve(root, 'data', 'runtime-settings.json'),
  env: process.env,
  mode: 'dev',
})

// CLI 显式参数（pnpm dev -- --port 8080）优先，直接透传
const rest = process.argv.slice(2) // ['dev', ...]
const hasPort = rest.includes('--port') || rest.some(a => a.startsWith('--port='))
const hasHost = rest.includes('--host') || rest.some(a => a.startsWith('--host='))

const devPort = Number(eff.effective['server.dev.port']) || 3000
const devHost = String(eff.effective['server.host'] ?? '0.0.0.0')
const portSource = eff.sources['server.dev.port']
console.log(`[config] 开发端口 -> ${devPort} (source: ${portSource}${hasPort ? ', CLI 显式覆盖生效' : ''})`)

const inject = [...rest]
if (!hasPort) inject.push('--port', String(devPort))
if (!hasHost) inject.push('--host', devHost)

// 把注入参数写入 process.argv（nuxt CLI 启动时读取 slice(2)），保证生效且不影响透传
process.argv.push(...(inject.length > rest.length ? inject.slice(rest.length) : []))

// nuxt 包 exports 不暴露 ./bin 子路径 → 用文件 URL 直连磁盘 CLI 入口(等效 `nuxt dev`)
const { pathToFileURL } = await import('node:url')
const { createRequire } = await import('node:module')
const binPath = createRequire(import.meta.url).resolve('nuxt/package.json').replace(/package\.json$/, 'bin/nuxt.mjs')
await import(pathToFileURL(binPath).href)
