#!/usr/bin/env node
// ============================================================
// test-sdk-surface.mjs — SDK 类型声明 / package.json 出口面 防漂移守卫
// ------------------------------------------------------------
// 断言三件事(任一失败 → exit 1):
//   ① 类型声明里列出的生命周期事件集合 == sdk/lifecycle.mjs 运行时集合
//      (LIFECYCLE_EVENTS 与 CLIENT_EVENTS 各自比对:
//       sdk/index.d.mts 的 readonly 元组字面量 vs 运行时 Object.freeze 数组)
//   ② sdk/client.d.mts 存在
//   ③ package.json 每个 exports 条目的 types / default 目标文件都真实存在
// 用法: node scripts/test-sdk-surface.mjs
// ============================================================
import { readFileSync, existsSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')

let failures = 0
const pass = msg => console.log(`  ✔ ${msg}`)
const fail = (msg) => {
  failures += 1
  console.error(`  ✘ ${msg}`)
}

/** 从 .d.mts 源码抽取 `export declare const <NAME>: readonly [...]` 的字面量集合 */
function extractTuple(file, name) {
  const src = readFileSync(file, 'utf8')
  // 允许跨行;匹配 declare const NAME: readonly [ ... ]
  const re = new RegExp(`export declare const ${name}\\s*:\\s*readonly\\s*\\[([\\s\\S]*?)\\]`)
  const m = src.match(re)
  if (!m) return null
  return m[1]
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
    .map((s) => {
      const q = s.match(/^'(.*)'$/) ?? s.match(/^"(.*)"$/)
      return q ? q[1] : s
    })
}

/** 集合并集比较(顺序无关,但重复也要能发现) */
function sameSet(a, b) {
  if (a.length !== b.length) return false
  const sa = [...new Set(a)].sort()
  const sb = [...new Set(b)].sort()
  return sa.length === sb.length && sa.every((v, i) => v === sb[i])
}

const fmt = arr => JSON.stringify(arr)

// ---------- ① 生命周期事件清单:类型 == 运行时 ----------
console.log('\n[1/3] 生命周期事件清单(类型声明 vs 运行时)')
const { LIFECYCLE_EVENTS, CLIENT_EVENTS } = await import('../sdk/lifecycle.mjs')
const indexDts = join(ROOT, 'sdk', 'index.d.mts')

for (const [name, runtime] of [['LIFECYCLE_EVENTS', [...LIFECYCLE_EVENTS]], ['CLIENT_EVENTS', [...CLIENT_EVENTS]]]) {
  const declared = extractTuple(indexDts, name)
  if (!declared) {
    fail(`${name}: sdk/index.d.mts 未找到 'export declare const ' + name + ': readonly [...]' 声明`)
    continue
  }
  if (sameSet(declared, runtime)) {
    pass(`${name}: 类型声明与运行时一致(${runtime.length} 项)`)
  }
  else {
    const missing = runtime.filter(e => !declared.includes(e))
    const extra = declared.filter(e => !runtime.includes(e))
    fail(`${name}: 类型声明与运行时漂移`)
    if (missing.length) console.error(`      类型缺失(运行时独有): ${fmt(missing)}`)
    if (extra.length) console.error(`      类型多余(已在运行时移除): ${fmt(extra)}`)
    console.error(`      运行时 = ${fmt(runtime)}`)
    console.error(`      类型声明 = ${fmt(declared)}`)
  }
}

// 额外守卫:确保由 sdk/index.mjs 转出的运行时清单与 lifecycle.mjs 同源
const indexMjs = await import('../sdk/index.mjs')
if (sameSet([...indexMjs.LIFECYCLE_EVENTS], [...LIFECYCLE_EVENTS])) {
  pass('sdk/index.mjs 转出的 LIFECYCLE_EVENTS 与 lifecycle.mjs 同源')
}
else {
  fail('sdk/index.mjs 转出的 LIFECYCLE_EVENTS 与 lifecycle.mjs 不一致')
}

// ---------- ② sdk/client.d.mts 存在 ----------
console.log('\n[2/3] sdk/client.d.mts 存在性')
const clientDts = join(ROOT, 'sdk', 'client.d.mts')
if (existsSync(clientDts) && statSync(clientDts).isFile()) {
  pass('sdk/client.d.mts 存在')
}
else {
  fail('sdk/client.d.mts 不存在(package.json exports["./sdk/client"].types 悬空)')
}

// 且必须真实描述 createClientContext(非空壳)
if (existsSync(clientDts)) {
  const src = readFileSync(clientDts, 'utf8')
  const need = ['createClientContext', 'CLIENT_SDK_VERSION', 'export interface ClientContext']
  for (const token of need) {
    if (src.includes(token)) pass(`sdk/client.d.mts 声明了 ${token}`)
    else fail(`sdk/client.d.mts 缺少声明: ${token}`)
  }
}

// ---------- ③ package.json exports 目标文件全部存在 ----------
console.log('\n[3/3] package.json exports 目标文件存在性')
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
const pkgName = pkg.name ?? '(anonymous)'

function checkTarget(specifier, conditionName, target) {
  // 字符串简写 与 { types, default } 两形态都支持
  if (typeof target === 'string') {
    checkFile(specifier, conditionName, target)
    return
  }
  if (target && typeof target === 'object') {
    for (const [cond, val] of Object.entries(target)) checkTarget(specifier, `${conditionName}.${cond}`, val)
    return
  }
  fail(`exports["${specifier}"]${conditionName}: 目标不是字符串/对象`)
}

function checkFile(specifier, conditionName, rel) {
  if (!rel.startsWith('./')) {
    fail(`exports["${specifier}"]${conditionName} → "${rel}" 不是相对路径`)
    return
  }
  const abs = join(ROOT, rel)
  if (existsSync(abs) && statSync(abs).isFile()) {
    pass(`exports["${specifier}"]${conditionName} → ${rel}`)
  }
  else {
    fail(`exports["${specifier}"]${conditionName} → ${rel} 文件不存在`)
  }
}

const exportsMap = pkg.exports ?? {}
const specifiers = Object.keys(exportsMap)
if (specifiers.length === 0) fail('package.json 未声明 exports')
for (const spec of specifiers) checkTarget(spec, '', exportsMap[spec])

// 额外守卫:两个 types 入口都应指向存在的 .d.mts
for (const spec of ['.', './sdk', './sdk/client']) {
  const t = exportsMap[spec]?.types
  if (t && !t.endsWith('.d.mts')) fail(`exports["${spec}"].types 不是 .d.mts: ${t}`)
}

// ---------- 报告 ----------
console.log('')
if (failures === 0) {
  console.log(`✅ SDK 出口面校验通过(${pkgName}@${pkg.version ?? '?'})`)
  process.exit(0)
}
console.error(`❌ SDK 出口面校验失败:${failures} 项`)
process.exit(1)
