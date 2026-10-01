// diag-bridge v2.2 单测(不依赖真实 IDD/平台实例):
// ① export 数据集上传(多文件 batch、manifest 首位、按名映射、token 头);
// ② diag_run sync 模式(轮询到完成、认领回执、报告路径与 kb_agent 指引);
// ③ sweep 完成回执(deliver 带 agentId/channelId —— Channel 接收链);
// ④ /report 路由(任务 → workspace run 目录 → report 内容代理)。
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { uploadExportDataset } from '../server/plugins-builtin/diag-bridge/host/exports.mjs'
import { sweepOnce } from '../server/plugins-builtin/diag-bridge/host/sweep.mjs'
import pluginDef from '../server/plugins-builtin/diag-bridge/host/plugin.mjs'

type ToolHandler = (args: Record<string, unknown>, agent?: unknown) => Promise<{ text: string, isError?: boolean }>
type PluginCtx = {
  config: { get: (k: string) => string }
  kv: { get: (k: string) => unknown, set: (k: string, v: unknown) => void, all: () => Record<string, unknown> }
  paths: { dataDir: string, home: string, configRoot: string }
  http: { get: (url: string, opts?: unknown) => Promise<Response>, post: (url: string, body: unknown, opts?: unknown) => Promise<Response> }
  services: { get: (name: string) => Promise<unknown> }
  logger: Record<string, (...a: unknown[]) => void>
  timer: { setInterval: () => void }
  hooks: { on: () => () => void }
  route: (m: string, p: string, h: (event?: unknown) => Promise<unknown>) => void
  omp: { registerTool: (t: { name: string, handler: ToolHandler }) => void }
}

let server: Server
let base = '' // http://127.0.0.1:<随机端口>
let dataRoot = ''
const uploaded: Array<{ folder: string, names: string[], auth: string }> = []
// IDD 桩状态:tasks POST 计数 / status 脚本(队列弹出)/ report 正文
let taskSeq = 0
let statusScript: Array<Record<string, unknown>> = []
let workspaceList: Array<{ name: string }> = []
let reportContent = ''
let reportHits = 0

function json(res: ServerResponse, body: unknown): void {
  res.setHeader('content-type', 'application/json')
  res.end(JSON.stringify(body))
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    req.on('data', c => chunks.push(c as Buffer))
    req.on('end', () => resolve(Buffer.concat(chunks)))
  })
}

/** 从 multipart body 里粗提 folder 字段与文件名(仅测试桩用) */
function parseMultipart(buf: Buffer): { fields: Record<string, string>, files: string[] } {
  const text = buf.toString('latin1')
  const fields: Record<string, string> = {}
  const files = [...text.matchAll(/filename="([^"]+)"/g)].map(m => m[1]!)
  const folderIdx = text.indexOf('name="folder"')
  if (folderIdx >= 0) {
    const val = text.slice(folderIdx).match(/\r\n\r\n([^\r\n]+)/)
    if (val) fields.folder = val[1]!
  }
  return { fields, files }
}

before(async () => {
  dataRoot = mkdtempSync(join(tmpdir(), 'aw-diagbr-'))
  server = createServer(async (req, res) => {
    const url = req.url ?? ''
    const auth = String(req.headers.authorization ?? '')
    if (url === '/api/files/data/upload' && req.method === 'POST') {
      const body = await readBody(req)
      const { fields, files } = parseMultipart(body)
      uploaded.push({ folder: fields.folder ?? '', names: files, auth })
      json(res, { success: true, data: files.map(name => ({ name, size: 1, path: `data/${fields.folder}/${name}` })) })
      return
    }
    if (url === '/api/diagnosis/tasks' && req.method === 'POST') {
      await readBody(req)
      taskSeq++
      json(res, { success: true, data: { task_id: `tid${taskSeq}`, name: `scene_tid${taskSeq}`, status: 'running' } })
      return
    }
    if (url.startsWith('/api/diagnosis/tasks/') && req.method === 'GET') {
      json(res, { success: true, data: statusScript.shift() ?? { status: 'running' } })
      return
    }
    if (url.startsWith('/api/diagnosis/status/') && req.method === 'GET') {
      json(res, { success: true, data: statusScript.shift() ?? { status: 'running' } })
      return
    }
    if (url === '/api/files/workspace' && req.method === 'GET') {
      json(res, { success: true, data: workspaceList })
      return
    }
    if (url.startsWith('/api/files/workspace/report/') && req.method === 'GET') {
      reportHits++
      json(res, { success: true, data: { name: decodeURIComponent(url.split('/report/')[1] ?? ''), content: reportContent } })
      return
    }
    json(res, { success: false, error: `stub 404 ${url}` })
  })
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve())
  })
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

after(() => {
  server.close()
  rmSync(dataRoot, { recursive: true, force: true })
})

/** 造一份 daq-export 数据集到 dataRoot */
function makeDataset(id: string, nodes: string[]): string {
  const dir = join(dataRoot, 'daq-exports', id)
  mkdirSync(join(dir, 'nodes'), { recursive: true })
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({
    schema: 'aw.daq-export/1',
    export_id: id,
    note: '温度越限场景',
    window: { from_ms: 1, to_ms: 2, from: 'a', to: 'b' },
    lines: [{ lineId: 'line-a', lineName: '示范产线' }],
    nodes: nodes.map(n => ({ id: n, file: `nodes/${n}.csv` })),
    totals: { files: nodes.length, rows: 6 },
  }))
  for (const n of nodes) writeFileSync(join(dir, 'nodes', `${n}.csv`), 'ts_iso,ts_ms,value,state\r\n')
  return dir
}

/** diag-bridge 插件宿主 fake ctx(config/kv/http/services/omp/route/timer/hooks/logger) */
function makeCtx() {
  const tools: Record<string, { handler: ToolHandler }> = {}
  const routes: Record<string, (event?: unknown) => Promise<unknown>> = {}
  const kvStore = new Map<string, unknown>()
  const delivered: Array<Record<string, unknown>> = []
  const claimed: Array<[string, string]> = []
  const ctx: PluginCtx & Record<string, unknown> = {
    name: 'diag-bridge',
    config: {
      get: (k: string) => (k === 'plugins.diag-bridge.base_url' ? base : k === 'plugins.diag-bridge.token' ? 'stub-token' : ''),
      defineGroup: () => {},
      defineField: () => {},
    },
    kv: {
      get: (k: string) => kvStore.get(k),
      set: (k: string, v: unknown) => kvStore.set(k, v),
      all: () => Object.fromEntries(kvStore),
    },
    paths: { dataDir: dataRoot, home: dataRoot, configRoot: dataRoot },
    http: {
      get: (url: string, opts?: unknown) => fetch(url, opts as never),
      post: (url: string, body: unknown, opts?: unknown) => fetch(url, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' }, ...(opts as never ?? {}) }),
    },
    services: {
      get: async (name: string) => name === 'notify'
        ? {
            deliver: (n: Record<string, unknown>) => { delivered.push(n) },
            claim: (tool: string, jobId: string) => { claimed.push([tool, jobId]) },
          }
        : null,
    },
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    timer: { setInterval: () => {} },
    hooks: { on: () => () => {} },
    route: (_m: string, p: string, h: (event?: unknown) => Promise<unknown>) => { routes[p] = h },
    omp: { registerTool: (t: { name: string, handler: ToolHandler }) => { tools[t.name] = t } },
  }
  ;(pluginDef as unknown as { setup: (ctx: unknown) => void }).setup(ctx)
  return { ctx, tools, routes, kvStore, delivered, claimed }
}

test('uploadExportDataset:manifest 首位 + 节点 CSV 按清单序,带 Bearer,按名映射路径', async () => {
  uploaded.length = 0
  makeDataset('daqexp-t1', ['n2', 'n1'])
  const m = makeCtx()
  const r = await uploadExportDataset(m.ctx as never, 'daqexp-t1') as { ok: boolean, dataPaths: string[], folder: string }
  assert.equal(r.ok, true)
  assert.equal(uploaded.length, 1)
  assert.equal(uploaded[0]!.folder, 'aw-snapshots/exp-daqexp-t1')
  assert.equal(uploaded[0]!.auth, 'Bearer stub-token')
  assert.deepEqual(uploaded[0]!.names, ['manifest.json', 'n2.csv', 'n1.csv'])
  assert.equal(r.dataPaths[0], 'data/aw-snapshots/exp-daqexp-t1/manifest.json')
  assert.deepEqual(r.dataPaths.slice(1), [
    'data/aw-snapshots/exp-daqexp-t1/n2.csv',
    'data/aw-snapshots/exp-daqexp-t1/n1.csv',
  ])
})

test('uploadExportDataset:数据集不存在 → ok:false 且错误带指引', async () => {
  const m = makeCtx()
  const r = await uploadExportDataset(m.ctx as never, 'daqexp-nope') as { ok: boolean, error?: string }
  assert.equal(r.ok, false)
  assert.match(r.error ?? '', /daq_export/)
})

test('diag_run export_id+sync:轮询到完成,认领回执,文本含报告路径与 kb_agent 指引', async () => {
  uploaded.length = 0
  statusScript = []
  makeDataset('daqexp-t2', ['n1'])
  const ctx = makeCtx()
  // 第一次轮询:running;第二次:completed(tasks 与 status 两个桩共用脚本)
  statusScript.push({ status: 'running' })
  statusScript.push({
    status: 'completed',
    result: { score: 96, verdict: 'ENDORSED', summary: '根因为温度传感器漂移', report_md_path: 'D:/idd/workspace/diagnostic-runs/x_tid/report.md' },
  })
  const r = await ctx.tools['diag_run']!.handler({
    export_id: 'daqexp-t2',
    scene: 'unit-sync',
    mode: 'sync',
    sync_timeout_s: 30,
  }, { agentId: 'ag-1', channelId: 'ch-1' })
  assert.equal(r.isError, undefined)
  assert.match(r.text, /同步诊断完成/)
  assert.match(r.text, /task_id=tid/)
  assert.match(r.text, /评分=96/)
  assert.match(r.text, /report_md_path=/)
  assert.match(r.text, /kb_agent/)
  assert.equal(ctx.claimed.length, 1) // 同步拿到结果后认领,防 sweep 补送
  assert.equal(ctx.claimed[0]![0], 'diag_run')
  // kv run 记录带归因(发起 Agent/频道)
  const runEntry = [...ctx.kvStore.entries()].find(([k]) => k.startsWith('run:'))
  assert.ok(runEntry, 'kv 中登记了 run')
  assert.equal((runEntry![1] as Record<string, unknown>).agentId, 'ag-1')
  assert.equal((runEntry![1] as Record<string, unknown>).channelId, 'ch-1')
})

test('sweep:完成时 deliver 回执带 agentId/channelId 与 kb_agent 指引(Channel 接收链)', async () => {
  const m = makeCtx()
  m.kvStore.set('run:sw1', { line: 'line-a', status: 'running', source: 'agent', agentId: 'ag-9', channelId: 'ch-9', createdAt: Date.now(), question: 'q' })
  statusScript = [{ status: 'completed', engineStatus: 'completed', score: 91, judge_verdict: 'ENDORSED', report_path: 'D:/idd/rep.md', name: 'x_sw1' }]
  await sweepOnce(m.ctx as never)
  assert.equal(m.delivered.length, 1)
  const n = m.delivered[0]!
  assert.equal(n.kind, 'tool-result')
  assert.equal(n.tool, 'diag_run')
  assert.equal(n.jobId, 'sw1')
  assert.equal(n.agentId, 'ag-9')
  assert.equal(n.channelId, 'ch-9')
  assert.equal(n.ok, true)
  assert.match(String(n.summary), /report_md_path=D:\/idd\/rep\.md/)
  assert.match(String(n.summary), /kb_agent/)
})

test('/report 路由:任务 completed → workspace 匹配 run → 代理返回报告正文', async () => {
  const ctx = makeCtx()
  workspaceList = [{ name: '20261002_demo_tid42' }]
  reportContent = '# 深度诊断报告\n根因:进料波动'
  statusScript = [{ status: 'completed', result: { score: 88, verdict: 'ENDORSED', report_md_path: 'D:/idd/w/20261002_demo_tid42/report.md' } }]
  const handler = ctx.routes['/report']!
  const out = await handler({ path: `/api/plugins/diag-bridge/report?run_id=tid42` }) as { success: boolean, report?: { content?: string } }
  assert.equal(out.success, true)
  assert.match(out.report?.content ?? '', /根因:进料波动/)
  assert.equal(reportHits, 1)
})
