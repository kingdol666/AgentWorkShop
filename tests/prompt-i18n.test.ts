/**
 * F5A 注入面 i18n 单测:
 *  - locale 归一与 env 回退(zh 缺省);
 *  - tr 缺省 zh 逐字节返回原文;
 *  - en 装配面不残留系统中文(用户数据用英文名隔离)。
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.AGENTWORKSHOP_TEST = '1'
process.env.AW_MODE = 'home'
process.env.AW_HOME = mkdtempSync(join(tmpdir(), 'aw-prompt-i18n-'))

const { normalizePromptLocale, promptLocaleOf, tr } = await import('../server/services/workshop/agents/prompt-i18n')
const { optimizationNoteLines, buildIndustrialContext, industrialLoopGuide, mesCapabilityLabel } = await import('../server/services/workshop/agents/industrial-context')

const CJK = /[\u4E00-\u9FFF]/

describe('prompt-i18n', () => {
  const prev = process.env.AW_PROMPT_LOCALE
  before(() => {
    process.env.AW_PROMPT_LOCALE = 'en-US'
  })
  after(() => {
    if (prev === undefined) delete process.env.AW_PROMPT_LOCALE
    else process.env.AW_PROMPT_LOCALE = prev
  })

  it('locale 归一:en/en-US/EN_GB → en;其余 → zh', () => {
    assert.equal(normalizePromptLocale('en'), 'en')
    assert.equal(normalizePromptLocale('en-US'), 'en')
    assert.equal(normalizePromptLocale('EN_GB'), 'en')
    assert.equal(normalizePromptLocale('zh-CN'), 'zh')
    assert.equal(normalizePromptLocale(''), 'zh')
    assert.equal(normalizePromptLocale(undefined), 'zh')
  })

  it('无 agent/channel 配置时回落 env', () => {
    assert.equal(promptLocaleOf(), 'en')
  })

  it('Agent 实例配置优先;未配置时经 agent.channelId 回落频道 llm_json', () => {
    const g = globalThis as typeof globalThis & { __workshopManager?: unknown }
    const prev = g.__workshopManager
    g.__workshopManager = {
      deps: {
        repos: {
          channelAgents: {
            findById: (id: string) => id === 'ag-own'
              ? { configJson: JSON.stringify({ locale: 'zh' }), channelId: 'ch-1' }
              : { configJson: '{}', channelId: 'ch-2' },
          },
          channels: {
            findById: (id: string) => ({ llmJson: JSON.stringify({ locale: id === 'ch-2' ? 'en' : 'zh' }) }),
          },
        },
      },
    }
    try {
      assert.equal(promptLocaleOf('ag-own'), 'zh') // 实例覆盖频道
      assert.equal(promptLocaleOf('ag-fallback'), 'en') // 实例无 locale → 其频道 en
    }
    finally {
      g.__workshopManager = prev
    }
  })

  it('tr:zh 缺省逐字节不变,en 返回英文', () => {
    const zh = '- 物理量: 温度,单位 ℃'
    assert.equal(tr('zh', zh, '- Physical quantity: temperature'), zh)
    assert.equal(tr('en', zh, '- Physical quantity: temperature'), '- Physical quantity: temperature')
  })
})

describe('en 装配面不残留系统中文', () => {
  const records = [
    { nodeName: 'OvenTemp', status: 'judged', judge: { verdict: 'keep', reason: 'thickness in window' } },
    { nodeName: 'OvenTemp', status: 'judged', judge: { verdict: 'rollback', reason: 'film too thin' } },
  ]

  it('dcw 节点行(en)', () => {
    const lines = optimizationNoteLines({
      dcwNodes: ['dn-1'],
      recipes: [{ recipeId: 'rr-1', name: 'BOPET-Main' }],
      recordsOf: f => (f.nodeId ? records : []),
    }, 'en')
    assert.ok(lines.length >= 1)
    assert.ok(lines.every(l => !CJK.test(l)), lines.join('\n'))
    assert.match(lines[0]!, /last 2 tunings/)
  })

  it('配方无记录提示(en)', () => {
    const lines = optimizationNoteLines({
      dcwNodes: [],
      recipes: [{ recipeId: 'rr-empty', name: 'NewRecipe' }],
      recordsOf: () => [],
    }, 'en')
    assert.equal(lines.length, 1)
    assert.ok(!CJK.test(lines[0]!))
    assert.match(lines[0]!, /no tuning history yet/)
  })

  it('缺省 zh 保持原格式(回归)', () => {
    const lines = optimizationNoteLines({ dcwNodes: ['dn-1'], recipes: [], recordsOf: () => records })
    assert.match(lines[0]!, /近 2 次调控/)
  })
})

describe('无绑定 Agent 的注入面为空(不制造英文噪声)', () => {
  it('buildIndustrialContext 无绑定 → 空串(zh/en 一致)', () => {
    assert.equal(buildIndustrialContext('no-such-agent', 'zh'), '')
    assert.equal(buildIndustrialContext('no-such-agent', 'en'), '')
  })

  it('industrialLoopGuide 无绑定 → 空串(zh/en 一致)', () => {
    assert.equal(industrialLoopGuide('no-such-agent', 'zh'), '')
    assert.equal(industrialLoopGuide('no-such-agent', 'en'), '')
  })

  it('MES 能力标签:zh 用「史/读/写/钩」,en 用 R/W/H/HK(回归)', () => {
    const e = { readable: true, writable: true, historyable: true, format: 'vector', hooked: true }
    assert.equal(mesCapabilityLabel(e, 'zh'), '读/写/史·vector/钩')
    assert.equal(mesCapabilityLabel(e, 'en'), 'R/W/H·vector/HK')
  })
})
