/* eslint-disable */
// 稳健轮询:取最新 AML 作业,打印状态与门禁
import { readFileSync } from 'node:fs'

const B = 'http://localhost:3001'
const TOK = readFileSync('tmp-e2e/admin.tok', 'utf8').trim()
const H = { authorization: `Bearer ${TOK}` }
const j = await (await fetch(`${B}/api/workshop/aml/jobs`, { headers: H })).json()
const arr = Array.isArray(j.data) ? j.data : (j.data?.items ?? j.data?.jobs ?? [])
const latest = arr.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))[0]
if (!latest) { console.log('no jobs'); process.exit(0) }
const detail = await (await fetch(`${B}/api/workshop/aml/jobs/${latest.id}`, { headers: H })).json()
const job = detail.data?.job ?? latest
const gates = job.gatesJson ? JSON.parse(job.gatesJson) : null
console.log(`最新作业: ${job.id.slice(0, 13)} status=${job.status} stage=${job.stage} progress=${job.progress}`)
if (gates) {
  console.log(`gates.passed=${gates.passed}`)
  for (const c of gates.checks) console.log(`  ${c.id} ${c.pass ? '✅' : '❌'} ${c.detail}`)
}
if (job.errorJson) console.log('error:', String(job.errorJson).slice(0, 200))
