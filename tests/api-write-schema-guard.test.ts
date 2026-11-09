/**
 * API 写面 schema 守卫测试(2026-11-08 审查 WP5)。
 *
 * 背景:全仓 186 个写面文件里只有 62 个走 readValidatedBody+zValidator,4 个高危
 * 写面(MES 凭据/物理参数写/工具桥/设备孪生控制)长期裸 readBody —— 形状不受控。
 * 本测试双保险:
 *  ① 静态:高危写面必须走 zValidator(有人改回裸 readBody 立刻红);
 *  ② 运行时:zValidator 的错误契约(400 AppError + 字段路径前缀)不变 —— 前端依赖它定位字段。
 *
 * 不校验各端点的业务规则(那些由 service 层既有实现负责)。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import { zValidator } from '../server/utils/validate'
import { AppError } from '../server/utils/errors'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/** 高危写面(安全敏感:凭据/物理设备/工具桥/设备控制)—— 必须 schema 校验 */
const GUARDED_WRITE_ENDPOINTS = [
  'server/api/workshop/mes/secrets/index.put.ts',
  'server/api/workshop/dcw/params/[id]/write.post.ts',
  'server/api/workshop/device-twins/[id]/control.post.ts',
  'server/api/workshop/agent-tools/invoke.post.ts',
  'server/api/workshop/hitl/respond.post.ts',
  'server/api/workshop/permissions/index.put.ts',
]

test('高危写面全部走 readValidatedBody + zValidator', () => {
  for (const rel of GUARDED_WRITE_ENDPOINTS) {
    const src = readFileSync(join(ROOT, rel), 'utf-8')
    assert.match(src, /readValidatedBody/, `${rel} 必须使用 readValidatedBody(裸 readBody 形状不受控)`)
    assert.match(src, /zValidator\(/, `${rel} 必须经 zValidator 包装 schema`)
    assert.ok(
      !/await readBody[<(]/.test(src),
      `${rel} 仍残留裸 readBody 调用(应只保留 readValidatedBody)`,
    )
  }
})

test('zValidator 错误契约:400 + 字段路径前缀(VALIDATION_ERROR)', () => {
  const validate = zValidator(z.object({ ref: z.string().min(1), value: z.number() }))
  try {
    validate({ ref: 'mes-cred', value: 'not-a-number' })
    assert.fail('应当抛错')
  }
  catch (err) {
    assert.ok(err instanceof AppError, '必须是 AppError(统一信封依赖它)')
    assert.equal(err.status, 400)
    assert.equal(err.code, 'VALIDATION_ERROR')
    // 精确到首个字段路径 —— 前端据此定位表单字段
    assert.match(String(err.message), /^value:/, `错误消息须以字段名开头,实际:${err.message}`)
  }
})

test('zValidator 通过时返回解析后的数据(含 trim 与 coerce 语义)', () => {
  const validate = zValidator(z.object({
    ref: z.string().trim().min(1),
    value: z.coerce.number().finite(),
  }))
  const out = validate({ ref: '  mes-cred  ', value: '12.5' })
  assert.deepEqual(out, { ref: 'mes-cred', value: 12.5 })
})

test('zValidator 拒绝非有限数值(NaN/Infinity/非数值对象不得抵达业务层)', () => {
  const validate = zValidator(z.object({ value: z.coerce.number().finite() }))
  // 注:[] 经 Number([])===0 与旧 Number(body.value) 语义一致,不在拒绝清单(保持行为对齐)。
  for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, 'abc', {}]) {
    assert.throws(() => validate({ value: bad }), /value:/, `应拒绝 ${String(bad)}`)
  }
})
