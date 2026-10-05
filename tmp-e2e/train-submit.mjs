// 提交真实训练作业(带 train-example.py 代码;在 uv venv 中运行)
import { readFileSync } from 'node:fs'

const B = 'http://localhost:3001'
const TOK = readFileSync('tmp-e2e/admin.tok', 'utf8').trim()
const code = readFileSync('server/services/workshop/aml/python/train-example.py', 'utf8')
const r = await (await fetch(`${B}/api/workshop/aml/jobs`, {
  method: 'POST',
  headers: { 'authorization': `Bearer ${TOK}`, 'content-type': 'application/json' },
  body: JSON.stringify({
    datasetId: 'ds-muv31uad-3uo119',
    purpose: 'mpc_surrogate',
    jobKind: 'supervised',
    budget: { maxExperiments: 4 },
    seed: 7,
    params: { epochs: 30, hidden: 64, lr: 1e-3, batch: 128 },
    changeNote: 'uv 环境首次真实训练(线2泵压 646 行,train-example 基线)',
    code,
  }),
})).json()
console.log('submit:', r.code, r.data?.job?.id ?? r.message ?? '')
console.log('status:', r.data?.job?.status ?? '')
