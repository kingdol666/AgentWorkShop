/** 临时:实例化全新的 hybrid_twin Channel 用于闭环验收(避开历史队列),输出 channelId */
const BASE = process.env.AW_BASE ?? 'http://127.0.0.1:3001'
const ADMIN = { email: process.env.AW_ADMIN_EMAIL ?? 'admin@awshop.local', password: process.env.AW_ADMIN_PASSWORD ?? 'Awshop@123!' }
const j = async (method, path, body, token) => {
  const r = await fetch(BASE + path, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) })
  return { status: r.status, ...(await r.json().catch(() => ({}))) }
}
const token = (await j('POST', '/api/users/login', ADMIN)).data?.token
const tpls = (await j('GET', '/api/workshop/channel-templates', undefined, token)).data ?? []
const tpl = tpls.find(x => x.id === 'chtpl-hybrid-twin-mpc-default')
if (!tpl) throw new Error('hybrid 模板缺失')
const inst = await j('POST', `/api/workshop/channel-templates/${tpl.id}/instantiate`, {
  name: `闭环优化-hybridtwin-verify-${Date.now().toString(36).slice(-4)}`,
  toolProfile: 'hybrid_twin',
  scene: { sceneId: 'injection-hold-control', sceneVersion: '1.0.0', lineId: 'line-injection-01', productId: 'product-injection-a', recipeId: 'recipe-injection-a' },
  objective: { objectiveId: 'weight-quality', targets: { weight: 32.5 } },
  controlPolicy: 'recommendation_only',
}, token)
const channelId = inst.data?.channelId ?? inst.data?.id
if (!channelId) throw new Error(`实例化失败: ${JSON.stringify(inst).slice(0, 300)}`)
process.stdout.write(String(channelId))
