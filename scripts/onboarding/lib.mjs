/**
 * scripts/onboarding/lib.mjs —— 产线接入 skill 的共享库(fetch/断言/幂等指纹/登录)。
 * 设计分工:skill 指令(aw-line-onboarding)做文档理解与 driverConfig 生成;
 * 本目录脚本只做**确定性 REST 调用+断言**,输入是配置 JSON,永不理解文档。
 * 风格对齐 scripts/testing/api-full-loop.mjs(ok 计数断言 + 信封 {code,data})。
 */
import { createHash } from 'node:crypto'

export const BASE = process.env.AW_BASE ?? 'http://127.0.0.1:3001'

let pass = 0, fail = 0
export const ok = (name, cond, detail = '') => {
  console.log(`${cond ? '✅' : '❌'} ${name}${detail ? ' — ' + detail : ''}`)
  cond ? pass++ : fail++
  return cond
}
export const summary = (label) => {
  console.log(`\n=== ${label}: ${pass} 通过 / ${fail} 失败 ===`)
  if (fail > 0) process.exit(1)
}

export const api = async (m, u, body, tok) => {
  const r = await fetch(BASE + u, {
    method: m,
    headers: { 'content-type': 'application/json', ...(tok ? { authorization: `Bearer ${tok}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return r.json()
}

export async function login() {
  if (process.env.AW_TOKEN) return process.env.AW_TOKEN
  const email = process.env.AW_EMAIL ?? 'admin@awshop.local'
  const password = process.env.AW_PASS ?? 'admin123'
  const j = await api('POST', '/api/users/login', { email, password })
  if (!j.data?.token) throw new Error(`登录失败:${j.message ?? '未知'}(可用 AW_TOKEN/AW_EMAIL/AW_PASS 覆盖)`)
  return j.data.token
}

/** 幂等指纹:同输入 → 同标签(写进 description,建前先查列表复用) */
export function fingerprint(kind, ...parts) {
  const h = createHash('sha1').update(parts.join('|')).digest('base64url').slice(0, 10)
  return `AW-${kind}:${h}`
}

/** 按 description 指纹在列表中找既有资源(幂等复用) */
export function findByTag(items, tag) {
  return (items ?? []).find(x => String(x.description ?? '').includes(tag))
}

/** 读 JSON 配置文件(process.argv[2]),带 --stdin 支持 */
export async function readConfig() {
  const arg = process.argv[2]
  if (!arg || arg === '--stdin') {
    const chunks = []
    for await (const c of process.stdin) chunks.push(c)
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  }
  const { readFileSync } = await import('node:fs')
  return JSON.parse(readFileSync(arg, 'utf8'))
}

/** 守护红线:演示线1 及既有关键资源绝不允许出现在本次写入目标里 */
export const PROTECTED = ['ln-d7e0a2a2']
export function assertNotProtected(id, what = '资源') {
  if (PROTECTED.includes(id)) throw new Error(`红线:${what} ${id} 是受保护演示资源,禁止操作`)
}

/** 轮询直到 cond 或超时(验收用:采样落库/HITL 卡出现) */
export async function pollUntil(fn, { timeoutMs = 30000, stepMs = 2000, label = 'poll' } = {}) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    const v = await fn()
    if (v) return v
    await new Promise(r => setTimeout(r, stepMs))
  }
  throw new Error(`${label}: ${Math.round(timeoutMs / 1000)}s 内未达成`)
}
