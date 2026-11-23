/**
 * REST 客户端建频道必须一次挂载(2026-11-23 发版审查)。
 *
 * 服务端 `POST /api/workshop/channels` 在 `mountToDefaultWorkspace` 下随创建挂一次:
 * 显式 `workspaceId` → 挂到指定工作区,否则建/挂 owner 的「默认工作区」。
 * 调用方若沿用旧写法(建完再 `POST /workspaces/:ws/channels/:id`)会把同一频道
 * 挂进两个工作区 —— console 里出现重复项、`workspace_channels` 多一行。
 * 这里锁定仓库内脚本的调用方式:创建请求带 workspaceId,且不再补挂。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = join(fileURLToPath(new URL('..', import.meta.url)))
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8')

/** 建频道路径字面量(含引号);用 String.fromCharCode 拼出单引号,避免测试源码里出现嵌套引号 */
const QUOTE = String.fromCharCode(39)
const CREATE_CALL = `${QUOTE}/api/workshop/channels${QUOTE}`
const POST_LITERAL = `${QUOTE}POST${QUOTE}`

/** 脚本里所有「建频道」请求的调用点:只看方法字面量紧邻路径的 POST(结构性断言用) */
function channelCreateBlocks(source: string): string[] {
  const blocks: string[] = []
  let from = 0
  for (;;) {
    const at = source.indexOf(CREATE_CALL, from)
    if (at < 0) break
    const prefix = source.slice(Math.max(0, at - 24), at)
    if (prefix.includes(POST_LITERAL)) blocks.push(source.slice(at, at + 420))
    from = at + CREATE_CALL.length
  }
  return blocks
}

test('仓库脚本建频道时随请求带 workspaceId,不再事后补挂', () => {
  const files = [
    'scripts/aw-start-smoke.mjs',
    'scripts/_audit/line-integration-live.mjs',
    'scripts/ui/seed-demo.mjs',
  ]
  for (const file of files) {
    const source = read(file)
    const creates = channelCreateBlocks(source)
    assert.ok(creates.length > 0, `${file} 应包含建频道调用`)
    for (const block of creates) {
      assert.ok(block.includes('workspaceId'), `${file}: 建频道请求必须带 workspaceId(否则服务端会挂到默认工作区,再补挂就重复)`)
    }
    assert.ok(!source.includes('/api/workshop/workspaces/'), `${file}: 不应再事后 POST 挂载(频道已随创建挂载)`)
  }
})
