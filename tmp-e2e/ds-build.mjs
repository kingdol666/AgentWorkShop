// 构建跨 run 数据集(覆盖线2 两个批次 → byRun 切分可产出 test;窗口放宽到全部历史)
import { readFileSync } from 'node:fs'

const B = 'http://localhost:3001'
const TOK = readFileSync('tmp-e2e/admin.tok', 'utf8').trim()
const spec = {
  lineId: 'ln-83cfc594',
  productId: 'pd-492ef219',
  recipeId: 'rc-8f9cb3d9',
  nodes: [
    { nodeId: 'dn-121838ac', role: 'target' },
    { nodeId: 'dn-121838ac', role: 'feature' },
  ],
  beatMs: 5000,
  window: { historySteps: 60, horizonSteps: 30 },
  split: { valRatio: 0.15, testRatio: 0.2, seed: 7 },
  purpose: 'mpc_surrogate',
  note: '跨 run 数据集(修复 byRun 单 run 无 test 批):两批次全历史',
}
const r = await (await fetch(`${B}/api/workshop/aml/datasets`, {
  method: 'POST',
  headers: { 'authorization': `Bearer ${TOK}`, 'content-type': 'application/json' },
  body: JSON.stringify(spec),
})).json()
console.log('build:', r.code, r.message ?? '')
const ds = r.data?.dataset
console.log('dataset:', ds?.id, 'rows=' + ds?.rowCount, 'runIds=', JSON.stringify(ds?.runIds))
console.log('splits:', JSON.stringify(r.data?.report?.splits ?? ds?.splits ?? {}).slice(0, 200))
