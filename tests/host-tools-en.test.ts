/**
 * F5B host-tools 英文增量目录:
 *  - zh 缺省仍为原中文定义;
 *  - en 覆盖生效(description/参数描述),未覆盖工具回退中文;
 *  - overlay 缺失键不破坏定义形状。
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { resolve } from 'node:path'

process.env.AGENTWORKSHOP_TEST = '1'

const promptsDir = resolve(process.cwd(), '.AgentWorkShop', 'prompts')
const prev = process.env.AW_PROMPTS_DIR
before(() => {
  process.env.AW_PROMPTS_DIR = promptsDir
})
after(() => {
  if (prev === undefined) delete process.env.AW_PROMPTS_DIR
  else process.env.AW_PROMPTS_DIR = prev
})

const { loadHostToolDefs } = await import('../server/services/workshop/prompts/loader')

const CJK = /[\u4E00-\u9FFF]/

describe('host-tools 英文增量目录', () => {
  it('zh 缺省:daq_query 描述保持中文', () => {
    const tools = loadHostToolDefs('zh')
    const t = tools.find(x => x.name === 'daq_query')!
    assert.ok(t)
    assert.match(t.description, /时序数据库|活动批次/)
  })

  it('en:daq_query/recipe_update 描述与参数描述为英文', () => {
    const tools = loadHostToolDefs('en')
    const daq = tools.find(x => x.name === 'daq_query')!
    assert.match(daq.description, /Query historical\/live data/)
    assert.ok(!CJK.test(daq.description))
    const props = (daq.parameters as { properties: Record<string, { description?: string }> }).properties
    assert.ok(!CJK.test(props.node_id!.description!))

    const rec = tools.find(x => x.name === 'recipe_update')!
    assert.ok(!CJK.test(rec.description))
    assert.ok(!CJK.test((rec.parameters as { properties: Record<string, { description?: string }> }).properties.reason!.description!))
  })

  it('en:未覆盖工具回退中文定义(结构不缺失)', () => {
    const zh = loadHostToolDefs('zh').find(x => x.name === 'submit_task')!
    const en = loadHostToolDefs('en').find(x => x.name === 'submit_task')!
    assert.equal(en.description, zh.description)
    assert.ok(en.parameters)
  })

  it('en:工具集合与 zh 完全一致(overlay 只改文案,不增删)', () => {
    const zhNames = loadHostToolDefs('zh').map(t => t.name).sort()
    const enNames = loadHostToolDefs('en').map(t => t.name).sort()
    assert.deepEqual(enNames, zhNames)
  })
})
