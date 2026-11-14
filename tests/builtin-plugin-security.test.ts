/**
 * 内置插件安全收敛回归(2026-11-14 P1):
 *  ① serial-bridge /probe 仅管理员可用,sendLine 任意下发彻底移除(后端+面板+i18n);
 *  ② diag-bridge /snapshot 按用户×产线授权收敛,/runs、/report 按产线可见面过滤;
 *  ③ diag-bridge 导出数据集:路径包含、符号链接拒绝、manifest sha256 复核。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, symlinkSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'

const repoRoot = process.cwd()

// ---------- ① serial-bridge:probe 管理员闸 + sendLine 移除 ----------

test('serial-bridge /probe 对非管理员拒绝且不触达串口', async () => {
  const plugin = (await import('../server/plugins-builtin/serial-bridge/index.mjs')).default
  const routes = new Map()
  const ctx = {
    name: 'serial-bridge',
    logger: { warn() {}, info() {}, error() {} },
    route: (method, path, handler) => routes.set(`${method} ${path}`, handler),
    daq: { nodes: async () => [], registerDriver() {} },
    onDispose: () => () => {},
    omp: { registerTool() {} },
    dcw: { registerWriteDriver() {} },
  }
  await plugin.setup(ctx)
  const probe = routes.get('POST /probe')
  assert.ok(probe, 'probe 路由已注册')
  const denied = await probe({ awUser: { id: 'u1', role: 'user', name: 'u' }, awBody: { path: 'COM3', mode: 'modbus-rtu' } })
  assert.equal(denied.success, false)
  assert.match(String(denied.error), /FORBIDDEN_ADMIN/)
  // 未带用户(理论上转发层已拦,双保险)同样拒绝
  const anon = await probe({ awBody: { path: 'COM3' } })
  assert.equal(anon.success, false)
  assert.match(String(anon.error), /FORBIDDEN_ADMIN/)
})

test('serial-bridge sendLine 任意下发已从插件目录彻底移除(后端/面板/i18n)', () => {
  for (const file of ['index.mjs', 'client.mjs', 'drivers.mjs', 'i18n.json', 'lib.mjs', 'rtu.mjs']) {
    const src = readFileSync(join(repoRoot, 'server/plugins-builtin/serial-bridge', file), 'utf8')
    assert.equal(src.includes('sendLine'), false, `${file} 不应再包含 sendLine(任意设备下发面已移除)`)
  }
  const i18n = JSON.parse(readFileSync(join(repoRoot, 'server/plugins-builtin/serial-bridge/i18n.json'), 'utf8'))
  for (const locale of Object.keys(i18n)) assert.equal(i18n[locale]?.panel?.sendLine, undefined)
})

test('serial-bridge /probe 管理员可用并进入参数校验(串口包缺失时如实报不可用)', async () => {
  const plugin = (await import('../server/plugins-builtin/serial-bridge/index.mjs')).default
  const routes = new Map()
  const ctx = {
    name: 'serial-bridge',
    logger: { warn() {}, info() {}, error() {} },
    route: (method, path, handler) => routes.set(`${method} ${path}`, handler),
    daq: { nodes: async () => [], registerDriver() {} },
    onDispose: () => () => {},
    omp: { registerTool() {} },
    dcw: { registerWriteDriver() {} },
  }
  await plugin.setup(ctx)
  const probe = routes.get('POST /probe')
  const r = await probe({ awUser: { id: 'admin', role: 'admin', name: 'a' }, awBody: { path: 'COM3', mode: 'modbus-rtu', baudRate: 9600 } })
  // 无串口硬件/包时到达驱动层如实失败,但绝不再是 FORBIDDEN_ADMIN(闸门已过)
  assert.ok(!/FORBIDDEN_ADMIN/.test(String(r.error ?? r.message ?? '')))
})

// ---------- ② diag-bridge:snapshot/runs/report 产线授权 ----------

function makeDiagCtx(kvStore = {}, grants = new Map()) {
  const routes = new Map()
  const ctx = {
    name: 'diag-bridge',
    logger: { warn() {}, info() {}, error() {} },
    // diag setup 需要的最小宿主面:config 扩展 / hooks / http / timer / services
    config: { defineGroup() {}, defineField() {}, get: () => undefined },
    hooks: { on() {} },
    http: { get: async () => ({ data: null }) },
    timer: { setInterval: () => ({ cleared: false }), clearInterval: () => {} },
    services: { get: async () => { throw new Error('service unavailable in test') } },
    omp: { registerTool() {} },
    kv: {
      get: k => kvStore[k],
      set: (k, v) => { kvStore[k] = v },
      all: () => ({ ...kvStore }),
    },
    permissions: {
      lineMode: (user, lineId) => grants.get(`${user.id}:${lineId}`) ?? (user.role === 'admin' ? 'operate' : 'none'),
      visibleLineIds: user => user.role === 'admin' ? null : new Set([...grants.keys()].filter(k => k.startsWith(`${user.id}:`)).map(k => k.split(':')[1])),
    },
    daq: { nodes: async () => [], registerDriver() {} },
    onDispose: () => () => {},
    route: (method, path, handler) => routes.set(`${method} ${path}`, handler),
  }
  return { ctx, routes }
}

test('diag-bridge /snapshot 无产线权限拒绝,只读授权放行(闸门语义)', async () => {
  const plugin = (await import('../server/plugins-builtin/diag-bridge/host/index.mjs')).default
  const { ctx, routes } = makeDiagCtx({}, new Map([['u1:ln-1', 'readonly']]))
  await plugin.setup(ctx)
  const snapshot = routes.get('POST /snapshot')
  assert.ok(snapshot, 'snapshot 路由已注册')
  const denied = await snapshot({ awUser: { id: 'u1', role: 'user', name: 'u' }, awBody: { line: 'ln-other' } })
  assert.equal(denied.success, false)
  assert.match(String(denied.error), /FORBIDDEN_LINE/)
  // 只读授权 → 通过闸门,到达数据层(空产线如实报无数采节点,而不是权限错误)
  const allowed = await snapshot({ awUser: { id: 'u1', role: 'user', name: 'u' }, awBody: { line: 'ln-1' } })
  assert.equal(allowed.success, false)
  assert.ok(!/FORBIDDEN_LINE/.test(String(allowed.error)))
})

test('diag-bridge /runs 按产线可见面过滤;无产线归属 run 仅管理员可见', async () => {
  const plugin = (await import('../server/plugins-builtin/diag-bridge/host/index.mjs')).default
  const kv = {
    'run:run-a': { line: 'ln-1', status: 'completed', createdAt: 3 },
    'run:run-b': { line: 'ln-secret', status: 'completed', createdAt: 2 },
    'run:run-c': { status: 'completed', createdAt: 1 },
  }
  const { ctx, routes } = makeDiagCtx(kv, new Map([['u1:ln-1', 'readonly']]))
  await plugin.setup(ctx)
  const runs = routes.get('GET /runs')
  const r = await runs({ awUser: { id: 'u1', role: 'user', name: 'u' } })
  assert.equal(r.success, true)
  const ids = (r.runs ?? []).map(x => x.runId)
  assert.deepEqual(ids, ['run-a'], '仅可见产线的 run 返回;无产线归属的 run 对非管理员隐藏')
  const adminView = await runs({ awUser: { id: 'a', role: 'admin', name: 'a' } })
  assert.equal((adminView.runs ?? []).length, 3, '管理员可见全部')
})

test('diag-bridge /report 非管理员读取他线/无产线归属 run 被拒', async () => {
  const plugin = (await import('../server/plugins-builtin/diag-bridge/host/index.mjs')).default
  const kv = { 'run:run-x': { line: '', status: 'completed' } }
  const { ctx, routes } = makeDiagCtx(kv, new Map())
  await plugin.setup(ctx)
  const report = routes.get('GET /report')
  const denied = await report({ awUser: { id: 'u1', role: 'user', name: 'u' }, path: '/report?run_id=run-x', node: { req: { url: '/report?run_id=run-x' } } })
  assert.equal(denied.success, false)
  assert.match(String(denied.error), /FORBIDDEN_LINE/)
})

// ---------- ③ 导出数据集完整性:包含/符号链接/sha256 ----------

function writeExportFixture(dir: string, manifest: Record<string, unknown>, nodeBody = 'ts_iso,ts_ms,value,state\n', nodeFile = 'nodes/n-1.csv') {
  mkdirSync(join(dir, 'nodes'), { recursive: true })
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8')
  writeFileSync(join(dir, nodeFile), nodeBody, 'utf8')
}

test('readExportDataset:路径穿越拒绝 + sha256 复核(篡改即拒)+ 符号链接拒绝', async () => {
  const home = mkdtempSync(join(tmpdir(), 'aw-exports-sec-'))
  try {
    const root = join(home, 'data', 'daq-exports')
    const ctx = { paths: { dataDir: join(home, 'data') } }
    const { readExportDataset } = await import('../server/plugins-builtin/diag-bridge/host/exports.mjs')

    // 正常数据集(带 sha256)
    const body = 'ts_iso,ts_ms,value,state\n2026-11-14T00:00:00Z,1,42,ok\n'
    const sha = createHash('sha256').update(body, 'utf8').digest('hex')
    writeExportFixture(join(root, 'exp-ok'), { schema: 'aw.daq-export/1', nodes: [{ id: 'n-1', file: 'nodes/n-1.csv', sha256: sha }] }, body)
    const ok = await readExportDataset(ctx, 'exp-ok')
    assert.equal(ok.ok, true)
    assert.equal(ok.verifiedHashes, 1)
    assert.equal(ok.hashExpected, 1)

    // 篡改 → sha256 不匹配拒绝
    writeFileSync(join(root, 'exp-ok', 'nodes', 'n-1.csv'), `${body}tampered\n`, 'utf8')
    const tampered = await readExportDataset(ctx, 'exp-ok')
    assert.equal(tampered.ok, false)
    assert.match(String(tampered.error), /完整性校验失败/)

    // 路径穿越 → 拒绝
    const outside = join(home, 'data', 'secret.csv')
    writeFileSync(outside, 'secret', 'utf8')
    writeExportFixture(join(root, 'exp-trav'), { nodes: [{ id: 'n-1', file: '../../secret.csv' }] }, 'x', 'nodes/n-1.csv')
    const trav = await readExportDataset(ctx, 'exp-trav')
    assert.equal(trav.ok, false)
    assert.match(String(trav.error), /越界|路径穿越/)

    // 符号链接 → 拒绝(Windows 无特权可能创建失败:创建失败则跳过该子断言)
    const linkDir = join(root, 'exp-link')
    writeExportFixture(linkDir, { nodes: [{ id: 'n-1', file: 'nodes/n-1.csv' }] }, 'x', 'nodes/n-1.csv')
    try {
      symlinkSync(outside, join(linkDir, 'nodes', 'link.csv'), 'file')
      const linkManifest = JSON.parse(readFileSync(join(linkDir, 'manifest.json'), 'utf8'))
      linkManifest.nodes[0].file = 'nodes/link.csv'
      writeFileSync(join(linkDir, 'manifest.json'), JSON.stringify(linkManifest), 'utf8')
      const link = await readExportDataset(ctx, 'exp-link')
      assert.equal(link.ok, false)
      assert.match(String(link.error), /符号链接拒绝|不是常规文件/)
    }
    catch { /* 无符号链接特权:跳过 */ }

    // 旧 manifest(无 sha256)仍可读:包含/常规文件校验生效,哈希复核按声明跳过
    writeExportFixture(join(root, 'exp-legacy'), { schema: 'aw.daq-export/1', nodes: [{ id: 'n-1', file: 'nodes/n-1.csv' }] }, 'legacy\n')
    const legacy = await readExportDataset(ctx, 'exp-legacy')
    assert.equal(legacy.ok, true)
    assert.equal(legacy.verifiedHashes, 0)
    assert.equal(legacy.hashExpected, 0)
  }
  finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('daq-export 导出的 manifest 节点携带 sha256(标量 CSV 写入即算)', async () => {
  const src = readFileSync(join(repoRoot, 'server/services/workshop/agents/industrial/daq-export.ts'), 'utf8')
  assert.match(src, /createHash\('sha256'\)/)
  assert.match(src, /sha256: fileHash\.digest\('hex'\)/)
})
