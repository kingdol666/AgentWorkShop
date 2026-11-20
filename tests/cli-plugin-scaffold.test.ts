/**
 * `aw plugin create` 脚手架契约测试:
 *  ① 生成三件套(index/client/README)到指定作用域;
 *  ② 生成的 index.mjs **可解析可导入**(模板转义错误会让脚手架产出坏文件——本测试专门盯这个);
 *  ③ 脚手架自带 Agent 工具示例:setup 后注册 `<name>_ping` 只读工具(把「插件注册自定义工具」
 *    这条主路径放进默认模板,而不是只写在文档里)。
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { run } from '../cli/commands/plugin.mjs'

describe('aw plugin create scaffold', () => {
  it('生成可导入的入口,并自带 <name>_ping Agent 工具示例', async () => {
    const root = mkdtempSync(join(tmpdir(), 'aw-plugin-scaffold-'))
    try {
      const ctx = { root, home: join(root, 'home'), cwd: root }
      await run({ flags: {}, positionals: ['create', 'demo-tool'] }, ctx)

      const dir = join(root, '.AgentWorkShop', 'plugins', 'demo-tool')
      for (const f of ['index.mjs', 'client.mjs', 'README.md']) {
        assert.ok(existsSync(join(dir, f)), `缺少 ${f}`)
      }

      const entry = join(dir, 'index.mjs')
      const mod = await import(pathToFileURL(entry).href)
      const def = mod.default
      assert.equal(def.name, 'demo-tool')
      assert.equal(typeof def.setup, 'function')

      const tools: Array<Record<string, unknown>> = []
      const kv: Record<string, unknown> = {}
      const fakeCtx = {
        logger: { info() {}, warn() {}, error() {}, debug() {} },
        kv: {
          get: (k: string) => kv[k],
          set: (k: string, v: unknown) => { kv[k] = v },
          bump: (k: string) => {
            kv[k] = Number(kv[k] ?? 0) + 1
            return kv[k]
          },
        },
        hooks: { on: () => () => {} },
        events: { on() {}, off() {} },
        route: () => true,
        omp: {
          registerTool: (t: Record<string, unknown>) => {
            tools.push(t)
            return { ok: true }
          },
        },
      }
      await def.setup(fakeCtx)

      assert.equal(tools.length, 1)
      const tool = tools[0]
      assert.equal(tool.name, 'demo_tool_ping')
      assert.equal(tool.riskClass, 'read')
      assert.equal(tool.noRefs, true)
      assert.deepEqual(tool.roles, ['lead', 'worker'])
      // 示例工具必须真的能跑(handler 返回文本,不回显未转义模板)
      kv.samples = 3
      const handler = tool.handler as (a: Record<string, unknown>) => Promise<{ text: string }>
      const res = await handler({ text: 'hi' })
      assert.match(res.text, /^hi/)
      assert.match(res.text, /samples=3/)
      assert.doesNotMatch(res.text, /\$\{/)
    }
    finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('非法名字被拒绝(小写字母开头 2-32 位)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'aw-plugin-scaffold-bad-'))
    try {
      const ctx = { root, home: join(root, 'home'), cwd: root }
      await assert.rejects(() => run({ flags: {}, positionals: ['create', 'Bad_Name'] }, ctx), /用法/)
      assert.equal(existsSync(join(root, '.AgentWorkShop', 'plugins', 'Bad_Name')), false)
    }
    finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
