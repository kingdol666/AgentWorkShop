/**
 * 创建期（Agent 模板 / 添加成员 / 编辑成员）运行模型选择 —— 源码契约。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const read = (path: string): string => readFileSync(join(root, path), 'utf8')

test('runtime profile fields component offers native catalog, custom ids and effort modes', () => {
  const fields = read('app/components/workshop/RuntimeProfileFields.vue')
  assert.match(fields, /\$\{prefix\}-fields/)
  assert.match(fields, /listHarnessProviders/)
  assert.match(fields, /effortMode === 'freetext'/)
  assert.match(fields, /effortMode === 'unsupported'/)
  assert.match(fields, /runtimeProfile\.custom/)
  assert.match(fields, /support\.provider/)
  assert.match(fields, /support\.model/)
  assert.match(fields, /support\.effort/)
  assert.match(fields, /data-testid="`\$\{prefix\}-provider`"/)
  assert.match(fields, /data-testid="`\$\{prefix\}-model`"/)
  assert.match(fields, /data-testid="`\$\{prefix\}-effort`"/)
})

test('agent template modal exposes structured harness + model fields and syncs them into config', () => {
  const modal = read('app/components/workshop/agents/AgentTemplateEditModal.vue')
  assert.match(modal, /workshop-runtime-profile-fields/)
  assert.match(modal, /agent-template-profile/)
  assert.match(modal, /v-model:provider="form\.provider"/)
  assert.match(modal, /v-model:model="form\.model"/)
  assert.match(modal, /v-model:effort="form\.effort"/)
  assert.match(modal, /runtimeProfile\.section/)

  const form = read('app/pages/workshop/composables/useAgentTemplateForm.ts')
  assert.match(form, /provider: string/)
  assert.match(form, /syncProfileToJson/)
  assert.match(form, /thinkingLevel/)
  assert.match(form, /variant/)
  assert.match(form, /watch\(\(\) => \[form\.provider, form\.model, form\.effort\]/)
})

test('add-member modal uses the registry harness list and sends the profile config', () => {
  const modal = read('app/components/workshop/lanes/AddMemberModal.vue')
  assert.match(modal, /useAgentHarnessOptions/)
  assert.match(modal, /add-member-harness/)
  assert.match(modal, /add-member-profile/)
  assert.match(modal, /:options="harnessOptions"/)
  assert.match(modal, /memberConfig\(\)/)
  assert.doesNotMatch(modal, /<a-radio value="omp">/)
})

test('edit-member modal can change harness and profile', () => {
  const modal = read('app/components/workshop/lanes/EditMemberModal.vue')
  assert.match(modal, /edit-member-harness/)
  assert.match(modal, /edit-member-profile/)
  assert.match(modal, /harness: editForm\.harness/)
  assert.match(modal, /thinkingLevel/)
  const api = read('app/composables/workshop/useWorkshopApi.ts')
  assert.match(api, /updateChannelAgent: \(id: string, agentId: string, body: \{ name\?: string, harness\?: string/)
})

test('runtimeProfile i18n keys exist in both locales', () => {
  const zh = read('i18n/locales/zh-CN.ts')
  const en = read('i18n/locales/en.ts')
  for (const key of ['section', 'provider', 'model', 'effort', 'default', 'custom', 'hint', 'retry']) {
    assert.match(zh, new RegExp(`\\b${key}:`), `zh missing runtimeProfile.${key}`)
    assert.match(en, new RegExp(`\\b${key}:`), `en missing runtimeProfile.${key}`)
  }
})
