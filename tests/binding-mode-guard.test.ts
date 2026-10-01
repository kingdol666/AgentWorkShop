import { test } from 'node:test'
import assert from 'node:assert/strict'

const { resolveModeChange } = await import('../server/services/workshop/agents/binding-mode')

// 产线 Co-Pilot P2 auto 治理(计划 §5.4 / 铁律 2):
// 绑定控制模式切换判定纯函数 —— manual→auto 必须显式 confirm,其余方向放行,
// 无 mode 字段/同名 = 不变更。服务端 [id].patch.ts 以此消掉旧 `?? 'auto'` 静默缺省。
// (仓库 tests/ 无 nitro 路由级测试先例,按任务口径以纯函数层为准。)

test('binding-mode: manual→auto 无 confirm → 拒绝并标记 needConfirm', () => {
  const d = resolveModeChange('manual', 'auto', undefined)
  assert.equal(d.ok, false)
  assert.equal(d.needConfirm, true)
  assert.ok(d.error && d.error.length > 0, '应有中文错误文案')
})

test('binding-mode: manual→auto confirm=true → 放行', () => {
  assert.deepEqual(resolveModeChange('manual', 'auto', true), { ok: true })
})

test('binding-mode: manual→auto confirm 须严格布尔(字符串/数字不算)', () => {
  assert.equal(resolveModeChange('manual', 'auto', 'true').ok, false)
  assert.equal(resolveModeChange('manual', 'auto', 1).ok, false)
})

test('binding-mode: auto→manual 恢复人工审批,免 confirm', () => {
  assert.deepEqual(resolveModeChange('auto', 'manual', undefined), { ok: true })
})

test('binding-mode: 同名 mode → ok 且 noop(无操作)', () => {
  assert.deepEqual(resolveModeChange('auto', 'auto', undefined), { ok: true, noop: true })
  assert.deepEqual(resolveModeChange('manual', 'manual', true), { ok: true, noop: true })
})

test('binding-mode: target undefined(请求无 mode 字段)→ 不变更', () => {
  assert.deepEqual(resolveModeChange('manual', undefined, undefined), { ok: true, noop: true })
  assert.deepEqual(resolveModeChange('auto', undefined, true), { ok: true, noop: true })
})
