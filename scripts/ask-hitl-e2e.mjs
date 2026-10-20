#!/usr/bin/env node
/**
 * ask-hitl-e2e.mjs —— 原生 ask 提问型 HITL 的最短真实链路。
 *
 * 与 e2e-hitl-live.mjs 的终端注入路径互补:本脚本直接给 omp lead 一个任务,
 * 要求它调用原生 ask 工具提问;断言 hitl/pending 出现 question 型待办、
 * options 含 yes/no、应答后任务完成且交付物含用户答案。
 *
 * 用法:AW_E2E_TOKEN=<admin token> node scripts/ask-hitl-e2e.mjs [--base ...]
 */
const args = process.argv.slice(2)
const argOf = (k, d = '') => {
  const i = args.indexOf(k)
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : d
}
const BASE = argOf('--base', process.env.AW_BASE ?? 'http://127.0.0.1:3001')
const TOKEN = process.env.AW_E2E_TOKEN ?? process.env.AW_TOKEN ?? ''
const TAG = Date.now().toString(36)
const sleep = ms => new Promise(r => setTimeout(r, ms))
const checks = []
const ok = (name, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'} | ${name} | ${String(detail).slice(0, 220)}`)
  checks.push({ name, ok: !!cond, detail: String(detail).slice(0, 500) })
  return !!cond
}
if (!TOKEN) {
  console.error('缺少 AW_E2E_TOKEN / AW_TOKEN')
  process.exit(1)
}
async function api(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'content-type': 'application/json', 'authorization': `Bearer ${TOKEN}` },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(120_000),
  })
  return { status: res.status, ...(await res.json().catch(() => ({}))) }
}
async function main() {
  console.log(`━━━ ask HITL 最短链路 @ ${BASE} (tag=${TAG}) ━━━`)
  const ch = await api('POST', '/api/workshop/channels', {
    name: `ask-${TAG}`,
    description: `ask-hitl-e2e ${TAG}`,
    leadAgent: { name: 'ask-operator', harness: 'omp' },
  })
  const channelId = ch.data?.channelId
  const leadId = ch.data?.leadAgentId
  ok('omp lead channel 创建', Boolean(channelId && leadId), channelId ?? ch.message)
  const task = await api('POST', `/api/workshop/channels/${channelId}/tasks`, {
    title: `ask-${TAG}`,
    description: 'Use the ask tool NOW to ask me exactly one question: "Proceed?" with options yes and no. '
      + 'Do not do anything else. After I answer, call complete_task with summary set to my exact answer.',
  })
  const taskId = task.data?.id
  ok('ask 任务提交', Boolean(taskId), taskId ?? task.message)

  let item = null
  const end = Date.now() + 180000
  while (Date.now() < end && !item) {
    const p = await api('GET', `/api/workshop/hitl/pending?channelId=${channelId}`)
    item = (p.data?.items ?? []).find((i) => {
      const opts = JSON.stringify(i.options ?? []).toLowerCase()
      return opts.includes('yes') && opts.includes('no')
    }) ?? null
    if (!item) await sleep(2500)
  }
  ok('hitl/pending 出现 ask 提问型待办', Boolean(item), item ? `kind=${item.kind} method=${item.method} options=${JSON.stringify(item.options)}` : '超时')
  if (!item) {
    process.exit(1)
  }
  ok('待办语义为 question/select', item.method === 'select' && (item.requestType === 'question' || item.kind === 'omp-dialog'), `kind=${item.kind} requestType=${item.requestType} method=${item.method}`)

  const respond = await api('POST', '/api/workshop/hitl/respond', { kind: item.kind, id: item.id, value: 'yes' })
  ok('应答 ask(选择 yes)', respond.code === 0, respond.message ?? 'ok')

  let done = null
  const end2 = Date.now() + 120000
  while (Date.now() < end2) {
    await sleep(3000)
    const s = await api('GET', `/api/workshop/tasks/${taskId}`)
    done = s.data ?? done
    if (['COMPLETED', 'FAILED', 'CANCELED'].includes(done?.state)) break
  }
  const text = (done?.artifacts ?? []).flatMap(a => a.parts ?? []).map(p => String(p.text ?? '')).join('\n')
  ok('应答后任务完成且交付物含 yes', done?.state === 'COMPLETED' && /\byes\b/i.test(text), `state=${done?.state} deliverable=${text.slice(0, 160)}`)

  const pass = checks.filter(c => c.ok).length
  console.log(`\n=== ask HITL: ${pass} PASS / ${checks.length - pass} FAIL ===`)
  const { writeFileSync } = await import('node:fs')
  writeFileSync('docs/audit/2026-10-20-harness-acceptance-evidence/us005-ask-hitl.json', JSON.stringify({ at: new Date().toISOString(), channelId, taskId, item, checks }, null, 2))
  process.exit(pass === checks.length ? 0 : 1)
}
main().catch((err) => {
  console.error(err)
  process.exit(1)
})
