// mes-hook 运行时单测:子进程 hook 执行(saveCsv/plot/savePng)+ 超时击杀 + 语法错误诚实失败
// + 产物限额 + requestHook 覆盖 + 图像直存。产物全部落临时目录,测试后清理。
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  configureMesHooks, runMesDataHook, runMesRequestHook, saveMesImageArtifact,
  listMesArtifacts, mesArtifactsRoot, mesDataHookCode, mesRequestHookCode,
} from '../server/services/workshop/mes/mes-hook'

let root: string
before(() => {
  root = mkdtempSync(join(tmpdir(), 'aw-meshook-'))
  configureMesHooks(root)
})
after(() => {
  rmSync(root, { recursive: true, force: true })
})

const DATA = {
  node: { id: 'n1', name: '膜厚质检', lineId: 'L1', unit: 'um' },
  format: 'vector',
  rows: [
    { ts: '2026-10-01T02:00:00Z', values: [50.1, 52.0, 53.2] },
    { ts: '2026-10-01T02:00:02Z', values: [50.4, 52.3, 53.0] },
    { ts: '2026-10-01T02:00:04Z', values: [49.9, 51.8, 53.5] },
  ],
  window: { from: '2026-10-01T02:00:00Z', to: '2026-10-01T02:00:06Z' },
}

test('dataHook 快乐路径:统计+plot+saveCsv,产物落盘且回包带摘要', async () => {
  const code = `function (param, data, ctx) {
  const means = data.rows.map(r => r.values.reduce((a, b) => a + b, 0) / r.values.length)
  ctx.plot({ name: 'trend', title: data.node.name, series: [{ name: 'rowMean', points: means.map((v, i) => [i, v]) }] })
  ctx.saveCsv({ name: 'rows', rows: [['ts', 'mean']].concat(data.rows.map((r, i) => [r.ts, means[i].toFixed(3)])) })
  return { summary: '行数 ' + data.rows.length + ' 均值 ' + means[0].toFixed(2), context: '已绘图并落 CSV', stats: { rows: data.rows.length } }
}`
  const out = await runMesDataHook(code, { lane: 2 }, DATA, { nodeId: 'n1' })
  assert.equal(out.ok, true, out.error)
  assert.match(out.summary ?? '', /行数 3/)
  assert.match(out.context ?? '', /CSV/)
  assert.equal(out.artifacts.length, 2)
  const svg = out.artifacts.find(a => a.mime === 'image/svg+xml')
  assert.ok(svg, 'SVG 产物存在')
  assert.match(readFileSync(svg!.file, 'utf-8'), /<svg[^>]*viewBox="0 0 860 320"/)
  const csv = out.artifacts.find(a => a.mime === 'text/csv')
  assert.match(readFileSync(csv!.file, 'utf-8'), /ts,mean/)
  assert.deepEqual(out.stats, { rows: 3 })
  assert.ok(existsSync(join(root, 'mes-artifacts', 'n1')))
})

test('dataHook:箭头函数/param 透传/ctx.log', async () => {
  const code = `(p, d, ctx) => { ctx.log('lane=' + p.lane); return { summary: 'lane=' + p.lane + ' rows=' + d.rows.length } }`
  const out = await runMesDataHook(code, { lane: 12 }, DATA, { nodeId: 'n1' })
  assert.equal(out.ok, true, out.error)
  assert.match(out.summary ?? '', /lane=12/)
  assert.match(out.logs.join(' '), /lane=12/)
})

test('dataHook 语法错误 → 诚实失败(不抛,ok=false)', async () => {
  const out = await runMesDataHook('function (p,d,c) { return { summary: p }', {}, DATA, { nodeId: 'n1' })
  assert.equal(out.ok, false)
  assert.match(out.error ?? '', /语法|Unexpected|failed|错误|结果/)
})

test('dataHook 死循环 → 4s 超时击杀(ok=false,主进程不受影响)', async () => {
  const t0 = Date.now()
  const out = await runMesDataHook('(p, d, c) => { while (true) {} }', {}, DATA, { nodeId: 'n1' })
  const wall = Date.now() - t0
  assert.equal(out.ok, false)
  assert.match(out.error ?? '', /超时|终止/)
  assert.ok(wall < 10_000, `wall ${wall}ms 应在超时+余量内`)
})

test('dataHook 抛错 → ok=false 且消息透传', async () => {
  const out = await runMesDataHook('(p, d, c) => { throw new Error("boom-业务错误") }', {}, DATA, { nodeId: 'n1' })
  assert.equal(out.ok, false)
  assert.match(out.error ?? '', /boom/)
})

test('dataHook 图像帧:savePng 落盘(base64 数据 URI 前缀剥离)', async () => {
  const pngB64 = Buffer.from('PNGDATA-not-a-real-png').toString('base64')
  const code = `(p, d, c) => { c.savePng({ name: 'frame0', base64: 'data:image/png;base64,' + d.rows[0].data }); return { summary: 'saved' } }`
  const out = await runMesDataHook(code, {}, { ...DATA, format: 'image', rows: [{ ts: 't', data: pngB64, mime: 'image/png' }] }, { nodeId: 'cam1' })
  assert.equal(out.ok, true, out.error)
  assert.equal(out.artifacts.filter(a => a.mime === 'image/png').length, 1)
})

test('saveMesImageArtifact 直存 + listMesArtifacts 清单', async () => {
  const b64 = Buffer.from('hello-image').toString('base64')
  const a = saveMesImageArtifact('cam1', 'frame-0001', b64, 'image/png')
  assert.ok(a)
  assert.ok(existsSync(a!.file))
  const list = listMesArtifacts('cam1', 10)
  assert.ok(list.some(x => x.name === a!.name))
  assert.equal(listMesArtifacts('no-such-node', 10).length, 0)
})

test('requestHook:query 覆盖返回;非函数代码诚实失败', async () => {
  const o = await runMesRequestHook('(param, ctx) => ({ query: { from: param.from, lane: String(param.lane) }, path: "/api/v2/thickness" })', { from: '2026-10-01', lane: 3 }, { nodeId: 'n1' })
  assert.deepEqual(o.query, { from: '2026-10-01', lane: '3' })
  assert.equal(o.path, '/api/v2/thickness')
  await assert.rejects(() => runMesRequestHook('42', {}, { nodeId: 'n1' }), /函数|function/)
})

test('mesDataHookCode/Request:空配置 null,超长 400', () => {
  assert.equal(mesDataHookCode({}), null)
  assert.equal(mesRequestHookCode({ dataHook: '' }), null)
  assert.throws(() => mesDataHookCode({ dataHook: 'x'.repeat(40 * 1024) }), /过长/)
})

test('hook 返回非对象 → context 兜底说明,ok=true', async () => {
  const out = await runMesDataHook('(p, d, c) => 42', {}, DATA, { nodeId: 'n1' })
  assert.equal(out.ok, true)
  assert.match(out.context ?? '', /非对象/)
})

test('worker 产物限额:超过 20 文件被拒并诚实失败', async () => {
  const code = `(p, d, c) => { for (let i = 0; i < 25; i++) c.saveText({ name: 'f' + i, text: 'x' }); return { summary: 'done' } }`
  const out = await runMesDataHook(code, {}, DATA, { nodeId: 'limit1' })
  assert.equal(out.ok, false)
  assert.match(out.error ?? '', /数量超限/)
})

test('mesArtifactsRoot 指向配置根', () => {
  assert.equal(mesArtifactsRoot(), join(root, 'mes-artifacts'))
  assert.ok(readdirSync(mesArtifactsRoot()).length >= 0)
})
