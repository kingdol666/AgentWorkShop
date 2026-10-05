/* eslint-disable @stylistic/max-statements-per-line */
// SDK 行为级实调 v2(sdk/index 聚合面):HookBus 语义 + createPlatformClient 真实调用链
import { HookBus, createClientContext, createPlatformClient, CLIENT_SDK_VERSION } from '../../sdk/index.mjs'

let pass = 0, fail = 0
const ok = (n, c, d = '') => { console.log(`${c ? '✅' : '❌'} ${n}${d ? ' — ' + d : ''}`); c ? pass++ : fail++ }

ok('SDK 版本导出', CLIENT_SDK_VERSION.length > 0, CLIENT_SDK_VERSION)

// ① HookBus:异步串行/错误隔离/通配/once
const bus = new HookBus({ name: 'test' })
const order = []
bus.on('task', async (p) => { order.push('a' + p); return p * 2 })
bus.on('task', async (p) => { order.push('b' + p) })
await bus.emit('task', 5)
ok('HookBus:异步串行', order.join(',') === 'a5,b5', order.join(','))
bus.on('boom', () => { throw new Error('fail') })
let survived = false
bus.on('boom', () => { survived = true })
await bus.emit('boom')
ok('HookBus:错误隔离', survived)
let wc = 0
bus.on('*', () => wc++)
await bus.emit('any', 1)
ok('HookBus:* 通配', wc >= 1)
let oc = 0
const un = bus.once('once-e', () => oc++)
await bus.emit('once-e')
un()
await bus.emit('once-e')
ok('HookBus:once+退订', oc === 1)

// ② createPlatformClient:登录 → 真实读取链
const pc = createPlatformClient({ baseUrl: 'http://localhost:3001' })
ok('platformClient:方法面完整', ['get', 'post', 'setToken', 'lines', 'daqNodes', 'channels'].every(k => k in pc), Object.keys(pc).length + ' 成员')
const login = await pc.post('/api/users/login', { email: 'visual@awshop.local', password: 'Visual2026' }).catch(e => ({ err: String(e) }))
const token = login?.data?.token ?? login?.token
pc.setToken?.(token)
ok('platformClient:登录+setToken', !!token)
const health = await pc.get('/api/health').catch(e => ({ err: String(e) }))
ok('platformClient:health', JSON.stringify(health).includes('"ok"'))
const lines = await pc.get('/api/workshop/dcw/lines').catch(e => ({ err: String(e) }))
const lineArr = lines?.data?.lines ?? lines?.lines ?? (Array.isArray(lines) ? lines : [])
ok('platformClient:lines()', Array.isArray(lineArr) && lineArr.length >= 5, `count=${Array.isArray(lineArr) ? lineArr.length : 'shape?'}`)
const daqNodes = await pc.get('/api/workshop/daq').catch(e => ({ err: String(e) }))
ok('platformClient:daqNodes()', JSON.stringify(daqNodes).includes('controller') || JSON.stringify(daqNodes).includes('nodes'))
const recipes = await pc.get('/api/workshop/dcw').catch(e => ({ err: String(e) }))
ok('platformClient:recipes()', JSON.stringify(recipes).includes('rc-'))

// ③ createClientContext 形状
const ctx = createClientContext({ name: 'loop-test', baseUrl: 'http://localhost:3001' })
ok('createClientContext:ctx 构建', !!ctx, Object.keys(ctx ?? {}).slice(0, 6).join(','))

console.log(`\n=== SDK 行为级实调: ${pass} pass / ${fail} fail ===`)
process.exit(fail ? 1 : 0)
