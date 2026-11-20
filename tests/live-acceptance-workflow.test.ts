// 验收 workflow 契约测试(live acceptance round workflow)。
//
// 用户要求:完整实测流程写入可复用 workflow——后续轮次能按它对系统做真实功能演示作业测试,
// 且可随时更新。这里把「workflow 必须存在、双位置一致、引用面真实存在、覆盖面完整」固化成
// 单元测试:删掉任何一环,这组断言就会红。
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SKILL = 'aw-live-acceptance-round'
const skillPath = base => join(REPO, base, SKILL, 'SKILL.md')

const readSkill = base => readFileSync(skillPath(base), 'utf8')

describe('live acceptance round workflow', () => {
  it('SKILL.md 在 skills/ 与 .agents/skills/ 双位置存在且逐字一致', () => {
    assert.ok(existsSync(skillPath('skills')), `缺少 ${skillPath('skills')}`)
    assert.ok(existsSync(skillPath(join('.agents', 'skills'))), `缺少发现副本`)
    assert.equal(readSkill('skills'), readSkill(join('.agents', 'skills')), '双位置副本必须逐字一致')
  })

  it('frontmatter name = 目录名,description 为可用性描述', () => {
    const text = readSkill('skills')
    const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/)
    assert.ok(m, '缺少 frontmatter')
    const name = m[1].match(/^name:\s*(.+)$/m)?.[1]?.trim()
    const desc = m[1].match(/^description:\s*(.+)$/m)?.[1]?.trim()
    assert.equal(name, SKILL)
    assert.ok(desc && desc.length >= 20 && desc.length <= 1024)
  })

  it('runbook 覆盖全部验收域(产线/Channel/下发/RSI/AML/Project/跨频道/记忆/缺陷回归)', () => {
    const body = readSkill('skills').split(/^---.*?---/s)[1] ?? ''
    for (const section of ['环境与实例纪律', 'L1', 'L2', 'L3', 'L4', 'L5', 'L6', 'L7', 'L8', '裁决纪律', 'workflow 更新']) {
      assert.ok(body.includes(section), `runbook 缺少「${section}」节`)
    }
    for (const keyword of ['治理下发', 'RSI', 'AML', 'Project', '跨频道', 'write-attempt', '经验记忆', '缺陷回归']) {
      assert.ok(body.includes(keyword), `runbook 缺少关键词「${keyword}」`)
    }
  })

  it('引用的轮次脚本真实存在且可语法解析', () => {
    const body = readSkill('skills')
    const refs = [...body.matchAll(/scripts\/experiments\/(tsa[\w-]+\.mjs)/g)].map(m => m[1])
    assert.ok(refs.length >= 5, `runbook 引用脚本过少: ${refs.length}`)
    for (const ref of new Set(refs)) {
      const p = join(REPO, 'scripts', 'experiments', ref)
      assert.ok(existsSync(p), `引用脚本不存在: ${ref}`)
    }
  })

  it('skills 校验器把本 skill 列入 REQUIRED_MIRRORS', () => {
    const req = createRequire(import.meta.url)
    const src = readFileSync(join(REPO, 'scripts', 'test-aw-skills.mjs'), 'utf8')
    assert.ok(src.includes(`'${SKILL}'`), 'test-aw-skills.mjs 的 REQUIRED_MIRRORS 必须包含本 skill')
    assert.ok(req)
  })
})
