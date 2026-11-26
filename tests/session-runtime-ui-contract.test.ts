/**
 * 会话 runtime 元数据编辑 —— 前端/API 源码契约（2026-11-26）。
 *
 * 锁定用户可感知结构：会话详情有运行实例面板、runtime 对象 id、编辑表单、
 * harness/原生模型选择、节点/recipe 绑定、冻结范围只读、变更只在下一回合生效的
 * 提示、重置/解绑就地确认、API 路径与 i18n 键。具体行为由 service/hot-reload/
 * 真实 UI E2E 覆盖。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const read = (path: string): string => readFileSync(join(root, path), 'utf8')

test('session detail embeds the runtime panel and the panel exposes runtime object ids', () => {
  const detail = read('app/components/workshop/SessionManageView.vue')
  assert.match(detail, /workshop-session-runtime-panel/)
  assert.match(detail, /:session-id="activeSession\.id"/)

  const panel = read('app/components/workshop/SessionRuntimePanel.vue')
  assert.match(panel, /data-testid="session-runtime-panel"/)
  assert.match(panel, /session-runtime-row-/)
  assert.match(panel, /session-runtime-edit-/)
  assert.match(panel, /session-runtime-rebuild-/)
  assert.match(panel, /runtimeObjectId/)
  assert.match(panel, /customized/)
  assert.match(panel, /baseHarness/)
  assert.match(panel, /runtime\.manageable/)
})

test('runtime editor has harness, native profile, bindings and in-place confirms', () => {
  const modal = read('app/components/workshop/SessionRuntimeEditModal.vue')
  assert.match(modal, /session-runtime-harness"/)
  assert.match(modal, /session-runtime-harness-effective/)
  assert.match(modal, /session-runtime-provider/)
  assert.match(modal, /session-runtime-model/)
  assert.match(modal, /session-runtime-effort/)
  assert.match(modal, /session-runtime-prompt/)
  assert.match(modal, /session-runtime-prefab/)
  assert.match(modal, /session-runtime-prefab-revision/)
  assert.match(modal, /session-runtime-object-id/)
  assert.match(modal, /nextTurnHint/)
  assert.match(modal, /ConfirmPopover/)
  assert.match(modal, /session-runtime-reset/)
  assert.match(modal, /RUNTIME_REVISION_CONFLICT/)
  assert.match(modal, /expectedRevision/)
  assert.match(modal, /profileSupport|support\.provider|support\.model/)
  assert.match(modal, /workshop-session-runtime-bindings/)
  assert.match(modal, /listHarnessProviders\(targetHarness\)/)
  assert.match(modal, /apiErrorCode/)
  // 运行面不接受启动参数/凭据
  assert.doesNotMatch(modal, /body:\s*\{[^}]*command/)
  assert.doesNotMatch(modal, /rpcMode/)
})

test('bindings section reads the summary, writes through agent-tools and edits the session scope', () => {
  const bindings = read('app/components/workshop/SessionRuntimeBindings.vue')
  assert.match(bindings, /data-testid="session-runtime-bindings"/)
  assert.match(bindings, /session-runtime-binding-add/)
  assert.match(bindings, /session-runtime-binding-kind/)
  assert.match(bindings, /session-runtime-binding-resource/)
  assert.match(bindings, /session-runtime-binding-row-/)
  assert.match(bindings, /session-runtime-binding-remove-/)
  assert.match(bindings, /session-runtime-binding-mode-/)
  assert.match(bindings, /data-testid="session-scope"/)
  assert.match(bindings, /session-scope-product/)
  assert.match(bindings, /session-scope-recipes/)
  assert.match(bindings, /session-scope-save/)
  assert.match(bindings, /session-scope-reset/)
  assert.match(bindings, /session-runtime-rebuild/)
  assert.match(bindings, /getSessionRuntimeBindings/)
  assert.match(bindings, /getSessionBinding/)
  assert.match(bindings, /updateSessionBinding/)
  assert.match(bindings, /addAgentBinding/)
  assert.match(bindings, /removeAgentBinding/)
  assert.match(bindings, /updateAgentBinding/)
  assert.match(bindings, /confirm: true/)
  assert.match(bindings, /ConfirmPopover/)
  assert.match(bindings, /scopeSourceLabel/)
})

test('session runtime API paths and types are declared once', () => {
  const api = read('app/composables/workshop/useWorkshopApi.ts')
  assert.match(api, /listSessionRuntime/)
  assert.match(api, /updateSessionRuntime/)
  assert.match(api, /getSessionRuntimeBindings/)
  assert.match(api, /rebuildSessionRuntime/)
  assert.match(api, /sessions\/\$\{sid\}\/runtime/)
  assert.match(api, /expectedRevision/)
  assert.match(api, /effectiveAt: 'next_turn'/)
  assert.match(api, /overrides: \{/)
  assert.match(api, /baseHarness/)
  assert.match(api, /profileSupport/)
  assert.match(api, /listAgentPrefabs/)
  assert.match(api, /getAgentPrefabRevision/)

  for (const path of [
    'server/api/workshop/channels/[id]/sessions/[sid]/runtime/index.get.ts',
    'server/api/workshop/channels/[id]/sessions/[sid]/runtime/[agentId].get.ts',
    'server/api/workshop/channels/[id]/sessions/[sid]/runtime/[agentId].patch.ts',
    'server/api/workshop/channels/[id]/sessions/[sid]/runtime/[agentId]/bindings.get.ts',
    'server/api/workshop/channels/[id]/sessions/[sid]/runtime/[agentId]/rebuild.post.ts',
  ]) {
    const source = read(path)
    assert.match(source, /resolveUser/)
    assert.match(source, /getWorkshopManager|createSessionRuntimeBindingService/)
    assert.match(source, /defineApiHandler/)
  }
  const patch = read('server/api/workshop/channels/[id]/sessions/[sid]/runtime/[agentId].patch.ts')
  assert.match(patch, /harness:/)
  assert.match(patch, /expectedRevision/)
  assert.match(patch, /zValidator/)
  assert.match(patch, /\.strict\(\)/)
})

test('runtime i18n keys exist in both locales with parity', () => {
  const zh = read('i18n/locales/zh-CN.ts')
  const en = read('i18n/locales/en.ts')
  const keys = [
    'title', 'hint', 'objectId', 'model', 'prefab', 'nextTurnHint', 'resetConfirmTitle', 'savedNextTurn', 'resetNextTurn',
    'harnessEffective', 'baseHarness', 'harnessOverridden', 'suppress', 'profileSection', 'warningsTitle',
    'bindingsTitle', 'bindingsHint', 'bindingsEmpty', 'bindingKind', 'bindingKindDaq', 'bindingKindDcw',
    'bindingKindRecipe', 'bindingKindLineRecipe', 'bindingResource', 'bindingMode', 'bindingModeAuto',
    'bindingModeManual', 'bindingAdd', 'bindingRemove', 'bindingRemoveTitle', 'bindingModeConfirmTitle',
    'scopeTitle', 'scopeHint', 'scopeProduct', 'scopeRecipes', 'scopeReset', 'scopeSaved',
    'scopeSourceOverride', 'scopeSourceSnapshot', 'scopeNote',
    'rebuild', 'rebuildTitle', 'rebuildDesc', 'rebuildQueued', 'toolRefreshNative',
  ]
  for (const key of keys) {
    assert.match(zh, new RegExp(`\\b${key}:`), `zh missing runtime key ${key}`)
    assert.match(en, new RegExp(`\\b${key}:`), `en missing runtime key ${key}`)
  }
})
