/**
 * 采样/查询时间间隔 场景测试(真实链路)。
 *   NO_PROXY='127.0.0.1,localhost' node scripts/_dbg-interval-scenario.mjs [--base http://127.0.0.1:3001]
 *
 * 验收:
 *  S1 节点采样间隔独立可调:同产线 3 节点 intervalMs=1000/5000/7000 → 60s 内样本数呈独立节拍
 *     (A≈55-60, B≈11-13, C≈8-10);下限 1s(<1000 被钳到 1000)
 *  S2 samples 查询:缺省 bucketMs → 返回 bucketMs=15000 且点为桶聚合(avg);bucketMs=1000 → 桶更细
 *  S3 产线 lineQuery(产品/配方/参数/时间/间隔):缺省 → 15s 桶;bucketMs=1000 → 桶数更多
 */
const BASE = (() => {
  const i = process.argv.indexOf('--base')
  return i > 0 ? process.argv[i + 1] : 'http://127.0.0.1:3001'
})()
const TAG = Date.now().toString(36)

let failures = 0
let passed = 0
const results = []
const check = (id, name, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${id} ${name}${detail ? ` — ${detail}` : ''}`)
  results.push({ id, name, ok, detail })
  ok ? passed++ : failures++
}
const sleep = ms => new Promise(r => setTimeout(r, ms))
const api = async (method, path, { body, token } = {}) => {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  return { status: res.status, ...(await res.json().catch(() => ({}))) }
}

async function main() {
  console.log(`\n━━━ 采样/查询间隔 场景测试 @ ${BASE} (tag=${TAG}) ━━━`)
  const reg = await api('POST', '/api/users/register', { body: { email: `itv-${TAG}@test.local`, password: 'Passw0rd!123', name: `itv-${TAG}` } })
  const token = reg.data?.token
  if (!token) throw new Error(`注册失败: ${JSON.stringify(reg).slice(0, 160)}`)

  const line = (await api('POST', '/api/workshop/dcw/lines', { body: { name: `间隔产线-${TAG}` }, token })).data?.line
  const mk = async (intervalMs) => (await api('POST', '/api/workshop/daq', {
    body: { templateRef: 'daq-temp-tc', name: `间隔${intervalMs ?? '默认'}-${TAG}`, driver: 'mock', lineId: line.id, intervalMs, publishIntervalMs: 0 }, token,
  })).data?.node
  const nA = await mk(1000)
  const nB = await mk(5000)
  const nC = await mk(7000)
  // 下限钳制:创建时传 250ms → 服务端收敛为 1000
  const nMin = (await api('POST', '/api/workshop/daq', {
    body: { templateRef: 'daq-temp-tc', name: `下限钳制-${TAG}`, driver: 'mock', lineId: line.id, intervalMs: 250, publishIntervalMs: 0 }, token,
  })).data?.node
  check('S0', '四节点创建(1s/5s/7s/下限钳制)', Boolean(nA?.id && nB?.id && nC?.id && nMin?.id))
  check('S0.1', '创建下限钳制(250ms → 1000)', nMin?.intervalMs === 1000, `intervalMs=${nMin?.intervalMs}`)

  const dw = (await api('POST', '/api/workshop/dcw', { body: { templateRef: 'dcw-temp-sp', name: `间隔参数-${TAG}`, driver: 'mock', lineId: line.id }, token })).data?.node
  const prod = (await api('POST', '/api/workshop/dcw/products', { body: { name: `间隔产品-${TAG}`, lineId: line.id }, token })).data?.product
  const recipe = (await api('POST', '/api/workshop/dcw/recipes', {
    body: {
      productId: prod.id, name: `间隔配方-${TAG}`,
      params: [{ templateRef: 'dcw-temp-sp', nodeId: dw.id, value: 180, min: 150, max: 200 }],
      daqWindows: [{ nodeId: nA.id, min: 0, max: 260 }],
    }, token,
  })).data?.recipe
  const start = await api('POST', `/api/workshop/dcw/lines/${line.id}/start`, { body: { recipeId: recipe.id }, token })
  check('S0.2', '产线开跑(门控激活)', start.code === 0, start.message ?? '')

  console.log('  … 60s 采样窗口(三节点独立节拍)…')
  await sleep(60_000)

  const countOf = async (id) => {
    const s = await api('GET', `/api/workshop/daq/${id}/samples?bucketMs=1000&from=${Date.now() - 70_000}`, { token })
    const pts = s.data?.points ?? []
    return pts.reduce((a, p) => a + Number(p.cnt ?? 1), 0)
  }
  const [cA, cB, cC, cMin] = await Promise.all([countOf(nA.id), countOf(nB.id), countOf(nC.id), countOf(nMin.id)])
  check('S1.1', '1s 节点 60s ≈55-60 样本', cA >= 45 && cA <= 65, `cnt=${cA}`)
  check('S1.2', '5s 节点 60s ≈11-13 样本', cB >= 9 && cB <= 15, `cnt=${cB}`)
  check('S1.3', '7s 节点 60s ≈8-10 样本', cC >= 6 && cC <= 12, `cnt=${cC}`)
  check('S1.4', '三节点节拍独立(A > B > C)', cA > cB && cB > cC, `A=${cA} B=${cB} C=${cC}`)
  check('S1.5', '钳制节点(250→1000)节拍 = 1s 档', Math.abs(cMin - cA) <= 6, `min=${cMin} A=${cA}`)

  // PATCH 改节拍:运行中把 7s 节点改 1s → 后续样本变密
  const repatch = await api('PATCH', `/api/workshop/daq/${nC.id}`, { body: { intervalMs: 1000 }, token })
  check('S1.6', '运行中 PATCH 改节拍(7s→1s)', repatch.code === 0 && repatch.data?.node?.intervalMs === 1000, `intervalMs=${repatch.data?.node?.intervalMs}`)
  await sleep(8000)
  const cAfter = await api('GET', `/api/workshop/daq/${nC.id}/samples?bucketMs=1000&from=${Date.now() - 7000}`, { token })
  const cAfterPts = cAfter.data?.points ?? []
  const cAfterCnt = cAfterPts.reduce((a, p) => a + Number(p.cnt ?? 1), 0)
  check('S1.7', '改拍后 7s 窗口样本 ≈7-9(原应≈1)', cAfterCnt >= 6, `cnt=${cAfterCnt}`)

  // S2 samples 查询缺省 bucket
  const qDefault = await api('GET', `/api/workshop/daq/${nB.id}/samples`, { token })
  const dpts = qDefault.data?.points ?? []
  const isBucketShape = dpts.length > 0 && dpts[0].avg !== undefined && dpts[0].cnt !== undefined
  check('S2.1', 'samples 缺省 → bucketMs=15000(15s 桶聚合)', qDefault.data?.bucketMs === 15000 && isBucketShape, `bucketMs=${qDefault.data?.bucketMs} shape=${isBucketShape} pts=${dpts.length}`)
  const q1s = await api('GET', `/api/workshop/daq/${nB.id}/samples?bucketMs=1000`, { token })
  check('S2.2', 'samples bucketMs=1000 → 桶数多于默认', (q1s.data?.points ?? []).length > dpts.length, `1s=${(q1s.data?.points ?? []).length} default=${dpts.length}`)
  const qLow = await api('GET', `/api/workshop/daq/${nB.id}/samples?bucketMs=300`, { token })
  check('S2.3', 'samples bucketMs=300 → 钳到 1000', qLow.data?.bucketMs === 1000, `bucketMs=${qLow.data?.bucketMs}`)

  // S3 产线 lineQuery(产线数据查询卡后端)
  const lqDefault = await api('GET', `/api/workshop/dcw/line/query?lineId=${line.id}&from=${Date.now() - 70_000}`, { token })
  const lch = lqDefault.data?.channels ?? []
  const lBucketShape = lch.length > 0 && (lch[0].points?.[0]?.avg !== undefined)
  check('S3.1', 'lineQuery 缺省 → 15s 桶聚合', lch.length > 0 && lBucketShape, `channels=${lch.length} bucketShape=${lBucketShape}`)
  const lq1s = await api('GET', `/api/workshop/dcw/line/query?lineId=${line.id}&from=${Date.now() - 70_000}&bucketMs=1000`, { token })
  const l1ch = (lq1s.data?.channels ?? [])[0]?.points?.length ?? 0
  const l0ch = lch[0]?.points?.length ?? 0
  check('S3.2', 'lineQuery bucketMs=1000 → 桶数更多', l1ch > l0ch, `1s=${l1ch} default=${l0ch}`)
  const lqLow = await api('GET', `/api/workshop/dcw/line/query?lineId=${line.id}&bucketMs=500`, { token })
  // 无法直接看生效值;用 1s 桶点数一致性间接验证(钳到 1000 → 与 bucketMs=1000 相同桶数)
  const lLowCh = (lqLow.data?.channels ?? [])[0]?.points?.length ?? 0
  check('S3.3', 'lineQuery bucketMs=500 → 钳到 1000(桶数与 1s 一致)', lLowCh === l1ch, `500→${lLowCh} vs 1000=${l1ch}`)

  // 清理
  await api('POST', `/api/workshop/dcw/lines/${line.id}/stop`, { token }).catch(() => {})
  for (const n of [nA, nB, nC, nMin]) await api('DELETE', `/api/workshop/daq/${n.id}`, { token }).catch(() => {})
  await api('DELETE', `/api/workshop/dcw/${dw.id}`, { token }).catch(() => {})
  await api('DELETE', `/api/workshop/dcw/lines/${line.id}`, { token }).catch(() => {})

  console.log(`\n━━━ 间隔场景测试结果: ${passed} passed / ${failures} failed ━━━`)
  if (failures) for (const r of results.filter(x => !x.ok)) console.log(`  ${r.id} ${r.name} — ${r.detail}`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((err) => { console.error('FATAL', err); process.exit(1) })
