/**
 * 对话页合并会话 + 位置化删除确认 源码契约（2026-11-26）。
 *
 * 这些断言锁定用户可感知的交互结构：
 *  - 多会话不再单开页面，chat 视图由 ChatSessionHost 承载群聊/会话切换；
 *  - 删除/移除入口必须包在 ConfirmPopover（a-popconfirm）里，确认后才调用动作；
 *  - 侧栏会话列表回到群聊/高亮当前会话。
 *
 * 逻辑行为由 tests/session-*.test.ts 与真实 UI E2E 覆盖；这里防的是"结构被改回去"。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const read = (path: string): string => readFileSync(join(root, path), 'utf8')

test('session switches discard stale responses and deep links select once', () => {
  const detail = read('app/components/workshop/SessionManageView.vue')
  assert.match(detail, /messagesSeq/)
  assert.match(detail, /seq !== messagesSeq[\s\S]*activeSessionId\.value !== s\.id/)
  assert.match(detail, /seq !== contextSeq[\s\S]*activeSessionId\.value !== s\.id/)
  assert.match(detail, /const seq = \+\+loadAllSeq[\s\S]*seq !== loadAllSeq[\s\S]*channelId !== props\.channelId/)
  assert.match(detail, /const seq = \+\+productsSeq[\s\S]*seq !== productsSeq/)

  const host = read('app/components/workshop/ChatSessionHost.vue')
  assert.match(host, /listSeq/)
  assert.match(host, /seq !== listSeq[\s\S]*channelId !== props\.channelId/)
  assert.match(host, /route\.query\.session/)

  const mini = read('app/components/workshop/console/SessionMiniList.vue')
  assert.match(mini, /loadSeq/)
  assert.match(mini, /seq !== loadSeq[\s\S]*id !== props\.channelId/)

  const project = read('app/pages/projects/[id].vue')
  assert.match(project, /openSessionConsole\(channelId: string, sessionId\?: string \| null\)/)
  assert.match(project, /session=\$\{encodeURIComponent\(sessionId\)\}/)
})

test('chat view hosts group chat and embedded session management on one page', () => {
  const host = read('app/components/workshop/ChatSessionHost.vue')
  assert.match(host, /workshop-session-manage-view/)
  assert.match(host, /\bembedded\b/)
  assert.match(host, /:selected-session-id="sessionId"/)
  assert.match(host, /openCreate/)
  assert.match(host, /workshop-chat-timeline/)
  assert.match(host, /chat-session-select/)
  assert.match(host, /chat-session-create/)

  const center = read('app/components/workshop/console/CenterPane.vue')
  assert.match(center, /workshop-chat-session-host/)
  assert.doesNotMatch(center, /view === 'sessions'/)

  const dock = read('app/components/workshop/console/Dock.vue')
  assert.match(dock, /v-if="!sessionActive"/)
})

test('sessions view is removed from navigation and legacy deep links fall back to chat', () => {
  const shell = read('app/pages/workshop/composables/useWorkspaceShell.ts')
  assert.doesNotMatch(shell, /\{ value: 'sessions'/)
  assert.doesNotMatch(shell, /7: 'sessions'/)
  assert.match(shell, /initView === 'sessions'[\s\S]*?'chat'/)

  const rail = read('app/components/workshop/console/Rail.vue')
  assert.doesNotMatch(rail, /value: 'sessions'/)

  const page = read('app/pages/workshop/w/[wsId].vue')
  assert.match(page, /@open-session="openChatSession"/)
  assert.match(page, /v-model:chat-session-id="chatSessionId"/)
  assert.match(page, /:session-active="view === 'chat' && !!chatSessionId"/)
})

test('sidebar session list supports group chat and active session highlight', () => {
  const mini = read('app/components/workshop/console/SessionMiniList.vue')
  assert.match(mini, /session-mini-group/)
  assert.match(mini, /activeSessionId === s\.id/)
  assert.match(mini, /emit\('open', null\)/)
})

test('dangerous delete/remove entry points are wrapped in ConfirmPopover', () => {
  const checks: Array<[string, RegExp[]]> = [
    ['app/components/workshop/ChannelSessionList.vue', [/unmountConfirmTitle/, /@confirm="unmount\(ch\.id\)"/]],
    ['app/components/workshop/workbench/WorkspaceCard.vue', [/delWsConfirmTitle/, /@confirm="emit\('remove', workspace\.id\)"/]],
    ['app/components/workshop/teams/TeamCard.vue', [/removeTeamConfirmTitle/, /removeMemberConfirmTitle/, /@confirm="emit\('remove', team\)"/]],
    ['app/components/settings/ArchivedSessionsPane.vue', [/removeNow\(record\)/, /archived-delete-/]],
    ['app/components/settings/SkillsPane.vue', [/removeNow\(record\)/]],
    ['app/components/settings/McpServersPane.vue', [/removeNow\(record\)/]],
    ['app/components/settings/AgentPrefabsPane.vue', [/removePrefabNow\(record\)/, /@confirm="unbind"/]],
    ['app/components/settings/RuntimeGroupSection.vue', [/deleteConfirmTitle/, /@confirm="removeGroup\(group\)"/]],
    ['app/components/settings/RuntimePane.vue', [/resetAllConfirmTitle/, /@confirm="resetAllRuntime"/]],
    ['app/components/workshop/DaqNodeRow.vue', [/unbindConfirmTitle/, /@confirm="removeNodeDevice\(did\)"/]],
    ['app/components/workshop/device-twin/DeviceTwinCard.vue', [/deleteConfirmTitle/, /@confirm="\$emit\('remove', true\)"/]],
    ['app/components/workshop/town/components/TownDeviceTransform.vue', [/common\.confirmDeleteTitle/, /removeSelectedDevice\(true\)/]],
    ['app/components/workshop/town/components/TownBoundaryPanel.vue', [/removeChannelConfirmTitle/, /@confirm="removeChannelFromScene"/]],
    ['app/components/workshop/town/components/TownAgentBindings.vue', [/unbindConfirmTitle/]],
    ['app/components/workshop/town/components/TownDeviceBindings.vue', [/unbindConfirmTitle/]],
    ['app/components/workshop/town/components/TownDcwBindSection.vue', [/unbindConfirmTitle/]],
    ['app/components/dcw/DcwRecipePanel.vue', [/removeProductConfirmTitle/, /removeRecipeConfirmTitle/]],
    ['app/components/dcw/DcwTemplateModal.vue', [/removeTemplateConfirmTitle/]],
    ['app/components/daq/DaqTemplateModal.vue', [/removeTemplateConfirmTitle/, /@confirm="emit\('remove', t\)"/]],
    ['app/components/aml/AmlEnvPanel.vue', [/pruneConfirmTitle/]],
    ['app/components/workshop/AssetLibrary.vue', [/removeConfirmTitle/, /@confirm="doRemove\(m\.id\)"/]],
  ]
  for (const [path, patterns] of checks) {
    const source = read(path)
    assert.match(source, /ConfirmPopover/, `${path} must use ConfirmPopover`)
    for (const pattern of patterns) assert.match(source, pattern, `${path} missing ${pattern}`)
  }
})

test('settings delete actions no longer open a distant Modal.confirm', () => {
  const archived = read('app/components/settings/ArchivedSessionsPane.vue')
  assert.doesNotMatch(archived, /Modal\.confirm/)
  const skills = read('app/components/settings/SkillsPane.vue')
  assert.doesNotMatch(skills, /function remove\(item: ManagedRevision\)/)
  const mcp = read('app/components/settings/McpServersPane.vue')
  assert.doesNotMatch(mcp, /function remove\(server: McpServer\)/)
})

test('AML row deletes use in-place confirmation, not a distant dialog', () => {
  for (const path of ['app/components/aml/AmlDatasetTable.vue', 'app/components/aml/AmlModelsTable.vue', 'app/components/aml/AmlJobsTable.vue']) {
    const source = read(path)
    assert.match(source, /ConfirmPopover/, `${path} must confirm at the row`)
    assert.match(source, /@confirm="\$emit\('remove'/)
  }
  const aml = read('app/pages/aml/composables/useAmlEntities.ts')
  assert.doesNotMatch(aml, /confirmDialog/)
})
