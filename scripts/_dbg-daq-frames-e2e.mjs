/**
 * 一次性 E2E:多形态数采帧管线 mock 场景活体验证(向量/图像)。
 * 前置:dev server(AW_HOME 隔离)跑在本脚本 ROOT;MinIO/Timescale/Mosquitto 可达。
 * ①登录拿 token → ②开跑产线 → ③建 thickness-scan(vector)/ccd-image(image)节点
 * → ④轮询 daq_frames REST:向量含点列+派生指标,图像含对象引用
 * → ⑤图像 content 端点回 PNG 字节 → ⑥scalar 节点零污染(daq_samples 查询无该节点)
 * → ⑦停线(帧冻结)+ 清理节点。
 * 运行: node scripts/_dbg-daq-frames-e2e.mjs
 */
const ROOT = process.env.E2E_ROOT ?? 'http://127.0.0.1:3100'
const sleep = ms => new Promise(r => setTimeout(r, ms))
const fail = (msg) => { console.error('FAIL:', msg); process.exitCode = 1 }

// ===== 登录(Bearer token 面已足够;daq REST resolveUser 接受 Bearer)=====
const login = await fetch(`${ROOT}/api/users/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: 'zhangwei@awshop.io', password: 'Awshop@123' }),
}).then(r => r.json())
const token = login?.data?.token
if (!token) { console.error('FAIL: login:', JSON.stringify(login).slice(0, 200)); process.exit(1) }
const H = { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
const j = (u, m = 'GET', b) => fetch(ROOT + u, { method: m, headers: H, body: b ? JSON.stringify(b) : undefined }).then(r => r.json())

// ===== 0. infra/meta:对象存储后端可见 =====
const meta0 = (await j('/api/workshop/daq')).data
console.log('meta.infra:', JSON.stringify(meta0.meta.infra ?? {}).slice(0, 160))
console.log('meta.backends:', JSON.stringify(meta0.meta.backends ?? meta0.meta))
const created = []
try {
  // ===== 1. 选产线 + 开跑(任一有配方的产线)=====
  const d = (await j('/api/workshop/dcw')).data
  const cand = d.lines.map(l => ({ line: l, recipe: d.recipes.find(r => r.lineId === l.id) })).find(x => x.recipe)
  if (!cand) { console.error('FAIL: 无可开跑产线(无配方)'); process.exit(1) }
  const stop = await j(`/api/workshop/dcw/lines/${cand.line.id}/stop`, 'POST').catch(() => {})
  await sleep(1200)
  const st = await j(`/api/workshop/dcw/lines/${cand.line.id}/start`, 'POST', { recipeId: cand.recipe.id })
  if (!st.data?.line?.active) { console.error('FAIL: line start:', JSON.stringify(st).slice(0, 200)); process.exit(1) }
  console.log('line started:', cand.line.name, '| recipe:', cand.recipe.name)

  // ===== 2. 建向量/图像节点(挂产线)=====
  const mk = async (templateRef, name) => {
    const r = await j('/api/workshop/daq', 'POST', { templateRef, lineId: cand.line.id, name })
    if (!r.data?.node?.id) { console.error('FAIL: create node:', JSON.stringify(r).slice(0, 200)); process.exit(1) }
    created.push(r.data.node.id)
    console.log(`node ${name}: ${r.data.node.id}`)
    return r.data.node.id
  }
  const vecId = await mk('thickness-scan', 'E2E 测厚扫描')
  const imgId = await mk('ccd-image', 'E2E CCD 相机')

  // ===== 3. 等帧入库(1s 节拍 × 若干 + 500ms 刷盘窗)=====
  let vecFrames = []
  let imgFrames = []
  for (let i = 0; i < 20; i++) {
    await sleep(2000)
    vecFrames = (await j(`/api/workshop/daq/${vecId}/frames?limit=10`)).data.frames
    imgFrames = (await j(`/api/workshop/daq/${imgId}/frames?limit=10`)).data.frames
    if (vecFrames.length >= 3 && imgFrames.length >= 3) break
  }
  // 向量断言
  if (vecFrames.length >= 3) {
    const f = vecFrames[0]
    if (f.kind === 'vector' && (f.points?.length ?? 0) === 64) console.log(`PASS 向量帧: ${vecFrames.length} 帧,64 点/帧`)
    else fail(`vector frame shape: kind=${f.kind} points=${f.points?.length}`)
    if (Number.isFinite(f.metrics.avg) && Number.isFinite(f.metrics.max)) console.log(`PASS 向量派生指标: avg=${f.metrics.avg} max=${f.metrics.max}`)
    else fail(`vector metrics: ${JSON.stringify(f.metrics)}`)
    if (f.lineId === cand.line.id) console.log('PASS 帧产线打标: lineId 继承')
    else fail(`frame lineId=${f.lineId} expect ${cand.line.id}`)
  } else fail(`vector frames insufficient: ${vecFrames.length}`)
  // 图像断言
  if (imgFrames.length >= 3) {
    const f = imgFrames[0]
    if (f.kind === 'image' && f.meta?.objectKey && f.meta?.thumbKey) console.log(`PASS 图像帧: ${imgFrames.length} 帧,对象键 ${String(f.meta.objectKey).slice(0, 40)}…`)
    else fail(`image frame meta: ${JSON.stringify(f.meta)}`)
    if (Number.isFinite(f.metrics.brightness)) console.log(`PASS 图像派生指标: brightness=${f.metrics.brightness} contrast=${f.metrics.contrast}`)
    else fail(`image metrics: ${JSON.stringify(f.metrics)}`)
    if (f.thumbUrl) console.log('PASS 缩略图 URL:', f.thumbUrl)
    else fail('image thumbUrl missing')
  } else fail(`image frames insufficient: ${imgFrames.length}`)

  // ===== 4. 图像 content 端点回 PNG 字节 =====
  if (imgFrames[0]) {
    const res = await fetch(`${ROOT}${imgFrames[0].thumbUrl}`, { headers: { authorization: H.authorization } })
    const buf = Buffer.from(await res.arrayBuffer())
    const pngMagic = buf.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    if (res.ok && pngMagic && buf.length > 50) console.log(`PASS 图像 content: HTTP ${res.status},${buf.length} 字节,PNG 魔数 ✓ (${res.headers.get('content-type')})`)
    else fail(`content: HTTP ${res.status} len=${buf.length} png=${pngMagic}`)
    const full = await fetch(`${ROOT}${imgFrames[0].contentUrl}`, { headers: { authorization: H.authorization } })
    const fbuf = Buffer.from(await full.arrayBuffer())
    if (full.ok && fbuf.length > imgFrames[0] ? true : fbuf.length > 0) console.log(`PASS 主图 content: ${fbuf.length} 字节(≥缩略图 ${fbuf.length >= buf.length ? '✓' : '✗'})`)
    else fail(`full content: HTTP ${full.status}`)
  }

  // ===== 5. 标量表零污染:向量/图像节点在 daq_samples 无行 =====
  for (const [label, id] of [['vector', vecId], ['image', imgId]]) {
    const pts = (await j(`/api/workshop/daq/${id}/samples?limit=10`)).data.points
    if (pts.length === 0) console.log(`PASS 标量表零污染(${label}): daq_samples 无该节点行`)
    else fail(`scalar pollution (${label}): ${pts.length} rows`)
  }

  // ===== 6. WS daq.frame(可选:浏览器外裸 WS 需应用源;此处跳过,REST 已覆盖管线)=====

  // ===== 7. 停线:帧冻结 =====
  await j(`/api/workshop/dcw/lines/${cand.line.id}/stop`, 'POST')
  await sleep(2500)
  const after = (await j(`/api/workshop/daq/${vecId}/frames?limit=5`)).data.frames
  await sleep(3000)
  const after2 = (await j(`/api/workshop/daq/${vecId}/frames?limit=5`)).data.frames
  if (after[0]?.at === after2[0]?.at) console.log('PASS 停线帧冻结: 最新帧时间不再推进')
  else fail(`frames still flowing after stop: ${after[0]?.at} → ${after2[0]?.at}`)
} finally {
  // ===== 清理:删节点 + 停线兜底 =====
  for (const id of created) await j(`/api/workshop/daq/${id}`, 'DELETE').catch(() => {})
  console.log(`cleanup: removed ${created.length} nodes`)
}

console.log(process.exitCode ? '\nE2E FAILED' : '\nE2E ALL PASS')
