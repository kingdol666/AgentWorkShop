/**
 * 演示用自定义工艺模板(Node 发 UTF-8,避免 Windows 控制台编码把名称写成乱码)。
 * 用法:node scripts/demo/create-demo-templates.mjs --base http://127.0.0.1:3960 --email .. --pass ..
 */
const args = process.argv.slice(2)
const argOf = (k, d = '') => {
  const i = args.indexOf(k)
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : d
}
const base = argOf('--base', 'http://127.0.0.1:3960')
process.env.NO_PROXY = '127.0.0.1,localhost'
const login = await fetch(`${base}/api/users/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: argOf('--email'), password: argOf('--pass') }),
})
const lj = await login.json()
const token = lj?.data?.token
if (!token) throw new Error(`登录失败:${JSON.stringify(lj).slice(0, 200)}`)

async function post(path, body) {
  const r = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'authorization': `Bearer ${token}` },
    body: JSON.stringify(body),
  })
  const j = await r.json()
  if (j?.code !== 0) throw new Error(`${path} 失败:${JSON.stringify(j).slice(0, 200)}`)
  return j.data
}
async function del(path) {
  await fetch(`${base}${path}`, { method: 'DELETE', headers: { authorization: `Bearer ${token}` } })
}

// 清掉先前 curl 写入的乱码模板(键已知)
for (const k of ['cw-47d1345c', 'ct-0efbf1f4', 'ct-89a808cc']) {
  try {
    await del(`/api/workshop/dcw/templates/${k}`)
  }
  catch { /* 不存在则忽略 */ }
  try {
    await del(`/api/workshop/daq/templates/${k}`)
  }
  catch { /* 不存在则忽略 */ }
}

const dcw = await post('/api/workshop/dcw/templates', {
  name: '保压压力设定',
  code: 'HOLD · SP',
  ch: '保压压力设定',
  unit: 'bar',
  min: 50,
  max: 90,
  decimals: 1,
  icon: 'pressure',
  semantics: '保压压力设定:升高提升补缩效果与制品重量,过高易飞边;每次调整建议 ≤2bar 并等待压力跟随。',
})
const weight = await post('/api/workshop/daq/templates', {
  name: '制品重量',
  code: 'WEIGHT · PV',
  ch: '制品重量',
  unit: 'g',
  base: 31.7,
  amp: 0.15,
  min: 28,
  max: 36,
  decimals: 3,
  icon: 'gateway',
  semantics: '制品重量:注塑质量核心指标;保压压力升高→补缩更充分→重量上升。',
})
const cavity = await post('/api/workshop/daq/templates', {
  name: '模腔压力',
  code: 'CAVITY · PV',
  ch: '模腔压力',
  unit: 'bar',
  base: 70,
  amp: 2,
  min: 0,
  max: 120,
  decimals: 2,
  icon: 'pressure',
  semantics: '模腔压力:保压压力的直接响应量,用于验证执行器跟随。',
})
console.log(JSON.stringify({ dcwKey: dcw.template.key, weightKey: weight.template.key, cavityKey: cavity.template.key, names: [dcw.template.name, weight.template.name, cavity.template.name] }))
