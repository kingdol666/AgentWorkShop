/**
 * 存量时间迁移:把数据库/JSON 仓库中的 UTC ISO 字符串(`Z` 后缀)改写为本地偏移形式
 * (`+08:00` 等,值=同一绝对时刻)。目的:与 00-local-time 补丁后的新数据排序一致。
 *
 *   NO_PROXY='*' node scripts/migrate-local-time.mjs [--home <dir>] [--dry]
 *
 * 范围:
 *  - workshop.sqlite / users.sqlite:全表全 TEXT 列中形如 `...Z` 的 ISO 时间戳
 *  - <configRoot>/data/*.json:递归遍历对象树中的 `...Z` 字符串字段
 * 不动:Timescale(timestamptz 绝对时刻)、daq-timeseries.sqlite(ts_ms 整数)、历史日志文件。
 */
import { DatabaseSync } from 'node:sqlite'
import { readdirSync, readFileSync, writeFileSync, renameSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { installLocalIso } from '../shared/local-time.mjs'

installLocalIso() // 迁移脚本自身用补丁后的 toISOString 产出本地偏移串

const DRY = process.argv.includes('--dry')
const homeIdx = process.argv.indexOf('--home')
const configRoot = homeIdx > 0 ? resolve(process.argv[homeIdx + 1] ?? '') : resolve(process.cwd(), '.AgentWorkShop')
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/

let converted = 0
const toLocal = (s) => {
  const ms = Date.parse(s)
  if (Number.isNaN(ms)) return s
  return new Date(ms).toISOString() // 补丁后 = 本地偏移
}

// ---- sqlite ----
function migrateSqlite(path) {
  let db
  try {
    db = new DatabaseSync(path)
  }
  catch (err) {
    console.log(`[skip] ${path}: ${err.message}`)
    return
  }
  const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`).all()
  for (const { name: table } of tables) {
    const cols = db.prepare(`PRAGMA table_info(${JSON.stringify(table).slice(1, -1)})`).all()
    for (const col of cols) {
      if ((col.type ?? '').toUpperCase() !== 'TEXT') continue
      let rows
      try {
        rows = db.prepare(`SELECT rowid AS rid, ${JSON.stringify(col.name).slice(1, -1)} AS v FROM ${JSON.stringify(table).slice(1, -1)}`).all()
      }
      catch { continue }
      const hits = rows.filter(r => typeof r.v === 'string' && ISO_UTC.test(r.v))
      if (hits.length === 0) continue
      console.log(`[sqlite] ${table}.${col.name}: ${hits.length} rows`)
      if (DRY) {
        converted += hits.length
        continue
      }
      const upd = db.prepare(`UPDATE ${JSON.stringify(table).slice(1, -1)} SET ${JSON.stringify(col.name).slice(1, -1)} = ? WHERE rowid = ?`)
      for (const r of hits) {
        upd.run(toLocal(r.v), r.rid)
        converted++
      }
    }
  }
  db.close()
}

// ---- json 仓库 ----
function walkJson(node) {
  if (typeof node === 'string') return ISO_UTC.test(node) ? toLocal(node) : node
  if (Array.isArray(node)) return node.map(walkJson)
  if (node && typeof node === 'object') {
    for (const k of Object.keys(node)) node[k] = walkJson(node[k])
    return node
  }
  return node
}

function migrateJsonDir(dir) {
  let entries
  try {
    entries = readdirSync(dir)
  }
  catch { return }
  for (const name of entries) {
    const p = join(dir, name)
    let st
    try {
      st = statSync(p)
    }
    catch { continue }
    if (st.isDirectory()) {
      if (name === 'plugins' || name === 'daq-objects' || name.startsWith('backup')) continue
      migrateJsonDir(p)
      continue
    }
    if (!name.endsWith('.json') || name === 'runtime-settings.json') continue
    try {
      const raw = readFileSync(p, 'utf-8')
      const parsed = JSON.parse(raw)
      const before = (raw.match(/Z"/g) ?? []).length
      const next = walkJson(parsed)
      const out = JSON.stringify(next, null, 2)
      const after = (out.match(/Z"/g) ?? []).length
      if (before === after) continue
      console.log(`[json] ${p}: ${before - after} timestamps`)
      if (DRY) {
        converted += before - after
        continue
      }
      writeFileSync(p + '.tmp', out)
      renameSync(p + '.tmp', p)
      converted += before - after
    }
    catch { /* 非 JSON 内容/读失败跳过 */ }
  }
}

console.log(`[migrate] configRoot=${configRoot} dry=${DRY}`)
migrateSqlite(join(configRoot, 'data', 'workshop.sqlite'))
migrateSqlite(join(configRoot, 'data', 'users.sqlite'))
migrateJsonDir(join(configRoot, 'data'))
console.log(`[migrate] done: ${converted} timestamps converted${DRY ? ' (dry-run,未写盘)' : ''}`)
