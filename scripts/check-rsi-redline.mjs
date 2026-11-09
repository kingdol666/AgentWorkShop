#!/usr/bin/env node
/**
 * RSI 红线静态检查（DoD §9.4）——学习环模块不得存在任何设备写路径。
 *
 * 扫描范围（计划 §9.4 点名）：runtime/memory（反射器/采集器）、experience/（晋升/护栏/注入）、verify/（独立回读）。
 * 判定：出现任一直接写调用 → 退出码 1；否则 0。CI/lint 链前置执行。
 *
 * 纪律：控制参数变更只能经 recipe 工具族 + write_intent + HITL；
 * 本脚本只做"存在性"静态证明，不替代安全审计。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

const ROOT = resolve(process.cwd())
const SCAN_DIRS = [
  'server/services/workshop/runtime/memory',
  'server/services/workshop/experience',
  'server/services/workshop/verify',
]

/** 直接设备写调用（含常见别名）；只匹配调用语法，匹配注释/文档不算（保守起见仍报出，由人复核） */
const WRITE_CALL = /\b(dcw_control|param_control|dcw_write|writeNode|write_node|serialWrite|serial_write|serialport\.write)\s*\(/

function walk(dir) {
  const out = []
  let entries
  try {
    entries = readdirSync(dir)
  }
  catch {
    return out
  }
  for (const name of entries) {
    const full = join(dir, name)
    let st
    try {
      st = statSync(full)
    }
    catch {
      continue
    }
    if (st.isDirectory()) out.push(...walk(full))
    else if (/\.(ts|mjs|js)$/.test(name)) out.push(full)
  }
  return out
}

const files = SCAN_DIRS.flatMap(d => walk(join(ROOT, d)))
const offenders = []
for (const file of files) {
  let text
  try {
    text = readFileSync(file, 'utf8')
  }
  catch {
    continue
  }
  const lines = text.split(/\r?\n/)
  lines.forEach((line, i) => {
    if (WRITE_CALL.test(line)) offenders.push(`${relative(ROOT, file)}:${i + 1}`)
  })
}

if (files.length === 0) {
  console.error('FAIL RSI 红线：扫描范围为空（路径错误？）')
  process.exit(1)
}
if (offenders.length > 0) {
  console.error(`FAIL RSI 红线：学习环模块出现设备写调用 ${offenders.length} 处`)
  for (const o of offenders) console.error(`  ${o}`)
  process.exit(1)
}
console.log(`PASS RSI 红线：${files.length} 个学习环文件 0 处设备写调用`)
