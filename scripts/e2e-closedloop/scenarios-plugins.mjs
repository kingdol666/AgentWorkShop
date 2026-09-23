/**
 * s10 插件 / s11 数据根
 * (由 scripts/e2e-full-closedloop.mjs 按职责拆出;内容逐行原文搬运)
 */
import { TAG, ctx } from './state.mjs'
import { api, manifestPlugins, ok, section, waitUntil } from './lib.mjs'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// ════════════════════════════════════════════════════════════════
// S10 插件系统
// ════════════════════════════════════════════════════════════════
export async function s10_plugins() {
  section('S10 插件系统(装载/路由/client/停用/热重载)')
  const configRoot = process.env.AW_E2E_CONFIG_ROOT
  if (!configRoot) {
    console.log('    · 未提供 AW_E2E_CONFIG_ROOT,跳过插件文件级断言(仅做清单一致性检查)')
  }

  const m0 = await api('GET', '/api/workshop/plugins', { token: ctx.token })
  ok(m0.status === 200, 'GET /api/workshop/plugins 可读')
  const list0 = manifestPlugins(m0)
  ok(Array.isArray(list0), `插件清单为数组(${list0.length} 个)`)

  if (configRoot) {
    const plugDir = join(configRoot, 'plugins')
    const name = `e2e-plug-${TAG}`
    const dir = join(plugDir, name)
    mkdirSync(dir, { recursive: true })

    // 1) setup 必抛错的插件 → 必须"完全无痕"(P0-1 回归)
    const badName = `e2e-bad-${TAG}`
    const badDir = join(plugDir, badName)
    mkdirSync(badDir, { recursive: true })
    writeFileSync(join(badDir, 'index.mjs'), `export default {
  name: ${JSON.stringify(badName)},
  setup(ctx) {
    ctx.route('GET', '/ghost', () => ({ ghost: true }))
    throw new Error('e2e intentional setup failure')
  },
}
`, 'utf8')

    // 2) 正常插件:路由 + client + i18n + 设置声明
    //    client 必须**在 manifest 里显式声明**(契约:client?: './client.mjs');
    //    只把 client.mjs 放进目录不会被识别 —— 扫描器读的是 manifest 字段而非文件存在性。
    writeFileSync(join(dir, 'index.mjs'), `export default {
  name: ${JSON.stringify(name)},
  version: '1.2.3',
  description: 'e2e plugin',
  client: './client.mjs',
  settings: [{ key: 'threshold', type: 'number', default: 42, label: 'E2E 阈值' }],
  setup(ctx) {
    ctx.kv.set('setupCalls', (Number(ctx.kv.get('setupCalls')) || 0) + 1)
    ctx.route('GET', '/ping', () => ({ pong: true, tag: ${JSON.stringify(TAG)} }))
    ctx.route('POST', '/echo', (req) => ({ echoed: req?.body ?? null }))
    ctx.onDispose(() => { ctx.kv.set('disposedAt', new Date().toISOString()) })
  },
}
`, 'utf8')
    writeFileSync(join(dir, 'client.mjs'), `export default { name: ${JSON.stringify(name)}, setup() {} }\n`, 'utf8')
    writeFileSync(join(dir, 'i18n.json'), JSON.stringify({ 'zh-CN': { hello: '你好' }, 'en': { hello: 'hi' } }), 'utf8')

    // 触发重载:写状态文件(与 CLI/Web 同路径)
    const statePath = join(configRoot, 'plugins-state.json')

    let loaded = await waitUntil('插件装载', async () => {
      const m = await api('GET', '/api/workshop/plugins', { token: ctx.token })
      const l = manifestPlugins(m)
      return l.find(p => p.name === name) ?? null
    }, 40_000, 1500)

    if (!loaded) {
      // 某些部署下 state 文件不存在 → 主动写一次空 disabled 集合触发 watcher
      writeFileSync(statePath, JSON.stringify({ version: 1, updatedAt: new Date().toISOString(), disabled: [] }), 'utf8')
      loaded = await waitUntil('插件装载(写入状态文件后)', async () => {
        const m = await api('GET', '/api/workshop/plugins', { token: ctx.token })
        const l = manifestPlugins(m)
        return l.find(p => p.name === name) ?? null
      }, 40_000, 1500)
    }
    ok(Boolean(loaded), '项目作用域插件被装载', JSON.stringify(loaded ?? {}).slice(0, 120))
    if (loaded) {
      ok(loaded.version === '1.2.3', '插件版本透传', loaded.version)
      ok(loaded.enabled !== false, '插件默认启用')
      ok(loaded.hasClient === true, 'client 脚本被识别')
      ok(loaded.hasI18n === true, 'i18n 包被识别')
      ok(loaded.settingsCount === 1, '设置声明被识别', String(loaded.settingsCount))
      ok(Array.isArray(loaded.routes) && loaded.routes.some(r => r.path === '/ping'), '路由已登记', JSON.stringify(loaded.routes))
    }

    // 路由真的可命中
    const ping = await api('GET', `/api/plugins/${name}/ping`, { token: ctx.token })
    ok(ping.status === 200 && (ping.data?.pong === true || ping.pong === true), '插件路由可命中', JSON.stringify(ping.data ?? ping).slice(0, 100))

    // client 脚本可读
    const client = await api('GET', `/api/plugins/client/${name}`, { token: ctx.token, raw: true })
    ok(client.status === 200, '插件 client 脚本可读', `status=${client.status}`)
    ok(/setup/.test(await client.text().catch(() => '')), 'client 脚本内容正确')

    // i18n 包
    const i18n = await api('GET', '/api/plugins/i18n', { token: ctx.token })
    ok(i18n.status === 200 || i18n.status === 404, 'i18n 端点存在或明确不存在')

    // 幽灵路由回归:setup 失败的插件不得留下可命中的路由(P0-1)
    const ghost = await api('GET', `/api/plugins/${badName}/ghost`, { token: ctx.token })
    ok(ghost.status === 404, 'setup 抛错的插件不留幽灵路由(P0-1)', `status=${ghost.status}`)
    const m2 = await api('GET', '/api/workshop/plugins', { token: ctx.token })
    const list2 = manifestPlugins(m2)
    ok(!list2.some(p => p.name === badName), 'setup 抛错的插件不进清单(P0-1)')

    // 停用 → 路由必须失效
    const dis = await api('POST', `/api/workshop/plugins/${name}/disable`, { body: {}, token: ctx.token })
    ok(dis.status === 200, '停用插件')
    const afterDisable = await waitUntil('停用生效', async () => {
      const m = await api('GET', '/api/workshop/plugins', { token: ctx.token })
      const l = manifestPlugins(m)
      const p = l.find(x => x.name === name)
      return p && p.enabled === false ? p : null
    }, 40_000, 1500)
    ok(Boolean(afterDisable), '停用状态在清单可见(enabled=false)')
    const pingOff = await api('GET', `/api/plugins/${name}/ping`, { token: ctx.token })
    ok(pingOff.status === 404, '停用后路由失效(无幽灵路由)', `status=${pingOff.status}`)

    // 重新启用 → 路由恢复(热重载闭环)
    const en = await api('POST', `/api/workshop/plugins/${name}/enable`, { body: {}, token: ctx.token })
    ok(en.status === 200, '重新启用插件')
    const restored = await waitUntil('热重载恢复', async () => {
      const p = await api('GET', `/api/plugins/${name}/ping`, { token: ctx.token })
      return p.status === 200 ? p : null
    }, 40_000, 1500)
    ok(Boolean(restored), '热重载后路由恢复')

    // 清理
    try {
      rmSync(dir, { recursive: true, force: true })
      rmSync(badDir, { recursive: true, force: true })
    }
    catch { /* 清理失败不影响断言 */ }
  }
}

// ════════════════════════════════════════════════════════════════
// S11 数据根唯一性(P0-B 回归)
// ════════════════════════════════════════════════════════════════
export async function s11_data_root() {
  section('S11 数据根唯一性(P0-B 回归)')
  const configRoot = process.env.AW_E2E_CONFIG_ROOT
  const cwd = process.env.AW_E2E_CWD
  if (!configRoot || !cwd) {
    console.log('    · 未提供 AW_E2E_CONFIG_ROOT / AW_E2E_CWD,跳过')
    return
  }
  const dataDir = join(configRoot, 'data')
  const legacyDir = join(cwd, 'server', 'data')

  // 本次 e2e 已经写入了产线/产品/配方/节点/回退,它们必须落在配置根
  const mustBeInConfigRoot = ['daqs.json', 'dcws.json', 'dcw-lines.json', 'dcw-products.json', 'dcw-recipes.json', 'dcw-rollback.json', 'dcw-writes.json']
  for (const f of mustBeInConfigRoot) {
    ok(existsSync(join(dataDir, f)), `配置根存在 ${f}`)
  }
  if (existsSync(legacyDir)) {
    const legacyFiles = mustBeInConfigRoot.filter(f => existsSync(join(legacyDir, f)))
    ok(legacyFiles.length === 0, 'cwd/server/data 不再被写入(P0-B)', legacyFiles.length ? `仍存在: ${legacyFiles.join(', ')}` : '')
  }
  else {
    ok(true, 'cwd/server/data 不存在(P0-B)')
  }
}
