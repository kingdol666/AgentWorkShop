/**
 * 产线治理一致性守卫(2026-11-10 审计 A4/A5/A6/A7/S1)。
 *
 * 这些问题的共同点:每一道闸单看都"有",但清单之间不同源、开关读了不生效、
 * 或者强制转换把"漏传"变成一次真实下发。本文件锁四件事:
 *   ① 真实设备写工具必须同时出现在"项目 write_intent 门"里(A5);
 *   ② 「配方下发人工审批」设置项必须真被读取(A4,死开关回归);
 *   ③ line_start 不得绕过配方二级认证(A6);
 *   ④ DAQ 标量 ingest 不得用 Number() 折叠 null/""/false/[](S1)。
 * A7(写审计去重键)有独立行为测试在 tests/dcw-write-audit.test.ts。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { PROJECT_GATED_WRITE_TOOL_NAMES } from '../server/services/workshop/projects/tool-surface'
import { HIGH_RISK_TOOL_NAMES } from '../server/services/workshop/runtime/permission-scope'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

function codeOnly(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter(line => !line.trim().startsWith('//'))
    .join('\n')
}

test('A5:全部真实设备写必须进项目 write_intent 门(optimization_explore 不得漏)', () => {
  // 两份清单不同源是历史缺口来源:permission-scope 把 optimization_explore 当高危,
  // tool-surface 的 write_intent 清单却漏了它 —— 项目内可直接写 PLC。
  for (const name of ['optimization_explore', 'recipe_apply', 'recipe_trial', 'line_start', 'line_stop']) {
    assert.ok(PROJECT_GATED_WRITE_TOOL_NAMES.has(name), `${name} 必须在 PROJECT_GATED_WRITE_TOOL_NAMES 内`)
  }
  // 反向:permission-scope 里属于设备写的工具(排除 AML 数据面)都应在门内
  for (const name of HIGH_RISK_TOOL_NAMES) {
    if (name.startsWith('aml_')) continue // AML 训练/建模属数据面,纳入与否是产品决策(P3 记录)
    assert.ok(PROJECT_GATED_WRITE_TOOL_NAMES.has(name), `${name} 列为高危写却不在项目 write_intent 门内`)
  }
})

test('A4:security.recipeDispatchApproval 必须真被读取(死开关回归)', () => {
  const src = codeOnly(readFileSync(join(ROOT, 'server/services/workshop/agents/industrial/recipe-gate.ts'), 'utf-8'))
  assert.match(src, /settingOf\('security\.recipeDispatchApproval'\)/, '必须从设置服务读取,不得硬编码 false')
  assert.doesNotMatch(src, /const globalGate = false/, '不得保留硬编码 false 的死开关')
  assert.match(src, /hitlRequired:.*globalGate/, 'globalGate 必须叠加进 hitlRequired')
})

test('A6:line_start 不得绕过配方二级认证(审批前 + 批后复核各一道)', () => {
  const src = codeOnly(readFileSync(join(ROOT, 'server/services/workshop/agents/industrial/line-tools.ts'), 'utf-8'))
  const checks = src.match(/access\?\.requireAuth/g) ?? []
  assert.ok(checks.length >= 2, `requireAuth 检查必须两道(审批前 + 批后),实际 ${checks.length}`)
  assert.match(src, /authorizedAgentIds \?\? \[\]\)\.includes\(agentId\)/, '必须按授权清单判定,空清单 fail-closed')
})

test('S1:DAQ 标量 ingest 不得用 Number() 折叠 null/空串/数组', () => {
  const src = codeOnly(readFileSync(join(ROOT, 'server/api/workshop/daq/[id]/ingest.post.ts'), 'utf-8'))
  assert.doesNotMatch(src, /const value = Number\(body\.value\)/, 'Number(null)/Number("")/Number([]) 全为 0,会污染时序')
  assert.match(src, /typeof rawValue === 'number'/, '必须以 typeof 区分 number 与字符串,再决定是否转换')
})
