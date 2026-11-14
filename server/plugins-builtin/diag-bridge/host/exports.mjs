/**
 * 数据集上传(da_pin daq-export 数据集 → IDD 多文件分析)
 *
 * 平台宿主工具 daq_export 把全量时序落盘到 <dataDir>/daq-exports/<exportId>/
 * (manifest.json + nodes/<nodeId>.csv)。本模块负责把整份数据集上传到诊断服务
 * (folder=aw-snapshots/exp-<exportId>),并按 manifest 的节点顺序拼出 dataPaths
 * (manifest 在首位,IDD 诊断 agent 先读映射与上下文,再逐节点读 CSV)。
 */
import { readFile, readdir, lstat } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join, resolve, sep } from 'node:path'
import { authHeadersOf, baseOf, short } from './helpers.mjs'

/** export_id 白名单(路径穿越防护;宿主 daqexp-<ts>-<hex> 格式,兼容旧手填) */
export function validExportId(id) {
  return /^[A-Za-z0-9_-]{4,80}$/.test(String(id ?? '').trim())
}

/** 数据集目录(<dataDir>/daq-exports/<id>;ctx.paths.dataDir 由 SDK 注入) */
export function exportsRootOf(ctx) {
  const dataDir = ctx?.paths?.dataDir
  if (!dataDir) return null
  return join(dataDir, 'daq-exports')
}

/** P1 完整性(2026-11-14):manifest 相对路径必须落在数据集目录内 */
export function containedPathOf(root, rel) {
  const rootAbs = resolve(root)
  const abs = resolve(rootAbs, String(rel ?? ''))
  if (abs !== rootAbs && !abs.startsWith(rootAbs + sep)) return null
  return abs
}

/** sha256(文件内容) */
export function sha256Of(buf) {
  return createHash('sha256').update(buf).digest('hex')
}

/** 读取数据集:{ ok, manifest, files:[{ name, abs }], verifiedHashes, hashExpected };失败 { ok:false, error } */
export async function readExportDataset(ctx, exportId) {
  if (!validExportId(exportId)) return { ok: false, error: `export_id 非法(仅允许字母数字_-):${short(exportId)}` }
  const root = exportsRootOf(ctx)
  if (!root) return { ok: false, error: '平台数据目录未注入(ctx.paths.dataDir 缺失),无法读取 daq-export 数据集。' }
  const dir = containedPathOf(root, String(exportId).trim())
  if (!dir) return { ok: false, error: `export_id 非法(路径越界):${short(exportId)}` }
  let manifest
  try {
    manifest = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8'))
  }
  catch (err) {
    return { ok: false, error: `数据集 ${exportId} 不存在或 manifest.json 不可读(${err?.message ?? err});先用宿主工具 daq_export 导出。` }
  }
  // 收集 CSV:以 manifest.nodes[].file 为准,缺失时回退扫 nodes/ 目录
  let names = (Array.isArray(manifest?.nodes) ? manifest.nodes : [])
    .map(n => String(n?.file ?? '')).filter(Boolean)
  if (names.length === 0) {
    try {
      names = (await readdir(join(dir, 'nodes'))).filter(f => f.endsWith('.csv')).map(f => `nodes/${f}`)
    }
    catch { names = [] }
  }
  // P1 完整性:逐文件 ① 路径必须落在数据集目录内;② 拒绝符号链接/非常规文件;
  // ③ manifest 声明了 sha256 的一律复核(篡改/损坏在读取即拒,不得上传冒充证据)
  const expectedHashes = new Map()
  for (const n of (Array.isArray(manifest?.nodes) ? manifest.nodes : [])) {
    const f = String(n?.file ?? '')
    const h = String(n?.sha256 ?? '')
    if (f && /^[a-f0-9]{64}$/i.test(h)) expectedHashes.set(f.split('/').pop(), h.toLowerCase())
  }
  const files = [{ name: 'manifest.json', abs: join(dir, 'manifest.json') }]
  let verifiedHashes = 0
  for (const rel of names) {
    const abs = containedPathOf(dir, rel)
    if (!abs) return { ok: false, error: `manifest 节点路径越界(路径穿越拒绝):${short(rel)}` }
    const st = await lstat(abs).catch(() => null)
    if (!st) return { ok: false, error: `节点文件缺失:${short(rel)}` }
    if (st.isSymbolicLink() || !st.isFile()) return { ok: false, error: `节点文件不是常规文件(符号链接拒绝):${short(rel)}` }
    const expected = expectedHashes.get(rel.split('/').pop())
    if (expected) {
      const actual = sha256Of(await readFile(abs))
      if (actual !== expected) return { ok: false, error: `节点文件完整性校验失败(sha256 不匹配,疑似篡改/损坏):${short(rel)}` }
      verifiedHashes++
    }
    files.push({ name: rel.split('/').pop(), abs })
  }
  return { ok: true, dir, manifest, files, verifiedHashes, hashExpected: expectedHashes.size }
}

/** 单次 multipart 最多文件数(IDD /api/files/data/upload max_files=50) */
const UPLOAD_BATCH = 50

/**
 * 上传数据集到诊断服务:manifest + 全部节点 CSV → folder aw-snapshots/exp-<id>。
 * 返回 { ok, dataPaths(manifest 首位), files, manifest };失败 { ok:false, error }。
 */
export async function uploadExportDataset(ctx, exportId) {
  const ds = await readExportDataset(ctx, exportId)
  if (!ds.ok) return ds
  const base = baseOf(ctx)
  if (!base) return { ok: false, error: 'diag.base_url 非法(仅允许 http/https 且 host 为 127.0.0.1/localhost)。' }
  const folder = `aw-snapshots/exp-${String(exportId).trim()}`
  const byName = new Map()
  try {
    for (let i = 0; i < ds.files.length; i += UPLOAD_BATCH) {
      const batch = ds.files.slice(i, i + UPLOAD_BATCH)
      const fd = new FormData()
      fd.append('folder', folder)
      for (const f of batch) {
        const buf = await readFile(f.abs)
        fd.append('files', new Blob([buf], { type: 'text/plain' }), f.name)
      }
      const ac = new AbortController()
      const timer = setTimeout(() => ac.abort(), 120_000)
      let body
      try {
        const res = await fetch(`${base}/api/files/data/upload`, { method: 'POST', body: fd, signal: ac.signal, headers: authHeadersOf(ctx) })
        body = await res.json().catch(() => null)
        if (!res.ok) throw new Error(`HTTP ${res.status} ${short(body)}`)
        if (!body || body.success !== true) throw new Error(`success!=true ${short(body)}`)
      }
      finally {
        clearTimeout(timer)
      }
      for (const entry of (Array.isArray(body?.data) ? body.data : [])) {
        if (entry?.name && entry?.path) byName.set(String(entry.name), String(entry.path))
      }
    }
  }
  catch (err) {
    return { ok: false, error: `数据集上传失败: ${err?.message ?? err}` }
  }
  if (!byName.has('manifest.json')) return { ok: false, error: '上传响应缺少 manifest.json 的路径映射。' }
  // dataPaths:manifest 首位,节点 CSV 按 manifest.nodes 顺序(逐文件名映射,顺序无关上传)
  const dataPaths = [byName.get('manifest.json')]
  for (const rel of (Array.isArray(ds.manifest?.nodes) ? ds.manifest.nodes : [])) {
    const name = String(rel?.file ?? '').split('/').pop()
    const p = byName.get(name)
    if (p) dataPaths.push(p)
  }
  return { ok: true, dataPaths, files: dataPaths.length, manifest: ds.manifest, folder }
}
