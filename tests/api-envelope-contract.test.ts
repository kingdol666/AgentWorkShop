/**
 * 统一信封契约测试(2026-11-10 全系统审计 B1/B6)。
 *
 * B1:zValidator 抛出的 AppError 会被 h3 v2 包成 HTTPError,原始错误在 cause 链上
 *     (实测 error.cause.cause)。修复前 HTTP 层永远拿不到业务码 VALIDATION_ERROR,
 *     62 个校验路由全被降级成 REQUEST_ERROR;且既有单测只测 zValidator 本身,测不到
 *     这个边界,所以一直是绿的。这里用 toWebHandler 走真实 HTTP 路径做回归守卫。
 * B6:三处 `.catch(() => ({...}))` 把空 body 的校验错误连同"超长 title"一起吞掉,
 *     schema 形同虚设;改为 schema.optional().default({}) 后空 body 仍合法。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import { createApp, createRouter, toWebHandler, readValidatedBody, createError } from 'h3'
import { defineApiHandler } from '../server/utils/response'
import { zValidator } from '../server/utils/validate'
import { AppError } from '../server/utils/errors'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

const app = createApp()
const router = createRouter()

const valueSchema = z.object({ value: z.number().finite() })

router.post('/validated', defineApiHandler(async (event) => {
  return await readValidatedBody(event, zValidator(valueSchema))
}))

router.post('/app-error', defineApiHandler(async () => {
  throw new AppError(409, 'WRITE_FREQUENT', '写入过于频繁(保持窗内)')
}))

router.post('/h3-error', defineApiHandler(async () => {
  throw createError({ statusCode: 418, statusMessage: 'teapot' })
}))

app.use(router)
const web = toWebHandler(app)

const post = async (path: string, body?: string, contentType = 'application/json'): Promise<{ status: number, body: { code: unknown, message: string, data: unknown } }> => {
  const res = await web(new Request(`http://localhost${path}`, {
    method: 'POST',
    headers: { 'content-type': contentType },
    body,
  }))
  return { status: res.status, body: await res.json() as { code: unknown, message: string, data: unknown } }
}

test('HTTP 层:zValidator 失败 → 400 + code=VALIDATION_ERROR + 字段前缀(h3 cause 链还原)', async () => {
  const { status, body } = await post('/validated', JSON.stringify({ value: 'nope' }))
  assert.equal(status, 400)
  assert.equal(body.code, 'VALIDATION_ERROR', 'h3 v2 会把 AppError 包两层,必须沿 cause 链还原业务码')
  assert.match(body.message, /^value:/, '消息须以字段名开头(前端据此定位表单字段)')
  assert.equal(body.data, null)
})

test('HTTP 层:AppError 直抛不被改写(非校验路径码值透传)', async () => {
  const { status, body } = await post('/app-error')
  assert.equal(status, 409)
  assert.equal(body.code, 'WRITE_FREQUENT')
  assert.equal(body.message, '写入过于频繁(保持窗内)')
})

test('HTTP 层:非 AppError 的 H3Error 仍归 REQUEST_ERROR(修复不误伤)', async () => {
  const { status, body } = await post('/h3-error')
  assert.equal(status, 418)
  assert.equal(body.code, 'REQUEST_ERROR')
})

test('HTTP 层:裸 JSON 解析失败仍是 REQUEST_ERROR(不冒充校验失败)', async () => {
  const { status, body } = await post('/validated', '{oops')
  assert.equal(status, 400)
  assert.equal(body.code, 'REQUEST_ERROR')
})

/** 去掉块注释与整行 // 注释后再做源码契约断言(避免注释里提到旧写法就误报) */
function codeOnly(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter(line => !line.trim().startsWith('//'))
    .join('\n')
}

test('B6:三处会话/任务端点不得再用 .catch 吞校验错误', () => {
  for (const rel of [
    'server/api/workshop/channels/[id]/sessions/index.post.ts',
    'server/api/workshop/channels/[id]/sessions/[sid]/close.post.ts',
    'server/api/workshop/tasks/[id]/reopen.post.ts',
  ]) {
    const src = codeOnly(readFileSync(join(ROOT, rel), 'utf-8'))
    assert.ok(!/\.catch\(\(\)\s*=>/.test(src), `${rel} 仍残留 .catch(() => ...):超长字段被静默丢弃`)
    assert.match(src, /\.default\(\{\}\)/, `${rel} 必须用 schema.default({}) 承接空 body`)
  }
})

test('B6:空 body 经 default({}) 解析为 {} —— 校验仍对超长值生效', () => {
  const validate = zValidator(z.object({ title: z.string().max(120).optional() }).default({}))
  assert.deepEqual(validate(undefined), {}, '空 body 合法(标题缺省)')
  assert.deepEqual(validate({}), {})
  assert.throws(() => validate({ title: 'x'.repeat(121) }), (err: unknown) => {
    assert.ok(err instanceof AppError)
    assert.match(err.message, /^title:/)
    return true
  }, '超长标题必须 400,不得静默改名')
})
