#!/usr/bin/env node
/**
 * scripts/_audit/verify-data-integrity.mjs —— 数据根完整性核对(只读)
 *
 * 背景:DCW 审计 agent 的隔离实验因为仓库改用 ensureDataDir() 而误写真实配置根,
 * 造成 .AgentWorkShop/data/{dcw-rollback,dcws}.json 被合成数据污染(11.4MB 账本 +
 * 2 个 phantom 节点),其自述已修复。本脚本独立核对"修复是否真的把两套根收敛回一致",
 * 以及关键集合规模是否与权威副本相符。
 *
 * 用法: node scripts/_audit/verify-data-integrity.mjs
 * 退出码:0 = 全部一致;1 = 存在分歧。
 */
import { readFileSync, statSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const REPO = process.cwd()
const ROOTS = {
  server: join(REPO, 'server', 'data'),
  config: join(REPO, '.AgentWorkShop', 'data'),
}
const FILES = [
  'dcws.json', 'daqs.json', 'dcw-rollback.json', 'dcw-writes.json', 'dcw-runs.json',
  'dcw-recipes.json', 'dcw-lines.json', 'dcw-products.json', 'dcw-templates.json',
  'line-runs.json', 'scene-layouts.json', 'agent-node-bindings.json', 'daq-templates.json',
]

let bad = 0
const note = (okFlag, msg) => {
  if (!okFlag) bad++
  console.log(`  ${okFlag ? '✔' : '✘'} ${msg}`)
}

const read = (root, f) => {
  const p = join(ROOTS[root], f)
  if (!existsSync(p)) return null
  return { path: p, size: statSync(p).size, mtime: statSync(p).mtimeMs, text: readFileSync(p, 'utf8') }
}

/** 从 DCW/DAQ 快照里数出集合规模(兼容数组与 {nodes:[...]} 两种形态) */
function countOf(text, keys) {
  try {
    const j = JSON.parse(text)
    for (const k of keys) {
      if (Array.isArray(j[k])) return j[k].length
      if (Array.isArray(j)) return j.length
    }
    return null
  }
  catch {
    return null
  }
}

console.log('═══ 数据根完整性核对(只读)═══\n')

console.log('── 1. 两套根的逐文件对照 ──')
for (const f of FILES) {
  const s = read('server', f)
  const c = read('config', f)
  if (!s && !c) {
    console.log(`  · ${f}: 两侧均无(未使用)`)
    continue
  }
  if (!s) {
    console.log(`  · ${f}: 仅 config(${c.size} B)`)
    continue
  }
  if (!c) {
    console.log(`  · ${f}: 仅 server(${s.size} B)`)
    continue
  }
  const same = s.text === c.text
  const sizeTag = s.size === c.size ? `${s.size}B` : `${s.size}B vs ${c.size}B`
  console.log(`  ${same ? '=' : '≠'} ${f}: ${sizeTag}`)
  if (!same && (f === 'dcws.json' || f === 'dcw-rollback.json')) {
    // 关键文件必须一致(污染事件的核心)
    note(false, `${f} 两侧内容不一致 —— 修复未收敛`)
  }
}

console.log('\n── 2. 污染痕迹清零核对 ──')
const dcws = read('config', 'dcws.json')
if (dcws) {
  const phantoms = ['dw-cc28b097', 'dw-c37e304b']
  const found = phantoms.filter(id => dcws.text.includes(id))
  note(found.length === 0, `phantom 节点已清除${found.length ? ` (残留: ${found.join(', ')})` : ''}`)
  note(!dcws.text.includes('"decimals": 101') && !dcws.text.includes('"decimals":101'),
    'decimals=101 污染值已清除')
  const n = countOf(dcws.text, ['nodes', 'items'])
  console.log(`    config dcws 节点数 = ${n}`)
}

const rb = read('config', 'dcw-rollback.json')
if (rb) {
  const n = countOf(rb.text, ['records'])
  const a = countOf(rb.text, ['anchors'])
  console.log(`    config dcw-rollback: records=${n} anchors=${a} size=${rb.size}B`)
  note(rb.size < 2_000_000, `账本规模正常(<2MB)${rb.size >= 2_000_000 ? ` —— 实测 ${rb.size}B,疑似合成数据残留` : ''}`)
  const synthetic = (rb.text.match(/"n-\d+"/g) ?? []).length
  note(synthetic === 0, `无合成锚 id(n-*)${synthetic ? ` (残留 ${synthetic} 个)` : ''}`)
}

console.log('\n── 3. 污染备份证据留存 ──')
const backupDir = join(REPO, 'scripts', '_audit', '.tmp', 'pollution-backup')
for (const f of ['dcw-rollback.polluted.json', 'dcws.polluted.json']) {
  const p = join(backupDir, f)
  const okFlag = existsSync(p)
  console.log(`  ${okFlag ? '✔' : '·'} 证据 ${f}${okFlag ? ` (${statSync(p).size} B)` : '(未找到)'}`)
}

console.log(`\n═══ 结果:${bad === 0 ? '全部一致' : `${bad} 项不一致`} ═══`)
process.exit(bad === 0 ? 0 : 1)
