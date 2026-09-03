/**
 * 补充验证 C:帧派生指标 → 既有告警链路(确定性:自定义模板阈值必越)。
 * 建自定义 vector 模板(avg alarmHigh=0.30,mock avg≈0.52 恒越)→ 建节点开跑
 * → 断言 alarm_events 出现 metric=<template>.avg 告警 → 清理(节点+模板+停线)。
 * 运行: node scripts/_dbg-daq-frame-alarm.mjs
 */
const ROOT = process.env.E2E_ROOT ?? 'http://127.0.0.1:3000'
const sleep = ms => new Promise(r => setTimeout(r, ms))
const fail = (msg) => { console.error('FAIL:', msg); process.exitCode = 1 }

const login = await fetch(`${ROOT}/api/users/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'zhangwei@awshop.io', password: 'Awshop@123' }) }).then(r => r.json())
const H = { authorization: `Bearer ${login.data.token}`, 'content-type': 'application/json' }
const j = (u, m = 'GET', b) => fetch(ROOT + u, { method: m, headers: H, body: b ? JSON.stringify(b) : undefined }).then(r => r.json())

const tplKey = `ct-alarm${Date.now().toString(36).slice(-4)}`
const tpl = (await j('/api/workshop/daq/templates', 'POST', {
  name: `E2E 告警模板 ${tplKey.slice(-4)}`,
  unit: 'mm',
  min: 0.4,
  max: 0.65,
  base: 0.52,
  amp: 0.015,
  signalKind: 'vector',
  vector: { points: 16, min: 0.4, max: 0.65 },
  sink: { processors: [{ name: 'derive-metric', args: { name: 'avg', op: 'avg' } }] },
  metrics: [{ key: 'avg', label: '平均厚度', unit: 'mm', alarmHigh: 0.3 }],
})).data.template
if (!tpl?.key) { console.error('FAIL: create template:', JSON.stringify(tpl).slice(0, 200)); process.exit(1) }

const d = (await j('/api/workshop/dcw')).data
const cand = d.lines.map(l => ({ line: l, recipe: d.recipes.find(r => r.lineId === l.id) })).find(x => x.recipe)
await j(`/api/workshop/dcw/lines/${cand.line.id}/stop`, 'POST').catch(() => {})
await sleep(1000)
await j(`/api/workshop/dcw/lines/${cand.line.id}/start`, 'POST', { recipeId: cand.recipe.id })
const node = (await j('/api/workshop/daq', 'POST', { templateRef: tpl.key, lineId: cand.line.id, name: 'E2E 告警' })).data.node

let hit = null
try {
  await sleep(6000)
  const alarms = (await j('/api/workshop/daq/alarms?scope=all&limit=100')).data.alarms
  hit = alarms.find(a => a.nodeId === node.id && a.metric === `${tpl.key}.avg`)
  if (hit) console.log(`PASS 指标告警: metric=${hit.metric} value=${hit.value} rule=${hit.rule} threshold=${hit.threshold}`)
  else fail(`no frame alarm for ${tpl.key}.avg (alarms=${alarms.length})`)
} finally {
  await j(`/api/workshop/daq/${node.id}`, 'DELETE').catch(() => {})
  await j(`/api/workshop/daq/templates/${tpl.key}`, 'DELETE').catch(() => {})
  await j(`/api/workshop/dcw/lines/${cand.line.id}/stop`, 'POST').catch(() => {})
}
console.log(process.exitCode ? '\nALARM E2E FAILED' : '\nALARM E2E PASS')
