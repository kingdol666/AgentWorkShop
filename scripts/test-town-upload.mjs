/**
 * 小镇·模型上传/绑定/删除 管线验证(纯 REST E2E,无需浏览器)。
 * 断言:上传落盘 → 列表可见 → 绑定 → config.modelRef 持久化 → 引删保护 → 解除绑定后删除。
 */
import fs from 'node:fs'

const BASE = 'http://127.0.0.1:3000'
const api = async (m, ep, { body, token, form } = {}) => {
  const headers = {}
  if (token) headers.authorization = `Bearer ${token}`
  let payload
  if (form) {
    payload = form
  }
  else {
    headers['content-type'] = 'application/json'
    payload = body ? JSON.stringify(body) : undefined
  }
  const res = await fetch(`${BASE}${ep}`, { method: m, headers, body: payload })
  return res.json()
}

async function main() {
  const email = `up-${Date.now().toString(36)}@test.local`
  const reg = await api('POST', '/api/users/register', { body: { name: `up-${Date.now().toString(36)}`, email, password: 'Passw0rd!123' } })
  if (!reg.data) {
    console.error('REG FAIL', JSON.stringify(reg))
    process.exit(2)
  }
  const { token } = reg.data
  await api('POST', '/api/workshop/workspaces', { body: { name: 'up-ws' }, token })
  const ch = await api('POST', '/api/workshop/channels', { body: { name: 'up-ch', scenarioPrompt: 't', leadAgent: { name: 'lead', harness: 'mock' } }, token })
  const cid = ch.data.channelId
  const agent = await api('POST', `/api/workshop/channels/${cid}/agents`, { body: { name: 'w1', harness: 'mock', role: 'worker' }, token })
  const aid = agent.data.id

  // 1) 上传 knight.png(multipart)
  const buf = fs.readFileSync('public/assets/game/character/knight.png')
  const form = new FormData()
  form.append('file', new Blob([buf], { type: 'image/png' }), 'knight.png')
  form.append('name', '上传测试骑士')
  form.append('kind', 'sheet')
  form.append('frameWidth', '48')
  form.append('frameHeight', '88')
  form.append('frames', '4')
  const up = await api('POST', '/api/workshop/assets/character', { token, form })
  if (!up.data?.asset) {
    console.error('UPLOAD FAIL', JSON.stringify(up))
    process.exit(2)
  }
  const assetId = up.data.asset.id
  console.log('upload id:', assetId)
  const fileExists = fs.existsSync(`public${up.data.asset.file}`)
  console.log(`上传落盘: ${fileExists ? 'PASS' : 'FAIL'}`)

  // 2) GET 列表可见
  const list1 = await api('GET', `/api/workshop/assets/character`, { token })
  const visible = (list1.data?.assets ?? []).some(a => a.id === assetId)
  console.log(`列表可见: ${visible ? 'PASS' : 'FAIL'}`)

  // 3) 绑定到 agent → config.modelRef 持久化
  const bind = await api('PATCH', `/api/workshop/channels/${cid}/agents/${aid}/model`, { token, body: { modelRef: assetId } })
  console.log(`绑定: ${bind.data?.modelRef === assetId ? 'PASS' : 'FAIL'} (${bind.data?.modelRef})`)
  const agents = await api('GET', `/api/workshop/channels/${cid}/agents`, { token })
  const boundAgent = (agents.data ?? []).find(a => a.id === aid)
  const modelRefPersisted = boundAgent?.config?.modelRef === assetId
  console.log(`config.modelRef 持久化: ${modelRefPersisted ? 'PASS' : 'FAIL'}`)

  // 4) 引删保护:仍被绑定 → used>0
  const del1 = await api('DELETE', `/api/workshop/assets/character/${assetId}`, { token })
  const protectedDel = del1.data?.used > 0
  console.log(`引删保护(used>0): ${protectedDel ? 'PASS' : 'FAIL'} (used=${del1.data?.used})`)

  // 5) 清空绑定后删除 → removed + 文件删
  await api('PATCH', `/api/workshop/channels/${cid}/agents/${aid}/model`, { token, body: { modelRef: '' } })
  const del2 = await api('DELETE', `/api/workshop/assets/character/${assetId}`, { token })
  const fileGone = !fs.existsSync(`public${up.data.asset.file}`)
  console.log(`解除绑定后删除: ${del2.data?.deleted ? 'PASS' : 'FAIL'} | 文件删: ${fileGone ? 'PASS' : 'FAIL'}`)

  const allPass = fileExists && visible && bind.data?.modelRef === assetId && modelRefPersisted && protectedDel && del2.data?.deleted && fileGone
  console.log('\nSUMMARY:', JSON.stringify({ fileExists, visible, modelRefPersisted, protectedDel, deleted: del2.data?.deleted, fileGone }))
  console.log(allPass ? '\n==> ALL PASS' : '\n==> SOME FAIL')
  process.exit(allPass ? 0 : 1)
}
main()
  .catch((e) => {
    console.error(e)
    process.exit(2)
  })
